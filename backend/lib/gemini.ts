import type { Annotation, Intensity } from "@oddity/shared";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAnnotations } from "./schema-validator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");
const modelName = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";

// Load shared prompt fragments once at startup
const promptsConfig = JSON.parse(
  readFileSync(resolve(__dirname, "../config/prompts.json"), "utf-8"),
);
const sharedRules: string = promptsConfig.shared_rules ?? "";
const schemaExample: string = promptsConfig.schema_example ?? "";

interface PromptProfile {
  system_prompt: string;
  annotation_density: string;
}

/**
 * Expand template placeholders in a system prompt.
 * {{shared_rules}} → the shared anchor rules
 * {{schema_example}} → the compact JSON schema reference
 */
function expandPrompt(template: string): string {
  return template
    .replace(/\{\{shared_rules\}\}/g, sharedRules)
    .replace(/\{\{schema_example\}\}/g, schemaExample);
}

/**
 * Expand compressed field names from LLM output to standard annotation format.
 * Supports both compressed (t, a, c, e, p, s, n, w, q) and full field names.
 */
function expandCompressedAnnotations(data: unknown[]): unknown[] {
  return data.map((item: any) => {
    if (!item || typeof item !== "object") return item;

    // If already using full field names, pass through
    if (item.type && item.anchor && item.content) return item;

    const expanded: any = {
      id: item.id,
      type: item.t ?? item.type,
      anchor: undefined,
      content: undefined,
    };

    // Expand anchor: a → anchor, hardcode type: TextQuoteSelector
    const anchor = item.a ?? item.anchor;
    if (anchor && typeof anchor === "object") {
      expanded.anchor = {
        type: "TextQuoteSelector",
        exact: anchor.e ?? anchor.exact,
        prefix: anchor.p ?? anchor.prefix,
        suffix: anchor.s ?? anchor.suffix,
      };
    }

    // Expand content: c → content
    const content = item.c ?? item.content;
    if (content && typeof content === "object") {
      expanded.content = {
        note: content.n ?? content.note,
        ...((content.w ?? content.why_it_matters)
          ? { why_it_matters: content.w ?? content.why_it_matters }
          : {}),
        ...((content.q ?? content.question)
          ? { question: content.q ?? content.question }
          : {}),
      };
    }

    return expanded;
  });
}

/**
 * Assign globally unique IDs to annotations.
 * LLM-generated IDs (e.g. "ann_1") are sequential per-call and collide
 * across separate API calls for different content regions.  Replacing them
 * with UUIDs ensures margin-note dedup in the client never incorrectly
 * drops annotations from a different region.
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

async function callGemini(
  text: string,
  config: PromptProfile,
  correctionNote?: string,
): Promise<unknown> {
  const systemPrompt = expandPrompt(config.system_prompt);
  const generationConfig = getGenerationConfig();

  const model = genAI.getGenerativeModel({
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
    return parsed.annotations ?? parsed;
  } catch {
    return [];
  }
}

export async function generateAnnotations(
  text: string,
  intensity: Intensity,
  promptConfig: PromptProfile,
): Promise<Annotation[]> {
  const firstAttempt = await callGemini(text, promptConfig);
  const expanded = Array.isArray(firstAttempt)
    ? expandCompressedAnnotations(firstAttempt)
    : firstAttempt;
  const { valid, errors } = validateAnnotations(expanded);

  if (errors.length === 0) return assignUniqueIds(valid);

  // Retry once with corrective prompt
  const correctionPrompt = `Your previous response had validation errors:\n${errors.join("\n")}\n\nPlease fix these issues and return a valid JSON array of annotations.`;
  const retryAttempt = await callGemini(text, promptConfig, correctionPrompt);
  const retryExpanded = Array.isArray(retryAttempt)
    ? expandCompressedAnnotations(retryAttempt)
    : retryAttempt;
  const retryResult = validateAnnotations(retryExpanded);

  // Return whatever valid annotations we got (partial results OK)
  return assignUniqueIds(
    retryResult.valid.length > 0 ? retryResult.valid : valid,
  );
}

/**
 * Streaming annotation generator. Yields individual annotation objects
 * as they are parsed from the incremental JSON stream.
 */
export async function* generateAnnotationsStream(
  text: string,
  intensity: Intensity,
  promptConfig: PromptProfile,
): AsyncGenerator<Annotation, Annotation[], unknown> {
  const systemPrompt = expandPrompt(promptConfig.system_prompt);
  const generationConfig = getGenerationConfig();
  const allAnnotations: Annotation[] = [];

  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
    generationConfig,
  });

  const stream = await model.generateContentStream({
    contents: [{ role: "user", parts: [{ text }] }],
  });

  let buffer = "";

  for await (const chunk of stream.stream) {
    const delta = chunk.text();
    if (!delta) continue;
    buffer += delta;

    // Try to extract complete annotation objects from the buffer.
    // The LLM outputs: {"annotations": [{...}, {...}, ...]}
    // We look for complete objects within the array by tracking brace depth.
    const extracted = extractCompleteObjects(buffer);
    for (const objStr of extracted.objects) {
      try {
        const raw = JSON.parse(objStr);
        const expanded = expandCompressedAnnotations([raw]);
        const { valid } = validateAnnotations(expanded);
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

  // Find the start of the array content (after "annotations": [)
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

  // Keep from the last successfully extracted position
  return {
    objects,
    remaining: buffer.slice(0, arrayStart + 1) + buffer.slice(searchFrom),
  };
}
