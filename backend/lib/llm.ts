import type {
  Annotation,
  AnnotationMode,
  DepthPersonality,
  LlmProvider,
  LlmReasoningEffort,
} from "@oddity/shared";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import promptsConfig from "../config/prompts.json" with { type: "json" };
import type { LlmCallOverride, LlmTransport } from "./llm-config.js";
import { validatePdfPageSummary } from "./pdf-page-summary-validator.js";
import { getPersona } from "./persona-registry.js";
import { validateAnnotations } from "./schema-validator.js";

const apiKeys = [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_BACKUP1,
  process.env.OPENROUTER_API_KEY_BACKUP2,
].filter((key): key is string => !!key);

type KeyEntry = {
  apiKey: string;
  keyIndex: number;
};

const apiKeyEntries: KeyEntry[] = apiKeys.map((key, index) => ({
  apiKey: key,
  keyIndex: index + 1,
}));

const modelName = process.env.OPENROUTER_MODEL ?? "meta/muse-spark-1.3-contributor";
export const activeModelName = modelName;

const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
// Reasoning effort for thinking models (OpenAI-style: max/xhigh/high/medium/
// low/minimal/none). Empty string disables the reasoning parameter.
const OPENROUTER_REASONING_EFFORT =
  process.env.OPENROUTER_REASONING_EFFORT ?? "medium";
const OPENROUTER_TIMEOUT_MS = getPositiveNumber(
  process.env.OPENROUTER_TIMEOUT_MS,
  45000,
);
const OPENROUTER_ATTEMPTS_PER_KEY = getPositiveNumber(
  process.env.OPENROUTER_ATTEMPTS_PER_KEY,
  2,
);
const OPENROUTER_RETRY_BASE_DELAY_MS = getPositiveNumber(
  process.env.OPENROUTER_RETRY_BASE_DELAY_MS,
  250,
);
const OPENROUTER_RETRY_MAX_DELAY_MS = getPositiveNumber(
  process.env.OPENROUTER_RETRY_MAX_DELAY_MS,
  2000,
);

const reliabilityCounters = {
  stream_parse_failures: 0,
  retries: 0,
  key_rotations: 0,
  buffered_fallbacks: 0,
};

type CounterName = keyof typeof reliabilityCounters;

export type LlmLogContext = {
  route: "annotate" | "annotate/stream" | "sketch" | "pdf-page-summary";
  requestId?: string;
  contentHash?: string;
};

type LlmRequestOptions = {
  signal?: AbortSignal;
  logContext?: LlmLogContext;
  /** BYOK / Oddity Free override. Absent means the tier default path. */
  override?: LlmCallOverride | null;
};

type AnnotationStreamOptions = LlmRequestOptions & {
  onAnnotation?: (annotation: Annotation) => void;
};

type SketchStreamOptions = LlmRequestOptions & {
  onChunk?: (text: string) => void;
};

type LlmFailureKind =
  | "stream_parse"
  | "network"
  | "rate_limit"
  | "upstream_5xx"
  | "timeout"
  | "abort"
  | "permanent"
  | "unknown";

type LlmErrorInfo = {
  kind: LlmFailureKind;
  retryable: boolean;
  status?: number;
};

type StreamResult = {
  annotations: Annotation[];
  usedBufferedFallback: boolean;
};

// promptsConfig imported statically above (bundler-safe for Vercel)
const overviewPromptTemplate: string =
  promptsConfig.overview_prompt_template ?? "";
const depthPrompts: Record<string, string> = promptsConfig.depth_prompts ?? {};
const overviewPersonalities: Record<string, string> =
  ((promptsConfig as Record<string, unknown>).overview_personalities as Record<
    string,
    string
  >) ?? {};
const sketchPrompt: string = promptsConfig.sketch_prompt ?? "";
const pdfPageSummaryPrompt: string =
  ((promptsConfig as Record<string, unknown>)
    .pdf_page_summary_prompt as string) ?? "";
const promptPrompt: string =
  ((promptsConfig as Record<string, unknown>).prompt_prompt as string) ?? "";

export class LlmOperationError extends Error {
  readonly kind: LlmFailureKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly keyIndex: number;
  readonly attemptNumber: number;

  constructor(
    message: string,
    {
      kind,
      retryable,
      status,
      keyIndex,
      attemptNumber,
      cause,
    }: LlmErrorInfo & {
      keyIndex: number;
      attemptNumber: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause });
    this.name = "LlmOperationError";
    this.kind = kind;
    this.retryable = retryable;
    this.status = status;
    this.keyIndex = keyIndex;
    this.attemptNumber = attemptNumber;
  }
}

function getPositiveNumber(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function incrementCounter(counter: CounterName): number {
  reliabilityCounters[counter] += 1;
  return reliabilityCounters[counter];
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

function logLlmEvent(
  level: "log" | "warn" | "error",
  event: string,
  context: LlmLogContext | undefined,
  details: Record<string, unknown> = {},
  options?: LlmRequestOptions,
): void {
  console[level](
    `[llm] ${event}`,
    JSON.stringify({
      route: context?.route,
      request_id: context?.requestId,
      content_hash_prefix: context?.contentHash?.slice(0, 12),
      provider: options?.override?.provider ?? "oddity",
      model: options?.override?.model ?? modelName,
      ...details,
    }),
  );
}

function ensureKeysConfigured(): void {
  if (apiKeyEntries.length === 0) {
    throw new Error("No OpenRouter API keys configured");
  }
}

function buildSystemPrompt(
  mode: AnnotationMode,
  personality?: DepthPersonality,
): string {
  if (mode === "overview") {
    const personalityText =
      overviewPersonalities[personality ?? "jerry"] ??
      overviewPersonalities.jerry ??
      "";
    return overviewPromptTemplate.replace(
      /\{\{PERSONALITY\}\}/g,
      personalityText,
    );
  }

  // Public figure persona: Terry's base prompt + persona thinking overlay
  if (personality?.startsWith("pf:")) {
    const slug = personality.slice(3);
    const persona = getPersona(slug);
    if (!persona) {
      console.warn(
        `[llm] Unknown persona slug: ${slug}, falling back to terry`,
      );
      return depthPrompts["terry"] ?? depthPrompts["jerry"] ?? "";
    }
    const base = depthPrompts["terry"] ?? depthPrompts["jerry"] ?? "";
    return `${base}\n\n---\n## PERSONA THINKING OVERLAY\n${persona.prompt}`;
  }

  const key = personality ?? "jerry";
  return depthPrompts[key] ?? depthPrompts["jerry"] ?? "";
}

function mapOverviewOutput(raw: unknown[]): unknown[] {
  return raw.map((item: any) => {
    if (!item || typeof item !== "object") return item;
    if (item.mode && item.type && item.anchor && item.content) return item;

    return {
      id: item.id ?? randomUUID(),
      mode: "overview",
      type: "core_claim",
      label: item.label ?? "",
      anchor: {
        type: "TextQuoteSelector",
        exact: item.anchor ?? item.exact ?? "",
        prefix: item.prefix,
        suffix: item.suffix,
      },
      content: {
        note: item.summary ?? item.note ?? "",
      },
      ...(item.chunk_start && item.chunk_end
        ? {
            chunk: {
              start: { type: "TextQuoteSelector", exact: item.chunk_start },
              end: { type: "TextQuoteSelector", exact: item.chunk_end },
            },
          }
        : {}),
    };
  });
}

function mapDepthOutput(raw: unknown[]): unknown[] {
  return raw.map((item: any) => {
    if (!item || typeof item !== "object") return item;
    if (
      item.mode &&
      item.anchor?.type === "TextQuoteSelector" &&
      item.content
    ) {
      return item;
    }

    const rawType = (item.skill ?? item.type ?? "caveat")
      .replace(/\s+/g, "_")
      .toLowerCase();

    return {
      id: item.id ?? randomUUID(),
      mode: "depth",
      type: rawType,
      label: item.label,
      anchor: {
        type: "TextQuoteSelector",
        exact: item.anchor ?? item.exact ?? "",
        prefix: item.prefix,
        suffix: item.suffix,
      },
      content: {
        note: item.provocation ?? item.note ?? "",
      },
    };
  });
}

function mapLlmOutput(raw: unknown[], mode: AnnotationMode): unknown[] {
  return mode === "overview" ? mapOverviewOutput(raw) : mapDepthOutput(raw);
}

function assignUniqueIds(annotations: Annotation[]): Annotation[] {
  for (const annotation of annotations) {
    annotation.id = randomUUID();
  }
  return annotations;
}

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  reasoning?: { effort: string };
  reasoning_effort?: string;
};

function isOpenAiReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model);
}

function buildChatBody(
  model: string,
  messages: ChatMessage[],
  options: {
    temperature: number;
    maxTokens: number;
    reasoning?: boolean;
    provider?: LlmProvider | null;
    effort?: LlmReasoningEffort;
  },
): ChatCompletionRequest {
  const provider = options.provider ?? null;
  const body: ChatCompletionRequest = {
    model,
    messages,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
  };

  // OpenAI reasoning models only accept temperature 1 and max_completion_tokens.
  if (provider === "openai" && isOpenAiReasoningModel(model)) {
    body.temperature = 1;
    body.max_completion_tokens = options.maxTokens;
    delete body.max_tokens;
  }

  // Reasoning is omitted for tiny structured outputs (e.g. the mode router):
  // thinking tokens share the output budget and would starve the answer.
  if (options.reasoning === false) {
    return body;
  }

  // Tier default path: server-wide effort setting (unchanged behavior).
  if (provider === null) {
    if (OPENROUTER_REASONING_EFFORT !== "") {
      body.reasoning = { effort: OPENROUTER_REASONING_EFFORT };
    }
    return body;
  }

  // BYOK path: only explicit user choices attach provider-specific params.
  // "default"/"none" omit them so unsupported combos cannot 400.
  const effort = options.effort ?? "default";
  if (effort !== "low" && effort !== "medium" && effort !== "high") {
    return body;
  }
  if (provider === "openrouter" || provider === "oddity-free") {
    body.reasoning = { effort };
  } else if (provider === "openai" && isOpenAiReasoningModel(model)) {
    body.reasoning_effort = effort;
  }
  // gemini/muse via chat-completions: effort support unknown, omit fail-safe.
  return body;
}

class LlmHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LlmHttpError";
    this.status = status;
  }
}

function buildKeyAttemptPlan(overrideKeys?: string[]): KeyEntry[] {
  const entries = overrideKeys
    ? overrideKeys.map((apiKey, index) => ({ apiKey, keyIndex: index + 1 }))
    : apiKeyEntries;
  if (entries.length === 0) {
    throw new Error(
      overrideKeys
        ? "No API keys for the selected provider"
        : "No OpenRouter API keys configured",
    );
  }
  return entries.flatMap((entry) =>
    Array.from({ length: OPENROUTER_ATTEMPTS_PER_KEY }, () => entry),
  );
}

function classifyLlmError(
  error: unknown,
  signal?: AbortSignal,
): LlmErrorInfo {
  if (signal?.aborted) {
    return {
      kind: "abort",
      retryable: false,
    };
  }

  if (error instanceof LlmHttpError) {
    const status = error.status;

    if (status === 429) {
      return {
        kind: "rate_limit",
        retryable: true,
        status,
      };
    }

    if (status >= 500) {
      return {
        kind: "upstream_5xx",
        retryable: true,
        status,
      };
    }

    return {
      kind: "permanent",
      retryable: false,
      status,
    };
  }

  if (error instanceof Error && error.name === "AbortError") {
    return {
      kind: "timeout",
      retryable: true,
    };
  }

  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  if (message.includes("failed to parse stream")) {
    incrementCounter("stream_parse_failures");
    return {
      kind: "stream_parse",
      retryable: true,
    };
  }

  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    error instanceof TypeError
  ) {
    return {
      kind: "network",
      retryable: true,
    };
  }

  if (message.includes("timed out") || message.includes("timeout")) {
    return {
      kind: "timeout",
      retryable: true,
    };
  }

  return {
    kind: "unknown",
    retryable: false,
  };
}

function toLlmOperationError(
  error: unknown,
  keyIndex: number,
  attemptNumber: number,
  signal?: AbortSignal,
): LlmOperationError {
  const info = classifyLlmError(error, signal);
  const message = error instanceof Error ? error.message : String(error);
  return new LlmOperationError(message, {
    ...info,
    keyIndex,
    attemptNumber,
    cause: error,
  });
}

function buildRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(OPENROUTER_TIMEOUT_MS);
  if (!signal) return timeoutSignal;
  if (signal.aborted) return signal;
  return AbortSignal.any([signal, timeoutSignal]);
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { content?: unknown };
    finish_reason?: string;
  }>;
  error?: { message?: string; code?: number };
};

type ChatChunk = {
  choices?: Array<{
    delta?: { content?: unknown };
    finish_reason?: string | null;
  }>;
};

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return "";
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function postChatCompletion(
  entry: KeyEntry,
  baseUrl: string,
  body: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(joinUrl(baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${entry.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Oddity1",
    },
    body: JSON.stringify(body),
    signal: buildRequestSignal(signal),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new LlmHttpError(
      response.status,
      `LLM request failed with status ${response.status}${errorText ? `: ${errorText.slice(0, 500)}` : ""}`,
    );
  }

  const parsed = (await response.json()) as ChatCompletionResponse;
  if (parsed.error) {
    throw new Error(`LLM error: ${parsed.error.message ?? "unknown"}`);
  }
  return extractTextContent(parsed.choices?.[0]?.message?.content);
}

async function streamChatCompletion(
  entry: KeyEntry,
  baseUrl: string,
  body: ChatCompletionRequest,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(joinUrl(baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${entry.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Oddity1",
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal: buildRequestSignal(signal),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new LlmHttpError(
      response.status,
      `LLM request failed with status ${response.status}${errorText ? `: ${errorText.slice(0, 500)}` : ""}`,
    );
  }

  if (!response.body) {
    throw new Error("LLM stream response had no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (line === "" || line.startsWith(":")) {
          boundary = buffer.indexOf("\n");
          continue;
        }
        if (!line.startsWith("data:")) {
          boundary = buffer.indexOf("\n");
          continue;
        }
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(data) as ChatChunk;
        } catch {
          throw new Error("Failed to parse stream");
        }
        const delta = extractTextContent(chunk.choices?.[0]?.delta?.content);
        if (delta) onDelta(delta);
        boundary = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Anthropic Messages transport (BYOK Anthropic keys) ─────────────────────

type AnthropicRequest = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  temperature: number;
  thinking?: { type: "enabled"; budget_tokens: number };
  stream?: boolean;
};

type AnthropicResponse = {
  content?: Array<{ type?: string; text?: string }>;
  error?: { type?: string; message?: string };
};

type AnthropicStreamEvent = {
  type: string;
  delta?: { type?: string; text?: string };
  error?: { type?: string; message?: string };
};

const ANTHROPIC_THINKING_BUDGET: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
};

function buildAnthropicBody(
  model: string,
  messages: ChatMessage[],
  options: { temperature: number; maxTokens: number; effort: LlmReasoningEffort },
): AnthropicRequest {
  const systemParts: string[] = [];
  const convo: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
    } else {
      convo.push({ role: message.role, content: message.content });
    }
  }

  const body: AnthropicRequest = {
    model,
    max_tokens: options.maxTokens,
    messages: convo,
    temperature: options.temperature,
  };
  if (systemParts.length > 0) {
    body.system = systemParts.join("\n\n");
  }

  // Thinking budget must fit inside max_tokens; skip it when it cannot.
  // Thinking also forces temperature 1 — other values are rejected.
  const wanted = ANTHROPIC_THINKING_BUDGET[options.effort];
  if (wanted !== undefined) {
    const budget = Math.min(wanted, options.maxTokens - 1024);
    if (budget >= 1024) {
      body.thinking = { type: "enabled", budget_tokens: budget };
      body.temperature = 1;
    }
  }
  return body;
}

function extractAnthropicText(parsed: AnthropicResponse): string {
  if (parsed.error) {
    throw new Error(`LLM error: ${parsed.error.message ?? "unknown"}`);
  }
  return (parsed.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

async function postAnthropicMessages(
  entry: KeyEntry,
  baseUrl: string,
  body: AnthropicRequest,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(joinUrl(baseUrl, "/v1/messages"), {
    method: "POST",
    headers: {
      "x-api-key": entry.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: buildRequestSignal(signal),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new LlmHttpError(
      response.status,
      `LLM request failed with status ${response.status}${errorText ? `: ${errorText.slice(0, 500)}` : ""}`,
    );
  }

  return extractAnthropicText((await response.json()) as AnthropicResponse);
}

async function streamAnthropicMessages(
  entry: KeyEntry,
  baseUrl: string,
  body: AnthropicRequest,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(joinUrl(baseUrl, "/v1/messages"), {
    method: "POST",
    headers: {
      "x-api-key": entry.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal: buildRequestSignal(signal),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new LlmHttpError(
      response.status,
      `LLM request failed with status ${response.status}${errorText ? `: ${errorText.slice(0, 500)}` : ""}`,
    );
  }

  if (!response.body) {
    throw new Error("LLM stream response had no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";

  const handleEventData = (data: string): void => {
    if (data === "[DONE]") return;
    let event: AnthropicStreamEvent;
    try {
      event = JSON.parse(data) as AnthropicStreamEvent;
    } catch {
      throw new Error("Failed to parse stream");
    }
    if (event.type === "error") {
      const kind = event.error?.type ?? "";
      // Map onto HTTP-ish statuses so the retry classifier applies.
      const status = kind.includes("overloaded")
        ? 529
        : kind.includes("rate_limit")
          ? 429
          : 400;
      throw new LlmHttpError(
        status,
        `LLM stream error: ${event.error?.message ?? kind}`,
      );
    }
    if (
      eventName === "content_block_delta" &&
      event.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      event.delta.text
    ) {
      onDelta(event.delta.text);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (line === "" || line.startsWith(":")) {
          boundary = buffer.indexOf("\n");
          continue;
        }
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          handleEventData(line.slice(5).trim());
        }
        boundary = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function firstEntryFor(options: LlmRequestOptions): KeyEntry {
  const overrideKeys = options.override?.apiKeys;
  if (overrideKeys) {
    if (overrideKeys.length === 0) {
      throw new Error("No API keys for the selected provider");
    }
    return { apiKey: overrideKeys[0]!, keyIndex: 1 };
  }
  ensureKeysConfigured();
  return apiKeyEntries[0]!;
}

type CallContext = {
  provider: LlmProvider | null;
  transport: LlmTransport;
  baseUrl: string;
  model: string;
  effort: LlmReasoningEffort;
};

function resolveCallContext(
  options: LlmRequestOptions,
  tierModel: string,
): CallContext {
  const override = options.override ?? null;
  if (!override) {
    return {
      provider: null,
      transport: "openai-chat",
      baseUrl: OPENROUTER_BASE_URL,
      model: tierModel,
      effort: "default",
    };
  }
  return {
    provider: override.provider,
    transport: override.transport,
    baseUrl: override.baseUrl,
    model: override.model,
    effort: override.effort,
  };
}

type TextGenOptions = {
  temperature: number;
  maxTokens: number;
  reasoning?: boolean;
};

async function postTextCompletion(
  entry: KeyEntry,
  ctx: CallContext,
  messages: ChatMessage[],
  options: TextGenOptions,
  signal?: AbortSignal,
): Promise<string> {
  if (ctx.transport === "anthropic-messages") {
    return postAnthropicMessages(
      entry,
      ctx.baseUrl,
      buildAnthropicBody(ctx.model, messages, {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        effort: options.reasoning === false ? "default" : ctx.effort,
      }),
      signal,
    );
  }
  return postChatCompletion(
    entry,
    ctx.baseUrl,
    buildChatBody(ctx.model, messages, {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      reasoning: options.reasoning,
      provider: ctx.provider,
      effort: ctx.effort,
    }),
    signal,
  );
}

async function streamTextCompletion(
  entry: KeyEntry,
  ctx: CallContext,
  messages: ChatMessage[],
  options: TextGenOptions,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (ctx.transport === "anthropic-messages") {
    return streamAnthropicMessages(
      entry,
      ctx.baseUrl,
      buildAnthropicBody(ctx.model, messages, {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        effort: options.reasoning === false ? "default" : ctx.effort,
      }),
      onDelta,
      signal,
    );
  }
  return streamChatCompletion(
    entry,
    ctx.baseUrl,
    buildChatBody(ctx.model, messages, {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      reasoning: options.reasoning,
      provider: ctx.provider,
      effort: ctx.effort,
    }),
    onDelta,
    signal,
  );
}

async function waitBeforeRetry(
  attemptNumber: number,
  signal?: AbortSignal,
): Promise<void> {
  const baseDelay =
    OPENROUTER_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptNumber - 1);
  const cappedDelay = Math.min(baseDelay, OPENROUTER_RETRY_MAX_DELAY_MS);
  const jitterMs =
    process.env.NODE_ENV === "test" ? 0 : Math.floor(Math.random() * 100);
  await delay(cappedDelay + jitterMs, undefined, { signal });
}

async function runWithRetryPlan<T>(
  operation: string,
  runner: (entry: KeyEntry, attemptNumber: number) => Promise<T>,
  options: LlmRequestOptions = {},
): Promise<T> {
  const attempts = buildKeyAttemptPlan(options.override?.apiKeys);
  let lastError: LlmOperationError | null = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const entry = attempts[index]!;
    const attemptNumber = index + 1;

    try {
      return await runner(entry, attemptNumber);
    } catch (error) {
      const operationError = toLlmOperationError(
        error,
        entry.keyIndex,
        attemptNumber,
        options.signal,
      );
      lastError = operationError;

      logLlmEvent(
        "warn",
        `${operation}.attempt_failed`,
        options.logContext,
        {
          key_index: entry.keyIndex,
          attempt_number: attemptNumber,
          error_kind: operationError.kind,
          retryable: operationError.retryable,
          status: operationError.status,
          error: serializeError(error),
        },
        options,
      );

      if (!operationError.retryable || options.signal?.aborted) {
        throw operationError;
      }

      if (index >= attempts.length - 1) {
        break;
      }

      incrementCounter("retries");
      const nextEntry = attempts[index + 1]!;
      if (nextEntry.keyIndex !== entry.keyIndex) {
        incrementCounter("key_rotations");
      }

      await waitBeforeRetry(attemptNumber, options.signal);
    }
  }

  throw lastError ?? new Error(`LLM ${operation} failed without attempts`);
}

async function callChatWithKey(
  entry: KeyEntry,
  text: string,
  mode: AnnotationMode,
  personality: DepthPersonality | undefined,
  correctionNote: string | undefined,
  signal: AbortSignal | undefined,
  ctx: CallContext,
): Promise<unknown> {
  const systemPrompt = buildSystemPrompt(mode, personality);
  const userContent = correctionNote ? `${text}\n\n${correctionNote}` : text;
  const content = await postTextCompletion(
    entry,
    ctx,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    { temperature: 0.3, maxTokens: 4096 },
    signal,
  );
  if (!content) return [];

  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : (parsed.annotations ?? []);
  } catch {
    return [];
  }
}

async function callChat(
  text: string,
  mode: AnnotationMode,
  personality?: DepthPersonality,
  correctionNote?: string,
  options: LlmRequestOptions = {},
): Promise<unknown> {
  const ctx = resolveCallContext(options, modelName);
  return runWithRetryPlan(
    "generate_content",
    (entry) =>
      callChatWithKey(
        entry,
        text,
        mode,
        personality,
        correctionNote,
        options.signal,
        ctx,
      ),
    options,
  );
}

async function callChatPdfPageSummaryWithKey(
  entry: KeyEntry,
  text: string,
  correctionNote: string | undefined,
  signal: AbortSignal | undefined,
  ctx: CallContext,
): Promise<unknown> {
  const userContent = correctionNote ? `${text}\n\n${correctionNote}` : text;
  const content = await postTextCompletion(
    entry,
    ctx,
    [
      { role: "system", content: pdfPageSummaryPrompt },
      { role: "user", content: userContent },
    ],
    { temperature: 0.3, maxTokens: 4096 },
    signal,
  );
  if (!content) return {};

  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function callChatPdfPageSummary(
  text: string,
  correctionNote?: string,
  options: LlmRequestOptions = {},
): Promise<unknown> {
  const ctx = resolveCallContext(options, modelName);
  return runWithRetryPlan(
    "generate_pdf_page_summary",
    (entry) =>
      callChatPdfPageSummaryWithKey(
        entry,
        text,
        correctionNote,
        options.signal,
        ctx,
      ),
    options,
  );
}

async function consumeAnnotationStreamAttempt(
  entry: KeyEntry,
  text: string,
  mode: AnnotationMode,
  personality: DepthPersonality | undefined,
  options: AnnotationStreamOptions,
): Promise<Annotation[]> {
  const systemPrompt = buildSystemPrompt(mode, personality);
  const ctx = resolveCallContext(options, modelName);
  const allAnnotations: Annotation[] = [];
  let buffer = "";

  await streamTextCompletion(
    entry,
    ctx,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    { temperature: 0.3, maxTokens: 4096 },
    (delta) => {
      buffer += delta;

      const extracted = extractCompleteObjects(buffer);
      for (const objectString of extracted.objects) {
        try {
          const raw = JSON.parse(objectString);
          const mapped = mapLlmOutput([raw], mode);
          const { valid } = validateAnnotations(mapped);
          if (valid.length > 0) {
            valid[0]!.id = randomUUID();
            allAnnotations.push(valid[0]!);
            options.onAnnotation?.(valid[0]!);
          }
        } catch {
          // Skip malformed items; the authoritative final result is sent later.
        }
      }

      buffer = extracted.remaining;
    },
    options.signal,
  );

  return allAnnotations;
}

async function consumeSketchStreamAttempt(
  entry: KeyEntry,
  inputText: string,
  purpose: string,
  userReactions: string,
  mode: "sketch" | "prompt",
  options: SketchStreamOptions,
): Promise<string> {
  const systemPrompt = mode === "prompt" ? promptPrompt : sketchPrompt;
  const normalizedUserReactions = userReactions.trim();
  const noUserReactionsGuard =
    "No user notes or reactions were provided. Do not infer, invent, or attribute any opinions, reactions, annotations, agreements, disagreements, priorities, or conclusions to the user beyond the stated purpose. Ground the result only in the source text and the stated purpose.";
  const userMessage =
    mode === "prompt"
      ? normalizedUserReactions
        ? `Source Text:\n${inputText}\n\nPrompt Purpose:\n${purpose}\n\nUser's Notes and Reactions:\n${normalizedUserReactions}`
        : `Source Text:\n${inputText}\n\nPrompt Purpose:\n${purpose}\n\n${noUserReactionsGuard}`
      : normalizedUserReactions
        ? `Input Text:\n${inputText}\n\nPurpose of Reading:\n${purpose}\n\nUser's Reactions:\n${normalizedUserReactions}`
        : `Input Text:\n${inputText}\n\nPurpose of Reading:\n${purpose}\n\n${noUserReactionsGuard}\nOnly include positions that are directly supported by the stated purpose; if the purpose is broad, keep the output conservative.`;
  let fullText = "";
  const ctx = resolveCallContext(options, modelName);

  await streamTextCompletion(
    entry,
    ctx,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    { temperature: 0.3, maxTokens: 2048 },
    (delta) => {
      fullText += delta;
      options.onChunk?.(delta);
    },
    options.signal,
  );

  return fullText;
}

export async function generateAnnotations(
  text: string,
  mode: AnnotationMode,
  personality?: DepthPersonality,
  options: LlmRequestOptions = {},
): Promise<Annotation[]> {
  const firstAttempt = await callChat(
    text,
    mode,
    personality,
    undefined,
    options,
  );
  const mapped = Array.isArray(firstAttempt)
    ? mapLlmOutput(firstAttempt, mode)
    : firstAttempt;
  const { valid, errors } = validateAnnotations(mapped);

  if (errors.length === 0) return assignUniqueIds(valid);

  const correctionPrompt = `Your previous response had validation errors:\n${errors.join("\n")}\n\nPlease fix these issues and return a valid JSON array of annotations.`;
  const retryAttempt = await callChat(
    text,
    mode,
    personality,
    correctionPrompt,
    options,
  );
  const retryMapped = Array.isArray(retryAttempt)
    ? mapLlmOutput(retryAttempt, mode)
    : retryAttempt;
  const retryResult = validateAnnotations(retryMapped);

  return assignUniqueIds(
    retryResult.valid.length > 0 ? retryResult.valid : valid,
  );
}

export async function generateAnnotationsStream(
  text: string,
  mode: AnnotationMode,
  personality?: DepthPersonality,
  options: AnnotationStreamOptions = {},
): Promise<StreamResult> {
  const attempts = buildKeyAttemptPlan(options.override?.apiKeys);
  let lastError: LlmOperationError | null = null;
  let emittedAnnotations = false;

  for (let index = 0; index < attempts.length; index += 1) {
    const entry = attempts[index]!;
    const attemptNumber = index + 1;

    try {
      const annotations = await consumeAnnotationStreamAttempt(
        entry,
        text,
        mode,
        personality,
        {
          ...options,
          onAnnotation: (annotation) => {
            emittedAnnotations = true;
            options.onAnnotation?.(annotation);
          },
        },
      );
      return {
        annotations,
        usedBufferedFallback: false,
      };
    } catch (error) {
      const operationError = toLlmOperationError(
        error,
        entry.keyIndex,
        attemptNumber,
        options.signal,
      );
      lastError = operationError;

      emittedAnnotations = emittedAnnotations || false;

      logLlmEvent(
        "warn",
        "generate_annotations_stream.attempt_failed",
        options.logContext,
        {
          key_index: entry.keyIndex,
          attempt_number: attemptNumber,
          error_kind: operationError.kind,
          retryable: operationError.retryable,
          status: operationError.status,
          emitted_annotations: emittedAnnotations,
          error: serializeError(error),
        },
        options,
      );

      if (!operationError.retryable || options.signal?.aborted) {
        throw operationError;
      }

      if (emittedAnnotations) {
        break;
      }

      if (index >= attempts.length - 1) {
        break;
      }

      incrementCounter("retries");
      const nextEntry = attempts[index + 1]!;
      if (nextEntry.keyIndex !== entry.keyIndex) {
        incrementCounter("key_rotations");
      }

      await waitBeforeRetry(attemptNumber, options.signal);
    }
  }

  incrementCounter("buffered_fallbacks");
  logLlmEvent(
    "warn",
    "generate_annotations_stream.buffered_fallback",
    options.logContext,
    {
      fallback_from_error_kind: lastError?.kind,
    },
    options,
  );

  try {
    const annotations = await generateAnnotations(
      text,
      mode,
      personality,
      options,
    );
    logLlmEvent(
      "log",
      "generate_annotations_stream.buffered_fallback_succeeded",
      options.logContext,
      {
        fallback_from_error_kind: lastError?.kind,
      },
      options,
    );
    return {
      annotations,
      usedBufferedFallback: true,
    };
  } catch (fallbackError) {
    logLlmEvent(
      "error",
      "generate_annotations_stream.buffered_fallback_failed",
      options.logContext,
      {
        fallback_from_error_kind: lastError?.kind,
        error: serializeError(fallbackError),
      },
      options,
    );
    throw fallbackError;
  }
}

export async function generateSketchStream(
  inputText: string,
  purpose: string,
  userReactions: string,
  mode: "sketch" | "prompt" = "sketch",
  options: SketchStreamOptions = {},
): Promise<string> {
  const attempts = buildKeyAttemptPlan(options.override?.apiKeys);
  let lastError: LlmOperationError | null = null;
  let emittedText = false;

  for (let index = 0; index < attempts.length; index += 1) {
    const entry = attempts[index]!;
    const attemptNumber = index + 1;

    try {
      return await consumeSketchStreamAttempt(
        entry,
        inputText,
        purpose,
        userReactions,
        mode,
        {
          ...options,
          onChunk: (chunk) => {
            emittedText = true;
            options.onChunk?.(chunk);
          },
        },
      );
    } catch (error) {
      const operationError = toLlmOperationError(
        error,
        entry.keyIndex,
        attemptNumber,
        options.signal,
      );
      lastError = operationError;

      logLlmEvent(
        "warn",
        "generate_sketch_stream.attempt_failed",
        options.logContext,
        {
          key_index: entry.keyIndex,
          attempt_number: attemptNumber,
          error_kind: operationError.kind,
          retryable: operationError.retryable,
          status: operationError.status,
          emitted_chunks: emittedText,
          error: serializeError(error),
        },
        options,
      );

      if (!operationError.retryable || options.signal?.aborted || emittedText) {
        throw operationError;
      }

      if (index >= attempts.length - 1) {
        break;
      }

      incrementCounter("retries");
      const nextEntry = attempts[index + 1]!;
      if (nextEntry.keyIndex !== entry.keyIndex) {
        incrementCounter("key_rotations");
      }

      await waitBeforeRetry(attemptNumber, options.signal);
    }
  }

  throw lastError ?? new Error("Sketch stream failed without attempts");
}

export async function generatePdfPageSummary(
  text: string,
  options: LlmRequestOptions = {},
): Promise<string> {
  const firstAttempt = await callChatPdfPageSummary(text, undefined, options);
  const firstResult = validatePdfPageSummary(firstAttempt);

  if (firstResult.errors.length === 0 && firstResult.valid) {
    return firstResult.valid.summary;
  }

  const correctionPrompt =
    `Your previous response had validation errors:\n${firstResult.errors.join("\n")}\n\n` +
    'Please fix these issues and return only valid JSON in the shape {"summary":"..."} with 1-2 concise sentences.';
  const retryAttempt = await callChatPdfPageSummary(
    text,
    correctionPrompt,
    options,
  );
  const retryResult = validatePdfPageSummary(retryAttempt);

  return retryResult.valid?.summary ?? firstResult.valid?.summary ?? "";
}

function extractCompleteObjects(buffer: string): {
  objects: string[];
  remaining: string;
} {
  const objects: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let objectStart = -1;

  const arrayStart = buffer.indexOf("[");
  if (arrayStart === -1) return { objects: [], remaining: buffer };

  let searchFrom = arrayStart + 1;

  for (let index = searchFrom; index < buffer.length; index += 1) {
    const ch = buffer[index]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        objects.push(buffer.slice(objectStart, index + 1));
        searchFrom = index + 1;
        objectStart = -1;
      }
    }
  }

  return {
    objects,
    remaining: buffer.slice(0, arrayStart + 1) + buffer.slice(searchFrom),
  };
}

export function getLlmReliabilityCounters(): Record<string, number> {
  return { ...reliabilityCounters };
}

// ─── GDocs Chat Streaming ─────────────────────────────────────────────────────

export type GDocsChatMode =
  | "chat"
  | "tree"
  | "essay"
  | "edit"
  | "fast"
  | "outline";

type GDocsChatMessage = { role: "user" | "assistant"; content: string };

type GDocsChatStreamOptions = LlmRequestOptions & {
  onChunk?: (text: string) => void;
};

const _gdocsPrompts = promptsConfig as Record<string, unknown>;
const gdocsPromptMap: Record<GDocsChatMode, string> = {
  chat: (_gdocsPrompts.gdocs_chat_prompt as string) ?? "",
  tree: (_gdocsPrompts.gdocs_tree_prompt as string) ?? "",
  essay: (_gdocsPrompts.gdocs_essay_prompt as string) ?? "",
  edit: (_gdocsPrompts.gdocs_edit_prompt as string) ?? "",
  fast: (_gdocsPrompts.gdocs_fast_prompt as string) ?? "",
  outline: (_gdocsPrompts.gdocs_plan_outline_prompt as string) ?? "",
};

// Reasoning model for long-form generation and complex structural edits.
// Defaults to the main model; override with OPENROUTER_REASONING_MODEL.
const reasoningModelName = process.env.OPENROUTER_REASONING_MODEL ?? modelName;
// Minimal model override per mode — undefined means use the default modelName
const gdocsModelMap: Partial<Record<GDocsChatMode, string>> = {
  essay: reasoningModelName,
  edit: reasoningModelName,
};
// Per-mode maxOutputTokens. edit/essay use the reasoning model and can produce
// large structured responses (many REPLACE blocks, full essays) — 2048 is too
// small and causes truncation before <<<END_EDIT>>> / <<<END_ESSAY>>> is emitted.
const gdocsMaxTokensMap: Partial<Record<GDocsChatMode, number>> = {
  edit: 8192,
  essay: 8192,
};

// All valid chat modes — any unknown mode string gets rejected before reaching the LLM
const VALID_GDOCS_MODES = new Set<string>(Object.keys(gdocsPromptMap));

export function isValidGDocsChatMode(mode: string): mode is GDocsChatMode {
  return VALID_GDOCS_MODES.has(mode);
}

async function consumeGDocsChatStreamAttempt(
  entry: KeyEntry,
  messages: GDocsChatMessage[],
  mode: GDocsChatMode,
  options: GDocsChatStreamOptions,
): Promise<string> {
  const systemPrompt = gdocsPromptMap[mode];
  if (!systemPrompt) {
    throw new Error(
      `[gdocs] Unknown mode "${mode}" — no system prompt defined`,
    );
  }
  const maxOutputTokens = gdocsMaxTokensMap[mode] ?? 2048;
  const ctx = resolveCallContext(options, gdocsModelMap[mode] ?? modelName);
  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...messages.map((m): ChatMessage => ({ role: m.role, content: m.content })),
  ];

  let fullText = "";
  await streamTextCompletion(
    entry,
    ctx,
    chatMessages,
    {
      temperature: 0.7,
      maxTokens: maxOutputTokens,
    },
    (delta) => {
      fullText += delta;
      options.onChunk?.(delta);
    },
    options.signal,
  );
  return fullText;
}

export async function generateGDocsChatStream(
  messages: GDocsChatMessage[],
  mode: GDocsChatMode,
  options: GDocsChatStreamOptions = {},
): Promise<string> {
  const attempts = buildKeyAttemptPlan(options.override?.apiKeys);
  let lastError: LlmOperationError | null = null;
  let emittedText = false;

  for (let index = 0; index < attempts.length; index += 1) {
    const entry = attempts[index]!;
    const attemptNumber = index + 1;

    try {
      return await consumeGDocsChatStreamAttempt(entry, messages, mode, {
        ...options,
        onChunk: (chunk) => {
          emittedText = true;
          options.onChunk?.(chunk);
        },
      });
    } catch (error) {
      const operationError = toLlmOperationError(
        error,
        entry.keyIndex,
        attemptNumber,
        options.signal,
      );
      lastError = operationError;

      if (!operationError.retryable || options.signal?.aborted || emittedText) {
        throw operationError;
      }

      if (index >= attempts.length - 1) break;

      incrementCounter("retries");
      const nextEntry = attempts[index + 1]!;
      if (nextEntry.keyIndex !== entry.keyIndex)
        incrementCounter("key_rotations");

      await waitBeforeRetry(attemptNumber, options.signal);
    }
  }

  throw lastError ?? new Error("GDocs chat stream failed without attempts");
}

// ─── MCQ Question Generation ──────────────────────────────────────────────────

// Ported from Claude Code's AskUserQuestionTool schema:
// - header: short chip/tag label shown above the question (≤12 chars)
// - options: 2-4 choices, each with a label (1-5 words) + description (trade-off explanation)
// - The UI always adds an "Other" freeform option automatically — do NOT include it here
export type McqOption = {
  label: string; // 1-5 words, displayed as the selectable choice
  description: string; // short explanation of trade-offs or implications
};

export type McqQuestion = {
  question: string; // full question text, ends with "?"
  header: string; // ≤12 char chip label (e.g. "Tone", "Audience")
  options: McqOption[]; // 2-4 options, best default FIRST marked "(Recommended)"
};

const mcqPromptTemplate: string =
  (_gdocsPrompts.gdocs_mcq_prompt as string) ?? "";

function parseMcqOption(raw: unknown): McqOption | null {
  if (typeof raw === "string") {
    // backward-compat: plain string → use as label, empty description
    return { label: raw.slice(0, 60), description: "" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj?.label !== "string") return null;
  return {
    label: obj.label.slice(0, 60),
    description:
      typeof obj.description === "string" ? obj.description.slice(0, 120) : "",
  };
}

export async function generateAllMcqQuestions(
  prompt: string,
  docContext: string,
  options: LlmRequestOptions = {},
): Promise<McqQuestion[]> {
  const docContextText = docContext.trim()
    ? `Existing document content:\n${docContext.trim()}\n\n`
    : "";

  const filledPrompt = mcqPromptTemplate
    .replace("{docContext}", docContextText)
    .replace("{prompt}", prompt);

  try {
    const entry = firstEntryFor(options);
    const ctx = resolveCallContext(options, modelName);
    const text = (
      await postTextCompletion(
        entry,
        ctx,
        [{ role: "user", content: filledPrompt }],
        { temperature: 0.8, maxTokens: 1536 },
        options.signal,
      )
    ).trim();
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const parsed = JSON.parse(cleaned) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>).questions)
        ? ((parsed as Record<string, unknown>).questions as unknown[])
        : null;

    if (arr) {
      const questions: McqQuestion[] = arr
        .filter(
          (item): item is Record<string, unknown> =>
            typeof (item as Record<string, unknown>).question === "string" &&
            Array.isArray((item as Record<string, unknown>).options),
        )
        .map((item) => {
          const opts = (item.options as unknown[])
            .map(parseMcqOption)
            .filter((o): o is McqOption => o !== null)
            .slice(0, 4); // Claude Code caps at 4 options
          return {
            question: item.question as string,
            header:
              typeof item.header === "string" ? item.header.slice(0, 12) : "",
            options: opts,
          };
        })
        // Uniqueness guard (from Claude Code): drop duplicate question texts
        .filter(
          (q, i, arr) => arr.findIndex((x) => x.question === q.question) === i,
        )
        .filter((q) => q.options.length >= 2) // must have at least 2 options
        .slice(0, 5);

      if (questions.length > 0) return questions;
    }
  } catch (err) {
    console.error(
      "[generateAllMcqQuestions] Error:",
      err instanceof Error ? err.message : err,
    );
  }

  // Fallback: 5 generic questions with descriptions
  return [
    {
      question: `What is the main goal of your writing about "${prompt.slice(0, 40)}"?`,
      header: "Goal",
      options: [
        {
          label: "Inform readers (Recommended)",
          description: "Present facts and analysis objectively",
        },
        {
          label: "Argue a position",
          description: "Persuade the reader toward a specific view",
        },
        {
          label: "Explore perspectives",
          description: "Weigh multiple sides without a fixed conclusion",
        },
      ],
    },
    {
      question: "Who is your primary audience?",
      header: "Audience",
      options: [
        {
          label: "General readers (Recommended)",
          description: "No assumed background knowledge",
        },
        {
          label: "Domain experts",
          description: "Can use technical language and skip basics",
        },
        {
          label: "Students / beginners",
          description: "Needs definitions and step-by-step explanations",
        },
      ],
    },
    {
      question: "What tone are you aiming for?",
      header: "Tone",
      options: [
        {
          label: "Formal & academic (Recommended)",
          description: "Structured, cited, suitable for essays",
        },
        {
          label: "Conversational",
          description: "Approachable, uses first person, flows naturally",
        },
        {
          label: "Persuasive & direct",
          description: "Assertive, action-oriented, emotionally engaging",
        },
      ],
    },
    {
      question: "How comprehensive should the coverage be?",
      header: "Depth",
      options: [
        {
          label: "High-level overview",
          description: "Broad strokes, key takeaways only",
        },
        {
          label: "Moderate depth (Recommended)",
          description: "Core arguments with supporting evidence",
        },
        {
          label: "Comprehensive",
          description: "Exhaustive — every angle, every counterargument",
        },
      ],
    },
    {
      question: "What should readers take away?",
      header: "Takeaway",
      options: [
        {
          label: "Clear understanding (Recommended)",
          description: "Readers leave knowing more than before",
        },
        {
          label: "Changed opinion",
          description: "Readers adopt or seriously reconsider your position",
        },
        {
          label: "Actionable next steps",
          description: "Readers know exactly what to do next",
        },
      ],
    },
  ];
}

// ─── Mode Router ──────────────────────────────────────────────────────────────

export type GDocsRouteMode = "FAST" | "PLAN";

export type GDocsRouteResult = {
  mode: GDocsRouteMode;
  confidence: "high" | "low";
  reasoning: string;
};

const routerSystemPrompt: string =
  (_gdocsPrompts.gdocs_router_prompt as string) ?? "";
const routerDeepSystemPrompt: string =
  (_gdocsPrompts.gdocs_router_deep_prompt as string) ?? "";
const routerModelName = process.env.OPENROUTER_ROUTER_MODEL ?? modelName;

function parseRouteResult(text: string): GDocsRouteResult {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const parsed = JSON.parse(cleaned) as {
    mode?: string;
    confidence?: string;
    reasoning?: string;
  };
  const mode: GDocsRouteMode = parsed.mode === "PLAN" ? "PLAN" : "FAST";
  const confidence: "high" | "low" =
    parsed.confidence === "low" ? "low" : "high";
  return { mode, confidence, reasoning: parsed.reasoning ?? "" };
}

export async function generateGDocsRoute(
  prompt: string,
  docContext: string,
  essayContent?: string,
  options: LlmRequestOptions = {},
): Promise<GDocsRouteResult> {
  const docText = (essayContent?.trim() || docContext?.trim()) ?? "";
  const userMessage = `User request: ${prompt}${docText ? `\n\nDocument:\n${docText.slice(0, 4000)}` : ""}`;

  try {
    const entry = firstEntryFor(options);
    const ctx = resolveCallContext(options, routerModelName);
    const messages: ChatMessage[] = [
      { role: "system", content: routerSystemPrompt },
      { role: "user", content: userMessage },
    ];

    // Stage 1: quick classification (no reasoning: the 150-token budget
    // would be consumed by thinking tokens before the answer is emitted)
    const stage1Text = await postTextCompletion(
      entry,
      ctx,
      messages,
      { temperature: 0.1, maxTokens: 150, reasoning: false },
      options.signal,
    );

    const stage1 = parseRouteResult(stage1Text.trim());

    // Stage 2: deeper reasoning for uncertain cases
    if (stage1.confidence === "low") {
      try {
        const stage2Text = await postTextCompletion(
          entry,
          ctx,
          [
            { role: "system", content: routerDeepSystemPrompt },
            { role: "user", content: userMessage },
          ],
          { temperature: 0.3, maxTokens: 256, reasoning: false },
          options.signal,
        );
        return parseRouteResult(stage2Text.trim());
      } catch {
        // Stage 2 failed — fall back to FAST (safe default)
        return {
          mode: "FAST",
          confidence: "low",
          reasoning: "stage2-fallback",
        };
      }
    }

    return stage1;
  } catch (err) {
    console.error(
      "[generateGDocsRoute] Error:",
      err instanceof Error ? err.message : err,
    );
    return { mode: "FAST", confidence: "low", reasoning: "fallback" };
  }
}
