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

const AnnotationModeSchema = z.enum(['overview', 'depth']);

const AllAnnotationTypes = z.enum([
  // Overview labels
  'core_claim',
  'evidence',
  'outcome',
  'background',
  'transition',
  // Depth types
  'caveat',
  'counterargument',
  'alternative',
  'fallacy',
  'criteria',
  'perspective',
  'consequence',
  'insight',
  'recall',
  'study',
  'translation',
  'vocabulary',
  // User-written
  'user_written',
  // Legacy (backward compat for cached data)
  'assumption',
  'open_question',
]);

const AnnotationSchema = z.object({
  id: z.string().min(1),
  mode: AnnotationModeSchema,
  type: AllAnnotationTypes,
  label: z.string().optional(),
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
    // Normalize LLM output: spaces → underscores, lowercase
    const item = data[i] as Record<string, unknown> | undefined;
    if (item && typeof item.type === 'string') {
      item.type = item.type.replace(/\s+/g, '_').toLowerCase();
    }
    if (item && typeof item.mode === 'string') {
      item.mode = item.mode.toLowerCase();
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
