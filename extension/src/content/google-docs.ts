import type { Annotation, TextQuoteSelector } from '@oddity/shared';
import { MAX_TEXT_LENGTH } from '@oddity/shared';
import { prepareWithSegments, layout, layoutWithLines } from '@chenglou/pretext';
import type { DetectedRegion } from './detector.js';
import type { ExtractedContent } from './extractor.js';
import type { AbsoluteRect } from './renderer/overlay.js';
import { sendMessage } from '../shared/messaging.js';

// ─── Detection ───

export function isGoogleDocs(): boolean {
  return window.location.hostname === 'docs.google.com';
}

/**
 * Extract the Google Docs document ID from the current URL.
 * URL format: https://docs.google.com/document/d/DOCUMENT_ID/edit
 */
export function getGoogleDocsId(): string | null {
  const match = window.location.pathname.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

/**
 * Fetch the plain text of a Google Docs document via the export URL.
 * Uses the user's existing Google session (credentials: 'include').
 * Returns null if the document is not accessible or fetch fails.
 */
export async function fetchGoogleDocsText(docId: string): Promise<string | null> {
  try {
    const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
    const result = await sendMessage<{ text?: string; error?: string }>({ action: 'fetchUrl', payload: { url } });
    if (!result || result.error) {
      console.warn(`[Oddity 1] GDocs: export fetch failed: ${result?.error}`);
      return null;
    }
    return result.text?.trim() ?? null;
  } catch (err) {
    console.warn('[Oddity 1] GDocs: export fetch error', err);
    return null;
  }
}

/**
 * Selectors tried in order to find the Google Docs editor container.
 * Google Docs' DOM class names have evolved; we try multiple to stay robust.
 * We want the container that holds paragraph text, not the canvas overlay.
 */
const GDOCS_REGION_SELECTORS = [
  '.kix-paginateddocumentplugin', // Canvas mode: paginated document container
  '.kix-appview-editor',          // Legacy DOM mode: main editor viewport
  '.kix-page',                    // Per-page container
  '.docs-texteventtarget-iframe', // Inner iframe fallback
];

/**
 * Selectors for paragraph-level elements within the region.
 * Used for text extraction and rough positioning.
 */
const GDOCS_PARAGRAPH_SELECTORS = [
  '.kix-paragraphrenderer',
  '[class*="paragraphrenderer"]',
];

/**
 * Selectors for word-level nodes within paragraphs.
 * Used for fine-grained position mapping.
 */
const GDOCS_WORD_SELECTORS = [
  '.kix-wordhtmlgenerator-word-node',
  '[class*="word-node"]',
];

/**
 * Detect the Google Docs editor as a single readable region.
 * Returns one region = the entire document editor container.
 * Falls back through multiple selectors for robustness across Docs versions.
 */
export function detectGoogleDocsRegions(): DetectedRegion[] {
  for (const selector of GDOCS_REGION_SELECTORS) {
    const els = document.querySelectorAll(selector);
    if (els.length === 0) continue;

    // Accept elements that have canvas tiles (canvas mode) OR paragraph text (DOM mode).
    // Also require the element to be visible — hidden tab panels have zero dimensions.
    const withContent = Array.from(els).filter(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false; // Hidden/inactive tab
      if (el.querySelectorAll('canvas').length > 0) return true;
      if (el.querySelectorAll('.kix-paragraphrenderer, [class*="paragraphrenderer"]').length > 0) return true;
      const text = el.textContent?.trim() ?? '';
      return text.length > 20;
    });

    if (withContent.length > 0) {
      // Prefer the element with the most canvas tiles (actual document, not sidebar)
      const best = withContent.reduce((a, b) =>
        b.querySelectorAll('canvas').length > a.querySelectorAll('canvas').length ? b : a
      );
      console.log(`[Oddity 1] GDocs: found editor via selector "${selector}"`);
      return [{
        id: 'google-docs-document',
        element: best,
        source: 'adapter' as const,
      }];
    }
  }

  return [];
}

/**
 * Check whether the Google Docs editor DOM is ready (paragraphs exist with text).
 * Used to decide when to start observing for content.
 */
export function isGoogleDocsEditorReady(): boolean {
  for (const selector of GDOCS_PARAGRAPH_SELECTORS) {
    const p = document.querySelector(selector);
    if (p && (p.textContent?.trim().length ?? 0) > 0) return true;
  }
  return false;
}

// ─── Extraction ───

function getParagraphEls(root: Element): Element[] {
  for (const selector of GDOCS_PARAGRAPH_SELECTORS) {
    const els = root.querySelectorAll(selector);
    if (els.length > 0) return Array.from(els);
  }
  return [];
}

function getWordNodeEls(root: Element): Element[] {
  for (const selector of GDOCS_WORD_SELECTORS) {
    const els = root.querySelectorAll(selector);
    if (els.length > 0) return Array.from(els);
  }
  return [];
}

/**
 * Extract text from a Google Docs document.
 * Primary: fetches the export URL using the user's browser session — reliable, full text.
 * Fallback: reads DOM paragraph elements (partial, works only in non-canvas mode).
 */
export async function extractGoogleDocsText(region: DetectedRegion): Promise<ExtractedContent | null> {
  const docId = getGoogleDocsId();

  // Primary: use the export URL (works as long as the user has access to the doc)
  if (docId) {
    const exported = await fetchGoogleDocsText(docId);
    if (exported && exported.length > 0) {
      let text = exported.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (text.length > MAX_TEXT_LENGTH) {
        text = text.slice(0, MAX_TEXT_LENGTH);
      }
      text = text.trim();
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      if (wordCount > 0) {
        console.log(`[Oddity 1] GDocs: exported ${wordCount} words via export URL`);
        _cachedDocText = text; // Cache for canvas-mode positioning
        return { regionId: region.id, text, wordCount, element: region.element };
      }
    }
  }

  // Fallback: DOM extraction (works in non-canvas/older Docs versions)
  const paragraphs = getParagraphEls(region.element);
  let text: string;
  if (paragraphs.length > 0) {
    text = Array.from(paragraphs)
      .map(p => p.textContent?.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  } else {
    text = (region.element.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  if (!text) return null;
  if (text.length > MAX_TEXT_LENGTH) text = text.slice(0, MAX_TEXT_LENGTH);
  text = text.trim();

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) return null;

  console.log(`[Oddity 1] GDocs: extracted ${wordCount} words from DOM (fallback)`);
  return { regionId: region.id, text, wordCount, element: region.element };
}

// ─── Canvas Mode Positioning ───

/** Cached full document text from the export URL, used for canvas-mode positioning. */
let _cachedDocText: string | null = null;

/**
 * GDocs canvas mode: text is painted on <canvas> tiles, no DOM text nodes.
 * Uses the cached export text + pretext line layout to estimate screen positions.
 *
 * Strategy:
 *  1. Find char offset of anchor in the full doc text
 *  2. Split text into paragraphs; layout each with pretext to count lines
 *  3. Sum lines before the target paragraph to get its Y offset
 *  4. Find target line within paragraph; compute rect from canvas top + margins
 */
function findAnnotationRectsCanvasMode(
  _ignored: HTMLElement, // kept for call-site compat; we resolve canvases from scrollContainer
  scrollContainer: HTMLElement,
  annotation: Annotation,
): { rects: AbsoluteRect[]; anchorNode: Element | null } {
  if (!_cachedDocText) return { rects: [], anchorNode: null };

  const fullText = _cachedDocText;
  const exact = annotation.anchor.exact;

  const charOffset = fullText.toLowerCase().indexOf(exact.toLowerCase());
  if (charOffset === -1) return { rects: [], anchorNode: null };

  const sy = scrollContainer.scrollTop;
  const sx = scrollContainer.scrollLeft;

  // Build a deduplicated list of page-level elements: one entry per visual page.
  // GDocs stacks multiple canvas layers per page (content + selection + cursor),
  // so we must deduplicate — otherwise pageIndex math will be wrong.
  //
  // Prefer .kix-page wrapper divs (always one per page). Fall back to canvases
  // deduplicated by offsetTop proximity (layers on the same page share the same top).
  let pageEls: HTMLElement[];
  const kixPages = Array.from(scrollContainer.querySelectorAll<HTMLElement>('.kix-page'))
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 400 && r.height > 600;
    });

  if (kixPages.length > 0) {
    pageEls = kixPages.sort((a, b) => a.offsetTop - b.offsetTop);
  } else {
    // No .kix-page elements — deduplicate canvas tiles by offsetTop.
    const sorted = Array.from(scrollContainer.querySelectorAll<HTMLElement>('canvas'))
      .filter(c => {
        const r = c.getBoundingClientRect();
        return r.width > 400 && r.height > 600;
      })
      .sort((a, b) => a.offsetTop - b.offsetTop);

    // Keep only the first canvas of each page (others are stacked layers at same offsetTop).
    pageEls = [];
    let lastTop = -Infinity;
    for (const c of sorted) {
      if (c.offsetTop - lastTop > 200) { // gap > 200px means a new page
        pageEls.push(c);
        lastTop = c.offsetTop;
      }
    }
  }

  if (pageEls.length === 0) return { rects: [], anchorNode: null };

  // Use the first page element to derive page dimensions (all pages share same size).
  const cr0 = pageEls[0]!.getBoundingClientRect();
  const pageW = cr0.width;
  const pageH = cr0.height;

  // Standard GDocs US Letter: 816×1056 at 96dpi. Margins: 1 inch = 96px.
  // Use floating-point arithmetic throughout — rounding per-line accumulates
  // to 10-25px error over 50 lines, which is visually very noticeable.
  const leftMarginPx = pageW * (96 / 816);
  const topMarginPx = pageH * (96 / 1056);
  const textWidthPx = pageW - 2 * leftMarginPx;

  // GDocs default: 11pt Arial, 1.15 line spacing. 11pt = 14.667px at 96dpi.
  const fontSize = pageW * (14.667 / 816);
  const lineHeight = fontSize * 1.15;
  const font = `${Math.round(fontSize)}px Arial`;
  const linesPerPage = (pageH - 2 * topMarginPx) / lineHeight;

  // Walk paragraphs, accumulating line count until we reach the annotation.
  const paragraphs = fullText.split('\n');
  let cumChars = 0;
  let cumLines = 0;
  let targetLineInPara = 0;

  for (const para of paragraphs) {
    const paraLen = para.length + 1; // +1 for the \n
    if (cumChars + paraLen > charOffset) {
      // Annotation is in this paragraph — find which line within it.
      const offsetInPara = charOffset - cumChars;
      try {
        const prepared = prepareWithSegments(para || ' ', font);
        const result = layoutWithLines(prepared, textWidthPx, lineHeight);
        let charsSeen = 0;
        for (let i = 0; i < result.lines.length; i++) {
          const lineLen = result.lines[i]!.text.length;
          if (offsetInPara <= charsSeen + lineLen) {
            targetLineInPara = i;
            break;
          }
          charsSeen += lineLen;
          if (i === result.lines.length - 1) targetLineInPara = i;
        }
      } catch {
        const charsPerLine = Math.max(1, Math.floor(textWidthPx / (fontSize * 0.55)));
        targetLineInPara = Math.floor(offsetInPara / charsPerLine);
      }
      break;
    }
    cumChars += paraLen;
    try {
      // Use layout() (not layoutWithLines) — we only need lineCount, not line text.
      const prepared = prepareWithSegments(para || ' ', font);
      cumLines += layout(prepared, textWidthPx, lineHeight).lineCount;
    } catch {
      const charsPerLine = Math.max(1, textWidthPx / (fontSize * 0.55));
      cumLines += Math.max(1, Math.ceil(para.length / charsPerLine));
    }
  }

  const totalLines = cumLines + targetLineInPara;

  // Map total line count to (page index, line within page) so we can use the
  // correct per-page canvas as the vertical anchor. This accounts for inter-page
  // gaps that would otherwise accumulate error for page 2+ annotations.
  const pageIndex = Math.min(
    Math.floor(totalLines / linesPerPage),
    pageEls.length - 1,
  );
  const lineInPage = totalLines - pageIndex * linesPerPage;

  const pageCr = pageEls[pageIndex]!.getBoundingClientRect();
  const top = pageCr.top + sy + topMarginPx + lineInPage * lineHeight;
  const left = pageCr.left + sx + leftMarginPx;

  const approxWidth = Math.min(exact.length * fontSize * 0.55, textWidthPx);

  return {
    rects: [{ left, top, width: approxWidth, height: lineHeight }],
    anchorNode: null,
  };
}

// ─── Position Resolution ───

interface WordNodeEntry {
  node: Element;
  start: number;
  end: number;
}

/**
 * Build an index of word-level nodes within a region,
 * mapping each to its [start, end) character offset within the concatenated full text.
 */
function buildWordNodeIndex(region: Element): { entries: WordNodeEntry[]; fullText: string } {
  const nodes = getWordNodeEls(region);
  const entries: WordNodeEntry[] = [];
  let offset = 0;

  for (const node of nodes) {
    const t = (node.textContent ?? '').trimEnd();
    if (t.length === 0) continue;
    entries.push({ node, start: offset, end: offset + t.length });
    offset += t.length + 1; // +1 for the space between words
  }

  const fullText = entries.map(e => e.node.textContent?.trimEnd() ?? '').join(' ');
  return { entries, fullText };
}

/**
 * Fuzzy-match annotation.anchor.exact within fullText using prefix/suffix disambiguation.
 * Mirrors the scoring logic in selector.ts findMatchPosition.
 */
function findMatchOffset(fullText: string, anchor: TextQuoteSelector): number {
  const exact = anchor.exact;
  if (!exact) return -1;

  const prefix = anchor.prefix ?? '';
  const suffix = anchor.suffix ?? '';

  let searchFrom = 0;
  let bestPos = -1;
  let bestScore = -1;

  while (searchFrom < fullText.length) {
    const pos = fullText.indexOf(exact, searchFrom);
    if (pos === -1) break;

    let score = 0;
    if (prefix) {
      const before = fullText.slice(Math.max(0, pos - prefix.length - 10), pos);
      if (before.includes(prefix)) score += 2;
      else if (before.toLowerCase().includes(prefix.toLowerCase())) score += 1;
    }
    if (suffix) {
      const after = fullText.slice(pos + exact.length, pos + exact.length + suffix.length + 10);
      if (after.includes(suffix)) score += 2;
      else if (after.toLowerCase().includes(suffix.toLowerCase())) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestPos = pos;
    }

    searchFrom = pos + 1;
  }

  if (bestPos !== -1) return bestPos;

  // Case-insensitive fallback
  const ci = fullText.toLowerCase().indexOf(exact.toLowerCase());
  if (ci !== -1) return ci;

  // Punctuation-stripped fallback
  const stripped = fullText.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
  const strippedExact = exact.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
  const si = stripped.toLowerCase().indexOf(strippedExact.toLowerCase());
  if (si !== -1) {
    let s = 0;
    let o = 0;
    while (o < fullText.length && s < si) {
      if (/[\w\s]/.test(fullText[o]!)) s++;
      o++;
    }
    return o;
  }

  return -1;
}

/**
 * Merge bounding rects that are on the same visual line (Y within 2px tolerance).
 * Produces one rect per line, spanning min-left to max-right.
 */
function mergeRectsOnSameLine(rects: AbsoluteRect[]): AbsoluteRect[] {
  if (rects.length === 0) return [];

  const sorted = [...rects].sort((a, b) => a.top - b.top);
  const merged: AbsoluteRect[] = [];

  for (const rect of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(rect.top - last.top) <= 2) {
      const right = Math.max(last.left + last.width, rect.left + rect.width);
      last.width = right - last.left;
      last.height = Math.max(last.height, rect.height);
    } else {
      merged.push({ ...rect });
    }
  }

  return merged;
}

/**
 * Read the computed font shorthand from a word node within a paragraph.
 */
function getParagraphFont(paragraphEl: Element): string {
  const wordNode = paragraphEl.querySelector(GDOCS_WORD_SELECTORS[0]!) ??
    paragraphEl.querySelector(GDOCS_WORD_SELECTORS[1]!);
  if (!wordNode) return '11pt Arial';
  const style = window.getComputedStyle(wordNode as HTMLElement);
  return style.font || `${style.fontSize} ${style.fontFamily}` || '11pt Arial';
}

/**
 * Find which paragraph element contains a given character offset within the full text.
 */
function findParagraphForOffset(region: Element, charOffset: number): Element | null {
  const paragraphs = getParagraphEls(region);
  let offset = 0;

  for (const para of paragraphs) {
    const nodes = getWordNodeEls(para);
    let paraLen = nodes.reduce((sum, n) => sum + (n.textContent ?? '').length, 0);
    if (paraLen === 0) paraLen = (para.textContent ?? '').length;

    if (charOffset < offset + paraLen) return para;
    offset += paraLen;
  }

  return null;
}

/**
 * Use pretext to validate that a paragraph has renderable content at the given line.
 * Returns false only if pretext computes 0 lines (paragraph not visible/empty).
 */
function validateWithPretext(paragraphEl: Element, matchingNodes: WordNodeEntry[]): boolean {
  if (matchingNodes.length === 0) return false;

  try {
    const font = getParagraphFont(paragraphEl);
    const paraWidth = paragraphEl.getBoundingClientRect().width;
    if (paraWidth <= 0) return true; // Can't validate — accept

    const paraText = (paragraphEl.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!paraText) return true;

    const firstNode = matchingNodes[0]!.node as HTMLElement;
    const computedSize = parseFloat(window.getComputedStyle(firstNode).fontSize) || 11;
    const lineHeight = computedSize * 1.15;

    const prepared = prepareWithSegments(paraText, font);
    const result = layoutWithLines(prepared, paraWidth, lineHeight);

    return result.lineCount > 0;
  } catch {
    return true;
  }
}

/**
 * Resolve annotation text to absolute bounding rects using Google Docs word nodes.
 *
 * For annotations where word nodes have valid bounding rects: returns precise per-word rects.
 * For annotations where rects are zero (canvas rendering without text layer): falls back to
 * the containing paragraph's rect as a rough line-level position.
 */
let _gdocsDiagLogged = false;

export function findAnnotationRects(
  region: DetectedRegion,
  annotation: Annotation,
): { rects: AbsoluteRect[]; anchorNode: Element | null } {
  const { entries, fullText } = buildWordNodeIndex(region.element);

  // One-time log: confirm rendering mode
  if (!_gdocsDiagLogged) {
    _gdocsDiagLogged = true;
    const canvasCount = region.element.querySelectorAll('canvas').length;
    const mode = canvasCount > 0 ? `canvas mode (${canvasCount} tiles)` : 'DOM mode';
    console.log(`[Oddity 1] GDocs: positioning mode = ${mode}`);
  }

  // Canvas mode: no DOM text nodes — use text-offset + pretext layout for positioning
  if (entries.length === 0) {
    const canvases = region.element.querySelectorAll('canvas');
    if (canvases.length > 0) {
      return findAnnotationRectsCanvasMode(canvases[0] as HTMLElement, region.element as HTMLElement, annotation);
    }
    return findAnnotationRectsByParagraph(region, annotation);
  }

  const matchStart = findMatchOffset(fullText, annotation.anchor);
  if (matchStart === -1) {
    // Word node text didn't match (e.g. spaces stripped) — fall back to paragraph positioning
    return findAnnotationRectsByParagraph(region, annotation);
  }
  const matchEnd = matchStart + annotation.anchor.exact.length;

  const matchingNodes = entries.filter(e => e.start < matchEnd && e.end > matchStart);
  if (matchingNodes.length === 0) return { rects: [], anchorNode: null };

  const containingParagraph = findParagraphForOffset(region.element, matchStart);
  if (containingParagraph) {
    const valid = validateWithPretext(containingParagraph, matchingNodes);
    if (!valid) {
      console.log(`[Oddity 1] GDocs: pretext validation failed for annotation ${annotation.id}`);
      return { rects: [], anchorNode: null };
    }
  }

  const sx = window.scrollX;
  const sy = window.scrollY;
  const rawRects: AbsoluteRect[] = [];

  for (const { node } of matchingNodes) {
    const r = (node as HTMLElement).getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      rawRects.push({ left: r.left + sx, top: r.top + sy, width: r.width, height: r.height });
    }
  }

  // If word node rects are all zero (canvas hides text layer), fall back to paragraph rects
  if (rawRects.length === 0) {
    console.debug(`[Oddity 1] GDocs: word node rects are zero — falling back to paragraph positioning`);
    return findAnnotationRectsByParagraph(region, annotation);
  }

  return {
    rects: mergeRectsOnSameLine(rawRects),
    anchorNode: matchingNodes[0]!.node,
  };
}

/**
 * Fallback: resolve annotation to the bounding rect of its containing paragraph.
 * Used when word nodes are not available or have zero dimensions.
 * Provides line-level positioning rather than word-level.
 */
function findAnnotationRectsByParagraph(
  region: DetectedRegion,
  annotation: Annotation,
): { rects: AbsoluteRect[]; anchorNode: Element | null } {
  const paragraphs = getParagraphEls(region.element);
  if (paragraphs.length === 0) return { rects: [], anchorNode: null };

  const exact = annotation.anchor.exact.slice(0, 60);
  const searchStr = exact.toLowerCase().slice(0, 30);

  for (const para of paragraphs) {
    const text = (para.textContent ?? '').replace(/\s+/g, ' ');
    if (!text.toLowerCase().includes(searchStr)) continue;

    const r = (para as HTMLElement).getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    const sx = window.scrollX;
    const sy = window.scrollY;
    return {
      rects: [{ left: r.left + sx, top: r.top + sy, width: r.width, height: r.height }],
      anchorNode: para,
    };
  }

  return { rects: [], anchorNode: null };
}

/**
 * Create a DOM Range pointing to a node element.
 * Used to give margin notes a valid anchor for positioning.
 */
export function createRangeFromNode(node: Element): Range {
  const r = document.createRange();
  r.selectNodeContents(node);
  return r;
}
