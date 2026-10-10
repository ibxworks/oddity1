import {
  LLM_PROVIDER_META,
  type LlmProvider,
  type LlmReasoningEffort,
  type UserPreferences,
} from "@oddity/shared";
import type { Response } from "express";
import { createHash } from "node:crypto";
import { decryptByokKey, isByokCryptoConfigured } from "./byok-crypto.js";
import { assertSafeLlmEndpoint } from "./ssrf.js";
import { serviceClient } from "./supabase.js";

// ─── Per-request LLM resolution ─────────────────────────────────────────────
// Decides which credentials, model, and transport serve one request:
// tier default (null provider), Oddity Free (server key + free model), or a
// user's own provider key (BYOK). BYOK and Oddity Free bypass monthly caps.

export type LlmTransport = "openai-chat" | "anthropic-messages";

export type LlmCallOverride = {
  provider: LlmProvider;
  transport: LlmTransport;
  baseUrl: string;
  apiKeys: string[];
  model: string;
  effort: LlmReasoningEffort;
};

export type ResolvedLlm = {
  override: LlmCallOverride | null;
  bypassLimits: boolean;
  /** Cache model_version. Null means the tier default (activeModelName). */
  cacheTag: string | null;
};

export class LlmConfigError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LlmConfigError";
    this.status = status;
  }
}

export const ODDITY_FREE_MODEL =
  process.env.ODDITY_FREE_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free";

const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

const PROVIDER_BASE_URLS: Record<LlmProvider, string> = {
  "oddity-free": OPENROUTER_BASE_URL,
  openrouter: OPENROUTER_BASE_URL,
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  muse: "https://api.meta.ai/v1",
};

function serverOpenRouterKeys(): string[] {
  return [
    process.env.OPENROUTER_API_KEY,
    process.env.OPENROUTER_API_KEY_BACKUP1,
    process.env.OPENROUTER_API_KEY_BACKUP2,
  ].filter((key): key is string => !!key);
}

export function hasServerOpenRouterKeys(): boolean {
  return serverOpenRouterKeys().length > 0;
}

export function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const message = String((error as { message?: unknown })?.message ?? "");
  return (
    code === "42P01" ||
    // PostgREST reports unknown tables via the schema cache (PGRST205).
    (message.includes("user_llm_keys") &&
      (message.includes("does not exist") ||
        message.toLowerCase().includes("could not find the table")))
  );
}

export function isValidLlmProvider(value: unknown): value is LlmProvider {
  return (
    typeof value === "string" &&
    (Object.keys(LLM_PROVIDER_META) as LlmProvider[]).includes(
      value as LlmProvider,
    )
  );
}

/**
 * Cache tag for read-only list routes (no key material needed, so no crypto
 * and no failure when the user selected a provider but saved nothing yet).
 * Returns "" for the tier default, which also matches pre-existing rows.
 */
export async function resolveCacheTagForRead(userId: string): Promise<string> {
  const { data: profile, error } = await serviceClient
    .from("profiles")
    .select("preferences")
    .eq("id", userId)
    .single();
  if (error && error.code !== "PGRST116") {
    throw new LlmConfigError(
      503,
      "Could not load your provider settings. Try again.",
    );
  }
  const provider = (
    (profile?.preferences as UserPreferences | null | undefined) ?? null
  )?.llm_provider;
  if (!isValidLlmProvider(provider)) return "";
  if (provider === "oddity-free") {
    return buildLlmCacheTag({
      provider,
      model: ODDITY_FREE_MODEL,
      effort: "default",
      baseUrl: OPENROUTER_BASE_URL,
    });
  }
  const { data: row, error: rowError } = await serviceClient
    .from("user_llm_keys")
    .select("model, base_url, reasoning_effort")
    .eq("user_id", userId)
    .eq("provider", provider)
    .single();
  // Pre-migration (or nothing saved): no variants can exist, so list tier rows.
  if (rowError && isMissingTableError(rowError)) return "";
  if (rowError && rowError.code !== "PGRST116") {
    throw new LlmConfigError(503, "Could not load your saved key. Try again.");
  }
  if (rowError || !row) return "";
  const record = row as {
    model?: string | null;
    base_url?: string | null;
    reasoning_effort?: string | null;
  };
  const baseUrl = record.base_url || PROVIDER_BASE_URLS[provider];
  return buildLlmCacheTag({
    provider,
    model: record.model || LLM_PROVIDER_META[provider].modelPlaceholder,
    effort: (record.reasoning_effort || "default") as LlmReasoningEffort,
    baseUrl,
  });
}

/**
 * Cache identity for an override configuration. Covers every stored setting
 * that affects generation so changing effort or endpoint cannot serve a
 * result generated under different settings.
 */
export function buildLlmCacheTag(options: {
  provider: LlmProvider;
  model: string;
  effort: LlmReasoningEffort;
  baseUrl: string;
}): string {
  const baseHash = createHash("sha256")
    .update(options.baseUrl)
    .digest("hex")
    .slice(0, 12);
  return `${options.provider}:${options.model}:${options.effort}:${baseHash}`;
}

type LlmKeyRow = {
  key_encrypted: string;
  model: string;
  base_url: string;
  reasoning_effort: string;
};

/** Resolve from a user id, loading preferences. Used by LLM routes. */
export async function resolveRequestLlm(userId: string): Promise<ResolvedLlm> {
  const { data: profile, error } = await serviceClient
    .from("profiles")
    .select("preferences")
    .eq("id", userId)
    .single();
  // A missing profile means a new user with no preferences; anything else is
  // an outage and must not silently fall back to the tier default, which
  // would route a BYOK user's content through the managed provider.
  if (error && error.code !== "PGRST116") {
    throw new LlmConfigError(
      503,
      "Could not load your provider settings. Try again.",
    );
  }
  return resolveLlmForRequest({
    userId,
    preferences:
      (profile?.preferences as UserPreferences | null | undefined) ?? null,
  });
}

/** Send a config error response. Returns true when the error was handled. */
export function sendLlmConfigError(res: Response, err: unknown): boolean {
  if (err instanceof LlmConfigError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

export async function resolveLlmForRequest(options: {
  userId: string;
  preferences: UserPreferences | null;
}): Promise<ResolvedLlm> {
  const provider = options.preferences?.llm_provider ?? null;

  // Tier default: Oddity-managed key and model. Limits apply.
  if (!provider) {
    return { override: null, bypassLimits: false, cacheTag: null };
  }

  if (!isValidLlmProvider(provider)) {
    throw new LlmConfigError(400, `Unknown LLM provider: ${provider}`);
  }

  // Oddity Free: server key + free model, independent of the capped Free tier.
  if (provider === "oddity-free") {
    const apiKeys = serverOpenRouterKeys();
    if (apiKeys.length === 0) {
      throw new LlmConfigError(
        503,
        "Oddity Free is unavailable right now. Try the default provider instead.",
      );
    }
    return {
      override: {
        provider,
        transport: "openai-chat",
        baseUrl: OPENROUTER_BASE_URL,
        apiKeys,
        model: ODDITY_FREE_MODEL,
        effort: "default",
      },
      bypassLimits: true,
      cacheTag: buildLlmCacheTag({
        provider,
        model: ODDITY_FREE_MODEL,
        effort: "default",
        baseUrl: OPENROUTER_BASE_URL,
      }),
    };
  }

  // BYOK: the user's own key, model, and effort.
  const { data: row, error } = await serviceClient
    .from("user_llm_keys")
    .select("key_encrypted, model, base_url, reasoning_effort")
    .eq("user_id", options.userId)
    .eq("provider", provider)
    .single();

  if (error && isMissingTableError(error)) {
    throw new LlmConfigError(
      503,
      "BYOK is unavailable right now. Try the default provider instead.",
    );
  }

  // Only "no rows" means a missing key. Other database failures are outages:
  // mapping them to 400 would prompt users to re-save valid keys.
  if (error && error.code !== "PGRST116") {
    throw new LlmConfigError(
      503,
      "Could not load your saved key. Try again.",
    );
  }

  if (error || !row) {
    const label = LLM_PROVIDER_META[provider].label;
    throw new LlmConfigError(
      400,
      `${label} is selected but no API key is saved. Add one in AI Provider settings.`,
    );
  }

  if (!isByokCryptoConfigured()) {
    throw new LlmConfigError(
      503,
      "BYOK is unavailable right now. Try the default provider instead.",
    );
  }

  const record = row as LlmKeyRow;
  let apiKey: string;
  try {
    apiKey = decryptByokKey(record.key_encrypted);
  } catch {
    throw new LlmConfigError(
      503,
      "Could not read your saved key. Re-save it in AI Provider settings.",
    );
  }

  const model = record.model || LLM_PROVIDER_META[provider].modelPlaceholder;
  const effort = (record.reasoning_effort || "default") as LlmReasoningEffort;
  // Re-validate custom endpoints on every resolve: a saved URL that once
  // passed can later resolve somewhere unsafe (DNS rebinding), and rows
  // written before validation existed must not be trusted.
  const baseUrl = record.base_url || PROVIDER_BASE_URLS[provider];
  if (record.base_url) {
    try {
      await assertSafeLlmEndpoint(record.base_url);
    } catch {
      throw new LlmConfigError(
        400,
        "Your saved base URL is not allowed. Update it in AI Provider settings.",
      );
    }
  }
  return {
    override: {
      provider,
      transport: provider === "anthropic" ? "anthropic-messages" : "openai-chat",
      baseUrl,
      apiKeys: [apiKey],
      model,
      effort,
    },
    bypassLimits: true,
    cacheTag: buildLlmCacheTag({ provider, model, effort, baseUrl }),
  };
}
