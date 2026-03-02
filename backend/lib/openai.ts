import OpenAI from "openai";
import type { Annotation, Intensity } from "@oddity/shared";
import { validateAnnotations } from "./schema-validator.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });
const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

// Load shared prompt fragments once at startup
const promptsConfig = JSON.parse(
  readFileSync(resolve(__dirname, '../config/prompts.json'), 'utf-8'),
);
const sharedRules: string = promptsConfig.shared_rules ?? '';
const schemaExample: string = promptsConfig.schema_example ?? '';

interface PromptProfile {
  system_prompt: string;
  annotation_density: string;
  max_annotations_per_1000_chars: number;
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

export async function generateAnnotations(
  text: string,
  intensity: Intensity,
  promptConfig: PromptProfile,
): Promise<Annotation[]> {
  const firstAttempt = await callOpenAI(text, promptConfig);
  const { valid, errors } = validateAnnotations(firstAttempt);

  if (errors.length === 0) return valid;

  // Retry once with corrective prompt
  const correctionPrompt = `Your previous response had validation errors:\n${errors.join("\n")}\n\nPlease fix these issues and return a valid JSON array of annotations.`;
  const retryAttempt = await callOpenAI(text, promptConfig, correctionPrompt);
  const retryResult = validateAnnotations(retryAttempt);

  // Return whatever valid annotations we got (partial results OK)
  return retryResult.valid.length > 0 ? retryResult.valid : valid;
}

async function callOpenAI(
  text: string,
  config: PromptProfile,
  correctionNote?: string,
): Promise<unknown> {
  const systemPrompt = expandPrompt(config.system_prompt);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: text },
  ];

  if (correctionNote) {
    messages.push({ role: "user", content: correctionNote });
  }

  const supportsTemperature = !(
    model.includes("gpt-5-nano") ||
    model.includes("gpt-5-mini") ||
    model.includes("gpt-4.1-nano") ||
    model.includes("gpt-4.1-mini")
  );
  console.log("supportsTemperature:", supportsTemperature);

  const response = await openai.chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
    ...(supportsTemperature && { temperature: 0.3 }),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return [];

  try {
    const parsed = JSON.parse(content);
    return parsed.annotations ?? parsed;
  } catch {
    return [];
  }
}
