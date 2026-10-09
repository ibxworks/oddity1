import { Router } from "express";
import { z } from "zod";
import {
  LLM_PROVIDER_META,
  type LlmKeyStatus,
  type LlmProvider,
  type LlmReasoningEffort,
  type LlmStatusResponse,
} from "@oddity/shared";
import {
  encryptByokKey,
  isByokCryptoConfigured,
  keyHint,
} from "../../lib/byok-crypto.js";
import {
  ODDITY_FREE_MODEL,
  hasServerOpenRouterKeys,
  isMissingTableError,
  isValidLlmProvider,
} from "../../lib/llm-config.js";
import { serviceClient } from "../../lib/supabase.js";

const router = Router();

const KEYED_PROVIDERS = (
  Object.keys(LLM_PROVIDER_META) as LlmProvider[]
).filter((provider) => LLM_PROVIDER_META[provider].needsKey);

const SaveKeySchema = z.object({
  api_key: z.string().trim().min(1).max(2000).optional(),
  model: z.string().trim().max(200).optional(),
  base_url: z.string().trim().max(500).optional(),
  reasoning_effort: z
    .enum(["default", "none", "low", "medium", "high"])
    .optional(),
});

function validateBaseUrl(value: string): string {
  if (value === "") return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Base URL must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Base URL must use https");
  }
  return value;
}

type KeyRow = {
  provider: string;
  key_hint: string;
  model: string;
  base_url: string;
  reasoning_effort: string;
  updated_at: string;
};

function rowToStatus(row: KeyRow): LlmKeyStatus {
  return {
    provider: row.provider as LlmProvider,
    configured: true,
    key_hint: row.key_hint || null,
    model: row.model || null,
    base_url: row.base_url || null,
    reasoning_effort: (row.reasoning_effort || "default") as LlmReasoningEffort,
    updated_at: row.updated_at,
  };
}

function emptyStatus(provider: LlmProvider): LlmKeyStatus {
  return {
    provider,
    configured: false,
    key_hint: null,
    model: null,
    base_url: null,
    reasoning_effort: null,
    updated_at: null,
  };
}

// GET /api/user/llm-keys — provider statuses (never includes secrets)
router.get("/", async (req, res) => {
  try {
    const userId = req.user!.id;
    const [{ data: profile }, { data: rows, error }] = await Promise.all([
      serviceClient
        .from("profiles")
        .select("preferences")
        .eq("id", userId)
        .single(),
      serviceClient
        .from("user_llm_keys")
        .select("provider, key_hint, model, base_url, reasoning_effort, updated_at")
        .eq("user_id", userId),
    ]);

    if (error && isMissingTableError(error)) {
      res.status(503).json({ error: "BYOK is unavailable right now." });
      return;
    }
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const byProvider = new Map(
      ((rows ?? []) as KeyRow[]).map((row) => [row.provider, row]),
    );
    const keys: LlmKeyStatus[] = (
      Object.keys(LLM_PROVIDER_META) as LlmProvider[]
    ).map((provider) => {
      if (provider === "oddity-free") {
        return {
          provider,
          configured: hasServerOpenRouterKeys(),
          key_hint: null,
          model: ODDITY_FREE_MODEL,
          base_url: null,
          reasoning_effort: "default" as LlmReasoningEffort,
          updated_at: null,
        };
      }
      const row = byProvider.get(provider);
      return row ? rowToStatus(row) : emptyStatus(provider);
    });

    const preferences = (profile?.preferences ?? {}) as {
      llm_provider?: LlmProvider | null;
    };
    const response: LlmStatusResponse = {
      active_provider: preferences.llm_provider ?? null,
      keys,
    };
    res.json(response);
  } catch (err) {
    console.error("[llm-keys GET] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/user/llm-keys/:provider — save key and/or settings (merge)
router.put("/:provider", async (req, res) => {
  try {
    const provider = req.params.provider as LlmProvider;
    if (!KEYED_PROVIDERS.includes(provider)) {
      res.status(400).json({ error: "Unknown provider or provider needs no key" });
      return;
    }

    const parsed = SaveKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    let baseUrl: string | undefined;
    if (parsed.data.base_url !== undefined) {
      try {
        baseUrl = validateBaseUrl(parsed.data.base_url);
      } catch (err) {
        res
          .status(400)
          .json({ error: err instanceof Error ? err.message : "Invalid base URL" });
        return;
      }
    }

    const { data: existing, error: fetchError } = await serviceClient
      .from("user_llm_keys")
      .select("key_encrypted, key_hint, model, base_url, reasoning_effort")
      .eq("user_id", req.user!.id)
      .eq("provider", provider)
      .single();

    if (fetchError && isMissingTableError(fetchError)) {
      res.status(503).json({ error: "BYOK is unavailable right now." });
      return;
    }
    if (fetchError && fetchError.code !== "PGRST116") {
      res.status(500).json({ error: fetchError.message });
      return;
    }

    let keyEncrypted = existing?.key_encrypted as string | undefined;
    let hint = existing?.key_hint as string | undefined;
    if (parsed.data.api_key !== undefined) {
      if (!isByokCryptoConfigured()) {
        res.status(503).json({ error: "BYOK is unavailable right now." });
        return;
      }
      keyEncrypted = encryptByokKey(parsed.data.api_key);
      hint = keyHint(parsed.data.api_key);
    }
    if (!keyEncrypted) {
      res.status(400).json({ error: "An API key is required" });
      return;
    }

    const { data: saved, error: saveError } = await serviceClient
      .from("user_llm_keys")
      .upsert(
        {
          user_id: req.user!.id,
          provider,
          key_encrypted: keyEncrypted,
          key_hint: hint ?? "",
          model: parsed.data.model ?? existing?.model ?? "",
          base_url: baseUrl ?? existing?.base_url ?? "",
          reasoning_effort:
            parsed.data.reasoning_effort ??
            existing?.reasoning_effort ??
            "default",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" },
      )
      .select("provider, key_hint, model, base_url, reasoning_effort, updated_at")
      .single();

    if (saveError) {
      res.status(500).json({ error: saveError.message });
      return;
    }

    res.json(rowToStatus(saved as KeyRow));
  } catch (err) {
    console.error("[llm-keys PUT] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/user/llm-keys/:provider — remove a saved key
router.delete("/:provider", async (req, res) => {
  try {
    const provider = req.params.provider as LlmProvider;
    if (!isValidLlmProvider(provider) || provider === "oddity-free") {
      res.status(400).json({ error: "Unknown provider or provider needs no key" });
      return;
    }

    const { error } = await serviceClient
      .from("user_llm_keys")
      .delete()
      .eq("user_id", req.user!.id)
      .eq("provider", provider);

    if (error && isMissingTableError(error)) {
      res.status(503).json({ error: "BYOK is unavailable right now." });
      return;
    }
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    // If the deleted key was active, fall back to the tier default.
    const { data: profile } = await serviceClient
      .from("profiles")
      .select("preferences")
      .eq("id", req.user!.id)
      .single();
    const preferences = (profile?.preferences ?? {}) as Record<string, unknown>;
    if (preferences.llm_provider === provider) {
      await serviceClient
        .from("profiles")
        .update({ preferences: { ...preferences, llm_provider: null } })
        .eq("id", req.user!.id);
    }

    res.json({ deleted: true });
  } catch (err) {
    console.error("[llm-keys DELETE] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
