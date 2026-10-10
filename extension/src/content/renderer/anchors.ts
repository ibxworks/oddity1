import type { Annotation } from '@oddity/shared';
import { getVisual } from './styles.js';
import { getThemeMode } from './theme-detector.js';

const ATTR = 'data-oddity-id';

// Lite motion: one 0.2s filter transition; none when reduced motion is preferred.
const REDUCED_MOTION =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const FILTER_TRANSITION = REDUCED_MOTION ? 'none' : 'filter 0.2s';

/** All injected anchor spans, keyed by annotation ID */
const anchorMap = new Map<string, HTMLSpanElement[]>();

/** Whether any anchor spans are currently injected in the DOM. */
export function hasAnchors(): boolean {
  return anchorMap.size > 0;
}

/**
 * Check whether a node lives inside a contenteditable subtree.
 */
function isInsideEditable(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
  if (!el) return false;
  return el.closest('[contenteditable]') !== null || (el as HTMLElement).isContentEditable;
}

/**
 * Inject invisible anchor spans around the text covered by `range` so that
 * hover / click events can be detected per-annotation.
 *
 * Returns the created spans (also stored internally for cleanup).
 */
export function injectAnchors(annotation: Annotation, range: Range): HTMLSpanElement[] {
  // Remove any previously injected spans for this annotation before re-injecting.
  // This prevents orphaned spans when the same annotation is rendered twice
  // (e.g. URL prediction renders speculatively, then the normal pipeline re-renders).
  if (anchorMap.has(annotation.id)) {
    removeAnchors(annotation.id);
  }

  const isPdf = !!document.querySelector('meta[name="oddity-source-pdf"]');
  const spans: HTMLSpanElement[] = [];

  // Collect text nodes within the range
  const textNodes: Text[] = [];
  let walkerRoot: Node = range.commonAncestorContainer;
  if (walkerRoot.nodeType === Node.TEXT_NODE) {
    walkerRoot = walkerRoot.parentElement ?? walkerRoot;
  }
  const walker = document.createTreeWalker(
    walkerRoot,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (isInsideEditable(node)) return NodeFilter.FILTER_REJECT;
        if (range.intersectsNode(node)) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_REJECT;
      },
    },
  );

  let current = walker.nextNode();
  while (current) {
    textNodes.push(current as Text);
    current = walker.nextNode();
  }

  for (const textNode of textNodes) {
    // Determine the slice of this text node that falls inside the range
    let startOffset = 0;
    let endOffset = textNode.length;

    if (textNode === range.startContainer) {
      startOffset = range.startOffset;
    }
    if (textNode === range.endContainer) {
      endOffset = range.endOffset;
    }

    // Nothing to wrap
    if (startOffset >= endOffset) continue;

    // Split off the portion we need to wrap
    let target: Text = textNode;

    // Split at start if needed
    if (startOffset > 0) {
      target = target.splitText(startOffset);
      endOffset -= startOffset;
    }

    // Split at end if needed (creates a tail we leave alone)
    if (endOffset < target.length) {
      target.splitText(endOffset);
    }

    // Wrap the target text node in a span
    const span = document.createElement('span');
    span.setAttribute(ATTR, annotation.id);
    span.setAttribute('data-oddity-type', annotation.type);
    const visual = getVisual(annotation.type, getThemeMode(), annotation.label, isPdf);
    let bgColor = visual.backgroundColor;
    let underlineStyle = visual.underlineStyle;
    const bgCss = bgColor ? `background-color: ${bgColor};` : '';
    const borderCss = underlineStyle ? `border-bottom: ${underlineStyle};` : '';
    span.style.cssText =
      `all: unset; display: inline; pointer-events: auto; position: relative; transition: ${FILTER_TRANSITION}; box-decoration-break: clone; -webkit-box-decoration-break: clone; ${bgCss} ${borderCss}`;

    target.parentNode!.insertBefore(span, target);
    span.appendChild(target);

    spans.push(span);
  }

  // Propagate highlight background to any inline ancestor elements (e.g. <a>,
  // <em>, <strong>) that sit between two highlighted spans.  Without this the
  // ancestor's own inline box creates a visible gap in the highlight.
  if (spans.length > 0) {
    const bgColor = getVisual(annotation.type, getThemeMode(), annotation.label, isPdf).backgroundColor;
    if (bgColor) {
      const tagged = new Set<Element>();
      for (const span of spans) {
        let el: Element | null = span.parentElement;
        while (el && el !== document.body && el !== document.documentElement) {
          // Only tag inline-level ancestors (links, em, strong, etc.)
          const display = getComputedStyle(el).display;
          if (display !== 'inline' && display !== 'inline-block') break;
          if (tagged.has(el)) break;
          tagged.add(el);
          (el as HTMLElement).style.backgroundColor = bgColor;
          (el as HTMLElement).dataset.oddityHighlightBg = annotation.id;
          el = el.parentElement;
        }
      }
    }
  }

  anchorMap.set(annotation.id, spans);
  return spans;
}

/**
 * Remove all anchor spans for a given annotation, restoring the original
 * text nodes.
 */
export function removeAnchors(annotationId: string): void {
  const spans = anchorMap.get(annotationId);
  if (!spans) return;

  // Remove highlight background from tagged inline ancestors
  const taggedEls = document.querySelectorAll(`[data-oddity-highlight-bg="${annotationId}"]`);
  for (const el of taggedEls) {
    (el as HTMLElement).style.backgroundColor = '';
    delete (el as HTMLElement).dataset.oddityHighlightBg;
  }

  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) continue;

    // Move children out of the span
    while (span.firstChild) {
      parent.insertBefore(span.firstChild, span);
    }
    parent.removeChild(span);

    // NOTE: We intentionally do NOT call parent.normalize() here.
    // normalize() merges adjacent text nodes, which destroys text node
    // references that React tracks internally.  When React later tries to
    // update a destroyed text node, it crashes with an error boundary.
    // Adjacent text nodes render identically and are harmless.
  }

  anchorMap.delete(annotationId);
}

/**
 * Remove all injected anchors for every annotation.
 */
export function clearAllAnchors(): void {
  for (const id of Array.from(anchorMap.keys())) {
    removeAnchors(id);
  }
}

/**
 * Get all anchor spans in document order for keyboard navigation.
 * Returns the first span per annotation (so Tab moves between annotations, not spans).
 */
export function getAllAnchorsInOrder(): HTMLSpanElement[] {
  const allSpans = document.querySelectorAll<HTMLSpanElement>(`[${ATTR}]`);
  const seen = new Set<string>();
  const result: HTMLSpanElement[] = [];

  for (const span of allSpans) {
    const id = span.getAttribute(ATTR);
    if (id && !seen.has(id)) {
      seen.add(id);
      span.tabIndex = 0;
      result.push(span);
    }
  }
  return result;
}

/**
 * Get the annotation ID from an anchor span.
 */
export function getAnnotationId(span: HTMLSpanElement): string | null {
  return span.getAttribute(ATTR);
}
