import type { Annotation, TextQuoteSelector } from '@oddity/shared';

/**
 * Post-process AI-generated annotations to ensure `exact` strings
 * actually exist in the source text. Attempts auto-correction for
 * near-misses, drops annotations that can't be resolved.
 */
export function filterAndFixAnnotations(
  annotations: Annotation[],
  sourceText: string,
): Annotation[] {
  const normalizedSource = normalizeWs(sourceText);
  const results: Annotation[] = [];

  for (const ann of annotations) {
    const exact = ann.anchor.exact;
    if (!exact || exact.trim().length === 0) {
      console.warn(`[annotation-filter] Dropping ${ann.id}: empty exact text`);
      continue;
    }

    // 1. Exact match (whitespace-normalized)
    const normalizedExact = normalizeWs(exact);
    if (normalizedSource.includes(normalizedExact)) {
      // Snap exact to the actual source text at the matched position
      const snapped = snapToSource(normalizedSource, normalizedExact, sourceText);
      if (snapped) {
        ann.anchor.exact = snapped.exact;
        ann.anchor.prefix = snapped.prefix;
        ann.anchor.suffix = snapped.suffix;
      }
      results.push(ann);
      continue;
    }

    // 2. Try with boundary punctuation stripped from the annotation's exact
    const stripped = stripBoundaryPunctuation(normalizedExact);
    if (stripped.length > 0 && normalizedSource.includes(stripped)) {
      console.log(`[annotation-filter] Auto-corrected ${ann.id}: boundary punctuation stripped`);
      const snapped = snapToSource(normalizedSource, stripped, sourceText);
      if (snapped) {
        ann.anchor.exact = snapped.exact;
        ann.anchor.prefix = snapped.prefix;
        ann.anchor.suffix = snapped.suffix;
      }
      results.push(ann);
      continue;
    }

    // 3. Case-insensitive match → snap to actual source text
    const lowerSource = normalizedSource.toLowerCase();
    const lowerExact = normalizedExact.toLowerCase();
    const ciPos = lowerSource.indexOf(lowerExact);
    if (ciPos !== -1) {
      console.log(`[annotation-filter] Auto-corrected ${ann.id}: case-insensitive match`);
      const actualExact = normalizedSource.slice(ciPos, ciPos + lowerExact.length);
      const snapped = snapToSource(normalizedSource, actualExact, sourceText);
      if (snapped) {
        ann.anchor.exact = snapped.exact;
        ann.anchor.prefix = snapped.prefix;
        ann.anchor.suffix = snapped.suffix;
      }
      results.push(ann);
      continue;
    }

    // 4. Fuzzy substring search — sliding window with word overlap
    const fuzzyMatch = fuzzySubstringSearch(normalizedSource, normalizedExact);
    if (fuzzyMatch) {
      console.log(
        `[annotation-filter] Auto-corrected ${ann.id}: fuzzy match (score=${fuzzyMatch.score.toFixed(2)})`,
      );
      const snapped = snapToSource(normalizedSource, fuzzyMatch.text, sourceText);
      if (snapped) {
        ann.anchor.exact = snapped.exact;
        ann.anchor.prefix = snapped.prefix;
        ann.anchor.suffix = snapped.suffix;
      }
      results.push(ann);
      continue;
    }

    // 5. Nothing worked — drop the annotation
    console.warn(`[annotation-filter] Dropping ${ann.id}: could not match "${exact.slice(0, 60)}..."`);
  }

  const dropped = annotations.length - results.length;
  if (dropped > 0) {
    console.log(
      `[annotation-filter] ${results.length}/${annotations.length} annotations kept (${dropped} dropped)`,
    );
  }

  // Fix chunk boundary anchors (overview mode only)
  for (const ann of results) {
    if (ann.chunk) {
      const fixedStart = fixChunkAnchor(ann.chunk.start, normalizedSource, sourceText);
      const fixedEnd = fixChunkAnchor(ann.chunk.end, normalizedSource, sourceText);
      // If either boundary couldn't be resolved, discard chunk data
      if (fixedStart && fixedEnd) {
        ann.chunk = { start: fixedStart, end: fixedEnd };
      } else {
        ann.chunk = undefined;
      }
    }
  }

  // Snap adjacent chunk boundaries so they're contiguous (no overlaps/gaps)
  snapAdjacentChunks(results, normalizedSource);

  return deduplicateOverlapping(results, normalizedSource);
}

/**
 * Fix a single annotation's anchor against the source text.
 * Returns the fixed annotation, or null if it can't be resolved.
 * Used for streaming — each annotation is fixed as it arrives.
 */
export function fixSingleAnnotation(
  ann: Annotation,
  sourceText: string,
): Annotation | null {
  const result = filterAndFixAnnotations([ann], sourceText);
  return result.length > 0 ? result[0]! : null;
}

// ─── Chunk Anchor Helpers ───

/**
 * Fix a single chunk boundary anchor against the source text.
 * Uses the same matching cascade as main anchors but simpler —
 * returns the fixed selector or null if unresolvable.
 */
function fixChunkAnchor(
  selector: TextQuoteSelector,
  normalizedSource: string,
  originalSource: string,
): TextQuoteSelector | null {
  const exact = selector.exact;
  if (!exact || exact.trim().length === 0) return null;

  const normalizedExact = normalizeWs(exact);

  // 1. Exact match
  if (normalizedSource.includes(normalizedExact)) {
    const snapped = snapToSource(normalizedSource, normalizedExact, originalSource);
    if (snapped) return { type: 'TextQuoteSelector', exact: snapped.exact, prefix: snapped.prefix, suffix: snapped.suffix };
  }

  // 2. Case-insensitive
  const lowerSource = normalizedSource.toLowerCase();
  const lowerExact = normalizedExact.toLowerCase();
  const ciPos = lowerSource.indexOf(lowerExact);
  if (ciPos !== -1) {
    const actualExact = normalizedSource.slice(ciPos, ciPos + lowerExact.length);
    const snapped = snapToSource(normalizedSource, actualExact, originalSource);
    if (snapped) return { type: 'TextQuoteSelector', exact: snapped.exact, prefix: snapped.prefix, suffix: snapped.suffix };
  }

  // 3. Fuzzy
  const fuzzyMatch = fuzzySubstringSearch(normalizedSource, normalizedExact);
  if (fuzzyMatch) {
    const snapped = snapToSource(normalizedSource, fuzzyMatch.text, originalSource);
    if (snapped) return { type: 'TextQuoteSelector', exact: snapped.exact, prefix: snapped.prefix, suffix: snapped.suffix };
  }

  return null;
}

// ─── Chunk Contiguity ───

/**
 * Ensure adjacent chunks are contiguous: chunk N's end should meet chunk N+1's start
 * with no overlap and no gap. If chunk N's end overlaps or has a gap with chunk N+1's
 * start, adjust chunk N's end to end right before chunk N+1's start.
 */
function snapAdjacentChunks(annotations: Annotation[], normalizedSource: string): void {
  // Only process annotations that have chunk data, in source order
  const withChunks = annotations.filter((a) => a.chunk);
  if (withChunks.length < 2) return;

  // Sort by chunk start position in the source text
  const positioned = withChunks.map((ann) => {
    const startExact = normalizeWs(ann.chunk!.start.exact);
    const endExact = normalizeWs(ann.chunk!.end.exact);
    const startPos = normalizedSource.indexOf(startExact);
    const endPos = normalizedSource.indexOf(endExact);
    return { ann, startPos, endPos: endPos !== -1 ? endPos + endExact.length : -1 };
  }).filter((p) => p.startPos !== -1 && p.endPos !== -1);

  positioned.sort((a, b) => a.startPos - b.startPos);

  for (let i = 0; i < positioned.length - 1; i++) {
    const curr = positioned[i]!;
    const next = positioned[i + 1]!;

    // If current chunk's end extends past (or into) the next chunk's start, snap it
    if (curr.endPos > next.startPos) {
      // Overlap: shrink current chunk's end to stop right at next chunk's start
      const newEndText = normalizedSource.slice(Math.max(curr.startPos, next.startPos - 60), next.startPos).trim();
      if (newEndText.length > 0) {
        // Take the last ~10 words as the new chunk_end anchor
        const words = newEndText.split(' ');
        const endPhrase = words.slice(-Math.min(12, words.length)).join(' ');
        curr.ann.chunk!.end = { type: 'TextQuoteSelector', exact: endPhrase };
        curr.endPos = next.startPos;
        console.log(`[annotation-filter] Snapped chunk ${curr.ann.id} end to remove overlap`);
      }
    }
  }
}

// ─── Helpers ───

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripBoundaryPunctuation(text: string): string {
  return text.replace(/^[^\w\s]+/, '').replace(/[^\w\s]+$/, '').trim();
}

/**
 * Given a match in normalizedSource, extract the actual substring from
 * the original sourceText and compute prefix/suffix context.
 */
function snapToSource(
  normalizedSource: string,
  matchText: string,
  originalSource: string,
): { exact: string; prefix: string; suffix: string } | null {
  const pos = normalizedSource.indexOf(matchText);
  if (pos === -1) return null;

  // Map normalized position back to original source
  const origStart = mapNormalizedOffset(originalSource, pos);
  const origEnd = mapNormalizedOffset(originalSource, pos + matchText.length);

  const exact = originalSource.slice(origStart, origEnd);
  const prefixStart = Math.max(0, origStart - 20);
  const suffixEnd = Math.min(originalSource.length, origEnd + 20);

  const prefix = normalizeWs(originalSource.slice(prefixStart, origStart)).slice(-15);
  const suffix = normalizeWs(originalSource.slice(origEnd, suffixEnd)).slice(0, 15);

  return { exact, prefix, suffix };
}

/**
 * Map an offset in whitespace-normalized text back to the original text.
 */
function mapNormalizedOffset(original: string, normalizedOffset: number): number {
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

/**
 * Remove annotations whose anchors overlap with a previously-kept annotation
 * in the same whitespace-normalized source. Earlier start position wins.
 * Annotations whose position cannot be located are passed through unchanged.
 */
function deduplicateOverlapping(
  annotations: Annotation[],
  normalizedSource: string,
): Annotation[] {
  type Positioned = { ann: Annotation; start: number; end: number };
  const locatable: Positioned[] = [];
  const unlocatable: Annotation[] = [];

  for (const ann of annotations) {
    const exact = normalizeWs(ann.anchor.exact);
    const prefix = ann.anchor.prefix ? normalizeWs(ann.anchor.prefix) : '';
    const suffix = ann.anchor.suffix ? normalizeWs(ann.anchor.suffix) : '';
    const start = findAnchorPosition(normalizedSource, exact, prefix, suffix);
    if (start === -1) {
      unlocatable.push(ann);
    } else {
      locatable.push({ ann, start, end: start + exact.length });
    }
  }

  locatable.sort((a, b) => a.start - b.start);

  const kept: Positioned[] = [];
  for (const item of locatable) {
    const overlaps = kept.some((k) => item.start < k.end && item.end > k.start);
    if (overlaps) {
      console.log(
        `[annotation-filter] Dropping overlapping annotation ${item.ann.id}: "${item.ann.anchor.exact.slice(0, 50)}"`,
      );
    } else {
      kept.push(item);
    }
  }

  return [...kept.map((k) => k.ann), ...unlocatable];
}

/**
 * Find the start position of `exact` in `source`, using prefix/suffix context
 * to pick the right occurrence when the phrase appears multiple times.
 * Returns -1 if not found.
 */
function findAnchorPosition(
  source: string,
  exact: string,
  prefix: string,
  suffix: string,
): number {
  let searchFrom = 0;
  while (true) {
    const pos = source.indexOf(exact, searchFrom);
    if (pos === -1) return -1;

    if (prefix || suffix) {
      const contextBefore = source.slice(Math.max(0, pos - prefix.length), pos);
      const contextAfter = source.slice(pos + exact.length, pos + exact.length + suffix.length);
      if (
        (!prefix || contextBefore.endsWith(prefix)) &&
        (!suffix || contextAfter.startsWith(suffix))
      ) {
        return pos;
      }
      searchFrom = pos + 1;
      continue;
    }

    return pos;
  }
}

/**
 * Fuzzy sliding-window search: find the best-matching substring in the source
 * by word overlap. Returns the match if similarity >= 0.75.
 */
function fuzzySubstringSearch(
  normalizedSource: string,
  normalizedExact: string,
): { text: string; score: number } | null {
  const exactWords = normalizedExact.split(' ');
  if (exactWords.length < 2) return null;

  const sourceWords = normalizedSource.split(' ');
  const windowSize = exactWords.length;

  if (sourceWords.length < windowSize) return null;

  let bestScore = 0;
  let bestStart = -1;
  let bestEnd = -1;

  // Build a set from exact words for fast lookup
  const exactWordSet = new Set(exactWords.map((w) => w.toLowerCase()));

  for (let i = 0; i <= sourceWords.length - windowSize; i++) {
    const windowWords = sourceWords.slice(i, i + windowSize);
    let overlap = 0;
    for (const w of windowWords) {
      if (exactWordSet.has(w.toLowerCase())) overlap++;
    }
    const score = overlap / windowSize;

    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
      bestEnd = i + windowSize;
    }
  }

  if (bestScore >= 0.75 && bestStart !== -1) {
    const matchedText = sourceWords.slice(bestStart, bestEnd).join(' ');
    return { text: matchedText, score: bestScore };
  }

  return null;
}
