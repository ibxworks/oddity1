import type { Annotation } from '@oddity/shared';

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

  return results;
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
