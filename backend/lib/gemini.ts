import type { Annotation, AnnotationMode } from "@oddity/shared";
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

/**
 * Build the system prompt for overview mode.
 */
function buildSystemPrompt(mode: AnnotationMode): string {
  return overviewPromptTemplate;
}

// ─── Executor Types ───

export type Verdict = "TAKE" | "CAUTION" | "THROW";

export interface ExecutorAssignment {
  anchor_index: number;
  anchor_text: string;
  match_reason: string;
  ai_introduced: boolean;
}

export interface ExecutorAnnotationResult {
  anchor_index: number;
  anchor_text: string;
  worldview: string;
  verdict: Verdict;
  ai_introduced: boolean;
  provocation: string;
}

export interface ExecutorSummary {
  takes: { count: number; pattern: string };
  cautions: { count: number; pattern: string };
  throws: { count: number; pattern: string };
  overall: string;
}

export interface ExecutorResult {
  annotations: ExecutorAnnotationResult[];
  summary: ExecutorSummary;
}

/**
 * Build the system prompt for an annotator call.
 * The annotator receives the router's anchor assignments and the full worldview file.
 */
function buildExecutorPrompt(
  worldviewName: string,
  worldviewContent: string,
  assignments: ExecutorAssignment[],
): string {
  const routerOutput = assignments.map((a) => ({
    anchor_index: a.anchor_index,
    anchor_text: a.anchor_text,
    worldview: worldviewName,
    match_reason: a.match_reason,
    ai_introduced: a.ai_introduced,
  }));

  return `You are the Annotator. You receive a text, a set of anchors with an assigned worldview, and the worldview file. For each anchor, you write a provocation grounded in the assigned worldview that forces the user to decide whether to take or throw the claim. You assign a verdict. You return annotations and a summary.

You are not a teacher. You do not explain. You do not soften. You surface the hidden cost, the failure condition, the unstated dependency — and you leave the final judgment to the user.
---
## Inputs

1. The original text (provided as the user message).
2. The router output:
${JSON.stringify(routerOutput, null, 2)}
3. The worldview file for ${worldviewName}:

${worldviewContent}
---
## Instructions

### Step 1: Read the Assigned Worldview
For each anchor in the router output, locate the specific concept or model referenced in match_reason. Read the surrounding context in the worldview file to understand the full argument behind that concept.
Do not rely on general knowledge of the thinker. Use the worldview file as your source.

### Step 2: Write the Provocation
For each anchor, write a provocation from the assigned worldview.

A provocation IS:
- A specific objection, hidden cost, alternative framing, or failure condition surfaced by the worldview's framework
- Grounded in a named concept or specific argument from the worldview file — not a vague gesture at the thinker's general philosophy
- Something that forces the user to decide whether the claim survives scrutiny
- Maximum 25 words

A provocation is NOT:
- A restatement of what the text says
- A generic challenge that could apply to any text ("Is this evidence strong enough?")
- An instruction to the reader ("Consider whether…", "Think about…")
- A resolved observation ("This may be problematic, though the author does address it later")
- A softened hedge when a direct observation is warranted
- A compliment or agreement

The provocation must be impossible to apply to any other anchor in the text.

### Step 3: Assign a Verdict
For each anchor, assign one verdict:
- TAKE — The claim survives pressure-testing. The provocation sharpens it but does not break it.
- CAUTION — The claim is directionally right but has a hidden cost, unstated dependency, or breaks under a specific condition.
- THROW — The claim fails under scrutiny. The provocation identifies a structural flaw, false premise, or misdiagnosis.

Verdict rules:
- The verdict is a signal, not a command. The user decides.
- The provocation must contain enough context for the user to evaluate the verdict independently.
- Do not default to CAUTION. Commit to a position. CAUTION is for genuinely conditional claims, not for hedging.
---
## Output Format
Return a JSON object with two fields: annotations and summary.
{
  "annotations": [
    {
      "anchor_index": 1,
      "anchor_text": "The exact sentence from the text.",
      "worldview": "${worldviewName}",
      "verdict": "TAKE",
      "ai_introduced": false,
      "provocation": "The provocation text, 25 words max."
    }
  ],
  "summary": {
    "takes": { "count": 0, "pattern": "One sentence describing the pattern across all TAKE verdicts." },
    "cautions": { "count": 0, "pattern": "One sentence describing the pattern across all CAUTION verdicts." },
    "throws": { "count": 0, "pattern": "One sentence describing the pattern across all THROW verdicts." },
    "overall": "2-3 sentences identifying where the text is strongest, where it breaks, and what's missing."
  }
}

Field rules:
- anchor_index: Must match the index from the router output.
- anchor_text: Exact sentence from the original text. Must match the router output.
- worldview: Must match the worldview assigned by the router. Do not override.
- verdict: One of "TAKE", "CAUTION", "THROW".
- ai_introduced: Carry over from the router output. Do not change.
- provocation: Maximum 25 words. Must be grounded in a specific concept from the worldview file.
- summary.overall: Maximum 3 sentences.
---
## Constraints
- Follow the router's assignments. Do not change which worldview is assigned to which anchor. Do not skip anchors. Do not add new anchors.
- Use ONLY the worldview file provided. Never invent frameworks or attribute ideas not present in the file.
- Maximum 25 words per provocation. No exceptions.
- Every provocation must be traceable to a specific concept in the worldview file.
- Do not explain the worldview to the user. The provocation must be self-contained.
- Output valid JSON only. No markdown wrapping, no commentary before or after the JSON.`;
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
 * Map raw LLM output to Annotation format (overview mode only).
 * Depth mode is handled by the planner/executor pipeline in annotate.ts.
 */
function mapLlmOutput(raw: unknown[], _mode: AnnotationMode): unknown[] {
  return mapOverviewOutput(raw);
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
  correctionNote?: string,
): Promise<unknown> {
  const systemPrompt = buildSystemPrompt(mode);
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
  correctionNote?: string,
): Promise<unknown> {
  return withKeyRetry((client) =>
    callGeminiWithClient(client, text, mode, correctionNote),
  );
}

export async function generateAnnotations(
  text: string,
  mode: AnnotationMode,
): Promise<Annotation[]> {
  const firstAttempt = await callGemini(text, mode);
  const mapped = Array.isArray(firstAttempt)
    ? mapLlmOutput(firstAttempt, mode)
    : firstAttempt;
  const { valid, errors } = validateAnnotations(mapped);

  if (errors.length === 0) return assignUniqueIds(valid);

  // Retry once with corrective prompt
  const correctionPrompt = `Your previous response had validation errors:\n${errors.join("\n")}\n\nPlease fix these issues and return a valid JSON array of annotations.`;
  const retryAttempt = await callGemini(text, mode, correctionPrompt);
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
): AsyncGenerator<Annotation, Annotation[], unknown> {
  const systemPrompt = buildSystemPrompt(mode);
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

// ─── Planner Call (Call 1) ───

/**
 * Gemini call for the annotation planner.
 * Takes a system prompt and the full text as user message.
 * Returns raw JSON string for parsing by the planner.
 */
export async function plannerCall(
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  return withKeyRetry(async (client) => {
    const model = client.getGenerativeModel({
      model: modelName,
      systemInstruction: systemPrompt,
      generationConfig: {
        responseMimeType: "application/json" as const,
        maxOutputTokens: 2048,
        temperature: 0.2,
      },
    });
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
    });
    return result.response.text();
  });
}

// ─── Executor Call (Call 2) ───

const EMPTY_EXECUTOR_RESULT: ExecutorResult = {
  annotations: [],
  summary: {
    takes: { count: 0, pattern: "" },
    cautions: { count: 0, pattern: "" },
    throws: { count: 0, pattern: "" },
    overall: "",
  },
};

/**
 * Execute annotations for a set of pre-assigned anchors using a specific worldview.
 * Returns verdict + provocation for each anchor, plus a summary.
 */
export async function executeAnnotations(
  text: string,
  worldviewName: string,
  worldviewContent: string,
  assignments: ExecutorAssignment[],
): Promise<ExecutorResult> {
  const systemPrompt = buildExecutorPrompt(worldviewName, worldviewContent, assignments);

  return withKeyRetry(async (client) => {
    const model = client.getGenerativeModel({
      model: modelName,
      systemInstruction: systemPrompt,
      generationConfig: {
        responseMimeType: "application/json" as const,
        maxOutputTokens: 4096,
        temperature: 0.3,
      },
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text }] }],
    });

    const content = result.response.text();
    if (!content) return EMPTY_EXECUTOR_RESULT;

    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          annotations: Array.isArray(parsed.annotations) ? parsed.annotations : [],
          summary: parsed.summary ?? EMPTY_EXECUTOR_RESULT.summary,
        };
      }
      // Fallback: if it returned a flat array, wrap it
      if (Array.isArray(parsed)) {
        return { annotations: parsed, summary: EMPTY_EXECUTOR_RESULT.summary };
      }
      return EMPTY_EXECUTOR_RESULT;
    } catch {
      return EMPTY_EXECUTOR_RESULT;
    }
  });
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
