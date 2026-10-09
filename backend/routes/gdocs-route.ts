import { Router } from "express";
import { z } from "zod";
import { canUseFeature } from "@oddity/shared";
import type { UserTier } from "@oddity/shared";
import { generateGDocsRoute, type GDocsRouteResult } from "../lib/openrouter.js";

const router = Router();

const GDocsRouteRequestSchema = z.object({
  prompt: z.string().min(1).max(2000),
  docContext: z.string().max(8000).default(""),
  essayContent: z.string().max(8000).default(""),
});

router.post("/", async (req, res) => {
  const userTier = (req.user?.tier ?? "free") as UserTier;
  if (!canUseFeature(userTier, "googleDocs")) {
    res.status(403).json({ error: "Google Docs features require a Standard plan", upgrade: true });
    return;
  }

  const parsed = GDocsRouteRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { prompt, docContext, essayContent } = parsed.data;

  try {
    const result: GDocsRouteResult = await generateGDocsRoute(prompt, docContext, essayContent);
    res.json(result);
  } catch (err) {
    console.error("[gdocs-route] Error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
