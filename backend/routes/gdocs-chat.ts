import { Router } from "express";
import { z } from "zod";
import { canUseFeature } from "@oddity/shared";
import type { UserTier } from "@oddity/shared";
import { generateGDocsChatStream, type GDocsChatMode } from "../lib/llm.js";
import {
  resolveRequestLlm,
  sendLlmConfigError,
  type ResolvedLlm,
} from "../lib/llm-config.js";
import { createRequestAbortSignal } from "../lib/request-abort.js";

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});

const GDocsChatRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(100),
  mode: z.enum(["chat", "tree", "essay", "edit", "fast", "outline"]).default("chat"),
});

const router = Router();

router.post("/", async (req, res) => {
  const userTier = (req.user?.tier ?? "free") as UserTier;
  if (!canUseFeature(userTier, "googleDocs")) {
    res.status(403).json({ error: "Google Docs features require a Standard plan", upgrade: true });
    return;
  }

  const parsed = GDocsChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { messages, mode } = parsed.data;

  let llm: ResolvedLlm;
  try {
    llm = await resolveRequestLlm(req.user!.id);
  } catch (err) {
    if (sendLlmConfigError(res, err)) return;
    // Express 4 does not forward async rejections: answer here, never throw.
    console.error("[gdocs-chat] Error resolving LLM:", err);
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const { signal, cleanup } = createRequestAbortSignal(req, res);

  try {
    await generateGDocsChatStream(messages, mode as GDocsChatMode, {
      signal,
      override: llm.override,
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
