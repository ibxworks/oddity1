import { Router } from "express";
import { z } from "zod";
import { generateAllMcqQuestions } from "../lib/gemini.js";

const router = Router();

const McqRequestSchema = z.object({
  prompt: z.string().min(1).max(2000),
  docContext: z.string().max(8000).default(""),
});

router.post("/", async (req, res) => {
  const parsed = McqRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { prompt, docContext } = parsed.data;

  try {
    const questions = await generateAllMcqQuestions(prompt, docContext);
    res.json(questions);
  } catch (err) {
    console.error("[gdocs-mcq] Error generating questions:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
