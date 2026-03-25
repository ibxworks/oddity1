import type { Annotation, AnnotationMode, DepthPersonality } from "@oddity/shared";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAnnotations } from "./schema-validator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const apiKeys = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_BACKUP1,
  process.env.GEMINI_API_KEY_BACKUP2,
].filter((k): k is string => !!k);

const genAIClients = apiKeys.map((key) => new GoogleGenerativeAI(key));
const modelName = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite-preview";

/**
 * Try an async operation with each API key client in order.
 * Only throws if all keys fail.
 */
async function withKeyRetry<T>(
  fn: (client: GoogleGenerativeAI) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < genAIClients.length; i++) {
    try {
      return await fn(genAIClients[i]!);
    } catch (err) {
      lastError = err;
      if (i < genAIClients.length - 1) {
        console.warn(`[gemini] API call failed with key ${i + 1}, trying next key...`, err);
      }
    }
  }
  throw lastError;
}

// Load prompt config once at startup
const promptsConfig = JSON.parse(
  readFileSync(resolve(__dirname, "../config/prompts.json"), "utf-8"),
);
const overviewPromptTemplate: string = promptsConfig.overview_prompt_template ?? promptsConfig.overview_prompt ?? "";
const depthPrompts: Record<string, string> = promptsConfig.depth_prompts ?? {};
const overviewPersonalities: Record<string, string> = promptsConfig.overview_personalities ?? {};

/**
 * Build the system prompt for a given mode and personality.
 */
function buildSystemPrompt(mode: AnnotationMode, personality?: DepthPersonality): string {
  if (mode === "overview") {
    const personalityText = overviewPersonalities[personality ?? "jerry"] ?? overviewPersonalities.jerry ?? "";
    return overviewPromptTemplate.replace(/\{\{PERSONALITY\}\}/g, personalityText);
  }
  // Depth mode: each personality has its own full prompt
  const key = personality ?? "jerry";
  return depthPrompts[key] ?? depthPrompts.jerry ?? "";
}

/**
 * Map raw LLM output (overview format) into Annotation objects.
 * Overview LLM returns: { anchor, prefix?, suffix?, label, summary }
 */
function mapOverviewOutput(raw: unknown[]): unknown[] {
  return raw.map((item: any) => {
    if (!item || typeof item !== "object") return item;
    // Already in Annotation format (has mode, type, anchor, content)
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
      ...(item.chunk_start && item.chunk_end ? {
        chunk: {
          start: { type: "TextQuoteSelector", exact: item.chunk_start },
          end: { type: "TextQuoteSelector", exact: item.chunk_end },
        },
      } : {}),
    };
  });
}

/**
 * Map raw LLM output (depth format) into Annotation objects.
 * Depth LLM returns: { anchor, prefix?, suffix?, type, provocation }
 */
function mapDepthOutput(raw: unknown[]): unknown[] {
  return raw.map((item: any) => {
    if (!item || typeof item !== "object") return item;
    // Already in Annotation format
    if (item.mode && item.anchor?.type === "TextQuoteSelector" && item.content) return item;

    // New prompts use "skill", old prompts used "type"; default to "caveat" when absent
    const rawType = (item.skill ?? item.type ?? "caveat").replace(/\s+/g, "_").toLowerCase();

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

/**
 * Map raw LLM output to Annotation format based on mode.
 */
function mapLlmOutput(raw: unknown[], mode: AnnotationMode): unknown[] {
  return mode === "overview" ? mapOverviewOutput(raw) : mapDepthOutput(raw);
}

/**
 * Assign globally unique IDs to annotations.
 */
function assignUniqueIds(annotations: Annotation[]): Annotation[] {
  for (const ann of annotations) {
    ann.id = randomUUID();
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

async function callGeminiWithClient(
  client: GoogleGenerativeAI,
  text: string,
  mode: AnnotationMode,
  personality?: DepthPersonality,
  correctionNote?: string,
): Promise<unknown> {
  const systemPrompt = buildSystemPrompt(mode, personality);
  const generationConfig = getGenerationConfig();

  const model = client.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
    generationConfig,
  });

  const userContent = correctionNote ? `${text}\n\n${correctionNote}` : text;
  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: userContent }] }],
  });

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
): Promise<unknown> {
  return withKeyRetry((client) =>
    callGeminiWithClient(client, text, mode, personality, correctionNote),
  );
}

export async function generateAnnotations(
  text: string,
  mode: AnnotationMode,
  personality?: DepthPersonality,
): Promise<Annotation[]> {
  const firstAttempt = await callGemini(text, mode, personality);
  const mapped = Array.isArray(firstAttempt)
    ? mapLlmOutput(firstAttempt, mode)
    : firstAttempt;
  const { valid, errors } = validateAnnotations(mapped);

  if (errors.length === 0) return assignUniqueIds(valid);

  // Retry once with corrective prompt
  const correctionPrompt = `Your previous response had validation errors:\n${errors.join("\n")}\n\nPlease fix these issues and return a valid JSON array of annotations.`;
  const retryAttempt = await callGemini(text, mode, personality, correctionPrompt);
  const retryMapped = Array.isArray(retryAttempt)
    ? mapLlmOutput(retryAttempt, mode)
    : retryAttempt;
  const retryResult = validateAnnotations(retryMapped);

  return assignUniqueIds(
    retryResult.valid.length > 0 ? retryResult.valid : valid,
  );
}

/**
 * Streaming annotation generator. Yields individual annotation objects
 * as they are parsed from the incremental JSON stream (flat array).
 */
export async function* generateAnnotationsStream(
  text: string,
  mode: AnnotationMode,
  personality?: DepthPersonality,
): AsyncGenerator<Annotation, Annotation[], unknown> {
  const systemPrompt = buildSystemPrompt(mode, personality);
  const generationConfig = getGenerationConfig();
  const allAnnotations: Annotation[] = [];

  const stream = await withKeyRetry(async (client) => {
    const model = client.getGenerativeModel({
      model: modelName,
      systemInstruction: systemPrompt,
      generationConfig,
    });
    return model.generateContentStream({
      contents: [{ role: "user", parts: [{ text }] }],
    });
  });

  let buffer = "";

  for await (const chunk of stream.stream) {
    const delta = chunk.text();
    if (!delta) continue;
    buffer += delta;

    const extracted = extractCompleteObjects(buffer);
    for (const objStr of extracted.objects) {
      try {
        const raw = JSON.parse(objStr);
        const mapped = mapLlmOutput([raw], mode);
        const { valid } = validateAnnotations(mapped);
        if (valid.length > 0) {
          valid[0]!.id = randomUUID();
          allAnnotations.push(valid[0]!);
          yield valid[0]!;
        }
      } catch {
        // Incomplete or malformed — skip
      }
    }
    buffer = extracted.remaining;
  }

  return allAnnotations;
}

// ─── Sketch Generation ───

const sketchPrompt: string = promptsConfig.sketch_prompt ?? "";

/**
 * Streaming sketch generator. Yields plain-text chunks as the LLM produces them.
 */
export async function* generateSketchStream(
  inputText: string,
  purpose: string,
  userReactions: string,
): AsyncGenerator<string, void, unknown> {
  const userMessage = `Input Text:\n${inputText}\n\nPurpose of Reading:\n${purpose}\n\nUser's Reactions:\n${userReactions}`;

  const stream = await withKeyRetry(async (client) => {
    const model = client.getGenerativeModel({
      model: modelName,
      systemInstruction: sketchPrompt,
      generationConfig: {
        responseMimeType: "text/plain" as const,
        maxOutputTokens: 2048,
        temperature: 0.3,
      },
    });
    return model.generateContentStream({
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
    });
  });

  for await (const chunk of stream.stream) {
    const delta = chunk.text();
    if (delta) yield delta;
  }
}

/**
 * Extract complete JSON objects from a buffer containing an array.
 * Tracks brace depth to find complete {...} segments.
 */
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

  for (let i = searchFrom; i < buffer.length; i++) {
    const ch = buffer[i]!;

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
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objectStart !== -1) {
        objects.push(buffer.slice(objectStart, i + 1));
        searchFrom = i + 1;
        objectStart = -1;
      }
    }
  }

  return {
    objects,
    remaining: buffer.slice(0, arrayStart + 1) + buffer.slice(searchFrom),
  };
}
