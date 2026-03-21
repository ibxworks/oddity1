import { Router } from "express";
import { z } from "zod";
import { generateProvocationStream } from "../lib/gemini.js";

const ProvokeRequestSchema = z.object({
  draft_text: z.string().min(1).max(8000),
  page_context: z.string().max(8000).default(""),
  page_url: z.string().default(""),
  already_shown: z.array(z.string()).default([]),
});

const router = Router();

router.post("/", async (req, res) => {
  const parsed = ProvokeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { draft_text, page_context, page_url, already_shown } = parsed.data;

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const stream = generateProvocationStream(draft_text, page_context, page_url, already_shown);

    for await (const chunk of stream) {
      res.write(`data: ${JSON.stringify({ text: chunk, done: false })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ text: "", done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error("[provoke] Error:", err);
    res.write(`data: ${JSON.stringify({ error: "Internal server error" })}\n\n`);
    res.end();
  }
});

export default router;
