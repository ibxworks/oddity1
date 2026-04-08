import { Router } from "express";
import { z } from "zod";
import { generateGDocsChatStream, type GDocsChatMode } from "../lib/gemini.js";
import { createRequestAbortSignal } from "../lib/request-abort.js";

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});

const GDocsChatRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(100),
  mode: z.enum(["chat", "tree", "essay", "edit", "fast", "outline", "skeleton"]).default("chat"),
});

const router = Router();

router.post("/", async (req, res) => {
  const parsed = GDocsChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { messages, mode } = parsed.data;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const { signal, cleanup } = createRequestAbortSignal(req, res);

  try {
    await generateGDocsChatStream(messages, mode as GDocsChatMode, {
      signal,
      onChunk: (chunk) => {
        if (signal.aborted || res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ text: chunk, done: false })}\n\n`);
      },
    });

    if (!signal.aborted && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ text: "", done: true })}\n\n`);
      res.end();
    }
  } catch (err) {
    if (signal.aborted) {
      if (!res.writableEnded) res.end();
      return;
    }
    console.error("[gdocs-chat] Error:", err);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: "Internal server error" })}\n\n`);
      res.end();
    }
  } finally {
    cleanup();
  }
});

export default router;
