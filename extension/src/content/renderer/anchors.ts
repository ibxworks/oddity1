import type { Annotation } from '@oddity/shared';

const ATTR = 'data-oddity-id';

/** All injected anchor spans, keyed by annotation ID */
const anchorMap = new Map<string, HTMLSpanElement[]>();

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
  const spans: HTMLSpanElement[] = [];

  // Collect text nodes within the range
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
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
    span.style.cssText =
      'all: unset; display: inline; pointer-events: auto; position: relative;';

    target.parentNode!.insertBefore(span, target);
    span.appendChild(target);

    spans.push(span);
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

  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) continue;

    // Move children out of the span
    while (span.firstChild) {
      parent.insertBefore(span.firstChild, span);
    }
    parent.removeChild(span);

    // Merge adjacent text nodes back together
    parent.normalize();
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
