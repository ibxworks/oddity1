import type { Annotation, Intensity } from "@oddity/shared";
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
// If two identical requests arrive concurrently, only one LLM call is made.
const dedup = createInflightDedup();

function cacheKey(contentHash: string, intensity: string): string {
  return `${contentHash}:${intensity}`;
}

const AnnotateRequestSchema = z.object({
  url: z.string().url(),
  content_hash: z.string().min(1),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  intensity: z.enum(["light", "default", "heavy"]),
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

    const { url, content_hash, text, intensity } = parsed.data;
    const key = cacheKey(content_hash, intensity);
    const authToken = req.headers.authorization?.slice(7) ?? "";

    // ── Layer 1: DB cache (Supabase) ──
    const { data: dbCached } = await serviceClient
      .from("annotation_cache")
      .select("annotations, model_version, prompt_version")
      .eq("content_hash", content_hash)
      .eq("intensity", intensity)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (dbCached) {
      // Compatibility check: ensure cached entry matches current model + prompt version
      const currentModel = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
      const currentPromptVersion = prompts.version;

      if (
        dbCached.model_version === currentModel &&
        dbCached.prompt_version === currentPromptVersion
      ) {
        // Merge with user annotations + feedback in single response
        const merged = await mergeAnnotationsAndFeedback(
          dbCached.annotations,
          url,
          content_hash,
          authToken,
        );
        res.json({ success: true, cached: true, source: "db", ...merged });
        return;
      }
      // Stale entry (model/prompt changed) — fall through to re-generate
    }

    // ── Layer 2: LLM generation (deduplicated) ──
    const aiAnnotations = await dedup.run(key, async () => {
      const profile = prompts.intensity_profiles[intensity as Intensity];
      const rawAnnotations = await generateAnnotations(text, intensity, profile);
      return filterAndFixAnnotations(rawAnnotations, text);
    });

    // Write-through: populate DB cache
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS);

    await serviceClient.from("annotation_cache").upsert(
      {
        content_hash,
        url,
        intensity,
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

    // Merge with user annotations + feedback in single response
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
  const { url, content_hash, text, intensity } = data;
  const authToken = req.headers.authorization?.slice(7) ?? "";

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    // Check DB cache first — if cached, send all at once and close
    const { data: dbCached } = await serviceClient
      .from("annotation_cache")
      .select("annotations, model_version, prompt_version")
      .eq("content_hash", content_hash)
      .eq("intensity", intensity)
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
      // Send all cached annotations at once
      for (const ann of merged.annotations) {
        res.write(`data: ${JSON.stringify({ annotation: ann })}\n\n`);
      }
      res.write(
        `data: ${JSON.stringify({ done: true, cached: true, annotations: merged.annotations, feedback: merged.feedback })}\n\n`,
      );
      res.end();
      return;
    }

    // Stream from LLM — single call for the whole article
    const profile = prompts.intensity_profiles[intensity as Intensity];
    const allAnnotations: Annotation[] = [];

    const stream = generateAnnotationsStream(text, intensity, profile);

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
        intensity,
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

    // Send final event with feedback
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
