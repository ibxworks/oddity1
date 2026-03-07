import type { Annotation, AnnotationType } from '@oddity/shared';

const OVERLAY_ID = 'oddity-overlay';
const Z_INDEX = 2147483646;

let overlayEl: HTMLDivElement | null = null;
let activeRanges: { annotation: Annotation; range: Range }[] = [];
let emphasizedId: string | null = null;

// ─── Batched Rendering ───
// Queue annotations and flush in a single rAF to avoid layout thrashing.
let pendingBatch: { annotation: Annotation; range: Range }[] = [];
let batchRafId: number | null = null;

function flushBatch(): void {
  if (!overlayEl || pendingBatch.length === 0) return;

  // Use DocumentFragment to batch all DOM insertions
  const fragment = document.createDocumentFragment();

  for (const { annotation, range } of pendingBatch) {
    drawAnnotationInto(fragment, annotation, range);
  }

  overlayEl.appendChild(fragment);
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
    overflow: hidden;
  `;
  document.body.appendChild(overlayEl);

  // Start scroll/resize tracking
  startTracking();

  return overlayEl;
}

/**
 * Render highlight/underline rectangles for an annotation's resolved range.
 * Annotations are batched and drawn in a single requestAnimationFrame to
 * avoid layout thrashing when rendering multiple annotations at once.
 */
export function renderAnnotation(annotation: Annotation, range: Range): void {
  if (!overlayEl) initOverlay();
  activeRanges.push({ annotation, range });
  pendingBatch.push({ annotation, range });
  scheduleBatchFlush();
}

/**
 * Clear all rendered annotations from the overlay.
 */
export function clearOverlay(): void {
  if (overlayEl) {
    overlayEl.innerHTML = '';
  }
  activeRanges = [];
}

/**
 * Remove a specific annotation's rendering.
 */
export function removeAnnotation(annotationId: string): void {
  activeRanges = activeRanges.filter((ar) => ar.annotation.id !== annotationId);
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
  if (!overlayEl) return;
  const typeSet = new Set(visibleTypes);

  for (const child of Array.from(overlayEl.children)) {
    const type = (child as HTMLElement).dataset.annotationType as AnnotationType | undefined;
    if (type) {
      (child as HTMLElement).style.display = typeSet.has(type) ? '' : 'none';
    }
  }
}

/**
 * Emphasize a specific annotation's anchor spans with brightness(1.4).
 */
const LIGHT_ACCENT_TYPES = new Set(['insight']);

export function emphasizeAnnotation(id: string): void {
  emphasizedId = id;
  document.querySelectorAll<HTMLSpanElement>(`[data-oddity-id]`).forEach(span => {
    if (span.getAttribute('data-oddity-id') !== id) { span.style.filter = ''; return; }
    const type = span.getAttribute('data-oddity-type') ?? '';
    span.style.filter = LIGHT_ACCENT_TYPES.has(type) ? 'brightness(1.1) saturate(1.15)' : 'brightness(1.4)';
  });
}

/**
 * Remove emphasis from all anchor spans.
 */
export function deemphasizeAnnotation(): void {
  emphasizedId = null;
  document.querySelectorAll<HTMLSpanElement>(`[data-oddity-id]`).forEach(span => {
    span.style.filter = '';
  });
}

/**
 * Destroy the overlay completely.
 */
export function destroyOverlay(): void {
  stopTracking();
  overlayEl?.remove();
  overlayEl = null;
  activeRanges = [];
}

// ─── Internal Drawing ───

/** Draw annotation rects into a target parent (overlay or DocumentFragment) */
function drawAnnotationInto(parent: Node, annotation: Annotation, range: Range): void {

  const isEmphasized = emphasizedId === annotation.id;
  const rects = range.getClientRects();

  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]!;
    if (rect.width === 0 || rect.height === 0) continue;

    const el = document.createElement('div');
    el.dataset.annotationId = annotation.id;
    el.dataset.annotationType = annotation.type;
    el.className = 'oddity-rect';

    el.style.cssText = `
      position: fixed;
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

function redraw(): void {
  if (!overlayEl) return;

  // Cancel any pending batch flush — redraw renders ALL activeRanges,
  // so the batch would duplicate what we're about to draw.
  pendingBatch = [];
  if (batchRafId !== null) {
    cancelAnimationFrame(batchRafId);
    batchRafId = null;
  }

  overlayEl.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (const { annotation, range } of activeRanges) {
    drawAnnotationInto(fragment, annotation, range);
  }
  overlayEl.appendChild(fragment);
}

// ─── Scroll / Resize Tracking ───

function startTracking(): void {
  // Use scroll/resize events to trigger redraw, throttled via rAF
  let needsRedraw = false;

  const scheduleRedraw = () => {
    if (!needsRedraw) {
      needsRedraw = true;
      requestAnimationFrame(() => {
        redraw();
        needsRedraw = false;
      });
    }
  };

  window.addEventListener('scroll', scheduleRedraw, { passive: true, capture: true });
  window.addEventListener('resize', scheduleRedraw, { passive: true });

  // Store cleanup references
  (overlayEl as HTMLDivElement & { _cleanup?: () => void })._cleanup = () => {
    window.removeEventListener('scroll', scheduleRedraw, { capture: true });
    window.removeEventListener('resize', scheduleRedraw);
  };
}

function stopTracking(): void {
  if (overlayEl) {
    const cleanup = (overlayEl as HTMLDivElement & { _cleanup?: () => void })._cleanup;
    cleanup?.();
  }
}
