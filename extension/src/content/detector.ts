import type { SiteAdapter } from "@oddity/shared";

export interface DetectedRegion {
  id: string;
  element: Element;
  source: "adapter" | "readability" | "heuristic";
}

/**
 * Detect reading regions on the current page using the adapter registry
 * with Readability and custom heuristic fallbacks.
 */
export function detectReadingRegions(
  adapters: SiteAdapter[],
): DetectedRegion[] {
  const hostname = window.location.hostname;

  // Try adapter match first
  const adapter = adapters.find((a) =>
    matchHostname(hostname, a.hostname_pattern),
  );
  if (adapter) {
    return detectWithAdapter(adapter);
  }

  // Try Readability detection (article-like pages)
  const readabilityRegions = detectForReadability();
  if (readabilityRegions.length > 0) return readabilityRegions;

  // Custom heuristic fallback
  return detectWithHeuristic();
}

function isOddityUiElement(el: Element): boolean {
  return Boolean(
    el.closest("oddity-arguments-box") ||
      el.closest("#oddity-margin-notes") ||
      el.closest("#oddity-overlay") ||
      el.closest("#oddity-page-dim") ||
      el.closest("[data-oddity-pdf-summary-host]"),
  );
}

function matchHostname(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return hostname === suffix || hostname.endsWith("." + suffix);
  }
  return hostname === pattern;
}

function detectWithAdapter(adapter: SiteAdapter): DetectedRegion[] {
  const excludedSet = new Set<Element>();
  for (const sel of adapter.excluded_selectors) {
    document.querySelectorAll(sel).forEach((el) => excludedSet.add(el));
  }

  const regions: DetectedRegion[] = [];
  for (const selector of adapter.content_selectors) {
    const elements = document.querySelectorAll(selector);
    elements.forEach((el, i) => {
      if (
        !excludedSet.has(el) &&
        !isInsideExcluded(el, excludedSet) &&
        !isOddityUiElement(el)
      ) {
        regions.push({
          id: `adapter-${selector}-${i}`,
          element: el,
          source: "adapter",
        });
      }
    });
  }

  return regions;
}

function isInsideExcluded(el: Element, excluded: Set<Element>): boolean {
  let parent = el.parentElement;
  while (parent) {
    if (excluded.has(parent)) return true;
    parent = parent.parentElement;
  }
  return false;
}

function detectForReadability(): DetectedRegion[] {
  // Check if page looks like an article
  const article = document.querySelector("article");
  if (
    article &&
    article.textContent &&
    article.textContent.trim().length > 200
  ) {
    return [
      { id: "readability-article-0", element: article, source: "readability" },
    ];
  }

  // Check for common article containers
  const candidates = document.querySelectorAll(
    '[role="article"], .post-content, .article-content, .entry-content, .post-body',
  );
  const regions: DetectedRegion[] = [];
  candidates.forEach((el, i) => {
    if (isOddityUiElement(el)) return;
    if (el.textContent && el.textContent.trim().length > 200) {
      regions.push({
        id: `readability-candidate-${i}`,
        element: el,
        source: "readability",
      });
    }
  });

  return regions;
}

function detectWithHeuristic(): DetectedRegion[] {
  // Score candidate elements by text density and semantic tags
  const candidates = document.querySelectorAll(
    'main, [role="main"], article, section, .content, .main-content, .post, .entry, div',
  );

  const scored: { el: Element; score: number }[] = [];

  candidates.forEach((el) => {
    if (isOddityUiElement(el)) return;
    const text = el.textContent?.trim() ?? "";
    if (text.length < 200) return;

    const textLen = text.length;
    const htmlLen = el.innerHTML.length || 1;
    const density = textLen / htmlLen;

    let score = textLen * density;

    // Bonus for semantic elements
    const tag = el.tagName.toLowerCase();
    if (tag === "main" || tag === "article") score *= 2;
    if (el.getAttribute("role") === "main") score *= 2;

    // Penalize very large containers (likely body-level wrappers)
    if (textLen > 60000) score *= 0.5;

    scored.push({ el, score });
  });

  // Sort by score, take top candidates, filter out ancestors of selected elements
  scored.sort((a, b) => b.score - a.score);

  const regions: DetectedRegion[] = [];
  const selected = new Set<Element>();

  for (const { el } of scored.slice(0, 5)) {
    // Skip if this element is an ancestor of an already-selected element
    let isAncestor = false;
    for (const s of selected) {
      if (el.contains(s)) {
        isAncestor = true;
        break;
      }
    }
    if (isAncestor) continue;

    // Skip if this element is a descendant of an already-selected element
    let isDescendant = false;
    for (const s of selected) {
      if (s.contains(el)) {
        isDescendant = true;
        break;
      }
    }
    if (isDescendant) continue;

    selected.add(el);
    regions.push({
      id: `heuristic-${regions.length}`,
      element: el,
      source: "heuristic",
    });
  }

  return regions;
}
