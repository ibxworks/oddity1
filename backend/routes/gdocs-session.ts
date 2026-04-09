import { Router } from "express";
import { z } from "zod";
import { canUseFeature } from "@oddity/shared";
import type { UserTier } from "@oddity/shared";
import { createUserClient } from "../lib/supabase.js";

const router = Router();

// GET /api/gdocs-session?docId=xxx
router.get("/", async (req, res) => {
  const userTier = (req.user?.tier ?? "free") as UserTier;
  if (!canUseFeature(userTier, "googleDocs")) {
    res.status(403).json({ error: "Google Docs features require a Standard plan", upgrade: true });
    return;
  }

  try {
    const { docId } = req.query;
    if (!docId || typeof docId !== "string") {
      res.status(400).json({ error: "docId query param required" });
      return;
    }

    const token = req.headers.authorization?.slice(7) ?? "";
    const userClient = createUserClient(token);

    const { data, error } = await userClient
      .from("gdocs_sessions")
      .select("chat_history, essay_versions, edit_suggestions, created_at, updated_at")
      .eq("doc_id", docId)
      .maybeSingle();

    if (error) {
      console.error("[gdocs-session GET] Supabase error:", error);
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    if (!data) {
      res.json({ session: null });
      return;
    }

    res.json({
      session: {
        chatHistory: data.chat_history ?? [],
        essayVersions: data.essay_versions ?? [],
        editSuggestions: data.edit_suggestions ?? [],
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      },
    });
  } catch (err) {
    console.error("[gdocs-session GET] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const EditOpSchema = z.object({
  find: z.string(),
  replace: z.string(),
});

const SaveSessionSchema = z.object({
  docId: z.string().min(1),
  chatHistory: z.array(MessageSchema),
  essayVersions: z.array(z.string()),
  editSuggestions: z.array(z.array(EditOpSchema)),
});

// POST /api/gdocs-session
router.post("/", async (req, res) => {
  const postUserTier = (req.user?.tier ?? "free") as UserTier;
  if (!canUseFeature(postUserTier, "googleDocs")) {
    res.status(403).json({ error: "Google Docs features require a Standard plan", upgrade: true });
    return;
  }

  try {
    const parsed = SaveSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    const { docId, chatHistory, essayVersions, editSuggestions } = parsed.data;
    const token = req.headers.authorization?.slice(7) ?? "";
    const userClient = createUserClient(token);

    const { error } = await userClient
      .from("gdocs_sessions")
      .upsert(
        {
          user_id: req.user!.id,
          doc_id: docId,
          chat_history: chatHistory,
          essay_versions: essayVersions,
          edit_suggestions: editSuggestions,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,doc_id" },
      );

    if (error) {
      console.error("[gdocs-session POST] Supabase error:", error);
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[gdocs-session POST] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
