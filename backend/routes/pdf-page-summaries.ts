import type { AnnotationUsage, UserTier } from "@oddity/shared";
import { MAX_TEXT_LENGTH, canUseFeature } from "@oddity/shared";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generatePdfPageSummary } from "../lib/llm.js";
import {
  resolveCacheTagForRead,
  resolveRequestLlm,
  sendLlmConfigError,
  type ResolvedLlm,
} from "../lib/llm-config.js";
import { createUserClient, serviceClient } from "../lib/supabase.js";

const router = Router();

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

const GetPdfPageSummariesSchema = z.object({
  url: z.string().url(),
  document_hash: z.string().min(1),
});

const GeneratePdfPageSummarySchema = z.object({
  url: z.string().url(),
  document_hash: z.string().min(1),
  page_no: z.string().min(1),
  page_text_hash: z.string().min(1),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  page_title: z.string().optional(),
});

router.get("/", async (req, res) => {
  const parsed = GetPdfPageSummariesSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const token = req.headers.authorization?.slice(7) ?? "";
  const userClient = createUserClient(token);

  try {
    let modelTag: string;
    try {
      modelTag = await resolveCacheTagForRead(req.user!.id);
    } catch (err) {
      if (sendLlmConfigError(res, err)) return;
      throw err;
    }

    const { data, error } = await userClient
      .from("pdf_page_summaries")
      .select(
        "id, url, document_hash, page_no, page_text_hash, summary, page_title, created_at, updated_at",
      )
      .eq("url", parsed.data.url)
      .eq("document_hash", parsed.data.document_hash)
      .eq("model_version", modelTag);

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    res.json({
      success: true,
      summaries: data ?? [],
    });
  } catch (err) {
    console.error("[pdf-page-summaries GET] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/generate", async (req, res) => {
  const parsed = GeneratePdfPageSummarySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const userTier = (req.user?.tier ?? "free") as UserTier;
  if (!canUseFeature(userTier, "pdfAnnotation")) {
    res.status(403).json({
      error: "PDF page summaries require a Standard plan",
      upgrade: true,
    });
    return;
  }

  const token = req.headers.authorization?.slice(7) ?? "";
  const userClient = createUserClient(token);
  const {
    url,
    document_hash,
    page_no,
    page_text_hash,
    text,
    page_title,
  } = parsed.data;

  try {
    let llm: ResolvedLlm;
    try {
      llm = await resolveRequestLlm(req.user!.id);
    } catch (err) {
      if (sendLlmConfigError(res, err)) return;
      throw err;
    }

    // "" is the tier default and matches pre-existing rows; overrides match
    // only their own configuration's variant.
    const modelTag = llm.cacheTag ?? "";
    const { data: existing, error: existingError } = await userClient
      .from("pdf_page_summaries")
      .select(
        "id, url, document_hash, page_no, page_text_hash, summary, page_title, created_at, updated_at",
      )
      .eq("url", url)
      .eq("document_hash", document_hash)
      .eq("page_no", page_no)
      .eq("model_version", modelTag)
      .maybeSingle();

    if (existingError) {
      res.status(400).json({ error: existingError.message });
      return;
    }

    if (existing) {
      res.json({
        success: true,
        cached: true,
        summary: existing,
      });
      return;
    }

    let usage: AnnotationUsage | undefined;
    const limits = getMonthlyPlanLimits();
    const limit = userTier !== "free" ? limits.standard : limits.free;
    const usageKey = `${url}#pdf-page-summary:${document_hash}:${page_no}`;
    const upgradeMultiplier =
      userTier === "free" ? getUpgradeMultiplier() : undefined;

    if (req.user?.id && !llm.bypassLimits) {
      const { data: usageResult, error: usageErr } = await serviceClient.rpc(
        "check_and_record_usage",
        { p_user_id: req.user.id, p_url: usageKey, p_limit: limit },
      );

      if (usageErr) {
        console.error("[pdf-page-summaries] Usage check failed:", usageErr.message);
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

    const summaryText = await generatePdfPageSummary(text, {
      override: llm.override,
      logContext: {
        route: "pdf-page-summary",
        requestId: randomUUID(),
        contentHash: page_text_hash,
      },
    });

    if (!summaryText) {
      res.status(502).json({ error: "Failed to generate a page summary" });
      return;
    }

    const { data: inserted, error: insertError } = await userClient
      .from("pdf_page_summaries")
      .insert({
        id: randomUUID(),
        user_id: req.user!.id,
        url,
        document_hash,
        page_no,
        page_text_hash,
        summary: summaryText,
        page_title: page_title ?? null,
        model_version: modelTag,
      })
      .select(
        "id, url, document_hash, page_no, page_text_hash, summary, page_title, created_at, updated_at",
      )
      .single();

    if (insertError) {
      res.status(400).json({ error: insertError.message });
      return;
    }

    res.status(201).json({
      success: true,
      cached: false,
      summary: inserted,
      usage,
      upgrade: userTier === "free" ? true : undefined,
      upgrade_multiplier: upgradeMultiplier,
    });
  } catch (err) {
    console.error("[pdf-page-summaries POST] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
