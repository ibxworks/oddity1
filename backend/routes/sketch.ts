import { MAX_TEXT_LENGTH, canUseFeature } from "@oddity/shared";
import type { UserTier } from "@oddity/shared";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generateSketchStream } from "../lib/gemini.js";
import { createRequestAbortSignal } from "../lib/request-abort.js";

const SketchRequestSchema = z.object({
  input_text: z.string().min(1).max(MAX_TEXT_LENGTH),
  purpose: z.string().min(1),
  user_reactions: z.string().min(1),
});

const router = Router();

router.post("/", async (req, res) => {
  // Feature gate: Sketch Pad requires Standard plan
  const userTier = (req.user?.tier ?? "free") as UserTier;
  if (!canUseFeature(userTier, "sketchPad")) {
    res.status(403).json({
      error: "Sketch Pad requires a Standard plan",
      upgrade: true,
    });
    return;
  }

  const parsed = SketchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { input_text, purpose, user_reactions } = parsed.data;

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const requestId = randomUUID();
  const { signal, cleanup } = createRequestAbortSignal(req, res);

  try {
    await generateSketchStream(input_text, purpose, user_reactions, {
      signal,
      logContext: {
        route: "sketch",
        requestId,
      },
      onChunk: (chunk) => {
        if (signal.aborted || res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ text: chunk, done: false })}\n\n`);
      },
    });

    if (signal.aborted || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ text: "", done: true })}\n\n`);
    res.end();
  } catch (err) {
    if (signal.aborted) {
      console.warn(
        "[sketch] Request aborted",
        JSON.stringify({ request_id: requestId }),
      );
      if (!res.writableEnded) res.end();
      return;
    }
    console.error("[sketch] Error:", err);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: "Internal server error" })}\n\n`);
      res.end();
    }
  } finally {
    cleanup();
  }
});

export default router;
