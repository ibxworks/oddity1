import { describe, expect, it, vi } from "vitest";
import {
  getGDocsEditInlineErrorMessage,
  resolveGDocsDocumentText,
} from "../gdocs-helpers.js";

describe("resolveGDocsDocumentText", () => {
  it("returns API text when the Docs API read succeeds", async () => {
    const readApiText = vi.fn(async () => ({ text: "Fresh API text" }));
    const readExportText = vi.fn(async () => "Export text");

    const result = await resolveGDocsDocumentText({
      docId: "doc-1",
      readApiText,
      readExportText,
      fallbackTexts: ["Cached fallback"],
    });

    expect(result).toEqual({
      text: "Fresh API text",
      source: "api",
      error: undefined,
    });
    expect(readExportText).not.toHaveBeenCalled();
  });

  it("falls back to exported document text when the Docs API auth is misconfigured", async () => {
    const readApiText = vi.fn(async () => ({
      text: "",
      error: "GDocsAuthConfigError:bad client id",
    }));
    const readExportText = vi.fn(async () => "Export fallback");

    const result = await resolveGDocsDocumentText({
      docId: "doc-2",
      readApiText,
      readExportText,
      fallbackTexts: ["Cached fallback"],
    });

    expect(result).toEqual({
      text: "Export fallback",
      source: "export",
      error: "GDocsAuthConfigError:bad client id",
    });
  });

  it("preserves the last non-empty fallback when both live reads fail", async () => {
    const result = await resolveGDocsDocumentText({
      docId: "doc-3",
      readApiText: async () => ({
        text: "",
        error: "GDocsAuthRequiredError:user interaction required",
      }),
      readExportText: async () => "",
      fallbackTexts: ["", "Stored session draft"],
    });

    expect(result).toEqual({
      text: "Stored session draft",
      source: "fallback",
      error: "GDocsAuthRequiredError:user interaction required",
    });
  });
});

describe("getGDocsEditInlineErrorMessage", () => {
  it("shows a dedicated auth/config message for OAuth client failures", () => {
    expect(
      getGDocsEditInlineErrorMessage("GDocsAuthConfigError:bad client id"),
    ).toContain("OAuth client is misconfigured");
  });

  it("keeps the locate-text message for anchor misses", () => {
    expect(
      getGDocsEditInlineErrorMessage("find text not found in document"),
    ).toContain("Couldn't locate the text to edit");
  });
});
