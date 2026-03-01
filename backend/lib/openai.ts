import type { Annotation, Intensity } from "@oddity/shared";
import OpenAI from "openai";
import { validateAnnotations } from "./schema-validator.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });
const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

interface PromptProfile {
  system_prompt: string;
  annotation_density: string;
  max_annotations_per_1000_chars: number;
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
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: config.system_prompt },
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
