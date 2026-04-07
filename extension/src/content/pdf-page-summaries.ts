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
  showPreview?: boolean;
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
    .oddity-pdf-summary-launcher {
      position: fixed;
      top: 24px;
      left: 24px;
      z-index: ${SUMMARY_MODAL_Z_INDEX - 1};
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 12.5px 20px;
      border-radius: 999px;
      border: 1px solid #e2e8f0;
      background: #fff;
      color: #0f172a;
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      opacity: 0.85;
      transition: opacity 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
    }

    .oddity-pdf-summary-launcher:hover {
      opacity: 1;
      box-shadow: 0 4px 16px rgba(0,0,0,0.12);
      transform: translateY(-1px);
    }

    .oddity-pdf-summary-launcher.oddity-fab-hidden {
      opacity: 0;
      pointer-events: none;
    }

    .oddity-pdf-summary-modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: ${SUMMARY_MODAL_Z_INDEX};
      background: #fff;
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

    .oddity-pdf-summary-modal-backdrop.open .oddity-pdf-summary-modal {
      animation: oddity-summary-modal-in 0.2s ease;
    }

    @keyframes oddity-summary-modal-in {
      from { opacity: 0; transform: scale(0.97) translateY(8px); }
      to   { opacity: 1; transform: scale(1) translateY(0); }
    }

    .oddity-pdf-summary-modal {
      width: 100vw;
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: #fff;
      font-family: inherit;
    }

    .oddity-pdf-summary-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 32px;
      border-bottom: 1px solid #e2e8f0;
      background: #fff;
    }

    .oddity-pdf-summary-modal-title {
      font-family: Helvetica, Arial, sans-serif;
      font-size: 18px;
      font-weight: 500;
      color: #0f172a;
      letter-spacing: -0.01em;
    }

    .oddity-pdf-summary-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border: 0;
      background: transparent;
      color: #64748b;
      cursor: pointer;
      font-size: 24px;
      line-height: 1;
      border-radius: 4px;
    }

    .oddity-pdf-summary-close:hover {
      background: #f1f5f9;
      color: #0f172a;
    }

    .oddity-pdf-summary-modal-body {
      flex: 1;
      overflow: auto;
      padding: 32px;
      background: #f8fafc;
    }

    .oddity-pdf-summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 24px;
      max-width: 1400px;
      margin: 0 auto;
    }

    .oddity-pdf-summary-modal-card {
      position: relative;
      display: flex;
      flex-direction: column;
      height: 400px;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.02);
      overflow: hidden;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
      cursor: pointer;
    }

    .oddity-pdf-summary-modal-card:hover {
      border-color: #cbd5e1;
      box-shadow: 0 4px 12px rgba(0,0,0,0.04);
    }

    .oddity-pdf-summary-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid #f1f5f9;
      background: #fff;
    }

    .oddity-pdf-summary-card-content {
      flex: 1;
      overflow-y: auto;
      padding: 20px 16px;
      display: flex;
      flex-direction: column;
    }

    .oddity-pdf-summary-page-pill {
      font-family: Helvetica, Arial, sans-serif;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #64748b;
    }

    .oddity-pdf-summary-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 16px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      background: #fff;
      color: #0f172a;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      margin-top: auto;
      width: 100%;
    }

    .oddity-pdf-summary-action:hover {
      background: #f8fafc;
      border-color: #cbd5e1;
    }

    .oddity-pdf-summary-action[disabled] {
      opacity: 0.6;
      cursor: default;
      pointer-events: none;
    }

    .oddity-pdf-summary-copy {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: #64748b;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }

    .oddity-pdf-summary-copy:hover {
      background: #f1f5f9;
      color: #334155;
    }

    .oddity-pdf-summary-copy.copied {
      color: #10b981;
    }

    .oddity-pdf-summary-text {
      font-size: 13px;
      line-height: 1.6;
      color: #334155;
    }

    .oddity-pdf-summary-preview-shell {
      display: flex;
      justify-content: center;
      align-items: center;
      flex: 1;
      background: #f8fafc;
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 16px;
      border: 1px solid #f1f5f9;
    }

    .oddity-pdf-summary-preview-frame {
      width: ${PREVIEW_WIDTH_PX}px;
      background: #fff;
      border: 1px solid #e2e8f0;
      box-shadow: 0 2px 4px -1px rgba(0, 0, 0, 0.05);
    }

    .oddity-pdf-summary-preview-inner {
      width: ${PREVIEW_WIDTH_PX}px;
      transform-origin: top left;
      overflow: hidden;
    }

    .oddity-pdf-summary-preview-page {
      transform-origin: top left;
      pointer-events: none !important;
      user-select: none;
    }

    @media (max-width: 760px) {
      .oddity-pdf-summary-modal-header {
        padding: 16px 20px;
      }
      .oddity-pdf-summary-modal-body {
        padding: 16px;
      }
      .oddity-pdf-summary-grid {
        grid-template-columns: 1fr;
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

    this.launcherBtn = this.createLauncherButton();
    this.launcherBtn.setAttribute(SUMMARY_HOST_ATTR, "");

    this.backdropEl = this.createModalBackdrop();
    this.backdropEl.setAttribute(SUMMARY_HOST_ATTR, "");

    this.modalEl = this.createModal();
    this.gridEl = document.createElement("div");
    this.gridEl.className = "oddity-pdf-summary-grid";

    const modalBody = document.createElement("div");
    modalBody.className = "oddity-pdf-summary-modal-body";
    modalBody.appendChild(this.gridEl);
    this.modalEl.appendChild(modalBody);
    this.backdropEl.appendChild(this.modalEl);

    document.body.appendChild(this.launcherBtn);
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
    this.launcherBtn.remove();
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
    button.setAttribute("aria-label", "Open page summaries");
    button.addEventListener("click", () => this.openModal());

    const svgNS = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(svgNS, "svg");
    icon.setAttribute("width", "18");
    icon.setAttribute("height", "18");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.setAttribute("aria-hidden", "true");
    const path1 = document.createElementNS(svgNS, "path");
    path1.setAttribute("d", "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z");
    const path2 = document.createElementNS(svgNS, "polyline");
    path2.setAttribute("points", "14 2 14 8 20 8");
    const path3 = document.createElementNS(svgNS, "line");
    path3.setAttribute("x1", "16");
    path3.setAttribute("y1", "13");
    path3.setAttribute("x2", "8");
    path3.setAttribute("y2", "13");
    const path4 = document.createElementNS(svgNS, "line");
    path4.setAttribute("x1", "16");
    path4.setAttribute("y1", "17");
    path4.setAttribute("x2", "8");
    path4.setAttribute("y2", "17");
    const path5 = document.createElementNS(svgNS, "polyline");
    path5.setAttribute("points", "10 9 9 9 8 9");
    icon.appendChild(path1);
    icon.appendChild(path2);
    icon.appendChild(path3);
    icon.appendChild(path4);
    icon.appendChild(path5);

    const label = document.createElement("span");
    label.textContent = "Summaries";

    button.appendChild(icon);
    button.appendChild(label);
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
    modal.setAttribute("aria-label", "Page Summaries");

    const header = document.createElement("div");
    header.className = "oddity-pdf-summary-modal-header";

    const title = document.createElement("div");
    title.className = "oddity-pdf-summary-modal-title";
    title.textContent = "Page Summaries";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "oddity-pdf-summary-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.closeModal());

    header.appendChild(title);
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
      this.closeModal();
      this.scrollToPage(state.page.pageNo);
    };

    if (state.summary?.summary && !state.showPreview) {
      card.appendChild(this.buildSummaryCardHeader(state));
      
      const content = document.createElement("div");
      content.className = "oddity-pdf-summary-card-content";

      const text = document.createElement("div");
      text.className = "oddity-pdf-summary-text";
      text.textContent = state.summary.summary;
      
      content.appendChild(text);

      const actionBtn = document.createElement("button");
      actionBtn.type = "button";
      actionBtn.className = "oddity-pdf-summary-action";
      actionBtn.textContent = "Show Thumbnail";
      actionBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        state.showPreview = true;
        this.renderState(state);
      });
      content.appendChild(actionBtn);

      card.appendChild(content);
      return;
    }

    card.appendChild(this.buildPreviewCardHeader(state.page.pageLabel));
    
    const content = document.createElement("div");
    content.className = "oddity-pdf-summary-card-content";
    content.appendChild(createPreviewFrame(state.page.element));

    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "oddity-pdf-summary-action";

    if (state.summary?.summary) {
      actionBtn.textContent = "Show Summary";
      actionBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        state.showPreview = false;
        this.renderState(state);
      });
    } else {
      actionBtn.textContent = state.loading ? "Summarizing..." : "Summarize";
      actionBtn.disabled = state.loading;
      actionBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.requestPageSummary(state.page.pageNo);
      });
    }
    
    content.appendChild(actionBtn);
    card.appendChild(content);
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
    const modalBody = this.backdropEl.querySelector<HTMLElement>(".oddity-pdf-summary-modal-body");
    if (modalBody) modalBody.scrollTop = 0;

    this.launcherBtn.classList.add("oddity-fab-hidden");
    this.backdropEl.classList.add("open");
    this.backdropEl.setAttribute("aria-hidden", "false");
  }

  private closeModal(): void {
    this.launcherBtn.classList.remove("oddity-fab-hidden");
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
