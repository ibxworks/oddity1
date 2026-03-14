import type { Annotation, AnnotationMode, DepthPersonality } from "@oddity/shared";
import { CACHE_TTL_DAYS, MAX_TEXT_LENGTH } from "@oddity/shared";
import { Router } from "express";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  filterAndFixAnnotations,
  fixSingleAnnotation,
} from "../lib/annotation-filter.js";
import { createInflightDedup } from "../lib/inflight-dedup.js";
import { mergeAnnotationsAndFeedback } from "../lib/merge-annotations.js";
import {
  generateAnnotations,
  generateAnnotationsStream,
} from "../lib/gemini.js";
import { serviceClient } from "../lib/supabase.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsPath = resolve(__dirname, "../config/prompts.json");
const prompts = JSON.parse(readFileSync(promptsPath, "utf-8"));

// ─── Optimization: in-flight request dedup ───
const dedup = createInflightDedup();

function cacheKey(contentHash: string, mode: string, personality?: string): string {
  return `${contentHash}:${mode}:${personality ?? "none"}`;
}

const AnnotateRequestSchema = z.object({
  url: z.string().url(),
  content_hash: z.string().min(1),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  mode: z.enum(["overview", "depth"]),
  personality: z.enum(["terry", "jerry", "sally", "gary"]).optional().transform(p => p === "gary" ? "sally" : p),
  word_count: z.number().int().positive(),
});

const router = Router();

router.post("/", async (req, res) => {
  try {
    const parsed = AnnotateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    // SSE streaming path: client requests progressive delivery
    const wantsStream = req.headers.accept === "text/event-stream";
    if (wantsStream) {
      return handleStreamingAnnotation(req, res, parsed.data);
    }

    const { url, content_hash, text, mode, personality } = parsed.data;
    const key = cacheKey(content_hash, mode, personality);
    const authToken = req.headers.authorization?.slice(7) ?? "";

    // ── Layer 1: DB cache (Supabase) ──
    // Use mode+personality in cache lookup
    const cacheIntensity = mode === "depth" ? `depth:${personality ?? "terry"}` : "overview";
    const { data: dbCached } = await serviceClient
      .from("annotation_cache")
      .select("annotations, model_version, prompt_version")
      .eq("content_hash", content_hash)
      .eq("intensity", cacheIntensity)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (dbCached) {
      const currentModel = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
      const currentPromptVersion = prompts.version;

      if (
        dbCached.model_version === currentModel &&
        dbCached.prompt_version === currentPromptVersion
      ) {
        const merged = await mergeAnnotationsAndFeedback(
          dbCached.annotations,
          url,
          content_hash,
          authToken,
        );
        res.json({ success: true, cached: true, source: "db", ...merged });
        return;
      }
    }

    // ── Layer 2: LLM generation (deduplicated) ──
    const aiAnnotations = await dedup.run(key, async () => {
      const rawAnnotations = await generateAnnotations(
        text,
        mode as AnnotationMode,
        personality as DepthPersonality | undefined,
      );
      return filterAndFixAnnotations(rawAnnotations, text);
    });

    // Write-through: populate DB cache
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS);

    await serviceClient.from("annotation_cache").upsert(
      {
        content_hash,
        url,
        intensity: cacheIntensity,
        annotations: aiAnnotations,
        model_version: process.env.GEMINI_MODEL ?? "gemini-3-flash-preview",
        prompt_version: prompts.version,
        expires_at: expiresAt.toISOString(),
      },
      { onConflict: "content_hash,intensity" },
    );

    // Increment user's annotation count (fresh generation only)
    if (req.user?.id) {
      await serviceClient.rpc("increment_annotation_count", {
        p_user_id: req.user.id,
        p_count: aiAnnotations.length,
      });
    }

    const merged = await mergeAnnotationsAndFeedback(
      aiAnnotations,
      url,
      content_hash,
      authToken,
    );
    res.json({ success: true, cached: false, source: "llm", ...merged });
  } catch (err) {
    console.error("[annotate] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * SSE streaming handler: sends individual annotations as they're generated,
 * then a final event with the complete merged result.
 */
async function handleStreamingAnnotation(
  req: import("express").Request,
  res: import("express").Response,
  data: z.infer<typeof AnnotateRequestSchema>,
): Promise<void> {
  const { url, content_hash, text, mode, personality } = data;
  const authToken = req.headers.authorization?.slice(7) ?? "";

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    // Check DB cache first
    const cacheIntensity = mode === "depth" ? `depth:${personality ?? "terry"}` : "overview";
    const { data: dbCached } = await serviceClient
      .from("annotation_cache")
      .select("annotations, model_version, prompt_version")
      .eq("content_hash", content_hash)
      .eq("intensity", cacheIntensity)
      .gt("expires_at", new Date().toISOString())
      .single();

    const currentModel = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
    const currentPromptVersion = prompts.version;

    if (
      dbCached &&
      dbCached.model_version === currentModel &&
      dbCached.prompt_version === currentPromptVersion
    ) {
      const merged = await mergeAnnotationsAndFeedback(
        dbCached.annotations,
        url,
        content_hash,
        authToken,
      );
      for (const ann of merged.annotations) {
        res.write(`data: ${JSON.stringify({ annotation: ann })}\n\n`);
      }
      res.write(
        `data: ${JSON.stringify({ done: true, cached: true, annotations: merged.annotations, feedback: merged.feedback })}\n\n`,
      );
      res.end();
      return;
    }

    // Stream from LLM
    const allAnnotations: Annotation[] = [];

    const stream = generateAnnotationsStream(
      text,
      mode as AnnotationMode,
      personality as DepthPersonality | undefined,
    );

    for await (const annotation of stream) {
      const fixed = fixSingleAnnotation(annotation, text);
      if (fixed) {
        allAnnotations.push(fixed);
        res.write(`data: ${JSON.stringify({ annotation: fixed })}\n\n`);
      }
    }

    // Cache the complete result
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS);

    await serviceClient.from("annotation_cache").upsert(
      {
        content_hash,
        url,
        intensity: cacheIntensity,
        annotations: allAnnotations,
        model_version: currentModel,
        prompt_version: currentPromptVersion,
        expires_at: expiresAt.toISOString(),
      },
      { onConflict: "content_hash,intensity" },
    );

    if (req.user?.id) {
      await serviceClient.rpc("increment_annotation_count", {
        p_user_id: req.user.id,
        p_count: allAnnotations.length,
      });
    }

    const merged = await mergeAnnotationsAndFeedback(
      allAnnotations,
      url,
      content_hash,
      authToken,
    );
    res.write(
      `data: ${JSON.stringify({ done: true, cached: false, annotations: merged.annotations, feedback: merged.feedback })}\n\n`,
    );
    res.end();
  } catch (err) {
    console.error("[annotate/stream] Error:", err);
    res.write(
      `data: ${JSON.stringify({ error: "Internal server error" })}\n\n`,
    );
    res.end();
  }
}

export default router;
