import type {
  Annotation,
  AnnotationMode,
  AnnotationSummary,
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
  executeAnnotations,
} from "../lib/gemini.js";
import type { ExecutorAssignment } from "../lib/gemini.js";
import { planAnnotations } from "../lib/worldview-router.js";
import type { RouterAssignment } from "../lib/worldview-router.js";
import { getWorldviewByKey } from "../lib/worldview-registry.js";
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
  const intensityPart = mode === "overview" ? "writing" : (personality ?? "none");
  return `${contentHash}:${mode}:${intensityPart}`;
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
  summary?: AnnotationSummary;
}

/**
 * Depth-mode annotation pipeline: router → parallel annotators → merge.
 * Returns annotations sorted by text position, plus an aggregate summary.
 */
async function generateDepthAnnotations(text: string): Promise<DepthResult> {
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

  // Run annotators in parallel (up to 9 worldviews, typically 1-3)
  const executorPromises = Array.from(grouped.entries()).map(
    async ([wvKey, assignments]) => {
      const wv = worldviewContents.get(wvKey)!;
      const execAssignments: ExecutorAssignment[] = assignments.map((a) => ({
        anchor_index: a.anchor_index,
        anchor_text: a.anchor_text,
        match_reason: a.match_reason,
        ai_introduced: a.ai_introduced,
      }));
      const result = await executeAnnotations(text, wv.name, wv.content, execAssignments);
      return { wvKey, assignments, result };
    },
  );

  const settled = await Promise.allSettled(executorPromises);

  // Merge results
  const allAnnotations: Annotation[] = [];
  let mergedSummary: AnnotationSummary = {
    takes: { count: 0, pattern: "" },
    cautions: { count: 0, pattern: "" },
    throws: { count: 0, pattern: "" },
    overall: "",
  };
  const overallParts: string[] = [];

  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") {
      console.warn("[annotate] Annotator failed:", outcome.reason);
      continue;
    }
    const { wvKey, assignments, result } = outcome.value;
    const wv = worldviewContents.get(wvKey);

    // Merge summary counts
    if (result.summary) {
      mergedSummary.takes.count += result.summary.takes?.count ?? 0;
      mergedSummary.cautions.count += result.summary.cautions?.count ?? 0;
      mergedSummary.throws.count += result.summary.throws?.count ?? 0;
      if (result.summary.takes?.pattern) mergedSummary.takes.pattern = result.summary.takes.pattern;
      if (result.summary.cautions?.pattern) mergedSummary.cautions.pattern = result.summary.cautions.pattern;
      if (result.summary.throws?.pattern) mergedSummary.throws.pattern = result.summary.throws.pattern;
      if (result.summary.overall) overallParts.push(result.summary.overall);
    }

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
        matchReason: routerAssignment?.match_reason,
        aiIntroduced: routerAssignment?.ai_introduced ?? annResult.ai_introduced ?? false,
      });
    }
  }

  mergedSummary.overall = overallParts.join(" ");

  const sorted = sortByTextPosition(allAnnotations, text);
  return {
    annotations: filterAndFixAnnotations(sorted, text),
    summary: mergedSummary,
  };
}

const AnnotateRequestSchema = z.object({
  url: z.string().url(),
  content_hash: z.string().min(1),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  mode: z.enum(["overview", "depth"]),
  personality: z.enum(["writing", "brainstorming", "reading"]).optional(),
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

    // ── Feature gate: Reading personality requires Standard ──
    if (
      parsed.data.personality === "reading" &&
      !canUseFeature(userTier, "readingPersonality")
    ) {
      res.status(403).json({
        error: "Reading personality requires a Standard plan",
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
    const cacheIntensity = mode === "overview" ? "overview:writing" : `${mode}:${personality ?? "writing"}`;
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
    let aiAnnotations: Annotation[];
    let summary: AnnotationSummary | undefined;

    if (mode === "depth") {
      const depthResult = await dedup.run(key, () => generateDepthAnnotations(text));
      aiAnnotations = depthResult.annotations;
      summary = depthResult.summary;
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
    res.json({ success: true, cached: false, source: "llm", ...merged, ...(summary ? { summary } : {}) });
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
    const cacheIntensity = mode === "overview" ? "overview:writing" : `${mode}:${personality ?? "writing"}`;
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

    // Generate annotations
    const allAnnotations: Annotation[] = [];
    let streamSummary: AnnotationSummary | undefined;

    if (mode === "depth") {
      // Router/annotator pipeline — wait for all, then stream in order
      const depthResult = await generateDepthAnnotations(text);
      streamSummary = depthResult.summary;
      for (const ann of depthResult.annotations) {
        allAnnotations.push(ann);
        res.write(`data: ${JSON.stringify({ annotation: ann })}\n\n`);
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
      `data: ${JSON.stringify({ done: true, cached: false, annotations: merged.annotations, feedback: merged.feedback, ...(streamSummary ? { summary: streamSummary } : {}) })}\n\n`,
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
