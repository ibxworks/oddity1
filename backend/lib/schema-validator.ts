import { z } from 'zod';
import type { Annotation } from '@oddity/shared';

const TextQuoteSelectorSchema = z.object({
  type: z.literal('TextQuoteSelector'),
  exact: z.string().min(1),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
});

const AnnotationContentSchema = z.object({
  note: z.string().min(1),
  why_it_matters: z.string().optional(),
  question: z.string().optional(),
});

const AnnotationSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'highlight',
    'recall',
    'provoking_question',
    'insight',
    'caveat',
    'vocabulary',
    'user_written',
  ]),
  anchor: TextQuoteSelectorSchema,
  content: AnnotationContentSchema,
});

/**
 * Validate an array of annotations, returning the valid subset
 * and error messages for invalid entries. Supports partial results.
 */
export function validateAnnotations(data: unknown): {
  valid: Annotation[];
  errors: string[];
} {
  if (!Array.isArray(data)) {
    return { valid: [], errors: ['Expected an array of annotations'] };
  }

  const valid: Annotation[] = [];
  const errors: string[] = [];

  for (let i = 0; i < data.length; i++) {
    // Normalize LLM output: "provoking question" (space) → "provoking_question" (underscore)
    const item = data[i] as Record<string, unknown> | undefined;
    if (item && typeof item.type === 'string') {
      item.type = item.type.replace(/\s+/g, '_');
    }

    const result = AnnotationSchema.safeParse(data[i]);
    if (result.success) {
      valid.push(result.data as Annotation);
    } else {
      const issues = result.error.issues
        .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
        .join('; ');
      errors.push(`Annotation[${i}]: ${issues}`);
    }
  }

  return { valid, errors };
}
