import type { SiteAdapter, ExtensionMessage, Annotation, AnnotationType, Intensity } from '@oddity/shared';
import { EAGER_WORD_LIMIT } from '@oddity/shared';
import { sendMessage, onMessage } from '../shared/messaging.js';
import { sha256 } from '../shared/hash.js';
import { detectReadingRegions, type DetectedRegion } from './detector.js';
import { extractText, extractWithReadability } from './extractor.js';
import { createStabilityWatcher } from './stability.js';
import { resolveSelector } from './selector.js';
import { initOverlay, renderAnnotation, clearOverlay, setOverlayVisible, filterByTypes, destroyOverlay } from './renderer/overlay.js';
import { injectAnchors, removeAnchors, clearAllAnchors, getAllAnchorsInOrder, getAnnotationId } from './renderer/anchors.js';
import { showPopover, hidePopover, isPopoverVisible } from './renderer/popover.js';
import { initScrollLoader, registerRegion, destroyScrollLoader } from './scroll-loader.js';
import { initManualAnnotations, destroyManualAnnotations } from './manual.js';

// ─── State ───

const annotatedRegions = new Set<string>();
const pendingRegions = new Set<string>();
const currentAnnotations = new Map<string, Annotation[]>();
let enabled = true;
let visibleTypes: AnnotationType[] = [
  'highlight', 'underline', 'question', 'insight', 'caveat', 'vocabulary',
];
let currentIntensity: Intensity = 'default';
let regions: DetectedRegion[] = [];

// ─── Pipeline ───

async function init(): Promise<void> {
  console.log('[Oddity] Content script initializing');

  // Fetch adapters from service worker
  const response = await sendMessage<{ adapters: SiteAdapter[] }>({
    action: 'getAdapters',
    payload: {},
  });

  const adapters = response?.adapters ?? [];
  const hostname = window.location.hostname;
  const matchedAdapter = adapters.find((a) =>
    matchHostname(hostname, a.hostname_pattern),
  );

  // Detect reading regions
  regions = detectReadingRegions(adapters);

  if (regions.length === 0) {
    console.log('[Oddity] No reading regions detected');
    return;
  }

  console.log(`[Oddity] Detected ${regions.length} reading region(s)`);

  // Initialize rendering layers
  initOverlay();

  // Initialize scroll-based lazy loader
  initScrollLoader((regionId, element) => {
    const region = regions.find((r) => r.id === regionId);
    if (region) {
      handleStableRegion(region, element);
    }
  });

  // Initialize manual annotation UI
  initManualAnnotations();

  // Initialize keyboard navigation
  initKeyboardNav();

  // Set up stability watchers for each region
  for (const region of regions) {
    const signal = matchedAdapter?.stability_signal ?? null;
    const watcher = createStabilityWatcher(signal);

    watcher.onStable(async (element) => {
      await handleStableRegion(region, element);
    });

    watcher.observe(region.element);
  }
}

async function handleStableRegion(
  region: DetectedRegion,
  _element: Element,
): Promise<void> {
  if (annotatedRegions.has(region.id) || pendingRegions.has(region.id)) return;

  // Extract text
  const extracted =
    region.source === 'readability'
      ? extractWithReadability()
      : extractText(region);

  if (!extracted || !extracted.text) return;

  // Compute content hash
  const contentHash = await sha256(extracted.text);

  // Store hash on the region element so manual annotations can reuse it
  (region.element as HTMLElement).dataset.oddityHash = contentHash;

  // Check word count — large regions get registered for lazy loading
  if (extracted.wordCount > EAGER_WORD_LIMIT) {
    console.log(
      `[Oddity] Region ${region.id} has ${extracted.wordCount} words — registering for lazy loader`,
    );
    registerRegion(region.id, region.element);
    return;
  }

  // Request annotations from service worker
  pendingRegions.add(region.id);
  console.log(`[Oddity] Requesting annotations for region ${region.id}`);

  try {
    const result = await sendMessage<{ error?: string }>({
      action: 'requestAnnotations',
      payload: {
        url: window.location.href,
        contentHash,
        text: extracted.text,
        intensity: currentIntensity,
        wordCount: extracted.wordCount,
      },
    });

    if (result?.error) {
      console.error(`[Oddity] Annotation request failed: ${result.error}`);
      pendingRegions.delete(region.id);
    }
  } catch (err) {
    console.error(`[Oddity] Annotation request error:`, err);
    pendingRegions.delete(region.id);
  }
}

// ─── Rendering ───

function renderAnnotations(regionId: string, annotations: Annotation[]): void {
  const region = regions.find((r) => r.id === regionId);
  const root = region?.element ?? document.body;

  for (const annotation of annotations) {
    if (!visibleTypes.includes(annotation.type)) continue;

    const range = resolveSelector(root, annotation.anchor);
    if (!range) {
      console.warn(`[Oddity] Could not resolve selector for annotation ${annotation.id}`);
      continue;
    }

    // Draw overlay rectangles
    renderAnnotation(annotation, range);

    // Inject inline anchors for hover detection
    const anchors = injectAnchors(annotation, range);
    for (const anchor of anchors) {
      anchor.addEventListener('mouseenter', () => {
        showPopover(annotation, anchor);
      });
      anchor.addEventListener('mouseleave', () => {
        hidePopover();
      });
    }
  }
}

function rerenderAll(): void {
  clearOverlay();
  clearAllAnchors();

  for (const [regionId, annotations] of currentAnnotations) {
    renderAnnotations(regionId, annotations);
  }
}

// ─── Message Listeners ───

onMessage((message: ExtensionMessage) => {
  switch (message.action) {
    case 'annotationsReady': {
      const { regionId, annotations } = message.payload;
      annotatedRegions.add(regionId);
      pendingRegions.delete(regionId);
      currentAnnotations.set(regionId, annotations);
      console.log(
        `[Oddity] Received ${annotations.length} annotations for region ${regionId}`,
      );

      if (enabled) {
        renderAnnotations(regionId, annotations);
      }
      break;
    }

    case 'settingsUpdated': {
      const { enabled: newEnabled, intensity: newIntensity, visibleTypes: newVisibleTypes } = message.payload;
      const wasEnabled = enabled;
      const intensityChanged = newIntensity !== currentIntensity;
      enabled = newEnabled;
      currentIntensity = newIntensity;
      visibleTypes = newVisibleTypes;

      console.log(
        `[Oddity] Settings updated — enabled: ${enabled}, intensity: ${currentIntensity}, types: ${visibleTypes.join(', ')}`,
      );

      if (!enabled) {
        // Hide everything
        setOverlayVisible(false);
        clearAllAnchors();
      } else if (intensityChanged) {
        // Intensity changed: clear cache and re-request all regions
        clearOverlay();
        clearAllAnchors();
        currentAnnotations.clear();
        annotatedRegions.clear();
        pendingRegions.clear();
        setOverlayVisible(true);
        for (const region of regions) {
          handleStableRegion(region, region.element);
        }
      } else if (!wasEnabled && enabled) {
        // Re-enable: re-render everything
        setOverlayVisible(true);
        rerenderAll();
      } else {
        // Just filter by types
        filterByTypes(visibleTypes);
      }
      break;
    }

    case 'deleteAnnotation': {
      const { annotationId } = message.payload;
      // Remove from state
      for (const [regionId, annotations] of currentAnnotations) {
        const filtered = annotations.filter((a) => a.id !== annotationId);
        if (filtered.length !== annotations.length) {
          currentAnnotations.set(regionId, filtered);
        }
      }
      // Remove from DOM
      removeAnchors(annotationId);
      // Re-render overlay (overlay.removeAnnotation handles its own cleanup)
      rerenderAll();
      break;
    }
  }
});

// ─── Keyboard Navigation ───
// Tab: move between annotations, Enter: open popover, Escape: close popover

let keyboardFocusIndex = -1;

function initKeyboardNav(): void {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!enabled) return;

    // Escape closes popover
    if (e.key === 'Escape' && isPopoverVisible()) {
      hidePopover();
      e.preventDefault();
      return;
    }

    // Tab navigates between annotations (only when not in an input/textarea)
    if (e.key === 'Tab' && !isInputFocused()) {
      const anchors = getAllAnchorsInOrder();
      if (anchors.length === 0) return;

      e.preventDefault();

      if (e.shiftKey) {
        keyboardFocusIndex = keyboardFocusIndex <= 0 ? anchors.length - 1 : keyboardFocusIndex - 1;
      } else {
        keyboardFocusIndex = keyboardFocusIndex >= anchors.length - 1 ? 0 : keyboardFocusIndex + 1;
      }

      const anchor = anchors[keyboardFocusIndex];
      if (anchor) {
        anchor.focus();
        anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    // Enter opens popover on focused annotation
    if (e.key === 'Enter' && !isInputFocused()) {
      const anchors = getAllAnchorsInOrder();
      const anchor = anchors[keyboardFocusIndex];
      if (anchor) {
        const annotationId = getAnnotationId(anchor);
        if (annotationId) {
          const annotation = findAnnotationById(annotationId);
          if (annotation) {
            showPopover(annotation, anchor);
            e.preventDefault();
          }
        }
      }
    }
  });
}

function isInputFocused(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' ||
    (active as HTMLElement).isContentEditable;
}

function findAnnotationById(id: string): Annotation | null {
  for (const annotations of currentAnnotations.values()) {
    const found = annotations.find((a) => a.id === id);
    if (found) return found;
  }
  return null;
}

// ─── Helpers ───

function matchHostname(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return hostname === suffix || hostname.endsWith('.' + suffix);
  }
  return hostname === pattern;
}

// ─── Start ───

init().catch((err) => {
  console.error('[Oddity] Content script init error:', err);
});
