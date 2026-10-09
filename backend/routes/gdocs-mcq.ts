import { Router } from "express";
import { z } from "zod";
import { canUseFeature } from "@oddity/shared";
import type { UserTier } from "@oddity/shared";
import { generateAllMcqQuestions } from "../lib/llm.js";
import {
  resolveRequestLlm,
  sendLlmConfigError,
  type ResolvedLlm,
} from "../lib/llm-config.js";

const router = Router();

const McqRequestSchema = z.object({
  prompt: z.string().min(1).max(2000),
  docContext: z.string().max(8000).default(""),
});

router.post("/", async (req, res) => {
  const userTier = (req.user?.tier ?? "free") as UserTier;
  if (!canUseFeature(userTier, "googleDocs")) {
    res.status(403).json({ error: "Google Docs features require a Standard plan", upgrade: true });
    return;
  }

  const parsed = McqRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { prompt, docContext } = parsed.data;

  let llm: ResolvedLlm;
  try {
    llm = await resolveRequestLlm(req.user!.id);
  } catch (err) {
    if (sendLlmConfigError(res, err)) return;
    throw err;
  }

  try {
    const questions = await generateAllMcqQuestions(prompt, docContext, {
      override: llm.override,
    });
    res.json(questions);
  } catch (err) {
    console.error("[gdocs-mcq] Error generating questions:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
