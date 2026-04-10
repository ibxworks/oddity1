import {
  GoogleGenerativeAI,
  GoogleGenerativeAIError,
  GoogleGenerativeAIFetchError,
} from "@google/generative-ai";
import type {
  Annotation,
  AnnotationMode,
  DepthPersonality,
} from "@oddity/shared";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import promptsConfig from "../config/prompts.json" with { type: "json" };
import { validatePdfPageSummary } from "./pdf-page-summary-validator.js";
import { getPersona } from "./persona-registry.js";
import { validateAnnotations } from "./schema-validator.js";

const apiKeys = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_BACKUP1,
  process.env.GEMINI_API_KEY_BACKUP2,
].filter((key): key is string => !!key);

type ClientEntry = {
  client: GoogleGenerativeAI;
  keyIndex: number;
};

const genAIClients: ClientEntry[] = apiKeys.map((key, index) => ({
  client: new GoogleGenerativeAI(key),
  keyIndex: index + 1,
}));

const modelName = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite-preview";
const GEMINI_TIMEOUT_MS = getPositiveNumber(
  process.env.GEMINI_TIMEOUT_MS,
  45000,
);
const GEMINI_ATTEMPTS_PER_KEY = getPositiveNumber(
  process.env.GEMINI_ATTEMPTS_PER_KEY,
  2,
);
const GEMINI_RETRY_BASE_DELAY_MS = getPositiveNumber(
  process.env.GEMINI_RETRY_BASE_DELAY_MS,
  250,
);
const GEMINI_RETRY_MAX_DELAY_MS = getPositiveNumber(
  process.env.GEMINI_RETRY_MAX_DELAY_MS,
  2000,
);

const reliabilityCounters = {
  stream_parse_failures: 0,
  retries: 0,
  key_rotations: 0,
  buffered_fallbacks: 0,
};

type CounterName = keyof typeof reliabilityCounters;

export type GeminiLogContext = {
  route: "annotate" | "annotate/stream" | "sketch" | "pdf-page-summary";
  requestId?: string;
  contentHash?: string;
};

type GeminiRequestOptions = {
  signal?: AbortSignal;
  logContext?: GeminiLogContext;
};

type AnnotationStreamOptions = GeminiRequestOptions & {
  onAnnotation?: (annotation: Annotation) => void;
};

type SketchStreamOptions = GeminiRequestOptions & {
  onChunk?: (text: string) => void;
};

type GeminiFailureKind =
  | "stream_parse"
  | "network"
  | "rate_limit"
  | "upstream_5xx"
  | "timeout"
  | "abort"
  | "permanent"
  | "unknown";

type GeminiErrorInfo = {
  kind: GeminiFailureKind;
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

export class GeminiOperationError extends Error {
  readonly kind: GeminiFailureKind;
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
    }: GeminiErrorInfo & {
      keyIndex: number;
      attemptNumber: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause });
    this.name = "GeminiOperationError";
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

function logGeminiEvent(
  level: "log" | "warn" | "error",
  event: string,
  context: GeminiLogContext | undefined,
  details: Record<string, unknown> = {},
): void {
  console[level](
    `[gemini] ${event}`,
    JSON.stringify({
      route: context?.route,
      request_id: context?.requestId,
      content_hash_prefix: context?.contentHash?.slice(0, 12),
      model: modelName,
      ...details,
    }),
  );
}

function ensureClientsConfigured(): void {
  if (genAIClients.length === 0) {
    throw new Error("No Gemini API keys configured");
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
        `[gemini] Unknown persona slug: ${slug}, falling back to terry`,
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

function getGenerationConfig() {
  return {
    responseMimeType: "application/json" as const,
    maxOutputTokens: 4096,
    temperature: 0.3,
  };
}

function buildClientAttemptPlan(): ClientEntry[] {
  ensureClientsConfigured();
  return genAIClients.flatMap((entry) =>
    Array.from({ length: GEMINI_ATTEMPTS_PER_KEY }, () => entry),
  );
}

function classifyGeminiError(
  error: unknown,
  signal?: AbortSignal,
): GeminiErrorInfo {
  if (signal?.aborted) {
    return {
      kind: "abort",
      retryable: false,
    };
  }

  if (error instanceof GoogleGenerativeAIFetchError) {
    const status = error.status ?? 0;

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

  if (message.includes("fetch failed") || message.includes("network")) {
    return {
      kind: "network",
      retryable: true,
    };
  }

  if (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("aborterror")
  ) {
    return {
      kind: "timeout",
      retryable: true,
    };
  }

  if (error instanceof GoogleGenerativeAIError) {
    return {
      kind: "unknown",
      retryable: false,
    };
  }

  return {
    kind: "unknown",
    retryable: false,
  };
}

function toGeminiOperationError(
  error: unknown,
  keyIndex: number,
  attemptNumber: number,
  signal?: AbortSignal,
): GeminiOperationError {
  const info = classifyGeminiError(error, signal);
  const message = error instanceof Error ? error.message : String(error);
  return new GeminiOperationError(message, {
    ...info,
    keyIndex,
    attemptNumber,
    cause: error,
  });
}

function getRequestOptions(signal?: AbortSignal) {
  return {
    signal,
    timeout: GEMINI_TIMEOUT_MS,
  };
}

async function waitBeforeRetry(
  attemptNumber: number,
  signal?: AbortSignal,
): Promise<void> {
  const baseDelay =
    GEMINI_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptNumber - 1);
  const cappedDelay = Math.min(baseDelay, GEMINI_RETRY_MAX_DELAY_MS);
  const jitterMs =
    process.env.NODE_ENV === "test" ? 0 : Math.floor(Math.random() * 100);
  await delay(cappedDelay + jitterMs, undefined, { signal });
}

async function runWithRetryPlan<T>(
  operation: string,
  runner: (entry: ClientEntry, attemptNumber: number) => Promise<T>,
  options: GeminiRequestOptions = {},
): Promise<T> {
  const attempts = buildClientAttemptPlan();
  let lastError: GeminiOperationError | null = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const entry = attempts[index]!;
    const attemptNumber = index + 1;

    try {
      return await runner(entry, attemptNumber);
    } catch (error) {
      const operationError = toGeminiOperationError(
        error,
        entry.keyIndex,
        attemptNumber,
        options.signal,
      );
      lastError = operationError;

      logGeminiEvent(
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

  throw lastError ?? new Error(`Gemini ${operation} failed without attempts`);
}

async function callGeminiWithClient(
  entry: ClientEntry,
  text: string,
  mode: AnnotationMode,
  personality?: DepthPersonality,
  correctionNote?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const systemPrompt = buildSystemPrompt(mode, personality);
  const generationConfig = getGenerationConfig();

  const model = entry.client.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
    generationConfig,
  });

  const userContent = correctionNote ? `${text}\n\n${correctionNote}` : text;
  const result = await model.generateContent(
    {
      contents: [{ role: "user", parts: [{ text: userContent }] }],
    },
    getRequestOptions(signal),
  );

  const content = result.response.text();
  if (!content) return [];

  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : (parsed.annotations ?? []);
  } catch {
    return [];
  }
}

async function callGemini(
  text: string,
  mode: AnnotationMode,
  personality?: DepthPersonality,
  correctionNote?: string,
  options: GeminiRequestOptions = {},
): Promise<unknown> {
  return runWithRetryPlan(
    "generate_content",
    (entry) =>
      callGeminiWithClient(
        entry,
        text,
        mode,
        personality,
        correctionNote,
        options.signal,
      ),
    options,
  );
}

async function callGeminiPdfPageSummaryWithClient(
  entry: ClientEntry,
  text: string,
  correctionNote?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const model = entry.client.getGenerativeModel({
    model: modelName,
    systemInstruction: pdfPageSummaryPrompt,
    generationConfig: getGenerationConfig(),
  });

  const userContent = correctionNote ? `${text}\n\n${correctionNote}` : text;
  const result = await model.generateContent(
    {
      contents: [{ role: "user", parts: [{ text: userContent }] }],
    },
    getRequestOptions(signal),
  );

  const content = result.response.text();
  if (!content) return {};

  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function callGeminiPdfPageSummary(
  text: string,
  correctionNote?: string,
  options: GeminiRequestOptions = {},
): Promise<unknown> {
  return runWithRetryPlan(
    "generate_pdf_page_summary",
    (entry) =>
      callGeminiPdfPageSummaryWithClient(
        entry,
        text,
        correctionNote,
        options.signal,
      ),
    options,
  );
}

async function consumeAnnotationStreamAttempt(
  entry: ClientEntry,
  text: string,
  mode: AnnotationMode,
  personality: DepthPersonality | undefined,
  options: AnnotationStreamOptions,
): Promise<Annotation[]> {
  const systemPrompt = buildSystemPrompt(mode, personality);
  const generationConfig = getGenerationConfig();

  const model = entry.client.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
    generationConfig,
  });

  const streamResult = await model.generateContentStream(
    {
      contents: [{ role: "user", parts: [{ text }] }],
    },
    getRequestOptions(options.signal),
  );

  let responseError: unknown = null;
  const responseSettled = streamResult.response
    .then(() => undefined)
    .catch((error) => {
      responseError = error;
    });

  const allAnnotations: Annotation[] = [];
  let buffer = "";

  try {
    for await (const chunk of streamResult.stream) {
      const delta = chunk.text();
      if (!delta) continue;
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
    }
  } catch (error) {
    await responseSettled;
    throw error;
  }

  await responseSettled;
  if (responseError) {
    throw responseError;
  }

  return allAnnotations;
}

async function consumeSketchStreamAttempt(
  entry: ClientEntry,
  inputText: string,
  purpose: string,
  userReactions: string,
  mode: "sketch" | "prompt",
  options: SketchStreamOptions,
): Promise<string> {
  const systemPrompt = mode === "prompt" ? promptPrompt : sketchPrompt;
  const userMessage =
    mode === "prompt"
      ? `Source Text:\n${inputText}\n\nPrompt Purpose:\n${purpose}\n\nUser's Notes and Reactions:\n${userReactions}`
      : `Input Text:\n${inputText}\n\nPurpose of Reading:\n${purpose}\n\nUser's Reactions:\n${userReactions}`;
  const model = entry.client.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
    generationConfig: {
      responseMimeType: "text/plain" as const,
      maxOutputTokens: 2048,
      temperature: 0.3,
    },
  });

  const streamResult = await model.generateContentStream(
    {
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
    },
    getRequestOptions(options.signal),
  );

  let responseError: unknown = null;
  const responseSettled = streamResult.response
    .then(() => undefined)
    .catch((error) => {
      responseError = error;
    });

  let fullText = "";

  try {
    for await (const chunk of streamResult.stream) {
      const delta = chunk.text();
      if (!delta) continue;
      fullText += delta;
      options.onChunk?.(delta);
    }
  } catch (error) {
    await responseSettled;
    throw error;
  }

  await responseSettled;
  if (responseError) {
    throw responseError;
  }

  return fullText;
}

export async function generateAnnotations(
  text: string,
  mode: AnnotationMode,
  personality?: DepthPersonality,
  options: GeminiRequestOptions = {},
): Promise<Annotation[]> {
  const firstAttempt = await callGemini(
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
  const retryAttempt = await callGemini(
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
  const attempts = buildClientAttemptPlan();
  let lastError: GeminiOperationError | null = null;
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
      const operationError = toGeminiOperationError(
        error,
        entry.keyIndex,
        attemptNumber,
        options.signal,
      );
      lastError = operationError;

      emittedAnnotations = emittedAnnotations || false;

      logGeminiEvent(
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
  logGeminiEvent(
    "warn",
    "generate_annotations_stream.buffered_fallback",
    options.logContext,
    {
      fallback_from_error_kind: lastError?.kind,
    },
  );

  try {
    const annotations = await generateAnnotations(
      text,
      mode,
      personality,
      options,
    );
    logGeminiEvent(
      "log",
      "generate_annotations_stream.buffered_fallback_succeeded",
      options.logContext,
      {
        fallback_from_error_kind: lastError?.kind,
      },
    );
    return {
      annotations,
      usedBufferedFallback: true,
    };
  } catch (fallbackError) {
    logGeminiEvent(
      "error",
      "generate_annotations_stream.buffered_fallback_failed",
      options.logContext,
      {
        fallback_from_error_kind: lastError?.kind,
        error: serializeError(fallbackError),
      },
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
  const attempts = buildClientAttemptPlan();
  let lastError: GeminiOperationError | null = null;
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
      const operationError = toGeminiOperationError(
        error,
        entry.keyIndex,
        attemptNumber,
        options.signal,
      );
      lastError = operationError;

      logGeminiEvent(
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
  options: GeminiRequestOptions = {},
): Promise<string> {
  const firstAttempt = await callGeminiPdfPageSummary(text, undefined, options);
  const firstResult = validatePdfPageSummary(firstAttempt);

  if (firstResult.errors.length === 0 && firstResult.valid) {
    return firstResult.valid.summary;
  }

  const correctionPrompt =
    `Your previous response had validation errors:\n${firstResult.errors.join("\n")}\n\n` +
    'Please fix these issues and return only valid JSON in the shape {"summary":"..."} with 1-2 concise sentences.';
  const retryAttempt = await callGeminiPdfPageSummary(
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

export function getGeminiReliabilityCounters(): Record<string, number> {
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

type GDocsChatStreamOptions = GeminiRequestOptions & {
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

// Reasoning model for long-form generation and complex structural edits
const reasoningModelName = "gemini-2.5-pro";
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

// All valid chat modes — any unknown mode string gets rejected before reaching Gemini
const VALID_GDOCS_MODES = new Set<string>(Object.keys(gdocsPromptMap));

export function isValidGDocsChatMode(mode: string): mode is GDocsChatMode {
  return VALID_GDOCS_MODES.has(mode);
}

async function consumeGDocsChatStreamAttempt(
  entry: ClientEntry,
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
  const effectiveModel = gdocsModelMap[mode] ?? modelName;
  const maxOutputTokens = gdocsMaxTokensMap[mode] ?? 2048;
  const model = entry.client.getGenerativeModel({
    model: effectiveModel,
    systemInstruction: systemPrompt,
    generationConfig: {
      responseMimeType: "text/plain" as const,
      maxOutputTokens,
      temperature: 0.7,
    },
  });

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const streamResult = await model.generateContentStream(
    { contents },
    getRequestOptions(options.signal),
  );

  let responseError: unknown = null;
  const responseSettled = streamResult.response
    .then(() => undefined)
    .catch((error) => {
      responseError = error;
    });

  let fullText = "";
  try {
    for await (const chunk of streamResult.stream) {
      const delta = chunk.text();
      if (!delta) continue;
      fullText += delta;
      options.onChunk?.(delta);
    }
  } catch (error) {
    await responseSettled;
    throw error;
  }

  await responseSettled;
  if (responseError) throw responseError;
  return fullText;
}

export async function generateGDocsChatStream(
  messages: GDocsChatMessage[],
  mode: GDocsChatMode,
  options: GDocsChatStreamOptions = {},
): Promise<string> {
  const attempts = buildClientAttemptPlan();
  let lastError: GeminiOperationError | null = null;
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
      const operationError = toGeminiOperationError(
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
): Promise<McqQuestion[]> {
  const docContextText = docContext.trim()
    ? `Existing document content:\n${docContext.trim()}\n\n`
    : "";

  const filledPrompt = mcqPromptTemplate
    .replace("{docContext}", docContextText)
    .replace("{prompt}", prompt);

  try {
    ensureClientsConfigured();
    const entry = genAIClients[0]!;
    const model = entry.client.getGenerativeModel({
      model: modelName,
      generationConfig: { maxOutputTokens: 1536, temperature: 0.8 },
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: filledPrompt }] }],
    });

    const text = result.response.text().trim();
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
const routerModelName = "gemini-3.1-flash-lite-preview";

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
): Promise<GDocsRouteResult> {
  const docText = (essayContent?.trim() || docContext?.trim()) ?? "";
  const userMessage = `User request: ${prompt}${docText ? `\n\nDocument:\n${docText.slice(0, 4000)}` : ""}`;

  try {
    ensureClientsConfigured();
    const entry = genAIClients[0]!;

    // Stage 1: quick classification
    const stage1Model = entry.client.getGenerativeModel({
      model: routerModelName,
      systemInstruction: routerSystemPrompt,
      generationConfig: { maxOutputTokens: 150, temperature: 0.1 },
    });

    const stage1Result = await stage1Model.generateContent({
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
    });

    const stage1 = parseRouteResult(stage1Result.response.text().trim());

    // Stage 2: deeper reasoning for uncertain cases
    if (stage1.confidence === "low") {
      try {
        const stage2Model = entry.client.getGenerativeModel({
          model: routerModelName,
          systemInstruction: routerDeepSystemPrompt,
          generationConfig: { maxOutputTokens: 256, temperature: 0.3 },
        });
        const stage2Result = await stage2Model.generateContent({
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
        });
        return parseRouteResult(stage2Result.response.text().trim());
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
