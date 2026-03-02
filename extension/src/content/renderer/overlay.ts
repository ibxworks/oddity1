import type { Annotation, AnnotationType } from '@oddity/shared';
import { getVisual } from './styles.js';

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
 * Emphasize a specific annotation's overlay rects (vivid styles).
 */
export function emphasizeAnnotation(id: string): void {
  emphasizedId = id;
  redraw();
}

/**
 * Remove emphasis from all overlay rects.
 */
export function deemphasizeAnnotation(): void {
  emphasizedId = null;
  redraw();
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

  const visual = getVisual(annotation.type);
  const isEmphasized = emphasizedId === annotation.id;
  const rects = range.getClientRects();

  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]!;
    if (rect.width === 0 || rect.height === 0) continue;

    const el = document.createElement('div');
    el.dataset.annotationId = annotation.id;
    el.dataset.annotationType = annotation.type;
    el.className = 'oddity-rect';

    // Underline-type rects get higher z-index so they render above background-type rects
    const isUnderline = !visual.backgroundColor && visual.underlineStyle;

    // Compute emphasized styles
    let bgStyle = '';
    let borderStyle = '';
    if (visual.backgroundColor) {
      // Background types: normal 0x33 (20%), emphasized 0x66 (40%)
      bgStyle = isEmphasized
        ? `background-color: ${visual.color}66;`
        : `background-color: ${visual.backgroundColor};`;
    }
    if (visual.underlineStyle) {
      if (isEmphasized) {
        // Thicker underline + subtle background tint
        const underlineParts = visual.underlineStyle.replace('2px', '3px');
        borderStyle = `border-bottom: ${underlineParts};`;
        bgStyle = `background-color: ${visual.color}15;`;
      } else {
        borderStyle = `border-bottom: ${visual.underlineStyle};`;
      }
    }

    el.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${rect.top}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      pointer-events: none;
      transition: opacity 0.15s, background-color 0.15s, border-bottom 0.15s;
      z-index: ${isUnderline ? 2 : 1};
      ${bgStyle}
      ${borderStyle}
    `;

    parent.appendChild(el);
  }

  // Gutter icon (for question type)
  if (visual.gutterIcon) {
    const firstRect = rects[0];
    if (firstRect) {
      const icon = document.createElement('div');
      icon.dataset.annotationId = annotation.id;
      icon.dataset.annotationType = annotation.type;
      icon.className = 'oddity-gutter';
      icon.textContent = visual.gutterIcon;
      icon.style.cssText = `
        position: fixed;
        left: ${firstRect.left - 20}px;
        top: ${firstRect.top}px;
        width: 16px;
        height: 16px;
        font-size: 12px;
        line-height: 16px;
        text-align: center;
        border-radius: 50%;
        background: ${visual.color};
        color: white;
        font-weight: bold;
        pointer-events: none;
      `;
      parent.appendChild(icon);
    }
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
