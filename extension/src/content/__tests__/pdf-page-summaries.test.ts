import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfPageSummary } from "@oddity/shared";
import {
  PdfPageSummaryController,
  computePdfDocumentHash,
  createPdfPageSummaryController,
  discoverPdfPages,
  extractPdfPageText,
  findPdfPageElements,
  normalizePdfDom,
} from "../pdf-page-summaries.js";

function renderPdfPages(): void {
  document.body.innerHTML = `
    <div id="page-container">
      <div
        id="pf1"
        data-page-no="1"
        style="width: 612px; height: 792px; position: relative; background: white;"
      >
        <div style="padding: 24px;">First page text</div>
      </div>
      <div
        id="pf2"
        data-page-no="2"
        style="width: 612px; height: 792px; position: relative; background: white;"
      >
        <div style="padding: 24px;">Second page text</div>
      </div>
    </div>
  `;
}

function renderNestedPdfPages(): void {
  document.body.innerHTML = `
    <div id="converted-shell" style="width: 760px;">
      <div class="converter-stage">
        <div id="page-container">
          <div
            id="pf1"
            data-page-no="1"
            style="width: 612px; height: 792px; position: relative; background: white;"
          >
            <div style="padding: 24px;">First page text</div>
          </div>
          <div
            id="pf2"
            data-page-no="2"
            style="width: 612px; height: 792px; position: relative; background: white;"
          >
            <div style="padding: 24px;">Second page text</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildSummary(pageNo: string, summaryText: string): PdfPageSummary {
  return {
    id: `summary_${pageNo}`,
    url: "https://example.com/file.pdf",
    document_hash: "sha256:doc-hash",
    page_no: pageNo,
    page_text_hash: `sha256:text-${pageNo}`,
    summary: summaryText,
    page_title: "Example PDF",
    created_at: "2026-04-06T00:00:00.000Z",
    updated_at: "2026-04-06T00:00:00.000Z",
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("pdf page summary helpers", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

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
          <span data-oddity-id="ann_1">Ignore highlighted text wrapper</span>
          <span>with extra spacing</span>
        </div>
      </div>
    `;

    const page = document.querySelector("#pf1");
    expect(extractPdfPageText(page!)).toBe(
      "Intro text Ignore highlighted text wrapper with extra spacing",
    );
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

  it("normalizePdfDom is a no-op when #page-container [data-page-no] already exists", () => {
    document.body.innerHTML = `
      <div id="page-container">
        <div id="pf1" data-page-no="1">Page one</div>
        <div id="pf2" data-page-no="2">Page two</div>
      </div>
    `;
    normalizePdfDom();
    expect(document.querySelectorAll("#page-container [data-page-no]")).toHaveLength(2);
    expect(document.querySelectorAll("#page-container")).toHaveLength(1);
  });

  it("normalizePdfDom adds data-page-no when #page-container children lack it", () => {
    document.body.innerHTML = `
      <div id="page-container">
        <div>First</div>
        <div>Second</div>
      </div>
    `;
    normalizePdfDom();
    const pages = document.querySelectorAll("#page-container [data-page-no]");
    expect(pages).toHaveLength(2);
    expect((pages[0] as HTMLElement).dataset.pageNo).toBe("1");
    expect((pages[1] as HTMLElement).dataset.pageNo).toBe("2");
  });

  it("normalizePdfDom wraps FreeConvert-style id=pageN elements in #page-container", () => {
    document.body.innerHTML = `
      <div id="page1">First page content</div>
      <div id="page2">Second page content</div>
    `;
    normalizePdfDom();
    const container = document.querySelector("#page-container");
    expect(container).not.toBeNull();
    const pages = document.querySelectorAll("#page-container [data-page-no]");
    expect(pages).toHaveLength(2);
    expect((pages[0] as HTMLElement).dataset.pageNo).toBe("1");
    expect((pages[1] as HTMLElement).dataset.pageNo).toBe("2");
  });

  it("normalizePdfDom falls back to single synthetic page when no structure found", () => {
    document.body.innerHTML = `<p>Some paragraph</p><p>Another paragraph</p>`;
    normalizePdfDom();
    const container = document.querySelector("#page-container");
    expect(container).not.toBeNull();
    const pages = document.querySelectorAll("#page-container [data-page-no]");
    expect(pages).toHaveLength(1);
    expect((pages[0] as HTMLElement).dataset.pageNo).toBe("1");
    expect(pages[0]!.textContent).toContain("Some paragraph");
  });

  it("mounts one launcher root immediately before the first page instead of inline hosts", async () => {
    renderPdfPages();

    const controller = await createPdfPageSummaryController({
      onGeneratePageSummary: vi.fn(),
    });

    expect(controller).toBeInstanceOf(PdfPageSummaryController);
    expect(document.querySelectorAll("[data-oddity-pdf-summary-host]")).toHaveLength(1);

    const firstPage = document.querySelector("#pf1");
    expect(
      firstPage?.previousElementSibling?.getAttribute("data-oddity-pdf-summary-host"),
    ).toBe("");
    expect(firstPage?.parentElement).toBe(document.querySelector("#page-container"));
    expect(
      document
        .querySelector("#pf2")
        ?.previousElementSibling?.hasAttribute("data-oddity-pdf-summary-host"),
    ).toBe(false);
  });

  it("mounts the launcher in the first page flow while keeping the modal backdrop on body", async () => {
    renderNestedPdfPages();

    await createPdfPageSummaryController({
      onGeneratePageSummary: vi.fn(),
    });

    const host = document.querySelector<HTMLElement>("[data-oddity-pdf-summary-host]");
    const firstPage = document.querySelector<HTMLElement>("#pf1");
    const pageContainer = document.querySelector<HTMLElement>("#page-container");
    const backdrop = document.querySelector<HTMLElement>(
      ".oddity-pdf-summary-modal-backdrop",
    );

    expect(host).not.toBeNull();
    expect(pageContainer).not.toBeNull();
    expect(firstPage).not.toBeNull();
    expect(host?.parentElement).toBe(pageContainer);
    expect(host?.nextElementSibling).toBe(firstPage);
    expect(backdrop?.parentElement).toBe(document.body);
    expect(pageContainer?.contains(backdrop!)).toBe(false);
  });

  it("opens and closes the modal from the launcher, backdrop, and Escape", async () => {
    renderPdfPages();

    await createPdfPageSummaryController({
      onGeneratePageSummary: vi.fn(),
    });

    const launcher = document.querySelector<HTMLButtonElement>(
      ".oddity-pdf-summary-launcher",
    );
    const backdrop = document.querySelector<HTMLDivElement>(
      ".oddity-pdf-summary-modal-backdrop",
    );

    expect(launcher).not.toBeNull();
    expect(backdrop).not.toBeNull();
    expect(backdrop?.classList.contains("open")).toBe(false);

    launcher!.click();
    expect(backdrop?.classList.contains("open")).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(backdrop?.classList.contains("open")).toBe(false);

    launcher!.click();
    expect(backdrop?.classList.contains("open")).toBe(true);

    backdrop!.click();
    expect(backdrop?.classList.contains("open")).toBe(false);
  });

  it("renders preview cards, disables repeat generation while loading, and swaps in the summary card", async () => {
    renderPdfPages();

    let resolveSummary:
      | ((value: {
          summary: PdfPageSummary;
        }) => void)
      | undefined;
    const onGeneratePageSummary = vi.fn(
      () =>
        new Promise<{ summary: PdfPageSummary }>((resolve) => {
          resolveSummary = resolve;
        }),
    );

    await createPdfPageSummaryController({
      onGeneratePageSummary,
    });

    document
      .querySelector<HTMLButtonElement>(".oddity-pdf-summary-launcher")!
      .click();

    expect(document.querySelectorAll(".oddity-pdf-summary-preview-frame")).toHaveLength(2);

    const firstCard = document.querySelectorAll<HTMLDivElement>(
      ".oddity-pdf-summary-modal-card",
    )[0]!;
    const firstButton = firstCard.querySelector<HTMLButtonElement>(
      ".oddity-pdf-summary-action",
    )!;

    firstButton.click();

    expect(onGeneratePageSummary).toHaveBeenCalledTimes(1);
    expect(
      firstCard.querySelector<HTMLButtonElement>(".oddity-pdf-summary-action")
        ?.disabled,
    ).toBe(true);
    expect(firstCard.textContent).toContain("Summarizing...");

    firstCard.querySelector<HTMLButtonElement>(".oddity-pdf-summary-action")!.click();
    expect(onGeneratePageSummary).toHaveBeenCalledTimes(1);

    resolveSummary?.({
      summary: buildSummary("1", "Saved summary for the first page."),
    });
    await flushPromises();

    expect(firstCard.querySelector(".oddity-pdf-summary-preview-frame")).toBeNull();
    expect(firstCard.textContent).toContain("Saved summary for the first page.");
    expect(firstCard.querySelector(".oddity-pdf-summary-copy")).not.toBeNull();
  });

  it("hydrates existing summaries, copies them, and keeps the modal open when a card scrolls to its page", async () => {
    renderPdfPages();

    const onGeneratePageSummary = vi.fn();
    const controller = await createPdfPageSummaryController({
      onGeneratePageSummary,
    });
    expect(controller).not.toBeNull();

    const pageOne = document.querySelector<HTMLElement>("#page-container #pf1")!;
    const scrollSpy = vi.fn();
    Object.defineProperty(pageOne, "scrollIntoView", {
      configurable: true,
      value: scrollSpy,
    });

    controller!.hydrate([buildSummary("1", "Hydrated summary text.")]);
    expect(controller!.getCards()[0]).toMatchObject({
      pageNo: "1",
      summary: "Hydrated summary text.",
      loading: false,
    });
    expect(onGeneratePageSummary).not.toHaveBeenCalled();

    document
      .querySelector<HTMLButtonElement>(".oddity-pdf-summary-launcher")!
      .click();

    const summaryCard = document.querySelectorAll<HTMLDivElement>(
      ".oddity-pdf-summary-modal-card",
    )[0]!;
    const copyButton = summaryCard.querySelector<HTMLButtonElement>(
      ".oddity-pdf-summary-copy",
    )!;

    copyButton.click();
    await flushPromises();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "Hydrated summary text.",
    );
    expect(scrollSpy).not.toHaveBeenCalled();

    summaryCard.click();
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(
      document
        .querySelector(".oddity-pdf-summary-modal-backdrop")
        ?.classList.contains("open"),
    ).toBe(true);
  });
});
