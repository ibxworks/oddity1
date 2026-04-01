import type {
  Annotation,
  AnnotationMode,
  UserContext,
} from "@oddity/shared";
import { CACHE_TTL_DAYS, MAX_TEXT_LENGTH, canUseFeature } from "@oddity/shared";
import type { UserTier } from "@oddity/shared";
import { Router } from "express";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  filterAndFixAnnotations,
  fixSingleAnnotation,
} from "../lib/annotation-filter.js";
import {
  generateAnnotations,
  generateAnnotationsStream,
  plannerCall,
  plannerCallStream,
  executeAnnotations,
  executeAnnotationsStream,
} from "../lib/gemini.js";
import type { AnnotatorAssignment } from "../lib/gemini.js";
import { planAnnotations, planAnnotationsStream } from "../lib/worldview-router.js";
import type { RouterAssignment } from "../lib/worldview-router.js";
import { getWorldviewByKey } from "../lib/worldview-registry.js";
import { createInflightDedup } from "../lib/inflight-dedup.js";
import { mergeAnnotationsAndFeedback } from "../lib/merge-annotations.js";
import { serviceClient } from "../lib/supabase.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsPath = resolve(__dirname, "../config/prompts.json");
const prompts = JSON.parse(readFileSync(promptsPath, "utf-8"));

// ─── Global depth annotator semaphore ───
// Hard cap: never run more than 3 annotator LLM calls at the same time,
// across all concurrent requests. Excess calls queue until a slot frees.
const MAX_ANNOTATOR_CONCURRENCY = 3;
let annotatorRunning = 0;
const annotatorQueue: Array<() => void> = [];

async function acquireAnnotatorSlot(): Promise<void> {
  if (annotatorRunning < MAX_ANNOTATOR_CONCURRENCY) {
    annotatorRunning++;
    return;
  }
  await new Promise<void>((resolve) => annotatorQueue.push(resolve));
  annotatorRunning++;
}

function releaseAnnotatorSlot(): void {
  annotatorRunning--;
  const next = annotatorQueue.shift();
  if (next) next();
}

// ─── Optimization: in-flight request dedup ───
const dedup = createInflightDedup();

function cacheKey(
  contentHash: string,
  mode: string,
  contextMode?: string,
): string {
  const intensityPart = mode === "overview" ? "overview" : `depth:${contextMode ?? "default"}`;
  return `${contentHash}:${intensityPart}`;
}

// ─── Worldview helpers ───

const worldviewsDir = resolve(__dirname, "../../worldviews");

function loadWorldviewContent(key: string): { name: string; content: string } | undefined {
  const meta = getWorldviewByKey(key);
  if (!meta) return undefined;
  const content = readFileSync(resolve(worldviewsDir, meta.fileName), "utf-8");
  return { name: meta.name, content };
}

function sortByTextPosition(annotations: Annotation[], sourceText: string): Annotation[] {
  return annotations.sort((a, b) => {
    const posA = sourceText.indexOf(a.anchor.exact);
    const posB = sourceText.indexOf(b.anchor.exact);
    return posA - posB;
  });
}

interface DepthResult {
  annotations: Annotation[];
}

/**
 * Depth-mode annotation pipeline: router → parallel annotators → merge.
 * Returns annotations sorted by text position.
 */
async function generateDepthAnnotations(text: string, userContext?: UserContext): Promise<DepthResult> {
  const plan = await planAnnotations(text, plannerCall);

  // Router returned no assignments (short text or non-prose)
  if (plan.assignments.length === 0) {
    return { annotations: [] };
  }

  // Collect unique worldview keys from assignments
  const uniqueKeys = new Set(plan.assignments.map((a) => a.worldview));

  // Load worldview .md files
  const worldviewContents = new Map<string, { name: string; content: string }>();
  for (const wvKey of uniqueKeys) {
    const wv = loadWorldviewContent(wvKey);
    if (wv) worldviewContents.set(wvKey, wv);
  }

  // Group assignments by worldview
  const grouped = new Map<string, RouterAssignment[]>();
  for (const assignment of plan.assignments) {
    if (!worldviewContents.has(assignment.worldview)) continue;
    const list = grouped.get(assignment.worldview) ?? [];
    list.push(assignment);
    grouped.set(assignment.worldview, list);
  }

  // Run annotators in parallel, gated by global semaphore (max 3 concurrent across all requests)
  const annotatorPromises = Array.from(grouped.entries()).map(
    async ([wvKey, assignments]) => {
      await acquireAnnotatorSlot();
      try {
        const wv = worldviewContents.get(wvKey)!;
        const annotatorAssignments: AnnotatorAssignment[] = assignments.map((a) => ({
          anchor_index: a.anchor_index,
          anchor_text: a.anchor_text,
          ai_introduced: a.ai_introduced,
        }));
        const result = await executeAnnotations(text, wv.name, wv.content, annotatorAssignments, userContext);
        return { wvKey, assignments, result };
      } finally {
        releaseAnnotatorSlot();
      }
    },
  );

  const settled = await Promise.allSettled(annotatorPromises);

  // Merge results
  const allAnnotations: Annotation[] = [];

  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") {
      console.warn("[annotate] Annotator failed:", outcome.reason);
      continue;
    }
    const { wvKey, assignments, result } = outcome.value;
    const wv = worldviewContents.get(wvKey);

    for (const annResult of result.annotations) {
      // Find the matching router assignment
      const routerAssignment = assignments.find(
        (a) => a.anchor_index === annResult.anchor_index,
      ) ?? assignments.find(
        (a) => a.anchor_text === annResult.anchor_text,
      );

      const anchorText = routerAssignment?.anchor_text ?? annResult.anchor_text ?? "";
      if (!anchorText) continue;

      const verdict = annResult.verdict;
      const validVerdicts = new Set(["TAKE", "CAUTION", "THROW"]);

      allAnnotations.push({
        id: randomUUID(),
        mode: "depth",
        type: "insight",
        label: annResult.label || undefined,
        anchor: {
          type: "TextQuoteSelector",
          exact: anchorText,
          prefix: routerAssignment?.prefix || undefined,
          suffix: routerAssignment?.suffix || undefined,
        },
        content: {
          note: annResult.provocation ?? "",
        },
        worldview: wvKey,
        worldviewName: wv?.name ?? wvKey,
        verdict: validVerdicts.has(verdict) ? verdict as Annotation["verdict"] : undefined,
        aiIntroduced: routerAssignment?.ai_introduced ?? annResult.ai_introduced ?? false,
      });
    }
  }

  const sorted = sortByTextPosition(allAnnotations, text);
  return {
    annotations: filterAndFixAnnotations(sorted, text),
  };
}

const AnnotateRequestSchema = z.object({
  url: z.string().url(),
  content_hash: z.string().min(1),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  mode: z.enum(["overview", "depth"]),
  user_context: z.object({
    mode: z.enum(["info-takeaway", "brainstorm", "argument-formation", "decision", "learning"]).optional(),
    note: z.string().max(500).optional(),
  }).optional(),
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

    const { url, content_hash, text, mode, user_context } = parsed.data;
    const key = cacheKey(content_hash, mode, user_context?.mode);
    const authToken = req.headers.authorization?.slice(7) ?? "";

    // ── Layer 1: DB cache (Supabase) ──
    const cacheIntensity = mode === "overview" ? "overview" : `depth:${user_context?.mode ?? "default"}`;
    const { data: dbCached } = await serviceClient
      .from("annotation_cache")
      .select("annotations, model_version, prompt_version")
      .eq("content_hash", content_hash)
      .eq("intensity", cacheIntensity)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (dbCached) {
      const currentModel = mode === "depth"
        ? process.env.GEMINI_ANNOTATOR_MODEL ?? "gemini-3-flash-preview"
        : process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite-preview";
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
    let aiAnnotations: Annotation[];

    if (mode === "depth") {
      const depthResult = await dedup.run(key, () => generateDepthAnnotations(text, user_context));
      aiAnnotations = depthResult.annotations;
    } else {
      aiAnnotations = await dedup.run(key, async () => {
        const rawAnnotations = await generateAnnotations(text, mode as AnnotationMode);
        return filterAndFixAnnotations(rawAnnotations, text);
      });
    }

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
          model_version: mode === "depth"
            ? process.env.GEMINI_ANNOTATOR_MODEL ?? "gemini-3-flash-preview"
            : process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite-preview",
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
  const { url, content_hash, text, mode, user_context } = data;
  const authToken = req.headers.authorization?.slice(7) ?? "";

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx proxy buffering
  res.flushHeaders();

  // Disable Nagle's algorithm — send each SSE event immediately instead of
  // batching small writes for up to 200ms.
  res.socket?.setNoDelay(true);

  try {
    // Check DB cache first
    const cacheIntensity = mode === "overview" ? "overview" : `depth:${user_context?.mode ?? "default"}`;
    const { data: dbCached } = await serviceClient
      .from("annotation_cache")
      .select("annotations, model_version, prompt_version")
      .eq("content_hash", content_hash)
      .eq("intensity", cacheIntensity)
      .gt("expires_at", new Date().toISOString())
      .single();

    const currentModel = mode === "depth"
      ? process.env.GEMINI_ANNOTATOR_MODEL ?? "gemini-3-flash-preview"
      : process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite-preview";
    const currentPromptVersion = prompts.version;

    if (
      dbCached &&
      dbCached.model_version === currentModel &&
      dbCached.prompt_version === currentPromptVersion
    ) {
      console.log(`[annotate/stream] Cache HIT for ${mode} ${content_hash.slice(0, 12)}… (${cacheIntensity}, ${dbCached.annotations?.length ?? 0} annotations)`);
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

    if (dbCached) {
      console.log(`[annotate/stream] Cache STALE for ${mode} ${content_hash.slice(0, 12)}… (model: ${dbCached.model_version} vs ${currentModel}, prompt: ${dbCached.prompt_version} vs ${currentPromptVersion})`);
    } else {
      console.log(`[annotate/stream] Cache MISS for ${mode} ${content_hash.slice(0, 12)}… (${cacheIntensity})`);
    }

    // Generate annotations
    const allAnnotations: Annotation[] = [];
    let depthAnnotatorCalls = 0;

    if (mode === "depth") {
      // Phase 1: Stream router anchors as highlights.
      // Preload worldview files as we see each worldview for the first time,
      // so they're already in memory when annotators start.
      const allAssignments: RouterAssignment[] = [];
      const worldviewContents = new Map<string, { name: string; content: string }>();
      const routerStream = planAnnotationsStream(text, plannerCallStream);

      for await (const assignment of routerStream) {
        allAssignments.push(assignment);

        // Preload worldview content on first encounter
        if (!worldviewContents.has(assignment.worldview)) {
          const wv = loadWorldviewContent(assignment.worldview);
          if (wv) worldviewContents.set(assignment.worldview, wv);
        }

        const wvMeta = getWorldviewByKey(assignment.worldview);
        res.write(`data: ${JSON.stringify({
          anchor: {
            anchor_index: assignment.anchor_index,
            anchor_text: assignment.anchor_text,
            prefix: assignment.prefix,
            suffix: assignment.suffix,
            worldview: assignment.worldview,
            worldviewName: wvMeta?.name ?? assignment.worldview,
            ai_introduced: assignment.ai_introduced,
          },
        })}\n\n`);
      }

      // Apply worldview cap (max 3)
      const MAX_WORLDVIEWS = 3;
      const countByWorldview = new Map<string, number>();
      for (const a of allAssignments) {
        countByWorldview.set(a.worldview, (countByWorldview.get(a.worldview) ?? 0) + 1);
      }
      let finalAssignments = allAssignments;
      if (countByWorldview.size > MAX_WORLDVIEWS) {
        const topKeys = new Set(
          [...countByWorldview.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_WORLDVIEWS)
            .map(([key]) => key),
        );
        finalAssignments = allAssignments.filter((a) => topKeys.has(a.worldview));
      }

      // Phase 2+3: Run annotators in parallel, streaming each annotation via SSE as it's produced
      // Worldview contents are already preloaded from Phase 1
      if (finalAssignments.length > 0) {

        const grouped = new Map<string, RouterAssignment[]>();
        for (const assignment of finalAssignments) {
          if (!worldviewContents.has(assignment.worldview)) continue;
          const list = grouped.get(assignment.worldview) ?? [];
          list.push(assignment);
          grouped.set(assignment.worldview, list);
        }

        const validVerdicts = new Set(["TAKE", "CAUTION", "THROW"]);

        // Each annotator streams its results via SSE the instant the LLM produces them.
        // Multiple annotators interleave their SSE events — no waiting for all to finish.
        const annotatorTasks = Array.from(grouped.entries()).map(
          async ([wvKey, assignments]) => {
            await acquireAnnotatorSlot();
            depthAnnotatorCalls++;
            try {
              const wv = worldviewContents.get(wvKey)!;
              const annotatorAssignments: AnnotatorAssignment[] = assignments.map((a) => ({
                anchor_index: a.anchor_index,
                anchor_text: a.anchor_text,
                ai_introduced: a.ai_introduced,
              }));

              const stream = executeAnnotationsStream(text, wv.name, wv.content, annotatorAssignments, user_context);

              for await (const annResult of stream) {
                const routerAssignment = assignments.find(
                  (a) => a.anchor_index === annResult.anchor_index,
                ) ?? assignments.find(
                  (a) => a.anchor_text === annResult.anchor_text,
                );

                const anchorText = routerAssignment?.anchor_text ?? annResult.anchor_text ?? "";
                if (!anchorText) continue;

                const ann: Annotation = {
                  id: randomUUID(),
                  mode: "depth",
                  type: "insight",
                  label: annResult.label || undefined,
                  anchor: {
                    type: "TextQuoteSelector",
                    exact: anchorText,
                    prefix: routerAssignment?.prefix || undefined,
                    suffix: routerAssignment?.suffix || undefined,
                  },
                  content: {
                    note: annResult.provocation ?? "",
                  },
                  worldview: wvKey,
                  worldviewName: wv?.name ?? wvKey,
                  verdict: validVerdicts.has(annResult.verdict) ? annResult.verdict as Annotation["verdict"] : undefined,
                  aiIntroduced: routerAssignment?.ai_introduced ?? annResult.ai_introduced ?? false,
                };

                allAnnotations.push(ann);
                res.write(`data: ${JSON.stringify({ annotation: ann })}\n\n`);
              }
            } catch (err) {
              console.warn("[annotate/stream] Annotator failed:", err);
            } finally {
              releaseAnnotatorSlot();
            }
          },
        );

        await Promise.allSettled(annotatorTasks);
      }
    } else {
      // Overview: stream incrementally from single LLM call
      const stream = generateAnnotationsStream(text, mode as AnnotationMode);
      for await (const annotation of stream) {
        const fixed = fixSingleAnnotation(annotation, text);
        if (fixed) {
          allAnnotations.push(fixed);
          res.write(`data: ${JSON.stringify({ annotation: fixed })}\n\n`);
        }
      }
    }

    // Cache the complete result
    console.log(`[annotate/stream] ${mode} complete: ${allAnnotations.length} annotations${depthAnnotatorCalls > 0 ? `, ${depthAnnotatorCalls} annotator calls` : ""} for ${content_hash.slice(0, 12)}…`);

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
    } else {
      console.log(`[annotate/stream] Cache written for ${content_hash.slice(0, 12)}… (${cacheIntensity})`);
    }

    const merged = await mergeAnnotationsAndFeedback(
      allAnnotations,
      url,
      content_hash,
      authToken,
    );
    res.write(
      `data: ${JSON.stringify({ done: true, cached: false, annotations: merged.annotations, feedback: merged.feedback, ...(depthAnnotatorCalls > 0 ? { annotator_calls: depthAnnotatorCalls } : {}) })}\n\n`,
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
