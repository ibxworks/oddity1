import type { TextQuoteSelector } from '@oddity/shared';

/**
 * Resolve a TextQuoteSelector to a DOM Range.
 * Uses TreeWalker for text node traversal with whitespace normalization.
 * Falls back to fuzzy matching if exact match fails.
 */
export function resolveSelector(
  root: Element,
  selector: TextQuoteSelector,
): Range | null {
  const exact = normalizeWhitespace(selector.exact);
  if (!exact) return null;

  // Collect all text nodes and build a concatenated text
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.textContent && node.textContent.trim().length > 0) {
      textNodes.push(node);
    }
  }

  if (textNodes.length === 0) return null;

  // Build offset map: concatenated text → (textNode, localOffset)
  const segments: { node: Text; start: number; text: string }[] = [];
  let totalOffset = 0;

  for (const tn of textNodes) {
    const normalized = normalizeWhitespace(tn.textContent ?? '');
    if (normalized.length === 0) continue;

    // Add a space between segments to simulate word boundaries
    if (totalOffset > 0) {
      totalOffset += 1;
    }

    segments.push({ node: tn, start: totalOffset, text: normalized });
    totalOffset += normalized.length;
  }

  const fullText = segments.map((s) => s.text).join(' ');

  // Find the exact match position in the concatenated text
  let matchPos = findMatchPosition(fullText, exact, selector.prefix, selector.suffix);

  // Fuzzy fallback: try without prefix/suffix
  if (matchPos === -1) {
    matchPos = fullText.indexOf(exact);
  }

  // Fuzzy fallback: case-insensitive
  if (matchPos === -1) {
    matchPos = fullText.toLowerCase().indexOf(exact.toLowerCase());
  }

  if (matchPos === -1) return null;

  // Map concatenated text position back to DOM range
  const startInfo = offsetToNode(segments, matchPos);
  const endInfo = offsetToNode(segments, matchPos + exact.length);

  if (!startInfo || !endInfo) return null;

  try {
    const range = document.createRange();
    range.setStart(startInfo.node, startInfo.offset);
    range.setEnd(endInfo.node, endInfo.offset);
    return range;
  } catch {
    return null;
  }
}

function findMatchPosition(
  fullText: string,
  exact: string,
  prefix?: string,
  suffix?: string,
): number {
  if (!prefix && !suffix) {
    return fullText.indexOf(exact);
  }

  const normalizedPrefix = prefix ? normalizeWhitespace(prefix) : '';
  const normalizedSuffix = suffix ? normalizeWhitespace(suffix) : '';

  // Search for all occurrences and pick the one best matching prefix/suffix
  let searchFrom = 0;
  let bestPos = -1;
  let bestScore = -1;

  while (searchFrom < fullText.length) {
    const pos = fullText.indexOf(exact, searchFrom);
    if (pos === -1) break;

    let score = 0;

    if (normalizedPrefix) {
      const before = fullText.slice(Math.max(0, pos - normalizedPrefix.length - 10), pos);
      if (before.includes(normalizedPrefix)) score += 2;
      else if (before.toLowerCase().includes(normalizedPrefix.toLowerCase())) score += 1;
    }

    if (normalizedSuffix) {
      const after = fullText.slice(pos + exact.length, pos + exact.length + normalizedSuffix.length + 10);
      if (after.includes(normalizedSuffix)) score += 2;
      else if (after.toLowerCase().includes(normalizedSuffix.toLowerCase())) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestPos = pos;
    }

    searchFrom = pos + 1;
  }

  return bestPos;
}

function offsetToNode(
  segments: { node: Text; start: number; text: string }[],
  offset: number,
): { node: Text; offset: number } | null {
  for (const seg of segments) {
    const segEnd = seg.start + seg.text.length;
    if (offset >= seg.start && offset <= segEnd) {
      // Map back from normalized offset to original text node offset
      const localNormOffset = offset - seg.start;
      const originalText = seg.node.textContent ?? '';
      const originalOffset = mapNormalizedToOriginal(originalText, localNormOffset);
      return { node: seg.node, offset: originalOffset };
    }
  }
  return null;
}

function mapNormalizedToOriginal(original: string, normalizedOffset: number): number {
  let normIdx = 0;
  let origIdx = 0;
  let inWhitespace = false;

  // Skip leading whitespace
  while (origIdx < original.length && /\s/.test(original[origIdx]!)) {
    origIdx++;
  }

  while (origIdx < original.length && normIdx < normalizedOffset) {
    if (/\s/.test(original[origIdx]!)) {
      if (!inWhitespace) {
        normIdx++;
        inWhitespace = true;
      }
    } else {
      normIdx++;
      inWhitespace = false;
    }
    origIdx++;
  }

  return origIdx;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
