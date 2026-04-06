import type { AnnotationUsage, PdfPageSummary } from "@oddity/shared";
import { sha256 } from "../shared/hash.js";
import { showNoticeToast } from "./notice-toast.js";

const SUMMARY_HOST_ATTR = "data-oddity-pdf-summary-host";
const SUMMARY_STYLE_ID = "oddity-pdf-summary-style";

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
  hostEl: HTMLDivElement;
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

export function findPdfPageElements(doc: Document = document): HTMLElement[] {
  return Array.from(
    doc.querySelectorAll<HTMLElement>("#page-container [data-page-no]"),
  );
}

export function extractPdfPageText(pageEl: Element): string {
  const clone = pageEl.cloneNode(true) as HTMLElement;
  removeInjectedUi(clone);
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

function ensureSummaryStyles(): void {
  if (document.getElementById(SUMMARY_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = SUMMARY_STYLE_ID;
  style.textContent = `
    [${SUMMARY_HOST_ATTR}] {
      width: min(360px, calc(100% - 24px));
      margin: 12px auto 10px;
      font-family: "Fraunces", Georgia, serif;
      color: #172033;
    }

    .oddity-pdf-summary-inline-card {
      position: relative;
      background: rgba(255, 255, 255, 0.96);
      border: 1px solid rgba(15, 23, 42, 0.08);
      border-radius: 14px;
      box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
      overflow: hidden;
      cursor: default;
    }

    .oddity-pdf-summary-inline-card::before {
      content: "";
      position: absolute;
      top: 14px;
      left: 12px;
      width: 4px;
      height: calc(100% - 28px);
      border-radius: 999px;
      background: linear-gradient(180deg, #1d9bf0 0%, #4cb4ff 100%);
    }

    .oddity-pdf-summary-inline-inner {
      padding: 14px 16px 14px 28px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .oddity-pdf-summary-inline-text {
      font-size: 14px;
      line-height: 1.55;
      color: #233146;
    }

    .oddity-pdf-summary-inline-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .oddity-pdf-summary-inline-page {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #6b7280;
    }

    .oddity-pdf-summary-inline-action,
    .oddity-pdf-summary-inline-copy {
      border: 0;
      background: none;
      cursor: pointer;
      font: inherit;
      color: inherit;
    }

    .oddity-pdf-summary-inline-action {
      padding: 10px 14px;
      border-radius: 10px;
      background: #172033;
      color: white;
      font-size: 13px;
      font-weight: 600;
    }

    .oddity-pdf-summary-inline-action[disabled] {
      opacity: 0.7;
      cursor: progress;
    }

    .oddity-pdf-summary-inline-copy {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #233146;
      background: rgba(29, 155, 240, 0.1);
      transition: background 0.18s ease, transform 0.18s ease;
    }

    .oddity-pdf-summary-inline-copy:hover {
      background: rgba(29, 155, 240, 0.18);
      transform: translateY(-1px);
    }

    .oddity-pdf-summary-inline-copy.copied {
      background: rgba(34, 197, 94, 0.16);
      color: #166534;
    }

    @media (max-width: 640px) {
      [${SUMMARY_HOST_ATTR}] {
        width: calc(100% - 16px);
        margin: 10px auto 8px;
      }

      .oddity-pdf-summary-inline-inner {
        padding: 12px 14px 12px 24px;
      }

      .oddity-pdf-summary-inline-text {
        font-size: 13px;
      }
    }
  `;
  document.head.appendChild(style);
}

function buildCopyIcon(): SVGSVGElement {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
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

export class PdfPageSummaryController {
  private readonly pageStates = new Map<string, PageSummaryState>();

  readonly documentHash: string;

  constructor(
    private readonly pages: PdfPageDescriptor[],
    documentHash: string,
    private readonly options: PdfPageSummaryControllerOptions,
  ) {
    this.documentHash = documentHash;
    ensureSummaryStyles();

    for (const page of pages) {
      const hostEl = document.createElement("div");
      hostEl.setAttribute(SUMMARY_HOST_ATTR, "");
      page.element.parentElement?.insertBefore(hostEl, page.element);
      this.pageStates.set(page.pageNo, {
        page,
        summary: null,
        loading: false,
        hostEl,
      });
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
    for (const state of this.pageStates.values()) {
      state.hostEl.remove();
    }
    this.pageStates.clear();
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
    const card = document.createElement("div");
    card.className = "oddity-pdf-summary-inline-card";

    const inner = document.createElement("div");
    inner.className = "oddity-pdf-summary-inline-inner";

    if (state.summary?.summary) {
      const text = document.createElement("div");
      text.className = "oddity-pdf-summary-inline-text";
      text.textContent = state.summary.summary;
      inner.appendChild(text);

      const footer = document.createElement("div");
      footer.className = "oddity-pdf-summary-inline-footer";

      const pageLabel = document.createElement("div");
      pageLabel.className = "oddity-pdf-summary-inline-page";
      pageLabel.textContent = `Page ${state.page.pageLabel}`;

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "oddity-pdf-summary-inline-copy";
      copyBtn.title = `Copy summary for page ${state.page.pageLabel}`;
      copyBtn.appendChild(buildCopyIcon());
      copyBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void copySummaryText(state.summary!.summary, copyBtn);
      });

      footer.appendChild(pageLabel);
      footer.appendChild(copyBtn);
      inner.appendChild(footer);
    } else {
      const actionBtn = document.createElement("button");
      actionBtn.type = "button";
      actionBtn.className = "oddity-pdf-summary-inline-action";
      actionBtn.textContent = state.loading
        ? `Summarizing page ${state.page.pageLabel}...`
        : `Summarize page ${state.page.pageLabel}`;
      actionBtn.disabled = state.loading;
      actionBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.requestPageSummary(state.page.pageNo);
      });
      inner.appendChild(actionBtn);
    }

    card.appendChild(inner);
    state.hostEl.replaceChildren(card);
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
