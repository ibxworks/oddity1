import type { Annotation, AnnotationType } from '@oddity/shared';

const OVERLAY_ID = 'oddity-overlay';
const Z_INDEX = 2147483646;

let overlayEl: HTMLDivElement | null = null;
/** Inner wrapper whose transform is updated on scroll instead of recreating DOM. */
let wrapperEl: HTMLDivElement | null = null;
let activeRanges: { annotation: Annotation; range: Range }[] = [];
let emphasizedId: string | null = null;

// ─── Position Cache ───
// Store absolute (page-level) rects so we never call getClientRects() on scroll.
type AbsoluteRect = { left: number; top: number; width: number; height: number };
let cachedRects: Map<string, AbsoluteRect[]> = new Map();

// Baseline scroll offsets recorded when the cache was last built.
let baseWindowScrollX = 0;
let baseWindowScrollY = 0;
// Nested scroll container (e.g. ChatGPT's chat pane) detected at runtime.
let scrollContainer: Element | null = null;
let baseContainerScrollLeft = 0;
let baseContainerScrollTop = 0;

// ─── Batched Rendering ───
// Queue annotations and flush in a single rAF to avoid layout thrashing.
let pendingBatch: { annotation: Annotation }[] = [];
let batchRafId: number | null = null;

function cacheAnnotationRects(annotation: Annotation, range: Range): void {
  const rects = range.getClientRects();
  const sx = window.scrollX;
  const sy = window.scrollY;
  const abs: AbsoluteRect[] = [];
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (r.width === 0 || r.height === 0) continue;
    abs.push({ left: r.left + sx, top: r.top + sy, width: r.width, height: r.height });
  }
  cachedRects.set(annotation.id, abs);
}

function flushBatch(): void {
  if (!wrapperEl || pendingBatch.length === 0) return;

  const fragment = document.createDocumentFragment();
  for (const { annotation } of pendingBatch) {
    drawCachedAnnotationInto(fragment, annotation);
  }

  wrapperEl.appendChild(fragment);
  updateWrapperTransform();
  pendingBatch = [];
  batchRafId = null;
}

function scheduleBatchFlush(): void {
  if (batchRafId !== null) return;
  batchRafId = requestAnimationFrame(flushBatch);
}

/**
 * Initialize the overlay layer — a fixed-position, pointer-events-none div
 * that sits on top of the page for drawing highlight/underline rectangles.
 */
export function initOverlay(): HTMLDivElement {
  if (overlayEl) return overlayEl;

  overlayEl = document.createElement('div');
  overlayEl.id = OVERLAY_ID;
  overlayEl.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: ${Z_INDEX};
    pointer-events: none;
    overflow: visible;
  `;

  wrapperEl = document.createElement('div');
  wrapperEl.style.cssText = 'position: absolute; top: 0; left: 0; will-change: transform;';
  overlayEl.appendChild(wrapperEl);

  document.body.appendChild(overlayEl);

  baseWindowScrollX = window.scrollX;
  baseWindowScrollY = window.scrollY;

  startTracking();

  return overlayEl;
}

/**
 * Render highlight/underline rectangles for an annotation's resolved range.
 * Rects are cached at absolute (page-level) coordinates and the wrapper's
 * CSS transform is used to map them into the viewport on scroll — no
 * per-annotation layout work on each frame.
 */
export function renderAnnotation(annotation: Annotation, range: Range): void {
  if (!overlayEl) initOverlay();
  activeRanges.push({ annotation, range });
  cacheAnnotationRects(annotation, range);
  pendingBatch.push({ annotation });
  scheduleBatchFlush();
}

/**
 * Clear all rendered annotations from the overlay.
 */
export function clearOverlay(): void {
  if (wrapperEl) {
    wrapperEl.innerHTML = '';
  }
  activeRanges = [];
  cachedRects.clear();
}

/**
 * Remove a specific annotation's rendering.
 */
export function removeAnnotation(annotationId: string): void {
  activeRanges = activeRanges.filter((ar) => ar.annotation.id !== annotationId);
  cachedRects.delete(annotationId);
  redraw();
}

/**
 * Show/hide the overlay.
 */
export function setOverlayVisible(visible: boolean): void {
  if (overlayEl) {
    overlayEl.style.display = visible ? '' : 'none';
  }
}

/**
 * Filter visible annotations by type.
 */
export function filterByTypes(visibleTypes: AnnotationType[]): void {
  if (!wrapperEl) return;
  const typeSet = new Set(visibleTypes);

  for (const child of Array.from(wrapperEl.children)) {
    const type = (child as HTMLElement).dataset.annotationType as AnnotationType | undefined;
    if (type) {
      (child as HTMLElement).style.display = typeSet.has(type) ? '' : 'none';
    }
  }
}

/**
 * Emphasize a specific annotation's anchor spans with brightness(1.4).
 */

export function emphasizeAnnotation(id: string): void {
  emphasizedId = id;
  document.querySelectorAll<HTMLSpanElement>(`[data-oddity-id]`).forEach(span => {
    if (span.getAttribute('data-oddity-id') !== id) {
      span.style.filter = '';
      if (span.dataset.oddityOrigBg) {
        span.style.backgroundColor = span.dataset.oddityOrigBg;
        span.dataset.oddityOrigBg = '';
      }
      if (span.dataset.oddityOrigBorder) {
        span.style.borderBottom = span.dataset.oddityOrigBorder;
        span.dataset.oddityOrigBorder = '';
      }
      return;
    }
    const type = span.getAttribute('data-oddity-type') ?? '';

    if (type === 'user_written') {
      // Blue: swap color to #3987FF, no brightness/opacity change
      if (!span.dataset.oddityOrigBg) span.dataset.oddityOrigBg = span.style.backgroundColor;
      if (!span.dataset.oddityOrigBorder) span.dataset.oddityOrigBorder = span.style.borderBottom;
      span.style.backgroundColor = 'rgba(57, 135, 255, 0.2)';
      span.style.borderBottom = '1.5px solid rgba(57, 135, 255, 0.9)';
      span.style.filter = '';
    } else {
      // All other colors: boost opacity + slight brightness
      const bg = span.style.backgroundColor;
      if (!span.dataset.oddityOrigBg) span.dataset.oddityOrigBg = bg;
      const currentBg = span.dataset.oddityOrigBg || bg;
      span.style.backgroundColor = boostAlpha(currentBg, 0.3);
      span.style.filter = 'brightness(1.1)';
    }
  });
}

/** Boost the alpha of a CSS color to a target value. */
function boostAlpha(color: string, targetAlpha: number): string {
  const rgbaMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (rgbaMatch) {
    const [, r, g, b] = rgbaMatch;
    return `rgba(${r}, ${g}, ${b}, ${targetAlpha})`;
  }
  return color;
}

/**
 * Remove emphasis from all anchor spans.
 */
export function deemphasizeAnnotation(): void {
  emphasizedId = null;
  document.querySelectorAll<HTMLSpanElement>(`[data-oddity-id]`).forEach(span => {
    span.style.filter = '';
    if (span.dataset.oddityOrigBg) {
      span.style.backgroundColor = span.dataset.oddityOrigBg;
      span.dataset.oddityOrigBg = '';
    }
    if (span.dataset.oddityOrigBorder) {
      span.style.borderBottom = span.dataset.oddityOrigBorder;
      span.dataset.oddityOrigBorder = '';
    }
  });
}

/**
 * Destroy the overlay completely.
 */
export function destroyOverlay(): void {
  stopTracking();
  overlayEl?.remove();
  overlayEl = null;
  wrapperEl = null;
  activeRanges = [];
  cachedRects.clear();
  scrollContainer = null;
}

// ─── Internal Drawing ───

/** Draw annotation rects from the position cache (no getClientRects). */
function drawCachedAnnotationInto(parent: Node, annotation: Annotation): void {
  const rects = cachedRects.get(annotation.id);
  if (!rects) return;

  const isEmphasized = emphasizedId === annotation.id;

  for (const rect of rects) {
    const el = document.createElement('div');
    el.dataset.annotationId = annotation.id;
    el.dataset.annotationType = annotation.type;
    el.className = 'oddity-rect';

    // Rects are stored at absolute page coordinates; the wrapper's transform
    // shifts them into the viewport.
    el.style.cssText = `
      position: absolute;
      left: ${rect.left}px;
      top: ${rect.top}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      pointer-events: none;
      transition: filter 0.15s;
      z-index: 1;
      ${isEmphasized ? 'filter: brightness(1.4);' : ''}
    `;

    parent.appendChild(el);
  }
}

/** Update the wrapper's CSS transform to map cached absolute positions into the viewport. */
function updateWrapperTransform(): void {
  if (!wrapperEl) return;
  const dx = window.scrollX - baseWindowScrollX +
    (scrollContainer ? scrollContainer.scrollLeft - baseContainerScrollLeft : 0);
  const dy = window.scrollY - baseWindowScrollY +
    (scrollContainer ? scrollContainer.scrollTop - baseContainerScrollTop : 0);
  wrapperEl.style.transform = `translate(${-dx}px, ${-dy}px)`;
}

/** Rebuild the wrapper DOM from the cache (used after add/remove, NOT on scroll). */
function redraw(): void {
  if (!wrapperEl) return;

  pendingBatch = [];
  if (batchRafId !== null) {
    cancelAnimationFrame(batchRafId);
    batchRafId = null;
  }

  wrapperEl.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (const { annotation } of activeRanges) {
    drawCachedAnnotationInto(fragment, annotation);
  }
  wrapperEl.appendChild(fragment);
  updateWrapperTransform();
}

/** Recalculate cached positions from live ranges (called on resize only). */
function recalculateCache(): void {
  baseWindowScrollX = window.scrollX;
  baseWindowScrollY = window.scrollY;
  baseContainerScrollLeft = scrollContainer?.scrollLeft ?? 0;
  baseContainerScrollTop = scrollContainer?.scrollTop ?? 0;

  cachedRects.clear();
  for (const { annotation, range } of activeRanges) {
    cacheAnnotationRects(annotation, range);
  }
  redraw();
}

// ─── Scroll / Resize Tracking ───

function startTracking(): void {
  // Scroll: just update the transform — no layout recalculation.
  const onScroll = (e: Event) => {
    // Auto-detect nested scroll container on first non-window scroll event.
    if (!scrollContainer && e.target !== document && e.target !== window && e.target instanceof Element) {
      const target = e.target;
      // Verify this container actually holds our annotations.
      const firstRange = activeRanges[0]?.range;
      if (firstRange && target.contains(firstRange.commonAncestorContainer)) {
        scrollContainer = target;
        baseContainerScrollLeft = target.scrollLeft;
        baseContainerScrollTop = target.scrollTop;
      }
    }
    updateWrapperTransform();
  };

  // Resize: full recalculate (positions may have shifted).
  let resizeRafId: number | null = null;
  const onResize = () => {
    if (resizeRafId === null) {
      resizeRafId = requestAnimationFrame(() => {
        recalculateCache();
        resizeRafId = null;
      });
    }
  };

  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('resize', onResize, { passive: true });

  (overlayEl as HTMLDivElement & { _cleanup?: () => void })._cleanup = () => {
    window.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('resize', onResize);
  };
}

function stopTracking(): void {
  if (overlayEl) {
    const cleanup = (overlayEl as HTMLDivElement & { _cleanup?: () => void })._cleanup;
    cleanup?.();
  }
}
