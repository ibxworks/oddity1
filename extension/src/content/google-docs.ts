import type { Annotation, AnnotationType, TextQuoteSelector } from '@oddity/shared';
import { MAX_TEXT_LENGTH, getAnnotationColor } from '@oddity/shared';
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
let _debugUnderlineEnabled = false;

export function setGDocsDebugUnderline(enabled: boolean): void {
  _debugUnderlineEnabled = enabled;
}

// ─── Cursor-based Position Correction ───

interface CorrectionJob {
  id: string;
  exact: string;
  scrollContainer: HTMLElement;
  left: number;
  width: number;
  height: number;
  annotationType: AnnotationType;
}

const GDOCS_HIGHLIGHT_GREEN = '#c7eec9';
const GDOCS_HIGHLIGHT_RED   = '#ffd4d1';

/** Map an annotation type to its GDocs native highlight color. */
function getGDocsHighlightColor(type: AnnotationType): { red: number; green: number; blue: number } {
  const annotColor = getAnnotationColor(type, 'light');
  const hex = annotColor === '#F5574C' ? GDOCS_HIGHLIGHT_RED : GDOCS_HIGHLIGHT_GREEN;
  return {
    red:   parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue:  parseInt(hex.slice(5, 7), 16) / 255,
  };
}
let _correctionQueue: CorrectionJob[] = [];
let _correctionRunning = false;
/** Jobs that completed successfully — kept for reference. */
const _completedJobs: CorrectionJob[] = [];

/**
 * Build a canvas pixel predicate for a given hex highlight color.
 * Uses tolerance=15 against the 100% RGB values — this covers both 100% opacity
 * and GDocs' ~40% blended rendering while reliably excluding pure white (255,255,255).
 */
function makeHighlightPredicate(hexColor: string, tol = 15): (r: number, g: number, b: number, a: number) => boolean {
  const r0 = parseInt(hexColor.slice(1, 3), 16);
  const g0 = parseInt(hexColor.slice(3, 5), 16);
  const b0 = parseInt(hexColor.slice(5, 7), 16);
  return (r, g, b, _a) =>
    Math.abs(r - r0) <= tol && Math.abs(g - g0) <= tol && Math.abs(b - b0) <= tol;
}

const _isGreenHighlight = makeHighlightPredicate(GDOCS_HIGHLIGHT_GREEN);
const _isRedHighlight   = makeHighlightPredicate(GDOCS_HIGHLIGHT_RED);
/** Combined predicate matching either annotation highlight color. */
const isAnchorHighlight = (r: number, g: number, b: number, a: number): boolean =>
  _isGreenHighlight(r, g, b, a) || _isRedHighlight(r, g, b, a);

/** Last-known rects (one per line) for each annotation's tracking highlight. */
const _anchorRects = new Map<string, AbsoluteRect[]>();
/** Annotation type per annotation — used to color-filter split candidates. */
const _anchorTypes = new Map<string, import('@oddity/shared').AnnotationType>();
/** Consecutive in-viewport scan misses per annotation — used to detect deleted anchor text. */
const _missCounts = new Map<string, number>();
/**
 * Current anchor text per annotation. Initially equals annotation.anchor.exact, but
 * updated whenever the user edits the highlighted text in the document so pretext can
 * continue tracking it through further edits.
 */
const _currentAnchorTexts = new Map<string, string>();

/** Returns the cached rects for an annotation, or null if not found. */
export function getGDocsAnchorRects(annotationId: string): AbsoluteRect[] | null {
  return _anchorRects.get(annotationId) ?? null;
}

// ─── GDocs State Persistence ───

const GDOCS_STATE_KEY_PREFIX = 'gdocs-state:';
let _gdocsDocId: string | null = null;
/** True if state was loaded from storage (skip Cmd+F and API call on this load). */
let _cachedRectsLoaded = false;

interface GDocsPersistedState {
  rects: Record<string, AbsoluteRect[]>;
  annotations: import('@oddity/shared').Annotation[];
  regionId: string;
}

/**
 * Load persisted GDocs state (rects + annotations) from chrome.storage.local.
 * Returns the persisted state if found, null otherwise.
 */
export async function initGDocsRectCache(docId: string): Promise<GDocsPersistedState | null> {
  _gdocsDocId = docId;
  if (!chrome?.storage?.local) return null;
  const key = GDOCS_STATE_KEY_PREFIX + docId;
  try {
    const result = await chrome.storage.local.get(key);
    const stored = result[key] as GDocsPersistedState | undefined;
    if (!stored?.rects || Object.keys(stored.rects).length === 0) return null;
    for (const [id, rects] of Object.entries(stored.rects)) {
      _anchorRects.set(id, rects);
    }
    if (stored.annotations) {
      for (const ann of stored.annotations) {
        _anchorTypes.set(ann.id, ann.type);
      }
    }
    _cachedRectsLoaded = true;
    console.log(`[Oddity 1] GDocs: restored ${_anchorRects.size} anchor rect(s) from storage`);
    return stored;
  } catch (err) {
    console.warn('[Oddity 1] GDocs: failed to load cached state', err);
    return null;
  }
}

function saveGDocsRectsToStorage(): void {
  if (!_gdocsDocId || !chrome?.storage?.local) return;
  const key = GDOCS_STATE_KEY_PREFIX + _gdocsDocId;
  // Merge rects into existing stored state (preserve annotations)
  chrome.storage.local.get(key).then(result => {
    const existing = (result[key] ?? {}) as Partial<GDocsPersistedState>;
    const rects: Record<string, AbsoluteRect[]> = {};
    for (const [id, r] of _anchorRects) rects[id] = r;
    return chrome.storage.local.set({ [key]: { ...existing, rects } });
  }).catch(() => {});
}

/** Persist annotations alongside rects so they survive service worker restarts. */
export function saveGDocsAnnotationsToStorage(
  docId: string,
  regionId: string,
  annotations: import('@oddity/shared').Annotation[],
): void {
  if (!chrome?.storage?.local) return;
  const key = GDOCS_STATE_KEY_PREFIX + docId;
  chrome.storage.local.get(key).then(result => {
    const existing = (result[key] ?? {}) as Partial<GDocsPersistedState>;
    return chrome.storage.local.set({ [key]: { ...existing, annotations, regionId } });
  }).catch(() => {});
}

/** Clear all annotation rects and persisted state (call before a full re-annotation). */
export function clearAllGDocsRects(docId: string): void {
  _anchorRects.clear();
  _anchorTypes.clear();
  _missCounts.clear();
  _currentAnchorTexts.clear();
  _cachedRectsLoaded = false;
  if (!chrome?.storage?.local) return;
  chrome.storage.local.remove(GDOCS_STATE_KEY_PREFIX + docId).catch(() => {});
}

/** Remove a single annotation's stored rects (call when annotation is deleted). */
export function deleteGDocsRect(docId: string, annotationId: string): void {
  _anchorRects.delete(annotationId);
  _anchorTypes.delete(annotationId);
  _currentAnchorTexts.delete(annotationId);
  if (!chrome?.storage?.local) return;
  const key = GDOCS_STATE_KEY_PREFIX + docId;
  chrome.storage.local.get(key).then(result => {
    const stored = result[key] as GDocsPersistedState | undefined;
    if (!stored?.rects) return;
    delete stored.rects[annotationId];
    // Also remove from annotations array
    if (stored.annotations) {
      stored.annotations = stored.annotations.filter(a => a.id !== annotationId);
    }
    return chrome.storage.local.set({ [key]: stored });
  }).catch(() => {});
}

/**
 * Scan visible canvas tiles for pixels matching `predicate`.
 * Optionally diffs against a before-snapshot so only newly-appeared pixels count.
 *
 * Returns AbsoluteRect[][] — one inner array per annotation span, each inner array
 * containing one rect per visual line (not a merged bounding box).
 *
 * Two-pass clustering:
 *   Pass 1: pixel rows within 1 px → same text line (strict to split adjacent lines).
 *   Pass 2: line runs within 40 px → same annotation span.
 */
function scanCanvasRects(
  predicate: (r: number, g: number, b: number, a: number) => boolean,
  scrollContainer: HTMLElement,
  before?: Map<HTMLCanvasElement, ImageData>,
  snapshot?: Map<HTMLCanvasElement, ImageData>,
): AbsoluteRect[][] {
  interface RowData { y: number; xMin: number; xMax: number; }
  const allRows: RowData[] = [];

  for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas')) {
    const bcr = canvas.getBoundingClientRect();
    if (bcr.width < 400 || bcr.height <= 0 || bcr.top >= window.innerHeight || bcr.bottom <= 0) continue;

    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    const { width, height } = canvas;
    if (!width || !height) continue;
    let pixels: ImageData;
    const snapshotData = snapshot?.get(canvas);
    if (snapshotData) {
      pixels = snapshotData;
    } else {
      try { pixels = ctx.getImageData(0, 0, width, height); } catch { continue; }
    }

    const { data } = pixels;
    const beforeData = before?.get(canvas)?.data;
    const sx = bcr.width  / width;
    const sy = bcr.height / height;

    // Gap threshold in canvas pixels: ~15 CSS px, enough to split adjacent anchors
    // on the same line while keeping spaces within a single anchor connected.
    const gapThreshold = Math.ceil(15 / sx);

    for (let py = 0; py < height; py++) {
      // Track separate horizontal segments so two highlights on the same line
      // with a gap between them produce distinct RowData entries.
      let segStart = -1, segEnd = -1;

      const flushSeg = () => {
        if (segStart === -1) return;
        allRows.push({
          y:    bcr.top  + py * sy + scrollContainer.scrollTop,
          xMin: bcr.left + segStart * sx + scrollContainer.scrollLeft,
          xMax: bcr.left + segEnd   * sx + scrollContainer.scrollLeft,
        });
        segStart = segEnd = -1;
      };

      for (let px = 0; px < width; px++) {
        const i = (py * width + px) * 4;
        const r = data[i]!, g = data[i+1]!, b = data[i+2]!, a = data[i+3]!;
        if (!predicate(r, g, b, a)) continue;
        if (beforeData) {
          const br = beforeData[i]!, bg = beforeData[i+1]!, bb = beforeData[i+2]!, ba = beforeData[i+3]!;
          if (predicate(br, bg, bb, ba)) continue;
        }
        if (segStart === -1) {
          segStart = segEnd = px;
        } else if (px - segEnd <= gapThreshold) {
          segEnd = px;
        } else {
          flushSeg();
          segStart = segEnd = px;
        }
      }
      flushSeg();
    }
  }

  if (allRows.length === 0) return [];
  allRows.sort((a, b) => a.y - b.y);

  // Pass 1 — merge pixel rows within 1 px into a single line run.
  // Using 1 px (not 2) so adjacent highlighted lines don't collapse into one rect.
  interface LineRun { top: number; bottom: number; left: number; right: number; }
  const lineRuns: LineRun[] = [];
  for (const row of allRows) {
    const last = lineRuns[lineRuns.length - 1];
    if (last && row.y - last.bottom <= 1) {
      last.bottom = row.y;
      last.left   = Math.min(last.left,  row.xMin);
      last.right  = Math.max(last.right, row.xMax);
    } else {
      lineRuns.push({ top: row.y, bottom: row.y, left: row.xMin, right: row.xMax });
    }
  }

  // Pass 2 — group line runs within 25 px into one annotation cluster.
  // 25 px covers up to 2× line spacing (gap ~14 px) while keeping separate paragraphs
  // with typical paragraph spacing (≥ 30 px) as distinct clusters. Same-annotation
  // multi-line highlights are always merged; the split logic separates different
  // annotations that end up in the same cluster.
  const clusters: LineRun[][] = [];
  for (const run of lineRuns) {
    const last = clusters[clusters.length - 1];
    const lastRun = last?.[last.length - 1];
    if (lastRun && run.top - lastRun.bottom <= 25) {
      last!.push(run);
    } else {
      clusters.push([run]);
    }
  }

  return clusters.map(lines =>
    lines.map(lr => ({ left: lr.left, top: lr.top, width: lr.right - lr.left, height: lr.bottom - lr.top + 1 })),
  );
}

// ─── Pretext Layout Helpers ───

interface PageLayoutMetrics {
  textWidthPx: number;
  leftMarginPx: number;
  lineHeight: number;
  font: string;
  /** Absolute x of the page's left edge (viewport left + scrollLeft). */
  pageAbsoluteLeft: number;
  measureCtx: CanvasRenderingContext2D;
}

/**
 * Read the current page layout metrics from the live DOM.
 * Returns null when the kix-page elements aren't ready yet.
 */
function readPageLayoutMetrics(scrollContainer: HTMLElement): PageLayoutMetrics | null {
  const kixPages = Array.from(scrollContainer.querySelectorAll<HTMLElement>('.kix-page'))
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 400 && r.height > 600; });
  if (kixPages.length === 0) return null;

  const cr0 = kixPages[0]!.getBoundingClientRect();
  const pageW = cr0.width;

  let leftMarginPx = pageW * (96 / 816);
  let textWidthPx = pageW - 2 * leftMarginPx;
  let fontSize = pageW * (14.667 / 816);
  let fontFamily = 'Arial';

  const firstPara = kixPages[0]!.querySelector<HTMLElement>(
    '.kix-paragraphrenderer, [class*="paragraphrenderer"]',
  );
  if (firstPara) {
    const pr = firstPara.getBoundingClientRect();
    const ml = pr.left - cr0.left;
    if (ml > 0 && ml < pageW * 0.4) leftMarginPx = ml;
    if (pr.width > pageW * 0.3) textWidthPx = pr.width;
  }

  const wordNode = scrollContainer.querySelector<HTMLElement>(
    '.kix-wordhtmlgenerator-word-node, [class*="word-node"]',
  );
  if (wordNode) {
    const style = window.getComputedStyle(wordNode);
    const parsed = parseFloat(style.fontSize);
    if (parsed > 0) fontSize = parsed;
    const family = style.fontFamily?.split(',')[0]?.replace(/['"]/g, '').trim();
    if (family) fontFamily = family;
  }

  const font = `${fontSize}px ${fontFamily}`;
  const measureCtx = document.createElement('canvas').getContext('2d')!;
  measureCtx.font = font;

  return {
    textWidthPx,
    leftMarginPx,
    lineHeight: fontSize * 1.15,
    font,
    pageAbsoluteLeft: cr0.left + scrollContainer.scrollLeft,
    measureCtx,
  };
}

interface AnchorLineInfo {
  /** Paragraph index in the document (split by '\n'). */
  paraIdx: number;
  /** Line index within that paragraph (after word-wrap by pretext). */
  lineIdx: number;
  /** x-offset of the anchor's first character from the paragraph's left edge, in CSS px. */
  xOffset: number;
  /** Rendered width of the anchor text in CSS px, measured with the same font. */
  width: number;
}

/**
 * Use pretext to find which paragraph + wrapped line an anchor text occupies, and its
 * x-offset within that line.  These are RELATIVE values (paragraph-local, not screen
 * coordinates) — reliable even when the absolute y of the anchor is unknown or stale.
 *
 * Returns null if the text is absent from the cached document text or layout fails.
 */
function computeAnchorLineInfo(
  anchorText: string,
  metrics: PageLayoutMetrics,
): AnchorLineInfo | null {
  if (!_cachedDocText) return null;
  const charOffset = _cachedDocText.toLowerCase().indexOf(anchorText.toLowerCase());
  if (charOffset === -1) return null;

  const paragraphs = _cachedDocText.split('\n');
  let cumChars = 0;
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi]!;
    const paraLen = para.length + 1; // +1 for '\n'
    if (cumChars + paraLen > charOffset) {
      const offsetInPara = charOffset - cumChars;
      try {
        const prepared = prepareWithSegments(para || ' ', metrics.font);
        const result = layoutWithLines(prepared, metrics.textWidthPx, metrics.lineHeight);
        let charsSeen = 0;
        for (let li = 0; li < result.lines.length; li++) {
          const lineLen = result.lines[li]!.text.length;
          if (offsetInPara <= charsSeen + lineLen) {
            const prefix = result.lines[li]!.text.slice(0, offsetInPara - charsSeen);
            return {
              paraIdx: pi,
              lineIdx: li,
              xOffset: metrics.measureCtx.measureText(prefix).width,
              width:   metrics.measureCtx.measureText(anchorText).width,
            };
          }
          charsSeen += lineLen;
        }
      } catch { /* ignore layout errors */ }
      break;
    }
    cumChars += paraLen;
  }
  return null;
}

/**
 * Return the character index in `lineText` where the rendered prefix width first reaches
 * or exceeds `targetX` CSS pixels.
 */
function charOffsetAtX(
  lineText: string,
  targetX: number,
  measureCtx: CanvasRenderingContext2D,
): number {
  for (let i = 0; i <= lineText.length; i++) {
    if (measureCtx.measureText(lineText.slice(0, i)).width >= targetX) return i;
  }
  return lineText.length;
}

/**
 * Given a canvas cluster's absolute position, extract the text that is currently
 * rendered at that x-range on that line from the cached document text.
 *
 * This is used to recover the anchor's *current* text after the user has edited it
 * in the document — the highlight still exists (canvas confirms it), but the stored
 * anchor text no longer matches the document.
 *
 * Returns null when the paragraph or line cannot be resolved.
 */
function extractAnchorTextFromCluster(
  cluster: AbsoluteRect[],
  scrollContainer: HTMLElement,
  metrics: PageLayoutMetrics,
  docText: string,
): string | null {
  if (!docText) return null;
  const r0 = cluster[0]!;
  // Viewport y at the vertical center of the first cluster rect.
  const viewportY = r0.top - scrollContainer.scrollTop + r0.height / 2;

  // Find the paragraph renderer whose bounding rect contains this viewport y.
  const paraRenderers = Array.from(
    scrollContainer.querySelectorAll<HTMLElement>(
      '.kix-paragraphrenderer, [class*="paragraphrenderer"]',
    ),
  ).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

  let paraIdx = -1;
  for (let i = 0; i < paraRenderers.length; i++) {
    const bcr = paraRenderers[i]!.getBoundingClientRect();
    if (bcr.top <= viewportY && viewportY < bcr.bottom + metrics.lineHeight) {
      paraIdx = i;
      break;
    }
  }
  if (paraIdx === -1) return null;

  const paragraphs = docText.split('\n');
  const para = paragraphs[paraIdx] ?? '';
  if (!para.trim()) return null;

  try {
    const prepared = prepareWithSegments(para, metrics.font);
    const result = layoutWithLines(prepared, metrics.textWidthPx, metrics.lineHeight);

    // Which wrapped line within this paragraph?
    const paraTop = paraRenderers[paraIdx]!.getBoundingClientRect().top;
    const lineIdx = Math.max(0, Math.floor((viewportY - paraTop) / metrics.lineHeight));
    const line = result.lines[Math.min(lineIdx, result.lines.length - 1)];
    if (!line) return null;

    // x-offset of the cluster within the text area (subtract page left edge + margin).
    const xStart = r0.left - metrics.pageAbsoluteLeft - metrics.leftMarginPx;
    const xEnd   = xStart + r0.width;

    const startChar = charOffsetAtX(line.text, xStart, metrics.measureCtx);
    const endChar   = charOffsetAtX(line.text, xEnd,   metrics.measureCtx);

    const extracted = line.text.slice(startChar, endChar).trim();
    return extracted.length >= 2 ? extracted : null; // ignore single-char noise
  } catch {
    return null;
  }
}

function enqueueCursorCorrection(job: CorrectionJob): void {
  if (_correctionQueue.some(j => j.id === job.id)) return;

  // Cached document: use stored rects directly — never run Cmd+F.
  if (_cachedRectsLoaded && _anchorRects.has(job.id)) {
    const rects = _anchorRects.get(job.id)!;
    setTimeout(() => {
      document.dispatchEvent(new CustomEvent('oddity-gdocs-corrected', { detail: { id: job.id, rects } }));
    }, 0);
    return;
  }

  _correctionQueue.push(job);
  if (!_correctionRunning) drainCorrectionQueue();
}


function drainCorrectionQueue(): void {
  const job = _correctionQueue.shift();
  if (!job) { _correctionRunning = false; return; }
  _correctionRunning = true;
  runCursorCorrection(job).finally(drainCorrectionQueue);
}

/** Snapshot ImageData for all currently-visible canvas tiles. */
function snapshotVisibleCanvases(): Map<HTMLCanvasElement, ImageData> {
  const snap = new Map<HTMLCanvasElement, ImageData>();
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas')) {
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.top >= window.innerHeight || r.bottom <= 0) continue;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    try { snap.set(canvas, ctx.getImageData(0, 0, canvas.width, canvas.height)); }
    catch { /* tainted */ }
  }
  return snap;
}



async function runCursorCorrection(job: CorrectionJob): Promise<void> {
  const { id, exact, scrollContainer, left, annotationType } = job;

  const docId = getGoogleDocsId();
  if (!docId) { console.warn('[Oddity1] runCursorCorrection: no docId'); return; }

  console.log(`[Oddity1] runCursorCorrection: start id=${id} text="${exact.slice(0, 40)}"`);

  // Snapshot before the API call so scanCanvasRects can diff out pre-existing highlight pixels.
  const beforeSnapshot = snapshotVisibleCanvases();

  const isRed = getAnnotationColor(annotationType, 'light') === '#F5574C';
  const highlightColor = getGDocsHighlightColor(annotationType);

  const result = await sendMessage<{ error?: string }>({
    action: 'gdocsFindAndHighlight',
    payload: {
      docId,
      anchorText: exact,
      color: highlightColor,
    },
  });

  console.log(`[Oddity1] gdocsFindAndHighlight result:`, result);

  if (result?.error) {
    console.warn(`[Oddity1] gdocsFindAndHighlight failed: ${result.error}`);
    return;
  }

  // Wait for GDocs canvas to repaint with the new highlight.
  await new Promise<void>(r => setTimeout(r, 600));

  // The before-snapshot diff ensures only newly-appeared highlight pixels are detected,
  // so even if other same-color annotations exist we only pick up the one we just applied.
  const isHighlight = isRed ? _isRedHighlight : _isGreenHighlight;
  const clusters = scanCanvasRects(isHighlight, scrollContainer, beforeSnapshot);
  console.log(`[Oddity1] scanCanvasRects clusters=${clusters.length}`);
  if (clusters.length === 0) return;

  // Pick the cluster whose first rect is horizontally closest to the expected position.
  let best = clusters[0]!;
  let bestDist = Math.abs(best[0]!.left - left);
  for (const cl of clusters.slice(1)) {
    const d = Math.abs(cl[0]!.left - left);
    if (d < bestDist) { bestDist = d; best = cl; }
  }
  if (bestDist >= 200) return;

  const idx = _completedJobs.findIndex(j => j.id === id);
  if (idx >= 0) _completedJobs[idx] = job; else _completedJobs.push(job);

  _anchorRects.set(id, best);
  saveGDocsRectsToStorage();
  document.dispatchEvent(new CustomEvent('oddity-gdocs-corrected', { detail: { id, rects: best } }));
}

/**
 * Find the paragraph renderer that best matches a given exported-text paragraph.
 * Searches a window around the expected index so index drift from blank lines,
 * headings, or list items doesn't silently pick the wrong renderer.
 *
 * Scoring: prefix-overlap fraction (0–1) weighted against distance from expected index.
 * Falls back to closest-by-index if no text content is available (canvas mode with
 * hidden word nodes).
 */
function findMatchingParaRenderer(
  renderers: HTMLElement[],
  expectedIndex: number,
  paraText: string,
  searchWindow = 8,
): HTMLElement | null {
  if (renderers.length === 0) return null;

  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const target = normalize(paraText);

  const start = Math.max(0, expectedIndex - searchWindow);
  const end   = Math.min(renderers.length - 1, expectedIndex + searchWindow);

  let bestEl    = renderers[Math.min(expectedIndex, renderers.length - 1)]!;
  let bestScore = -Infinity;

  for (let i = start; i <= end; i++) {
    const el = renderers[i]!;
    const rendText = normalize(el.textContent ?? '');
    const distancePenalty = Math.abs(i - expectedIndex);

    let textScore: number;
    if (target === '' && rendText === '') {
      // Both empty — good match, prefer closest to expected index.
      textScore = 1;
    } else if (target === '' || rendText === '') {
      // One empty, one not — poor match.
      textScore = 0;
    } else {
      // Fraction of the shorter string that overlaps as a prefix.
      const shorter = target.length <= rendText.length ? target : rendText;
      const longer  = target.length <= rendText.length ? rendText : target;
      let overlap = 0;
      while (overlap < shorter.length && shorter[overlap] === longer[overlap]) overlap++;
      textScore = overlap / shorter.length;
    }

    // Weight: text match matters most; distance is a tiebreaker.
    const score = textScore * 100 - distancePenalty;
    if (score > bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }

  return bestEl;
}

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

  // Use floating-point arithmetic throughout — rounding per-line accumulates
  // to 10-25px error over 50 lines, which is visually very noticeable.

  // Read margins and text width from the first paragraph renderer's position
  // relative to the page — these reflect the user's actual document margins.
  let leftMarginPx = pageW * (96 / 816);
  let topMarginPx = pageH * (96 / 1056);
  let textWidthPx = pageW - 2 * leftMarginPx;
  const firstPara = pageEls[0]!.querySelector<HTMLElement>('.kix-paragraphrenderer, [class*="paragraphrenderer"]');
  if (firstPara) {
    const paraRect = firstPara.getBoundingClientRect();
    const measuredLeft = paraRect.left - cr0.left;
    const measuredTop = paraRect.top - cr0.top + scrollContainer.scrollTop;
    if (measuredLeft > 0 && measuredLeft < pageW * 0.4) leftMarginPx = measuredLeft;
    if (measuredTop > 0 && measuredTop < pageH * 0.4) topMarginPx = measuredTop;
    if (paraRect.width > pageW * 0.3) textWidthPx = paraRect.width;
  }

  // Read font and size from a word node's computed style; fall back to GDocs default (11pt Arial).
  let fontSize = pageW * (14.667 / 816);
  let fontFamily = 'Arial';
  const wordNode = scrollContainer.querySelector<HTMLElement>('.kix-wordhtmlgenerator-word-node, [class*="word-node"]');
  if (wordNode) {
    const style = window.getComputedStyle(wordNode);
    const parsed = parseFloat(style.fontSize);
    if (parsed > 0) fontSize = parsed;
    const family = style.fontFamily?.split(',')[0]?.replace(/['"]/g, '').trim();
    if (family) fontFamily = family;
  }

  const lineHeight = fontSize * 1.15;
  const font = `${fontSize}px ${fontFamily}`;
  const linesPerPage = (pageH - 2 * topMarginPx) / lineHeight;

  // Shared canvas context for measuring text widths (same font as layout engine).
  const measureCtx = (() => {
    const c = document.createElement('canvas').getContext('2d')!;
    c.font = font;
    return c;
  })();

  // Collect paragraph renderers sorted by their document position.
  // Use getBoundingClientRect().top (viewport-relative) for sorting — offsetTop is
  // relative to each element's offsetParent, which resets per page and makes
  // cross-page comparisons wrong. getBoundingClientRect() is always viewport-relative.
  const paraRenderers = Array.from(
    scrollContainer.querySelectorAll<HTMLElement>('.kix-paragraphrenderer, [class*="paragraphrenderer"]')
  ).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  console.log(`[Oddity1 debug] paraRenderers.length=${paraRenderers.length} scrollContainer=${scrollContainer.className} allParaInDoc=${document.querySelectorAll('.kix-paragraphrenderer, [class*="paragraphrenderer"]').length}`);

  // Walk exported text paragraphs to find which one contains the annotation.
  const paragraphs = fullText.split('\n');
  let cumChars = 0;
  let targetParaIndex = 0;
  let targetLineInPara = 0;
  let xOffsetInLine = 0;

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi]!;
    const paraLen = para.length + 1; // +1 for the \n
    if (cumChars + paraLen > charOffset) {
      targetParaIndex = pi;
      const offsetInPara = charOffset - cumChars;
      try {
        const prepared = prepareWithSegments(para || ' ', font);
        const result = layoutWithLines(prepared, textWidthPx, lineHeight);
        let charsSeen = 0;
        for (let i = 0; i < result.lines.length; i++) {
          const lineLen = result.lines[i]!.text.length;
          if (offsetInPara <= charsSeen + lineLen) {
            targetLineInPara = i;
            const prefixText = result.lines[i]!.text.slice(0, offsetInPara - charsSeen);
            xOffsetInLine = measureCtx.measureText(prefixText).width;
            break;
          }
          charsSeen += lineLen;
          if (i === result.lines.length - 1) targetLineInPara = i;
        }
      } catch {
        const charsPerLine = Math.max(1, Math.floor(textWidthPx / (fontSize * 0.55)));
        targetLineInPara = Math.floor(offsetInPara / charsPerLine);
        xOffsetInLine = (offsetInPara % charsPerLine) * (fontSize * 0.55);
      }
      break;
    }
    cumChars += paraLen;
  }

  // Use the paragraph renderer's actual offsetTop as the Y base — this eliminates
  // all accumulated simulation error from paragraph counting. Only the within-paragraph
  // line offset is simulated, so error is bounded to a single paragraph's height.
  //
  // We fuzzy-match the target paragraph's text against renderer textContent rather
  // than assuming 1:1 index alignment, which breaks when blank lines, headings, or
  // list items cause the DOM and exported text to diverge.
  const paraEl = findMatchingParaRenderer(paraRenderers, targetParaIndex, paragraphs[targetParaIndex] ?? '');
  let top: number;
  let left: number;

  if (paraEl) {
    const paraBcr = paraEl.getBoundingClientRect();
    console.log(`[Oddity1 debug] anchor="${exact.slice(0,30)}" targetParaIndex=${targetParaIndex} paraRenderers.length=${paraRenderers.length} paraEl.bcr.top=${paraBcr.top} sy=${sy} targetLineInPara=${targetLineInPara} lineHeight=${lineHeight} paraEl.textContent.length=${paraEl.textContent?.length}`);
    top  = paraBcr.top + sy + targetLineInPara * lineHeight;
    left = cr0.left + sx + leftMarginPx + xOffsetInLine;
  } else {
    // Fallback: no paragraph renderers found — use page-based calculation.
    const linesPerPage = (pageH - 2 * topMarginPx) / lineHeight;
    // Recompute cumLines by simulating all paragraphs (legacy path).
    let cumLines = 0;
    for (let pi = 0; pi < targetParaIndex; pi++) {
      const para = paragraphs[pi]!;
      try {
        const prepared = prepareWithSegments(para || ' ', font);
        cumLines += layout(prepared, textWidthPx, lineHeight).lineCount;
      } catch {
        cumLines += Math.max(1, Math.ceil(para.length / (textWidthPx / (fontSize * 0.55))));
      }
    }
    const totalLines = cumLines + targetLineInPara;
    const pageIndex = Math.min(Math.floor(totalLines / linesPerPage), pageEls.length - 1);
    const lineInPage = totalLines - pageIndex * linesPerPage;
    const pageCr = pageEls[pageIndex]!.getBoundingClientRect();
    top  = pageCr.top + sy + topMarginPx + lineInPage * lineHeight;
    left = pageCr.left + sx + leftMarginPx + xOffsetInLine;
  }

  const approxWidth = Math.min(measureCtx.measureText(exact).width, textWidthPx - xOffsetInLine);

  // Track annotation type for color-based candidate filtering in scheduleParaCheck.
  _anchorTypes.set(annotation.id, annotation.type);
  // Queue cursor-based positioning — don't render until the real Y is known.
  enqueueCursorCorrection({ id: annotation.id, exact, scrollContainer, left, width: approxWidth, height: lineHeight, annotationType: annotation.type });

  // Return empty so the caller defers rendering until cursor correction fires.
  return { rects: [], anchorNode: null };
}

/**
 * Set up live overlay position tracking for GDocs editing.
 *
 * - Enter / Delete / Backspace: immediately shift rects below the cursor by ±lineHeight
 *   via `oddity-gdocs-line-shift` so overlays follow text as the user types.
 * - Debounced (2 s after last keystroke): silently re-run all completed cursor corrections
 *   so accumulated drift (word wrap, multi-line paste) is corrected when the user pauses.
 *   The find bar is already hidden during corrections via CSS injection in runCursorCorrection.
 *
 * Returns a cleanup function.
 */
export function setupGDocsEditTracking(scrollContainer: HTMLElement): () => void {
  const iframe = document.querySelector<HTMLIFrameElement>('.docs-texteventtarget-iframe');
  const iframeDoc = iframe?.contentDocument;
  if (!iframeDoc) return () => {};

  const getCaretAbsY = (): { y: number; h: number } | null => {
    const caret = document.querySelector<HTMLElement>('.kix-cursor-caret');
    const bcr = caret?.getBoundingClientRect();
    return bcr && bcr.height > 0
      ? { y: bcr.top + scrollContainer.scrollTop, h: bcr.height }
      : null;
  };

  // Live tracking: after text-modifying keys, wait for GDocs to repaint the canvas,
  // then scan for annotation highlights and update any that moved.
  // Run green and red scans separately so adjacent same-line highlights of different
  // colors are never merged into one cluster.
  // Doc text refresh: re-fetch the export URL after edits so _cachedDocText stays current.
  // A fresh doc text lets pretext keep tracking anchors whose text was edited by the user.
  let docRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleDocTextRefresh = (delay: number) => {
    if (docRefreshTimer) clearTimeout(docRefreshTimer);
    const docId = getGoogleDocsId();
    if (!docId) return;
    docRefreshTimer = setTimeout(async () => {
      docRefreshTimer = null;
      const text = await fetchGoogleDocsText(docId).catch(() => null);
      if (text && text !== _cachedDocText) {
        _cachedDocText = text;
        scheduleParaCheck(50); // re-run tracking with the fresh text
      }
    }, delay);
  };

  let trackTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleParaCheck = (delay = 150) => {
    if (_anchorRects.size === 0) return;
    if (trackTimer) clearTimeout(trackTimer);
    trackTimer = setTimeout(() => {
      trackTimer = null;

      const snapshot = snapshotVisibleCanvases();
      const assignedIds = new Set<string>();

      // Pretext: compute line identity (paragraph + line index + relative x-offset) for every
      // annotation from the cached doc text. This is RELATIVE data — reliable even when
      // absolute y is stale. Used only for split validation and split ordering, never for
      // absolute position or proximity matching (where canvas data is authoritative).
      const pageMetrics = _cachedDocText ? readPageLayoutMetrics(scrollContainer) : null;
      const preTextLine = new Map<string, AnchorLineInfo>();
      if (pageMetrics) {
        for (const id of _anchorRects.keys()) {
          const job = _completedJobs.find(j => j.id === id);
          if (!job) continue;
          // Use the current (possibly updated) anchor text so pretext keeps tracking
          // anchors whose text the user has edited since the initial annotation.
          const anchorText = _currentAnchorTexts.get(id) ?? job.exact;
          const info = computeAnchorLineInfo(anchorText, pageMetrics);
          if (info) preTextLine.set(id, info);
        }
      }

      // Scan green and red highlights separately so different-color annotations are
      // never in the same cluster. Track which clusters are red so candidate detection
      // can filter by color (red annotations must never be candidates for green clusters).
      const greenFound = scanCanvasRects(_isGreenHighlight, scrollContainer, undefined, snapshot);
      const redFound   = scanCanvasRects(_isRedHighlight,   scrollContainer, undefined, snapshot);
      const redClusterSet = new Set<AbsoluteRect[]>(redFound);
      const allFound   = [...greenFound, ...redFound];

      if (allFound.length > 0) {
        // Split merged clusters using a two-source cross-check:
        //  1. Canvas (stored rects) identifies candidates — tight y-tolerance so only
        //     annotations on the same visual line are considered.
        //  2. Pretext fallback — when canvas finds <2 candidates (stale positions after
        //     bulk deletion), use pretext line groups to detect co-located annotations.
        //  3. Pretext validates — both candidates must be on the same paragraph+line.
        //  4. Split width and ordering use pretext's font measurement (fresh, not stale).

        // Pre-compute pretext line groups: annotations that share the same paragraph+line.
        // Key = "paraIdx:lineIdx", value = [{id, xOffset, width}] sorted by x.
        const pretextLineGroups = new Map<string, Array<{ id: string; xOffset: number; width: number }>>();
        if (pageMetrics) {
          for (const [id, info] of preTextLine) {
            const key = `${info.paraIdx}:${info.lineIdx}`;
            if (!pretextLineGroups.has(key)) pretextLineGroups.set(key, []);
            pretextLineGroups.get(key)!.push({ id, xOffset: info.xOffset, width: info.width });
          }
          // Sort each group by x-offset ascending
          for (const members of pretextLineGroups.values()) {
            members.sort((a, b) => a.xOffset - b.xOffset);
          }
        }

        const splitClusters: AbsoluteRect[][] = [];
        for (const cluster of allFound) {
          const clusterLeft  = cluster[0]!.left;
          const clusterRight = clusterLeft + cluster[0]!.width;
          const clusterTop   = cluster[0]!.top;

          // Pass 1 — Canvas candidate detection: tight 30px y-tolerance.
          // Color-filtered: green clusters only consider green annotations and vice versa.
          // This prevents red annotations from becoming candidates for green clusters
          // when they happen to share the same visual line (different color, different cluster).
          const clusterIsRed = redClusterSet.has(cluster);
          let candidates: Array<{ id: string; left: number; width: number }> = [];
          for (const [id, lastRects] of _anchorRects) {
            // Color filter: skip annotations whose highlight color doesn't match this cluster.
            const annotType = _anchorTypes.get(id);
            if (annotType !== undefined) {
              const annotIsRed = getAnnotationColor(annotType, 'light') === '#F5574C';
              if (annotIsRed !== clusterIsRed) continue;
            }
            const lr = lastRects[0];
            if (!lr) continue;
            if (Math.abs(clusterTop - lr.top) > 30) continue; // same visual line only
            if (lr.left < clusterRight + 5 && (lr.left + lr.width) > clusterLeft - 5) {
              candidates.push({ id, left: lr.left, width: lr.width });
            }
          }

          // Pass 2 — Pretext fallback: when canvas found <2 candidates (positions stale
          // after bulk deletion), check pretext line groups. If a line group's x-range
          // overlaps this cluster AND has 2+ annotations, use it for splitting.
          // This handles the case where 3 anchors collapse onto one line after large
          // text removals and canvas stored positions are hundreds of pixels off.
          if (candidates.length <= 1 && pageMetrics) {
            const absPageLeft = pageMetrics.pageAbsoluteLeft + pageMetrics.leftMarginPx;
            for (const members of pretextLineGroups.values()) {
              if (members.length < 2) continue;
              // Color filter: skip members whose annotation color doesn't match cluster
              const colorMatchedMembers = members.filter(m => {
                const annotType = _anchorTypes.get(m.id);
                if (annotType === undefined) return true; // unknown — include
                const annotIsRed = getAnnotationColor(annotType, 'light') === '#F5574C';
                return annotIsRed === clusterIsRed;
              });
              if (colorMatchedMembers.length < 2) continue;
              // Approximate absolute x-range of this line group
              const groupAbsLeft  = absPageLeft + colorMatchedMembers[0]!.xOffset;
              const lastMember    = colorMatchedMembers[colorMatchedMembers.length - 1]!;
              const groupAbsRight = absPageLeft + lastMember.xOffset + lastMember.width;
              // Does the cluster overlap the line group's x-range?
              if (clusterLeft <= groupAbsRight + 30 && clusterRight >= groupAbsLeft - 30) {
                candidates = colorMatchedMembers.map(m => ({
                  id: m.id,
                  left: absPageLeft + m.xOffset,
                  width: m.width,
                }));
                break;
              }
            }
          }

          if (candidates.length <= 1) {
            splitClusters.push(cluster);
            continue;
          }

          // Pretext cross-check: confirm candidates are on the same paragraph + wrapped line.
          // If pretext says they're on different lines, canvas candidates are a false match
          // (e.g. two annotations on consecutive tight lines with overlapping stored y).
          const firstInfo = preTextLine.get(candidates[0]!.id);
          const sameLine = candidates.every(c => {
            const info = preTextLine.get(c.id);
            if (!info || !firstInfo) return true; // no data → assume same line, allow split
            return info.paraIdx === firstInfo.paraIdx && info.lineIdx === firstInfo.lineIdx;
          });

          if (!sameLine) {
            // Pretext says candidates are on different visual lines — do a vertical split:
            // assign each rect in the cluster to whichever candidate's stored position
            // is closest in y. This handles adjacent same-color annotations on different
            // lines being merged into one cluster by the 25px pass-2 threshold.
            const verticalGroups = new Map<string, AbsoluteRect[]>();
            for (const rect of cluster) {
              let bestId = candidates[0]!.id;
              let bestDist = Infinity;
              for (const c of candidates) {
                for (const sr of (_anchorRects.get(c.id) ?? [])) {
                  const d = Math.abs(sr.top - rect.top);
                  if (d < bestDist) { bestDist = d; bestId = c.id; }
                }
              }
              if (!verticalGroups.has(bestId)) verticalGroups.set(bestId, []);
              verticalGroups.get(bestId)!.push(rect);
            }
            if (verticalGroups.size > 1) {
              for (const [, rects] of verticalGroups) splitClusters.push(rects);
            } else {
              splitClusters.push(cluster);
            }
            continue;
          }

          // Both checks agree: this cluster spans multiple same-line annotations.
          // Sort by pretext relative x-offset (reliable) then split using pretext widths.
          candidates.sort((a, b) => {
            const aOff = preTextLine.get(a.id)?.xOffset ?? a.left;
            const bOff = preTextLine.get(b.id)?.xOffset ?? b.left;
            return aOff - bOff;
          });
          let xCursor = clusterLeft;
          for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i]!;
            const isLast = i === candidates.length - 1;
            const splitWidth = isLast
              ? (clusterRight - xCursor)
              : (preTextLine.get(c.id)?.width ?? c.width);
            if (splitWidth > 0) {
              // First rect: the portion of line 1 that belongs to this annotation.
              // Trailing rects (wrapped lines 2+) belong to the LAST annotation only —
              // they start at the left margin and must not inherit the split x-offset.
              const firstRect = { ...cluster[0]!, left: xCursor, width: splitWidth };
              const trailingRects = isLast ? cluster.slice(1) : [];
              splitClusters.push([firstRect, ...trailingRects]);
              xCursor += splitWidth;
            }
          }
        }

        // Proximity matching: canvas stored positions are authoritative for y and x.
        // Pretext is NOT used here — its absolute x is too imprecise to improve matching.
        const pairs: { id: string; cluster: AbsoluteRect[]; dist: number }[] = [];
        for (const [id, lastRects] of _anchorRects) {
          for (const cluster of splitClusters) {
            let minDist = Infinity;
            for (const lr of lastRects) {
              const d = Math.abs(cluster[0]!.top  - lr.top)
                      + Math.abs(cluster[0]!.left - lr.left) * 0.5;
              if (d < minDist) minDist = d;
            }
            pairs.push({ id, cluster, dist: minDist });
          }
        }
        pairs.sort((a, b) => a.dist - b.dist);
        const assignedClusters = new Set<AbsoluteRect[]>();
        // Track which cluster each annotation was assigned to (used for edit detection below).
        const assignments = new Map<string, AbsoluteRect[]>();
        for (const { id, cluster, dist } of pairs) {
          if (assignedIds.has(id) || assignedClusters.has(cluster)) continue;
          // Reject implausible matches (annotation moved > 800px — likely a mismatch)
          if (dist > 800) continue;
          assignedIds.add(id);
          assignedClusters.add(cluster);
          assignments.set(id, cluster);
          _missCounts.delete(id);
          const lastRects = _anchorRects.get(id)!;
          const posUnchanged  = Math.abs(cluster[0]!.top  - lastRects[0]!.top)  < 1
                             && Math.abs(cluster[0]!.left - lastRects[0]!.left) < 1;
          const shapeUnchanged = cluster.length === lastRects.length
                              && cluster.every((r, i) => Math.abs(r.width - (lastRects[i]?.width ?? 0)) < 2);
          if (posUnchanged && shapeUnchanged) continue;
          _anchorRects.set(id, cluster);
          document.dispatchEvent(new CustomEvent('oddity-gdocs-corrected', { detail: { id, rects: cluster } }));
        }

        // Anchor text edit detection: for every assigned annotation whose anchor text
        // pretext could NOT find in the current doc, the user has edited the highlighted
        // text itself. Extract the new text from the cluster's canvas position so pretext
        // can resume tracking it on subsequent scans.
        if (pageMetrics && _cachedDocText) {
          for (const [id, cluster] of assignments) {
            if (preTextLine.has(id)) continue; // pretext found it — no edit
            const newText = extractAnchorTextFromCluster(
              cluster, scrollContainer, pageMetrics, _cachedDocText,
            );
            if (newText) {
              const job = _completedJobs.find(j => j.id === id);
              const current = _currentAnchorTexts.get(id) ?? job?.exact ?? '';
              if (newText !== current) {
                _currentAnchorTexts.set(id, newText);
                console.log(`[Oddity1] Anchor text updated for ${id}: "${newText}"`);
              }
            }
          }
        }

      }

      // Deletion check: always runs, even when found is empty.
      // Require 2 consecutive in-viewport misses before treating an annotation as deleted.
      // A single miss often means the split logic failed (stale positions / stale doc text)
      // rather than the highlight actually being gone — the doc text refresh at 1500ms will
      // re-scan and correctly re-match it before the second miss accumulates.
      const viewTop    = scrollContainer.scrollTop;
      const viewBottom = viewTop + scrollContainer.clientHeight;
      const toDelete: string[] = [];
      for (const [id, rects] of _anchorRects) {
        if (assignedIds.has(id)) { _missCounts.delete(id); continue; }
        const r = rects[0];
        if (!r || r.top < viewTop || r.top > viewBottom) {
          _missCounts.delete(id); // off-screen — reset, don't count as a miss
          continue;
        }
        const misses = (_missCounts.get(id) ?? 0) + 1;
        _missCounts.set(id, misses);
        if (misses >= 2) toDelete.push(id);
      }
      // Fire deletions after iterating so _anchorRects isn't mutated mid-loop.
      for (const id of toDelete) {
        document.dispatchEvent(new CustomEvent('oddity-gdocs-anchor-deleted', { detail: { id } }));
      }

      // Completeness check: for every annotation that canvas scan found nothing for AND
      // is not being deleted, re-assert the last known position so the overlay layer
      // can re-draw if missing. Recovery from stale positions is handled by
      // scheduleDocTextRefresh → scheduleParaCheck(50) which uses fresh pretext data.
      for (const [id, rects] of _anchorRects) {
        if (assignedIds.has(id) || toDelete.includes(id)) continue;
        const r = rects[0];
        if (!r || r.top < viewTop - 200 || r.top > viewBottom + 200) continue;
        document.dispatchEvent(new CustomEvent('oddity-gdocs-corrected', { detail: { id, rects } }));
      }

      saveGDocsRectsToStorage();
    }, delay);
  };

  const onKeydown = (e: KeyboardEvent) => {
    const pos = getCaretAbsY();

    if (pos) {
      if (e.key === 'Enter') {
        requestAnimationFrame(() => {
          document.dispatchEvent(new CustomEvent('oddity-gdocs-line-shift', {
            detail: { thresholdAbsY: pos.y, dyPx: pos.h },
          }));
        });
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey) {
        requestAnimationFrame(() => {
          const after = getCaretAbsY();
          if (after && pos.y - after.y > pos.h * 0.5) {
            document.dispatchEvent(new CustomEvent('oddity-gdocs-line-shift', {
              detail: { thresholdAbsY: pos.y, dyPx: -pos.h },
            }));
          }
        });
      }
    }

    // Schedule a position re-scan after any text-modifying key.
    // Use a longer delay whenever the change may affect multiple lines:
    //   - Bulk ops (paste/undo/redo/cut): always multi-line
    //   - Backspace/Delete: may delete a multi-line selection
    //   - Any key while GDocs reports an active selection: replaces selection
    // Single character typing with no selection uses the fast path (150 ms).
    const isMeta = e.metaKey || e.ctrlKey;
    const isBulkChange = isMeta && !e.altKey &&
      (e.key === 'v' || e.key === 'z' || e.key === 'y' || e.key === 'x');
    const isDeletion = !isMeta && !e.altKey &&
      (e.key === 'Backspace' || e.key === 'Delete');
    const isTyping = !isMeta && !e.altKey &&
      (e.key.length === 1 || e.key === 'Enter');

    if (isBulkChange || isDeletion) {
      scheduleParaCheck(600);
      scheduleDocTextRefresh(1500); // refresh doc text after bulk changes
    } else if (isTyping) {
      // If GDocs has a non-collapsed selection, typing replaces potentially
      // many lines — treat it as a bulk change.
      const hasSelection = document.querySelector(
        '.kix-selection-overlay, [class*="kix-selection-overlay"]'
      ) !== null;
      scheduleParaCheck(hasSelection ? 600 : 150);
      scheduleDocTextRefresh(2000); // refresh doc text after typing pauses
    }
  };

  iframeDoc.addEventListener('keydown', onKeydown, true);

  // ── Periodic heartbeat ──────────────────────────────────────────────────────
  // Even when the user isn't typing, overlays can drift due to browser zoom,
  // window resize, or GDocs internal reflows. Scan every 5 s to catch drift and
  // confirm that every annotation that should be visible actually is.
  const heartbeatInterval = setInterval(() => {
    if (_anchorRects.size === 0) return;
    scheduleParaCheck(0);
  }, 5000);

  // ── Scroll-triggered scan ───────────────────────────────────────────────────
  // When the user scrolls to a new area, previously off-screen annotations
  // become visible. Re-scan 300 ms after the scroll settles so their overlays
  // are verified against the live canvas immediately.
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  const onScroll = () => {
    if (_anchorRects.size === 0) return;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      scheduleParaCheck(0);
    }, 300);
  };
  scrollContainer.addEventListener('scroll', onScroll, { passive: true });

  return () => {
    iframeDoc.removeEventListener('keydown', onKeydown, true);
    scrollContainer.removeEventListener('scroll', onScroll);
    if (trackTimer) clearTimeout(trackTimer);
    if (docRefreshTimer) clearTimeout(docRefreshTimer);
    if (scrollTimer) clearTimeout(scrollTimer);
    clearInterval(heartbeatInterval);
  };
}

/**
 * Debug helper: opens the Google Docs find bar (Cmd+F), types the anchor text,
 * presses Enter to select it, Escape to close the bar (keeps selection), then
 * fires Cmd+U to underline it. Shows exactly where the real text is vs the overlay.
 */
// Serialize debug underline calls — only one runs at a time so annotations
// don't race each other in the find bar.
let _debugQueue: string[] = [];
let _debugRunning = false;

function debugUnderlineViaFind(text: string): void {
  _debugQueue.push(text);
  if (!_debugRunning) processDebugQueue();
}

function processDebugQueue(): void {
  const text = _debugQueue.shift();
  if (!text) { _debugRunning = false; return; }
  _debugRunning = true;
  runDebugUnderline(text).finally(processDebugQueue);
}

function runDebugUnderline(text: string): Promise<void> {
  return new Promise((resolve) => {
    const iframe = document.querySelector<HTMLIFrameElement>('.docs-texteventtarget-iframe');
    const iframeDoc = iframe?.contentDocument;
    if (!iframeDoc) { resolve(); return; }

    const iframeKey = (k: string, code: string, extra?: KeyboardEventInit) =>
      iframeDoc.dispatchEvent(new KeyboardEvent('keydown', {
        key: k, code, bubbles: true, cancelable: true, ...extra,
      }));

    // Step 1: Cmd+F to open find bar
    iframeKey('f', 'KeyF', { metaKey: true });

    setTimeout(() => {
      // Step 2: locate the find input (it gets auto-focused by GDocs)
      const findInput = (
        document.activeElement instanceof HTMLInputElement
          ? document.activeElement
          : document.querySelector<HTMLInputElement>('.docs-find-bar input, [class*="find-bar"] input')
      );

      if (!findInput) { finish(); return; }

      findInput.focus();
      findInput.select?.();
      const inserted = document.execCommand('insertText', false, text);
      if (!inserted) {
        findInput.value = '';
        for (const char of text) {
          findInput.dispatchEvent(new KeyboardEvent('keydown',  { key: char, bubbles: true }));
          findInput.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
          findInput.value += char;
          findInput.dispatchEvent(new InputEvent('input', { data: char, bubbles: true }));
          findInput.dispatchEvent(new KeyboardEvent('keyup',    { key: char, bubbles: true }));
        }
      }

      setTimeout(() => {
        // Step 3: Enter to jump to match
        findInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
        }));

        setTimeout(() => {
          // Step 4: Escape — fire on the input, its container, and document
          // so whichever level GDocs' find bar controller listens on gets it.
          const escEvt = () => new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
          });
          findInput.dispatchEvent(escEvt());
          findInput.closest('[class*="find"]')?.dispatchEvent(escEvt());
          document.dispatchEvent(escEvt());

          setTimeout(() => {
            // Step 5: click the underline toolbar button directly.
            // DOM clicks work without isTrusted — keyboard events for formatting are blocked.
            const underlineBtn = document.querySelector<HTMLElement>(
              '[data-tooltip*="Underline"], [aria-label*="Underline"], [title*="Underline"]'
            );
            underlineBtn?.click();
            setTimeout(resolve, 100);
          }, 300);
        }, 150);
      }, 200);
    }, 300);
  });
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
