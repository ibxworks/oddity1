import { SCROLL_LOADER_ROOT_MARGIN, EAGER_WORD_LIMIT } from '@oddity/shared';

// ─── State ───

let observer: IntersectionObserver | null = null;
const loadedRegions = new Set<string>();
const registeredRegions = new Map<string, Element>();
let visibilityCallback: ((regionId: string, element: Element) => void) | null = null;

/**
 * Initialize the scroll-based lazy loader.
 * Uses IntersectionObserver to fire a callback when a registered region
 * enters the extended viewport (rootMargin = 500px).
 *
 * If the total page word count is below EAGER_WORD_LIMIT, all registered
 * regions are loaded immediately without waiting for intersection.
 */
export function initScrollLoader(
  onRegionVisible: (regionId: string, element: Element) => void,
): void {
  visibilityCallback = onRegionVisible;

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        const el = entry.target;
        const regionId = findRegionId(el);
        if (!regionId || loadedRegions.has(regionId)) continue;

        loadedRegions.add(regionId);
        observer?.unobserve(el);
        visibilityCallback?.(regionId, el);
      }
    },
    {
      rootMargin: SCROLL_LOADER_ROOT_MARGIN,
    },
  );
}

/**
 * Register an element as a lazy-loadable region.
 * If the page is small enough (total word count <= EAGER_WORD_LIMIT),
 * the callback fires immediately.
 */
export function registerRegion(regionId: string, element: Element): void {
  if (loadedRegions.has(regionId)) return;
  registeredRegions.set(regionId, element);

  // Check if page is small enough to eagerly load everything
  const totalWords = estimatePageWordCount();
  if (totalWords <= EAGER_WORD_LIMIT) {
    loadedRegions.add(regionId);
    visibilityCallback?.(regionId, element);
    return;
  }

  // Otherwise register with IntersectionObserver for lazy loading
  if (observer) {
    observer.observe(element);
  }
}

/**
 * Check whether a region has already been loaded (callback fired).
 */
export function isRegionLoaded(regionId: string): boolean {
  return loadedRegions.has(regionId);
}

/**
 * Tear down the scroll loader: disconnect observer, clear all state.
 */
export function destroyScrollLoader(): void {
  observer?.disconnect();
  observer = null;
  loadedRegions.clear();
  registeredRegions.clear();
  visibilityCallback = null;
}

// ─── Helpers ───

function findRegionId(element: Element): string | null {
  for (const [id, el] of registeredRegions) {
    if (el === element) return id;
  }
  return null;
}

function estimatePageWordCount(): number {
  const text = document.body.textContent ?? '';
  return text.split(/\s+/).filter(Boolean).length;
}
