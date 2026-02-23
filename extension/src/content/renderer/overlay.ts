import type { Annotation, AnnotationType } from '@oddity/shared';
import { getVisual } from './styles.js';

const OVERLAY_ID = 'oddity-overlay';
const Z_INDEX = 2147483646;

let overlayEl: HTMLDivElement | null = null;
let rafId: number | null = null;
let activeRanges: { annotation: Annotation; range: Range }[] = [];

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
 */
export function renderAnnotation(annotation: Annotation, range: Range): void {
  if (!overlayEl) initOverlay();
  activeRanges.push({ annotation, range });
  drawAnnotation(annotation, range);
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
 * Destroy the overlay completely.
 */
export function destroyOverlay(): void {
  stopTracking();
  overlayEl?.remove();
  overlayEl = null;
  activeRanges = [];
}

// ─── Internal Drawing ───

function drawAnnotation(annotation: Annotation, range: Range): void {
  if (!overlayEl) return;

  const visual = getVisual(annotation.type);
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
      transition: opacity 0.15s;
      ${visual.backgroundColor ? `background-color: ${visual.backgroundColor};` : ''}
      ${visual.underlineStyle ? `border-bottom: ${visual.underlineStyle};` : ''}
    `;

    overlayEl.appendChild(el);
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
      overlayEl.appendChild(icon);
    }
  }
}

function redraw(): void {
  if (!overlayEl) return;
  overlayEl.innerHTML = '';
  for (const { annotation, range } of activeRanges) {
    drawAnnotation(annotation, range);
  }
}

// ─── Scroll / Resize Tracking ───

function startTracking(): void {
  const onFrame = () => {
    redraw();
    rafId = requestAnimationFrame(onFrame);
  };

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
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (overlayEl) {
    const cleanup = (overlayEl as HTMLDivElement & { _cleanup?: () => void })._cleanup;
    cleanup?.();
  }
}
