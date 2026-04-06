import { describe, expect, it } from "vitest";
import {
  computePdfDocumentHash,
  discoverPdfPages,
  extractPdfPageText,
  findPdfPageElements,
} from "../pdf-page-summaries.js";

describe("pdf page summary helpers", () => {
  it("finds converted PDF pages in DOM order", () => {
    document.body.innerHTML = `
      <div id="page-container">
        <div id="pf2" data-page-no="2">Second page</div>
        <div id="pf3" data-page-no="3">Third page</div>
      </div>
    `;

    const pages = findPdfPageElements();
    expect(pages.map((page) => page.id)).toEqual(["pf2", "pf3"]);
  });

  it("extracts normalized page text without injected Oddity UI", () => {
    document.body.innerHTML = `
      <div id="page-container">
        <div id="pf1" data-page-no="1">
          Intro text
          <div data-oddity-pdf-summary-host>Ignore this summary UI</div>
          <span>with extra spacing</span>
        </div>
      </div>
    `;

    const page = document.querySelector("#pf1");
    expect(extractPdfPageText(page!)).toBe("Intro text with extra spacing");
  });

  it("reuses the converted document hash when present", async () => {
    document.body.innerHTML = `
      <div id="page-container" data-oddity-hash="sha256:existing-doc-hash">
        <div id="pf1" data-page-no="1">First page</div>
      </div>
    `;

    const pages = await discoverPdfPages();
    const hash = await computePdfDocumentHash(pages);

    expect(hash).toBe("sha256:existing-doc-hash");
  });

  it("falls back to hashing concatenated page text when needed", async () => {
    document.body.innerHTML = `
      <div id="page-container">
        <div id="pf1" data-page-no="1">First page text</div>
        <div id="pf2" data-page-no="2">Second page text</div>
      </div>
    `;

    const pages = await discoverPdfPages();
    const hash = await computePdfDocumentHash(pages);

    expect(hash.startsWith("sha256:")).toBe(true);
  });
});
