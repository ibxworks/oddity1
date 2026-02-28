import type {
  Annotation,
  AnnotationFeedback,
  AnnotationType,
  ExtensionMessage,
  Intensity,
  SiteAdapter,
} from "@oddity/shared";
import { EAGER_WORD_LIMIT } from "@oddity/shared";
import { sha256 } from "../shared/hash.js";
import { onMessage, sendMessage } from "../shared/messaging.js";
import { detectReadingRegions, type DetectedRegion } from "./detector.js";
import { extractText, extractWithReadability } from "./extractor.js";
import { initManualAnnotations } from "./manual.js";
import {
  clearAllAnchors,
  getAllAnchorsInOrder,
  getAnnotationId,
  injectAnchors,
  removeAnchors,
} from "./renderer/anchors.js";
import {
  clearOverlay,
  filterByTypes,
  initOverlay,
  renderAnnotation,
  setOverlayVisible,
} from "./renderer/overlay.js";
import {
  initMarginNotes,
  addMarginNote,
  removeMarginNote,
  clearMarginNotes,
  setMarginNotesVisible,
  filterMarginNotesByTypes,
  expandMarginNote,
  collapseAllMarginNotes,
  isAnyMarginNoteExpanded,
} from "./renderer/margin-notes.js";
import { initScrollLoader, registerRegion } from "./scroll-loader.js";
import { showAuthToast } from "./auth-toast.js";
import { handleExportPdf } from "./export-pdf.js";
import { resolveSelector } from "./selector.js";
import { createChatObserver } from "./chat-observer.js";
import { createStabilityWatcher } from "./stability.js";

// ─── State ───

const annotatedRegions = new Set<string>();
const pendingRegions = new Set<string>();
const currentAnnotations = new Map<string, Annotation[]>();
const currentFeedback = new Map<string, AnnotationFeedback[]>();
const regionByHash = new Map<string, DetectedRegion>();
let enabled = true;
let visibleTypes: AnnotationType[] = [
  "highlight",
  "underline",
  "question",
  "insight",
  "caveat",
  "vocabulary",
];
let currentIntensity: Intensity = "default";
let regions: DetectedRegion[] = [];

// ─── Pipeline ───

async function init(): Promise<void> {
  console.log("[Oddity 1] Content script initializing");

  // Fetch adapters from service worker
  const response = await sendMessage<{ adapters: SiteAdapter[] }>({
    action: "getAdapters",
    payload: {},
  });

  const adapters = response?.adapters ?? [];
  const hostname = window.location.hostname;
  const matchedAdapter = adapters.find((a) =>
    matchHostname(hostname, a.hostname_pattern),
  );

  if (matchedAdapter?.response_selector) {
    // ── Chat/dynamic site mode ──
    console.log("[Oddity 1] Chat mode — watching for AI responses");

    initOverlay();
    initManualAnnotations();
    initKeyboardNav();

    let marginNotesInitialized = false;

    const observer = createChatObserver({
      responseSelector: matchedAdapter.response_selector,
      stabilitySignal: matchedAdapter.stability_signal,
      onResponse: (regionId, element) => {
        if (!marginNotesInitialized) {
          initMarginNotes(element);
          marginNotesInitialized = true;
        }

        const region: DetectedRegion = {
          id: regionId,
          element,
          source: 'adapter',
        };
        regions.push(region);
        handleStableRegion(region, element);
      },
    });

    observer.start();
    return;
  }

  // ── Static site flow ──
  regions = detectReadingRegions(adapters);

  if (regions.length === 0) {
    console.log("[Oddity 1] No reading regions detected");
    return;
  }

  console.log(`[Oddity 1] Detected ${regions.length} reading region(s)`);

  // Initialize rendering layers
  initOverlay();
  initMarginNotes(regions[0]?.element ?? document.body);

  // Initialize scroll-based lazy loader
  initScrollLoader((regionId, element) => {
    const region = regions.find((r) => r.id === regionId);
    if (region) {
      handleStableRegion(region, element, true);
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
  fromLazyLoader = false,
): Promise<void> {
  // Extract text first so we can use contentHash as the dedup key
  const extracted =
    region.source === "readability"
      ? extractWithReadability()
      : extractText(region);

  if (!extracted || !extracted.text) return;

  // Compute content hash
  const contentHash = await sha256(extracted.text);

  if (annotatedRegions.has(contentHash) || pendingRegions.has(contentHash)) return;

  // Store hash on the region element so manual annotations can reuse it
  (region.element as HTMLElement).dataset.oddityHash = contentHash;

  // Map hash → region so renderAnnotations can find the element
  regionByHash.set(contentHash, region);

  // Check word count — large regions get registered for lazy loading
  // Skip this check when called from the lazy loader (region already approved)
  if (!fromLazyLoader && extracted.wordCount > EAGER_WORD_LIMIT) {
    console.log(
      `[Oddity 1] Region ${region.id} has ${extracted.wordCount} words — registering for lazy loader`,
    );
    registerRegion(region.id, region.element);
    return;
  }

  // Request annotations from service worker
  pendingRegions.add(contentHash);
  console.log(`[Oddity 1] Requesting annotations for region ${region.id} (hash: ${contentHash.slice(0, 12)}…)`);

  try {
    const result = await sendMessage<{ error?: string }>({
      action: "requestAnnotations",
      payload: {
        url: window.location.href,
        contentHash,
        text: extracted.text,
        intensity: currentIntensity,
        wordCount: extracted.wordCount,
      },
    });

    if (result?.error) {
      if (result.error.includes("Sign in")) {
        console.warn("[Oddity 1] Not signed in — open the Oddity extension to sign in");
        showAuthToast();
      } else {
        console.error(`[Oddity 1] Annotation request failed: ${result.error}`);
      }
      pendingRegions.delete(contentHash);
    }
  } catch (err) {
    const errStr = String(err);
    if (errStr.includes("Auth") || errStr.includes("401")) {
      console.warn("[Oddity 1] Not signed in — open the Oddity extension to sign in");
      showAuthToast();
    } else {
      console.error(`[Oddity 1] Annotation request error:`, err);
    }
    pendingRegions.delete(contentHash);
  }
}

// ─── Rendering ───

function renderAnnotations(regionId: string, annotations: Annotation[]): void {
  const region = regionByHash.get(regionId) ?? regions.find((r) => r.id === regionId);
  const root = region?.element ?? document.body;
  const feedback = currentFeedback.get(regionId) ?? [];

  // Filter visible types first
  const visible = annotations.filter((a) => visibleTypes.includes(a.type));

  // Sort: background-type annotations first (highlight, insight), underline-type last
  // This ensures underlines render on top in the DOM stacking order
  const backgroundTypes = new Set<AnnotationType>(["highlight", "insight"]);
  visible.sort((a, b) => {
    const aIsBg = backgroundTypes.has(a.type) ? 0 : 1;
    const bIsBg = backgroundTypes.has(b.type) ? 0 : 1;
    return aIsBg - bIsBg;
  });

  // Single-pass: resolve + render one annotation at a time
  // This avoids stale ranges from prior DOM mutations (injectAnchors splits text nodes)
  for (const annotation of visible) {
    const range = resolveSelector(root, annotation.anchor);
    if (!range) {
      console.warn(
        `[Oddity 1] Could not resolve selector for annotation ${annotation.id}`,
      );
      continue;
    }

    const anchors = injectAnchors(annotation, range);

    const stableRange = document.createRange();
    if (anchors.length > 0) {
      stableRange.setStartBefore(anchors[0]!);
      stableRange.setEndAfter(anchors[anchors.length - 1]!);
    } else {
      console.warn(
        `[Oddity 1] Failed to anchor: ${annotation.id} (${annotation.type}): "${annotation.anchor.exact.substring(0, 50)}..."`,
      );
      stableRange.setStart(range.startContainer, range.startOffset);
      stableRange.setEnd(range.endContainer, range.endOffset);
    }

    renderAnnotation(annotation, stableRange);
    const noteFeedback = feedback.filter((f) => f.annotation_id === annotation.id);
    addMarginNote(annotation, stableRange, noteFeedback);
  }
}

function rerenderAll(): void {
  clearOverlay();
  clearAllAnchors();
  clearMarginNotes();

  for (const [regionId, annotations] of currentAnnotations) {
    renderAnnotations(regionId, annotations);
  }
}

// ─── Message Listeners ───

onMessage((message: ExtensionMessage) => {
  switch (message.action) {
    case "exportPdf": {
      const { title, subtitle } = message.payload;
      // Flatten all annotations from currentAnnotations map
      const allAnnotations: Annotation[] = [];
      for (const annotations of currentAnnotations.values()) {
        allAnnotations.push(...annotations);
      }
      return handleExportPdf(title, subtitle, allAnnotations)
        .then(() => ({ success: true }))
        .catch((err) => ({ success: false, error: String(err) }));
    }
    case "annotationsReady": {
      const { regionId, annotations, feedback } = message.payload;
      annotatedRegions.add(regionId);
      pendingRegions.delete(regionId);
      currentFeedback.set(regionId, feedback);

      // Filter out annotations that have thumbs_down feedback
      const thumbsDownIds = new Set(
        feedback
          .filter((f) => f.feedback_type === "thumbs_down")
          .map((f) => f.annotation_id),
      );
      const filteredAnnotations = annotations.filter(
        (a) => !thumbsDownIds.has(a.id),
      );

      currentAnnotations.set(regionId, filteredAnnotations);
      console.log(
        `[Oddity 1] Received ${annotations.length} annotations for region ${regionId} (${filteredAnnotations.length} after feedback filter)`,
        filteredAnnotations,
      );

      if (enabled) {
        renderAnnotations(regionId, filteredAnnotations);
      }
      break;
    }

    case "settingsUpdated": {
      const {
        enabled: newEnabled,
        intensity: newIntensity,
        visibleTypes: newVisibleTypes,
      } = message.payload;
      const wasEnabled = enabled;
      const intensityChanged = newIntensity !== currentIntensity;
      enabled = newEnabled;
      currentIntensity = newIntensity;
      visibleTypes = newVisibleTypes;

      console.log(
        `[Oddity 1] Settings updated — enabled: ${enabled}, intensity: ${currentIntensity}, types: ${visibleTypes.join(", ")}`,
      );

      if (!enabled) {
        // Hide everything
        setOverlayVisible(false);
        setMarginNotesVisible(false);
        clearAllAnchors();
      } else if (intensityChanged) {
        // Intensity changed: clear cache and re-request all regions
        clearOverlay();
        clearAllAnchors();
        clearMarginNotes();
        currentAnnotations.clear();
        annotatedRegions.clear();
        pendingRegions.clear();
        regionByHash.clear();
        setOverlayVisible(true);
        setMarginNotesVisible(true);
        for (const region of regions) {
          handleStableRegion(region, region.element);
        }
      } else if (!wasEnabled && enabled) {
        // Re-enable: re-render everything
        setOverlayVisible(true);
        setMarginNotesVisible(true);
        rerenderAll();
      } else {
        // Just filter by types
        filterByTypes(visibleTypes);
        filterMarginNotesByTypes(visibleTypes);
      }
      break;
    }

    case "deleteAnnotation": {
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
      removeMarginNote(annotationId);
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
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (!enabled) return;

    // Escape collapses expanded margin notes
    if (e.key === "Escape" && isAnyMarginNoteExpanded()) {
      collapseAllMarginNotes();
      e.preventDefault();
      return;
    }

    // Tab navigates between annotations (only when not in an input/textarea)
    if (e.key === "Tab" && !isInputFocused()) {
      const anchors = getAllAnchorsInOrder();
      if (anchors.length === 0) return;

      e.preventDefault();

      if (e.shiftKey) {
        keyboardFocusIndex =
          keyboardFocusIndex <= 0 ? anchors.length - 1 : keyboardFocusIndex - 1;
      } else {
        keyboardFocusIndex =
          keyboardFocusIndex >= anchors.length - 1 ? 0 : keyboardFocusIndex + 1;
      }

      const anchor = anchors[keyboardFocusIndex];
      if (anchor) {
        anchor.focus();
        anchor.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }

    // Enter expands margin note on focused annotation
    if (e.key === "Enter" && !isInputFocused()) {
      const anchors = getAllAnchorsInOrder();
      const anchor = anchors[keyboardFocusIndex];
      if (anchor) {
        const annotationId = getAnnotationId(anchor);
        if (annotationId) {
          expandMarginNote(annotationId);
          e.preventDefault();
        }
      }
    }
  });
}

function isInputFocused(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    (active as HTMLElement).isContentEditable
  );
}

// ─── Helpers ───

function matchHostname(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return hostname === suffix || hostname.endsWith("." + suffix);
  }
  return hostname === pattern;
}

// ─── Start ───

init().catch((err) => {
  console.error("[Oddity 1] Content script init error:", err);
});
