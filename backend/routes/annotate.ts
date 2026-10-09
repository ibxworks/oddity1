import type {
  Annotation,
  AnnotationMode,
  AnnotationUsage,
  DepthPersonality,
} from "@oddity/shared";
import { CACHE_TTL_DAYS, MAX_TEXT_LENGTH, canUseFeature } from "@oddity/shared";
import type { UserTier } from "@oddity/shared";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  filterAndFixAnnotations,
  fixSingleAnnotation,
} from "../lib/annotation-filter.js";
import {
  activeModelName,
  generateAnnotations,
  generateAnnotationsStream,
} from "../lib/openrouter.js";
import { createInflightDedup } from "../lib/inflight-dedup.js";
import { isValidPersonaSlug } from "../lib/persona-registry.js";
import { mergeAnnotationsAndFeedback } from "../lib/merge-annotations.js";
import { createRequestAbortSignal } from "../lib/request-abort.js";
import { serviceClient } from "../lib/supabase.js";
import prompts from "../config/prompts.json" with { type: "json" };

// ─── Optimization: in-flight request dedup ───
const dedup = createInflightDedup();

function getPlanLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getMonthlyPlanLimits(): { free: number; standard: number } {
  return {
    free: getPlanLimit(process.env.FREE_PLAN_LIMIT_PER_MONTH, 100),
    standard: getPlanLimit(process.env.STANDARD_PLAN_LIMIT_PER_MONTH, 2000),
  };
}

function getUpgradeMultiplier(): number | undefined {
  const limits = getMonthlyPlanLimits();
  if (limits.free <= 0) return undefined;

  const multiplier = Math.round(limits.standard / limits.free);
  return Number.isFinite(multiplier) && multiplier > 1 ? multiplier : undefined;
}

function buildUsage(
  count: number,
  limit: number,
  alreadyCounted: boolean,
): AnnotationUsage {
  return {
    count,
    limit,
    already_counted: alreadyCounted,
  };
}

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
  personality: z.string().optional().transform(p => {
    if (!p) return undefined;
    if (p === "gary") return "sally" as DepthPersonality;
    if (p === "terry" || p === "jerry" || p === "sally") return p as DepthPersonality;
    if (p.startsWith("pf:") && isValidPersonaSlug(p.slice(3))) return p as DepthPersonality;
    return undefined; // unknown value — drop it
  }),
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
    const upgradeMultiplier =
      userTier === "free" ? getUpgradeMultiplier() : undefined;
    let usage: AnnotationUsage | undefined;

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

    // ── Feature gate: Public figure personas require Standard ──
    if (
      parsed.data.personality?.startsWith("pf:") &&
      !canUseFeature(userTier, "publicFigurePersonas")
    ) {
      res.status(403).json({
        error: "Public figure personas require a Standard plan",
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
      const limits = getMonthlyPlanLimits();
      const limit = userTier !== "free" ? limits.standard : limits.free;

      const { data: usageResult, error: usageErr } = await serviceClient.rpc(
        "check_and_record_usage",
        { p_user_id: req.user.id, p_url: parsed.data.url, p_limit: limit },
      );

      if (usageErr) {
        console.error("[annotate] Usage check failed:", usageErr.message);
      } else if (usageResult) {
        usage = buildUsage(
          Number(usageResult.count ?? 0),
          limit,
          Boolean(usageResult.already_counted),
        );
      }

      if (usageResult && !usageResult.allowed) {
        res.status(403).json({
          error: "Monthly annotation limit reached",
          usage,
          upgrade: userTier === "free",
          upgrade_multiplier: upgradeMultiplier,
        });
        return;
      }
    }

    // SSE streaming path: client requests progressive delivery
    const wantsStream = req.headers.accept === "text/event-stream";
    if (wantsStream) {
      return handleStreamingAnnotation(
        req,
        res,
        parsed.data,
        usage,
        userTier,
        upgradeMultiplier,
      );
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
      const currentModel = activeModelName;
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
        if (req.user?.id && merged.annotations.length > 0) {
          serviceClient.rpc("increment_annotation_count", {
            p_user_id: req.user.id,
            p_count: merged.annotations.length,
          }).then(({ error }) => {
            if (error) console.error("[annotate] annotation_count increment failed:", error.message);
          });
        }
        res.json({
          success: true,
          cached: true,
          source: "db",
          ...merged,
          usage,
          upgrade: userTier === "free" ? true : undefined,
          upgrade_multiplier: upgradeMultiplier,
        });
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
          model_version: activeModelName,
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
    if (req.user?.id && merged.annotations.length > 0) {
      serviceClient.rpc("increment_annotation_count", {
        p_user_id: req.user.id,
        p_count: merged.annotations.length,
      }).then(({ error }) => {
        if (error) console.error("[annotate] annotation_count increment failed:", error.message);
      });
    }
    res.json({
      success: true,
      cached: false,
      source: "llm",
      ...merged,
      usage,
      upgrade: userTier === "free" ? true : undefined,
      upgrade_multiplier: upgradeMultiplier,
    });
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
  usage: AnnotationUsage | undefined,
  userTier: UserTier,
  upgradeMultiplier: number | undefined,
): Promise<void> {
  const { url, content_hash, text, mode, personality } = data;
  const authToken = req.headers.authorization?.slice(7) ?? "";
  const requestId = randomUUID();
  const { signal, cleanup } = createRequestAbortSignal(req, res);

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

    const currentModel = activeModelName;
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
      if (req.user?.id && merged.annotations.length > 0) {
        serviceClient.rpc("increment_annotation_count", {
          p_user_id: req.user.id,
          p_count: merged.annotations.length,
        }).then(({ error }) => {
          if (error) console.error("[annotate/stream] annotation_count increment failed:", error.message);
        });
      }
      for (const ann of merged.annotations) {
        res.write(`data: ${JSON.stringify({ annotation: ann })}\n\n`);
      }
      res.write(
        `data: ${JSON.stringify({
          done: true,
          cached: true,
          annotations: merged.annotations,
          feedback: merged.feedback,
          usage,
          upgrade: userTier === "free" ? true : undefined,
          upgrade_multiplier: upgradeMultiplier,
        })}\n\n`,
      );
      res.end();
      return;
    }

    // Stream from LLM
    const streamResult = await generateAnnotationsStream(
      text,
      mode as AnnotationMode,
      personality as DepthPersonality | undefined,
      {
        signal,
        logContext: {
          route: "annotate/stream",
          requestId,
          contentHash: content_hash,
        },
        onAnnotation: (annotation) => {
          const fixed = fixSingleAnnotation(annotation, text);
          if (!fixed || signal.aborted || res.writableEnded) return;
          res.write(`data: ${JSON.stringify({ annotation: fixed })}\n\n`);
        },
      },
    );
    const allAnnotations = filterAndFixAnnotations(streamResult.annotations, text);

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
    if (streamResult.usedBufferedFallback) {
      console.warn(
        "[annotate/stream] Completed via buffered fallback",
        JSON.stringify({
          request_id: requestId,
          content_hash_prefix: content_hash.slice(0, 12),
          annotations: allAnnotations.length,
        }),
      );
    }
    if (signal.aborted || res.writableEnded) return;
    if (req.user?.id && merged.annotations.length > 0) {
      serviceClient.rpc("increment_annotation_count", {
        p_user_id: req.user.id,
        p_count: merged.annotations.length,
      }).then(({ error }) => {
        if (error) console.error("[annotate/stream] annotation_count increment failed:", error.message);
      });
    }
    res.write(
      `data: ${JSON.stringify({
        done: true,
        cached: false,
        annotations: merged.annotations,
        feedback: merged.feedback,
        usage,
        upgrade: userTier === "free" ? true : undefined,
        upgrade_multiplier: upgradeMultiplier,
      })}\n\n`,
    );
    res.end();
  } catch (err) {
    if (signal.aborted) {
      console.warn(
        "[annotate/stream] Request aborted",
        JSON.stringify({
          request_id: requestId,
          content_hash_prefix: content_hash.slice(0, 12),
        }),
      );
      if (!res.writableEnded) res.end();
      return;
    }
    console.error("[annotate/stream] Error:", err);
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({ error: "Internal server error" })}\n\n`,
      );
      res.end();
    }
  } finally {
    cleanup();
  }
}

export default router;
