import { Router } from "express";
import { z } from "zod";
import { generateMcqQuestion } from "../lib/gemini.js";

const router = Router();

const QASchema = z.object({
  question: z.string(),
  answer: z.string(),
});

const McqRequestSchema = z.object({
  prompt: z.string().min(1).max(2000),
  docContext: z.string().max(8000).default(""),
  previousQA: z.array(QASchema).max(10),
  questionNumber: z.number().int().min(1).max(5),
});

router.post("/", async (req, res) => {
  const parsed = McqRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { prompt, docContext, previousQA, questionNumber } = parsed.data;

  try {
    const result = await generateMcqQuestion(prompt, docContext, previousQA, questionNumber);
    res.json(result);
  } catch (err) {
    console.error("[gdocs-mcq] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
