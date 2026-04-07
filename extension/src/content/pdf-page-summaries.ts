import type { AnnotationUsage, PdfPageSummary } from "@oddity/shared";
import { sha256 } from "../shared/hash.js";
import { showNoticeToast } from "./notice-toast.js";

const SUMMARY_HOST_ATTR = "data-oddity-pdf-summary-host";
const SUMMARY_STYLE_ID = "oddity-pdf-summary-style";
const SUMMARY_MODAL_Z_INDEX = 2147483647;
const PREVIEW_WIDTH_PX = 220;
const PREVIEW_FALLBACK_WIDTH_PX = 816;
const PREVIEW_FALLBACK_HEIGHT_PX = 1056;

export type PdfPageDescriptor = {
  pageNo: string;
  pageLabel: string;
  pageTextHash: string;
  text: string;
  element: HTMLElement;
};

export type PdfPageSummaryCard = {
  pageNo: string;
  pageLabel: string;
  summary: string | null;
  loading: boolean;
};

export type PdfPageSummaryGenerateResult =
  | {
      summary: PdfPageSummary;
      usage?: AnnotationUsage;
      error?: undefined;
      limitReached?: boolean;
    }
  | {
      error: string;
      usage?: AnnotationUsage;
      limitReached?: boolean;
      summary?: undefined;
    };

type PdfPageSummaryControllerOptions = {
  onCardsChanged?: (cards: PdfPageSummaryCard[]) => void;
  onGeneratePageSummary: (
    page: PdfPageDescriptor,
  ) => Promise<PdfPageSummaryGenerateResult>;
};

type PageSummaryState = {
  page: PdfPageDescriptor;
  summary: PdfPageSummary | null;
  loading: boolean;
  cardEl: HTMLDivElement;
};

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function removeInjectedUi(root: ParentNode): void {
  root
    .querySelectorAll(
      `[${SUMMARY_HOST_ATTR}], oddity-arguments-box, #oddity-margin-notes, #oddity-overlay, #oddity-page-dim`,
    )
    .forEach((node) => node.remove());
}

function clearOddityPreviewArtifacts(root: ParentNode): void {
  root.querySelectorAll("[data-oddity-id]").forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;

    while (span.firstChild) {
      parent.insertBefore(span.firstChild, span);
    }

    parent.removeChild(span);
  });

  root.querySelectorAll<HTMLElement>("[data-oddity-highlight-bg]").forEach((el) => {
    el.style.backgroundColor = "";
    delete el.dataset.oddityHighlightBg;
  });
}

function sanitizePreviewClone(pageEl: HTMLElement): HTMLElement {
  const clone = pageEl.cloneNode(true) as HTMLElement;
  removeInjectedUi(clone);
  clearOddityPreviewArtifacts(clone);
  clone.removeAttribute("id");
  clone.removeAttribute("data-page-no");

  clone.setAttribute("aria-hidden", "true");
  clone.querySelectorAll<HTMLElement>(
    "a, button, input, select, textarea, [tabindex], [contenteditable]",
  ).forEach((el) => {
    el.setAttribute("tabindex", "-1");
    el.setAttribute("aria-hidden", "true");
    if (el.hasAttribute("contenteditable")) {
      el.setAttribute("contenteditable", "false");
    }
  });

  return clone;
}

function readPx(value: string | null | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getElementDimension(
  element: HTMLElement,
  dimension: "width" | "height",
): number {
  const rect = element.getBoundingClientRect();
  const rectValue = dimension === "width" ? rect.width : rect.height;
  if (rectValue > 0) return rectValue;

  const inlineValue = readPx(
    dimension === "width" ? element.style.width : element.style.height,
  );
  if (inlineValue > 0) return inlineValue;

  const computed = getComputedStyle(element);
  const computedValue = readPx(
    dimension === "width" ? computed.width : computed.height,
  );
  if (computedValue > 0) return computedValue;

  const scrollValue = dimension === "width" ? element.scrollWidth : element.scrollHeight;
  if (scrollValue > 0) return scrollValue;

  return dimension === "width"
    ? PREVIEW_FALLBACK_WIDTH_PX
    : PREVIEW_FALLBACK_HEIGHT_PX;
}

function ensureSummaryStyles(): void {
  if (document.getElementById(SUMMARY_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = SUMMARY_STYLE_ID;
  style.textContent = `
    [${SUMMARY_HOST_ATTR}].oddity-pdf-summary-root {
      width: min(1120px, calc(100% - 32px));
      margin: 18px auto 22px;
      font-family: "Fraunces", Georgia, serif;
      color: #172033;
    }

    .oddity-pdf-summary-launcher {
      display: inline-flex;
      align-items: center;
      gap: 14px;
      border: 1px solid rgba(15, 23, 42, 0.08);
      border-radius: 18px;
      padding: 14px 18px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(244, 248, 255, 0.96) 100%);
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
      color: #172033;
      cursor: pointer;
      transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
    }

    .oddity-pdf-summary-launcher:hover {
      transform: translateY(-1px);
      box-shadow: 0 20px 48px rgba(15, 23, 42, 0.12);
      border-color: rgba(29, 155, 240, 0.22);
    }

    .oddity-pdf-summary-launcher-copy {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 3px;
    }

    .oddity-pdf-summary-launcher-title {
      font-size: 16px;
      font-weight: 700;
      line-height: 1.2;
    }

    .oddity-pdf-summary-launcher-subtitle {
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 12px;
      line-height: 1.4;
      color: #526074;
    }

    .oddity-pdf-summary-launcher-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 34px;
      height: 34px;
      padding: 0 10px;
      border-radius: 999px;
      background: rgba(23, 32, 51, 0.06);
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #233146;
    }

    .oddity-pdf-summary-modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: ${SUMMARY_MODAL_Z_INDEX};
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: clamp(16px, 4vh, 34px) 24px;
      background: rgba(15, 23, 42, 0.34);
      backdrop-filter: blur(8px);
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 0.2s ease, visibility 0.2s ease;
    }

    .oddity-pdf-summary-modal-backdrop.open {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }

    .oddity-pdf-summary-modal {
      width: min(1240px, calc(100vw - 48px));
      max-height: calc(100vh - 48px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.7);
      border-radius: 28px;
      background:
        linear-gradient(180deg, rgba(250, 252, 255, 0.98) 0%, rgba(244, 248, 255, 0.98) 100%);
      box-shadow:
        0 32px 96px rgba(2, 6, 23, 0.3),
        0 10px 24px rgba(15, 23, 42, 0.14);
    }

    .oddity-pdf-summary-modal-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      padding: 24px 28px 18px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.22);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.94) 0%, rgba(248, 251, 255, 0.9) 100%);
    }

    .oddity-pdf-summary-modal-eyebrow {
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #73839a;
    }

    .oddity-pdf-summary-modal-title {
      margin-top: 6px;
      font-size: clamp(24px, 2.8vw, 32px);
      font-weight: 700;
      line-height: 1.1;
      color: #111827;
    }

    .oddity-pdf-summary-modal-subtitle {
      margin-top: 6px;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #526074;
    }

    .oddity-pdf-summary-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border: 0;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.06);
      color: #172033;
      cursor: pointer;
      font-size: 24px;
      line-height: 1;
      transition: background 0.18s ease, transform 0.18s ease;
    }

    .oddity-pdf-summary-close:hover {
      background: rgba(15, 23, 42, 0.1);
      transform: translateY(-1px);
    }

    .oddity-pdf-summary-modal-body {
      flex: 1;
      overflow: auto;
      padding: 24px 28px 28px;
    }

    .oddity-pdf-summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 18px;
      align-items: start;
    }

    .oddity-pdf-summary-modal-card {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-height: 220px;
      padding: 18px;
      border: 1px solid rgba(17, 24, 39, 0.08);
      border-radius: 22px;
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 16px 34px rgba(15, 23, 42, 0.08);
      cursor: pointer;
      transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
      overflow: hidden;
    }

    .oddity-pdf-summary-modal-card:hover {
      transform: translateY(-2px);
      border-color: rgba(29, 155, 240, 0.2);
      box-shadow: 0 22px 40px rgba(15, 23, 42, 0.12);
    }

    .oddity-pdf-summary-modal-card::before {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(29, 155, 240, 0.05) 0%, rgba(255, 255, 255, 0) 32%);
      pointer-events: none;
    }

    .oddity-pdf-summary-card-header,
    .oddity-pdf-summary-card-footer {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .oddity-pdf-summary-page-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 7px 12px;
      border-radius: 999px;
      background: rgba(23, 32, 51, 0.07);
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #233146;
    }

    .oddity-pdf-summary-action,
    .oddity-pdf-summary-copy {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 0;
      border-radius: 999px;
      cursor: pointer;
      transition: transform 0.18s ease, background 0.18s ease, opacity 0.18s ease;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
    }

    .oddity-pdf-summary-action:hover,
    .oddity-pdf-summary-copy:hover {
      transform: translateY(-1px);
    }

    .oddity-pdf-summary-action {
      padding: 10px 14px;
      background: #172033;
      color: white;
    }

    .oddity-pdf-summary-action[disabled] {
      opacity: 0.7;
      cursor: progress;
      transform: none;
    }

    .oddity-pdf-summary-copy {
      padding: 10px 14px;
      background: rgba(29, 155, 240, 0.1);
      color: #233146;
    }

    .oddity-pdf-summary-copy.copied {
      background: rgba(34, 197, 94, 0.16);
      color: #166534;
    }

    .oddity-pdf-summary-text {
      position: relative;
      z-index: 1;
      font-size: 14px;
      line-height: 1.65;
      color: #233146;
    }

    .oddity-pdf-summary-preview-shell {
      position: relative;
      z-index: 1;
      display: flex;
      justify-content: center;
      padding: 12px;
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(236, 243, 252, 0.96) 0%, rgba(247, 250, 255, 0.94) 100%);
      border: 1px solid rgba(148, 163, 184, 0.18);
      overflow: hidden;
    }

    .oddity-pdf-summary-preview-frame {
      width: ${PREVIEW_WIDTH_PX}px;
      max-width: 100%;
      overflow: hidden;
      border-radius: 12px;
      background: white;
      border: 1px solid rgba(15, 23, 42, 0.08);
      box-shadow: 0 14px 32px rgba(15, 23, 42, 0.12);
    }

    .oddity-pdf-summary-preview-inner {
      position: relative;
      width: ${PREVIEW_WIDTH_PX}px;
      overflow: hidden;
      transform-origin: top left;
    }

    .oddity-pdf-summary-preview-page {
      transform-origin: top left;
      pointer-events: none !important;
      user-select: none;
      overflow: hidden;
      filter: saturate(0.98);
    }

    .oddity-pdf-summary-card-hint {
      position: relative;
      z-index: 1;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 12px;
      line-height: 1.45;
      color: #6b7280;
    }

    @media (max-width: 760px) {
      [${SUMMARY_HOST_ATTR}].oddity-pdf-summary-root {
        width: calc(100% - 20px);
        margin: 14px auto 18px;
      }

      .oddity-pdf-summary-launcher {
        width: 100%;
        justify-content: space-between;
      }

      .oddity-pdf-summary-modal-backdrop {
        padding: 12px;
      }

      .oddity-pdf-summary-modal {
        width: calc(100vw - 24px);
        max-height: calc(100vh - 24px);
        border-radius: 22px;
      }

      .oddity-pdf-summary-modal-header {
        padding: 20px 18px 16px;
      }

      .oddity-pdf-summary-modal-body {
        padding: 18px;
      }

      .oddity-pdf-summary-grid {
        grid-template-columns: 1fr;
      }

      .oddity-pdf-summary-modal-card {
        padding: 16px;
      }
    }
  `;
  document.head.appendChild(style);
}

function buildCopyIcon(): SVGSVGElement {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 22 22");
  svg.setAttribute("fill", "none");

  const path1 = document.createElementNS(svgNS, "path");
  path1.setAttribute(
    "d",
    "M17.4883 5.5H7.94922C6.59655 5.5 5.5 6.59655 5.5 7.94922V17.4883C5.5 18.8409 6.59655 19.9375 7.94922 19.9375H17.4883C18.8409 19.9375 19.9375 18.8409 19.9375 17.4883V7.94922C19.9375 6.59655 18.8409 5.5 17.4883 5.5Z",
  );
  path1.setAttribute("stroke", "currentColor");
  path1.setAttribute("stroke-width", "1.375");
  path1.setAttribute("stroke-linejoin", "round");

  const path2 = document.createElementNS(svgNS, "path");
  path2.setAttribute(
    "d",
    "M16.4785 5.5L16.5 4.46875C16.4982 3.83113 16.2441 3.22014 15.7932 2.76928C15.3424 2.31841 14.7314 2.06431 14.0938 2.0625H4.8125C4.08382 2.06465 3.38559 2.35508 2.87034 2.87034C2.35508 3.38559 2.06465 4.08382 2.0625 4.8125V14.0938C2.06431 14.7314 2.31841 15.3424 2.76928 15.7932C3.22014 16.2441 3.83113 16.4982 4.46875 16.5H5.5",
  );
  path2.setAttribute("stroke", "currentColor");
  path2.setAttribute("stroke-width", "1.375");
  path2.setAttribute("stroke-linecap", "round");
  path2.setAttribute("stroke-linejoin", "round");

  svg.appendChild(path1);
  svg.appendChild(path2);
  return svg;
}

async function copySummaryText(
  summary: string,
  button?: HTMLButtonElement,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(summary);
    button?.classList.add("copied");
    window.setTimeout(() => button?.classList.remove("copied"), 1400);
    showNoticeToast("Summary copied");
  } catch {
    showNoticeToast("Couldn't copy summary");
  }
}

function createPagePill(pageLabel: string): HTMLDivElement {
  const pill = document.createElement("div");
  pill.className = "oddity-pdf-summary-page-pill";
  pill.textContent = `Page ${pageLabel}`;
  return pill;
}

function createPreviewFrame(pageEl: HTMLElement): HTMLDivElement {
  const width = getElementDimension(pageEl, "width");
  const height = getElementDimension(pageEl, "height");
  const scale = Math.min(PREVIEW_WIDTH_PX / width, 1);
  const frameHeight = Math.max(140, Math.round(height * scale));

  const previewShell = document.createElement("div");
  previewShell.className = "oddity-pdf-summary-preview-shell";

  const previewFrame = document.createElement("div");
  previewFrame.className = "oddity-pdf-summary-preview-frame";
  previewFrame.style.height = `${frameHeight}px`;

  const previewInner = document.createElement("div");
  previewInner.className = "oddity-pdf-summary-preview-inner";
  previewInner.style.height = `${frameHeight}px`;

  const previewClone = sanitizePreviewClone(pageEl);
  previewClone.classList.add("oddity-pdf-summary-preview-page");
  previewClone.style.width = `${width}px`;
  previewClone.style.height = `${height}px`;
  previewClone.style.transform = `scale(${scale})`;

  previewInner.appendChild(previewClone);
  previewFrame.appendChild(previewInner);
  previewShell.appendChild(previewFrame);
  return previewShell;
}

/**
 * Normalizes the converted PDF DOM so that `#page-container [data-page-no]`
 * always exists, regardless of which converter produced the HTML.
 *
 * Cascading checks:
 * 1. `#page-container [data-page-no]` already exists → no-op (Marker/pdf2htmlEX)
 * 2. `#page-container` exists but children lack `data-page-no` → inject attrs
 * 3. No `#page-container`, but `id="pageN"` elements found (FreeConvert pattern)
 *    → wrap them and inject attrs
 * 4. No recognizable structure → wrap all body children in a single synthetic page
 */
export function normalizePdfDom(doc: Document = document): void {
  if (doc.querySelector("#page-container [data-page-no]")) return;

  let container = doc.querySelector<HTMLElement>("#page-container");

  if (!container) {
    const pageEls = Array.from(
      doc.querySelectorAll<HTMLElement>("[id]"),
    ).filter((el) => /^page\d+$/.test(el.id));

    if (pageEls.length > 0) {
      container = doc.createElement("div");
      container.id = "page-container";
      pageEls[0]!.parentElement!.insertBefore(container, pageEls[0]!);
      for (const el of pageEls) container.appendChild(el);
    } else {
      container = doc.createElement("div");
      container.id = "page-container";
      const page = doc.createElement("div");
      page.setAttribute("data-page-no", "1");
      while (doc.body.firstChild) page.appendChild(doc.body.firstChild);
      container.appendChild(page);
      doc.body.appendChild(container);
      return;
    }
  }

  Array.from(container.children).forEach((child, i) => {
    if (!(child as HTMLElement).dataset.pageNo) {
      (child as HTMLElement).setAttribute("data-page-no", String(i + 1));
    }
  });
}

export function findPdfPageElements(doc: Document = document): HTMLElement[] {
  return Array.from(
    doc.querySelectorAll<HTMLElement>("#page-container [data-page-no]"),
  );
}

export function extractPdfPageText(pageEl: Element): string {
  const clone = pageEl.cloneNode(true) as HTMLElement;
  removeInjectedUi(clone);
  clearOddityPreviewArtifacts(clone);
  return normalizeWhitespace(clone.textContent ?? "");
}

export async function computePdfDocumentHash(
  pages: Array<{ text: string }>,
  doc: Document = document,
): Promise<string> {
  const container = doc.querySelector<HTMLElement>("#page-container");
  const existingHash = container?.dataset.oddityHash;
  if (existingHash) return existingHash;
  return sha256(pages.map((page) => page.text).join("\n\n"));
}

export async function discoverPdfPages(
  doc: Document = document,
): Promise<PdfPageDescriptor[]> {
  const elements = findPdfPageElements(doc);
  const pages: PdfPageDescriptor[] = [];

  for (const [index, element] of elements.entries()) {
    const pageNo = element.dataset.pageNo?.trim();
    if (!pageNo) continue;

    const text = extractPdfPageText(element);
    const pageTextHash = await sha256(text);
    pages.push({
      pageNo,
      pageLabel: String(index + 1),
      pageTextHash,
      text,
      element,
    });
  }

  return pages;
}

export class PdfPageSummaryController {
  private readonly pageStates = new Map<string, PageSummaryState>();
  private readonly rootEl: HTMLDivElement;
  private readonly launcherBtn: HTMLButtonElement;
  private readonly backdropEl: HTMLDivElement;
  private readonly modalEl: HTMLDivElement;
  private readonly gridEl: HTMLDivElement;

  readonly documentHash: string;

  constructor(
    private readonly pages: PdfPageDescriptor[],
    documentHash: string,
    private readonly options: PdfPageSummaryControllerOptions,
  ) {
    this.documentHash = documentHash;
    ensureSummaryStyles();

    const firstPage = this.pages[0]?.element;
    const launcherParent = firstPage?.parentElement;
    if (!firstPage || !launcherParent || !document.body) {
      throw new Error("PDF page summaries require discovered PDF pages to exist");
    }

    this.rootEl = document.createElement("div");
    this.rootEl.className = "oddity-pdf-summary-root";
    this.rootEl.setAttribute(SUMMARY_HOST_ATTR, "");

    this.launcherBtn = this.createLauncherButton();
    this.backdropEl = this.createModalBackdrop();
    this.modalEl = this.createModal();
    this.gridEl = document.createElement("div");
    this.gridEl.className = "oddity-pdf-summary-grid";

    const modalBody = document.createElement("div");
    modalBody.className = "oddity-pdf-summary-modal-body";
    modalBody.appendChild(this.gridEl);
    this.modalEl.appendChild(modalBody);
    this.backdropEl.appendChild(this.modalEl);

    this.rootEl.appendChild(this.launcherBtn);
    launcherParent.insertBefore(this.rootEl, firstPage);
    document.body.appendChild(this.backdropEl);

    document.addEventListener("keydown", this.handleKeydown);

    for (const page of pages) {
      const cardEl = document.createElement("div");
      this.pageStates.set(page.pageNo, {
        page,
        summary: null,
        loading: false,
        cardEl,
      });
      this.gridEl.appendChild(cardEl);
    }

    this.renderAll();
  }

  hydrate(summaries: PdfPageSummary[]): void {
    for (const summary of summaries) {
      const state = this.pageStates.get(summary.page_no);
      if (!state) continue;
      state.summary = summary;
      state.loading = false;
    }
    this.renderAll();
  }

  getCards(): PdfPageSummaryCard[] {
    return this.pages.map((page) => {
      const state = this.pageStates.get(page.pageNo)!;
      return {
        pageNo: page.pageNo,
        pageLabel: page.pageLabel,
        summary: state.summary?.summary ?? null,
        loading: state.loading,
      };
    });
  }

  async requestPageSummary(pageNo: string): Promise<void> {
    const state = this.pageStates.get(pageNo);
    if (!state || state.loading || state.summary) return;

    state.loading = true;
    this.renderState(state);
    this.emitCardsChanged();

    const result = await this.options.onGeneratePageSummary(state.page);

    state.loading = false;
    if (result.summary) {
      state.summary = result.summary;
    } else if (result.error) {
      showNoticeToast(result.error);
    }

    this.renderState(state);
    this.emitCardsChanged();
  }

  scrollToPage(pageNo: string): void {
    const state = this.pageStates.get(pageNo);
    state?.page.element.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  destroy(): void {
    document.removeEventListener("keydown", this.handleKeydown);
    this.backdropEl.remove();
    this.rootEl.remove();
    this.pageStates.clear();
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.isOpen()) {
      this.closeModal();
    }
  };

  private createLauncherButton(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "oddity-pdf-summary-launcher";
    button.addEventListener("click", () => this.openModal());

    const copyWrap = document.createElement("span");
    copyWrap.className = "oddity-pdf-summary-launcher-copy";

    const title = document.createElement("span");
    title.className = "oddity-pdf-summary-launcher-title";
    title.textContent = "Per-page summaries";

    const subtitle = document.createElement("span");
    subtitle.className = "oddity-pdf-summary-launcher-subtitle";
    subtitle.textContent = "Open a clean overview of every converted PDF page.";

    copyWrap.appendChild(title);
    copyWrap.appendChild(subtitle);

    const count = document.createElement("span");
    count.className = "oddity-pdf-summary-launcher-count";
    count.textContent = `${this.pages.length}`;

    button.appendChild(copyWrap);
    button.appendChild(count);
    return button;
  }

  private createModalBackdrop(): HTMLDivElement {
    const backdrop = document.createElement("div");
    backdrop.className = "oddity-pdf-summary-modal-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        this.closeModal();
      }
    });
    return backdrop;
  }

  private createModal(): HTMLDivElement {
    const modal = document.createElement("div");
    modal.className = "oddity-pdf-summary-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Per-page summaries");

    const header = document.createElement("div");
    header.className = "oddity-pdf-summary-modal-header";

    const copyWrap = document.createElement("div");

    const eyebrow = document.createElement("div");
    eyebrow.className = "oddity-pdf-summary-modal-eyebrow";
    eyebrow.textContent = "Converted PDF";

    const title = document.createElement("div");
    title.className = "oddity-pdf-summary-modal-title";
    title.textContent = "Per-page summaries";

    const subtitle = document.createElement("div");
    subtitle.className = "oddity-pdf-summary-modal-subtitle";
    subtitle.textContent = `Review ${this.pages.length} pages, summarize any missing ones, and copy saved summaries without leaving the document.`;

    copyWrap.appendChild(eyebrow);
    copyWrap.appendChild(title);
    copyWrap.appendChild(subtitle);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "oddity-pdf-summary-close";
    closeBtn.setAttribute("aria-label", "Close per-page summaries");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.closeModal());

    header.appendChild(copyWrap);
    header.appendChild(closeBtn);
    modal.appendChild(header);
    return modal;
  }

  private emitCardsChanged(): void {
    this.options.onCardsChanged?.(this.getCards());
  }

  private renderAll(): void {
    for (const state of this.pageStates.values()) {
      this.renderState(state);
    }
    this.emitCardsChanged();
  }

  private renderState(state: PageSummaryState): void {
    const card = state.cardEl;
    card.className = "oddity-pdf-summary-modal-card";
    card.replaceChildren();

    card.onclick = () => {
      this.scrollToPage(state.page.pageNo);
    };

    if (state.summary?.summary) {
      card.appendChild(this.buildSummaryCardHeader(state));

      const text = document.createElement("div");
      text.className = "oddity-pdf-summary-text";
      text.textContent = state.summary.summary;
      card.appendChild(text);

      const hint = document.createElement("div");
      hint.className = "oddity-pdf-summary-card-hint";
      hint.textContent = "Click anywhere on this card to jump to the page.";
      card.appendChild(hint);
      return;
    }

    card.appendChild(this.buildPreviewCardHeader(state.page.pageLabel));
    card.appendChild(createPreviewFrame(state.page.element));

    const footer = document.createElement("div");
    footer.className = "oddity-pdf-summary-card-footer";

    const hint = document.createElement("div");
    hint.className = "oddity-pdf-summary-card-hint";
    hint.textContent = "Open the page or generate a quick summary.";
    footer.appendChild(hint);

    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "oddity-pdf-summary-action";
    actionBtn.textContent = state.loading ? "Summarizing..." : "Summarize";
    actionBtn.disabled = state.loading;
    actionBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.requestPageSummary(state.page.pageNo);
    });
    footer.appendChild(actionBtn);

    card.appendChild(footer);
  }

  private buildPreviewCardHeader(pageLabel: string): HTMLDivElement {
    const header = document.createElement("div");
    header.className = "oddity-pdf-summary-card-header";
    header.appendChild(createPagePill(pageLabel));
    return header;
  }

  private buildSummaryCardHeader(state: PageSummaryState): HTMLDivElement {
    const header = document.createElement("div");
    header.className = "oddity-pdf-summary-card-header";
    header.appendChild(createPagePill(state.page.pageLabel));

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "oddity-pdf-summary-copy";
    copyBtn.title = `Copy summary for page ${state.page.pageLabel}`;
    copyBtn.appendChild(buildCopyIcon());

    const label = document.createElement("span");
    label.textContent = "Copy";
    copyBtn.appendChild(label);

    copyBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void copySummaryText(state.summary!.summary, copyBtn);
    });

    header.appendChild(copyBtn);
    return header;
  }

  private isOpen(): boolean {
    return this.backdropEl.classList.contains("open");
  }

  private openModal(): void {
    this.backdropEl.classList.add("open");
    this.backdropEl.setAttribute("aria-hidden", "false");
  }

  private closeModal(): void {
    this.backdropEl.classList.remove("open");
    this.backdropEl.setAttribute("aria-hidden", "true");
  }
}

export async function createPdfPageSummaryController(
  options: PdfPageSummaryControllerOptions,
): Promise<PdfPageSummaryController | null> {
  const pages = await discoverPdfPages();
  if (pages.length === 0) return null;

  const documentHash = await computePdfDocumentHash(pages);
  return new PdfPageSummaryController(pages, documentHash, options);
}
