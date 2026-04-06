import { describe, expect, it } from "vitest";
import { validatePdfPageSummary } from "../pdf-page-summary-validator.js";

describe("validatePdfPageSummary", () => {
  it("accepts a valid summary payload", () => {
    const result = validatePdfPageSummary({
      summary: "This page introduces the core claim and grounds it in two examples.",
    });

    expect(result.errors).toEqual([]);
    expect(result.valid?.summary).toBe(
      "This page introduces the core claim and grounds it in two examples.",
    );
  });

  it("rejects invalid payloads", () => {
    const result = validatePdfPageSummary({
      summary: "   ",
    });

    expect(result.valid).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
