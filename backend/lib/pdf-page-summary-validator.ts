import { z } from "zod";

const PdfPageSummaryPayloadSchema = z.object({
  summary: z
    .string()
    .trim()
    .min(1, "summary is required")
    .max(600, "summary must be 600 characters or fewer"),
});

export function validatePdfPageSummary(
  data: unknown,
): { valid: { summary: string } | null; errors: string[] } {
  const result = PdfPageSummaryPayloadSchema.safeParse(data);
  if (result.success) {
    return {
      valid: {
        summary: result.data.summary.trim(),
      },
      errors: [],
    };
  }

  return {
    valid: null,
    errors: result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    }),
  };
}
