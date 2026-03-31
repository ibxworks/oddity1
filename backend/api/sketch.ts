import { MAX_TEXT_LENGTH, canUseFeature } from "@oddity/shared";
import type { UserTier } from "@oddity/shared";
import { Router } from "express";
import { z } from "zod";
import { generateSketchStream } from "../lib/gemini.js";

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
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.socket?.setNoDelay(true);

  try {
    const stream = generateSketchStream(input_text, purpose, user_reactions);

    for await (const chunk of stream) {
      res.write(`data: ${JSON.stringify({ text: chunk, done: false })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ text: "", done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error("[sketch] Error:", err);
    res.write(`data: ${JSON.stringify({ error: "Internal server error" })}\n\n`);
    res.end();
  }
});

export default router;
