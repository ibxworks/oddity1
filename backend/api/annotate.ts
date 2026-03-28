import type {
  Annotation,
  AnnotationMode,
  DepthPersonality,
} from "@oddity/shared";
import { CACHE_TTL_DAYS, MAX_TEXT_LENGTH, canUseFeature } from "@oddity/shared";
import type { UserTier } from "@oddity/shared";
import { Router } from "express";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  filterAndFixAnnotations,
  fixSingleAnnotation,
} from "../lib/annotation-filter.js";
import {
  generateAnnotations,
  generateAnnotationsStream,
} from "../lib/gemini.js";
import { createInflightDedup } from "../lib/inflight-dedup.js";
import { mergeAnnotationsAndFeedback } from "../lib/merge-annotations.js";
import { serviceClient } from "../lib/supabase.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsPath = resolve(__dirname, "../config/prompts.json");
const prompts = JSON.parse(readFileSync(promptsPath, "utf-8"));

// ─── Optimization: in-flight request dedup ───
const dedup = createInflightDedup();

function cacheKey(
  contentHash: string,
  mode: string,
  personality?: string,
): string {
  const intensityPart = mode === "overview" ? "terry" : (personality ?? "none");
  return `${contentHash}:${mode}:${intensityPart}`;
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

    const userTier = (req.user?.tier ?? "free") as UserTier;

    // ── Feature gate: Sally personality requires Standard ──
    if (
      parsed.data.personality === "sally" &&
      !canUseFeature(userTier, "sallyPersonality")
    ) {
      res.status(403).json({
        error: "Sally personality requires a Standard plan",
        upgrade: true,
      });
      return;
    }

    // ── Feature gate: PDF URLs require Standard ──
    if (
      /\.pdf($|\?)/i.test(parsed.data.url) &&
      !canUseFeature(userTier, "pdfAnnotation")
    ) {
      res.status(403).json({
        error: "PDF annotation requires a Standard plan",
        upgrade: true,
      });
      return;
    }

    // ── Usage limit check ──
    if (req.user?.id) {
      const limit =
        userTier !== "free"
          ? Number(process.env.STANDARD_PLAN_LIMIT_PER_MONTH ?? 2000)
          : Number(process.env.FREE_PLAN_LIMIT_PER_MONTH ?? 100);

      const { data: usageResult, error: usageErr } = await serviceClient.rpc(
        "check_and_record_usage",
        { p_user_id: req.user.id, p_url: parsed.data.url, p_limit: limit },
      );

      if (usageErr) {
        console.error("[annotate] Usage check failed:", usageErr.message);
      } else if (usageResult && !usageResult.allowed) {
        res.status(403).json({
          error: "Monthly annotation limit reached",
          usage: { count: usageResult.count, limit },
          upgrade: userTier === "free",
        });
        return;
      }
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
    // Overview is persona-independent; depth varies by personality
    const cacheIntensity = mode === "overview" ? "overview:terry" : `${mode}:${personality ?? "terry"}`;
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

    const { error: cacheWriteError } = await serviceClient
      .from("annotation_cache")
      .upsert(
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
    if (cacheWriteError) {
      console.error("[annotate] Cache write failed:", cacheWriteError.message);
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
    // Overview is persona-independent; depth varies by personality
    const cacheIntensity = mode === "overview" ? "overview:terry" : `${mode}:${personality ?? "terry"}`;
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

    const { error: cacheWriteError } = await serviceClient
      .from("annotation_cache")
      .upsert(
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
    if (cacheWriteError) {
      console.error(
        "[annotate/stream] Cache write failed:",
        cacheWriteError.message,
      );
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
