import type {
  Annotation,
  AnnotationFeedback,
  AnnotationType,
  ExtensionMessage,
  Intensity,
  SiteAdapter,
} from "@oddity/shared";
import { sha256 } from "../shared/hash.js";
import { onMessage, sendMessage } from "../shared/messaging.js";
import { showAuthToast } from "./auth-toast.js";
import { createChatObserver } from "./chat-observer.js";
import { detectReadingRegions, type DetectedRegion } from "./detector.js";
import { handleExportPdf } from "./export-pdf.js";
import { extractText, extractWithReadability } from "./extractor.js";
import { isLongRequest } from "./long-request.js";
import { LongWaitManager } from "./long-wait-manager.js";
import { hideLongWaitToast, showLongWaitToast } from "./long-wait-toast.js";
import { initManualAnnotations } from "./manual.js";
import {
  clearAllAnchors,
  getAllAnchorsInOrder,
  getAnnotationId,
  injectAnchors,
  removeAnchors,
} from "./renderer/anchors.js";
import {
  addMarginNote,
  clearMarginNotes,
  collapseAllMarginNotes,
  expandMarginNote,
  filterMarginNotesByTypes,
  initMarginNotes,
  isAnyMarginNoteExpanded,
  onAnchorHoverEnd,
  onAnchorHoverStart,
  removeMarginNote,
  setMarginNotesVisible,
  updateMarginNotesStyle,
} from "./renderer/margin-notes.js";
import {
  clearOverlay,
  filterByTypes,
  initOverlay,
  renderAnnotation,
  setOverlayVisible,
} from "./renderer/overlay.js";
import { invalidateTextNodeIndex, resolveSelector } from "./selector.js";
import { createStabilityWatcher } from "./stability.js";

// ─── State ───

const annotatedRegions = new Set<string>();
const pendingRegions = new Set<string>();
const currentAnnotations = new Map<string, Annotation[]>();
const currentFeedback = new Map<string, AnnotationFeedback[]>();
const regionByHash = new Map<string, DetectedRegion>();
/** Tracks current content hash per region element — used for stale response guards */
const activeHashes = new Map<Element, string>();
let enabled = true;
let visibleTypes: AnnotationType[] = [
  "highlight",
  "recall",
  "provoking_question",
  "insight",
  "caveat",
  "vocabulary",
];
let currentIntensity: Intensity = "default";
let regions: DetectedRegion[] = [];
const longWaitManager = new LongWaitManager(
  { show: showLongWaitToast, hide: hideLongWaitToast },
  500,
);

// ─── Pipeline ───

async function init(): Promise<void> {
  console.log("[Oddity 1] Content script initializing");

  // Load stored enabled state before doing any work
  const stored = await chrome.storage.local.get("preferences");
  const prefs = stored?.preferences;
  if (prefs?.enabled === false) {
    enabled = false;
    console.log("[Oddity 1] Extension is disabled — skipping initialization");
    return;
  }

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

    const chatObserver = createChatObserver({
      responseSelector: matchedAdapter.response_selector,
      stabilitySignal: matchedAdapter.stability_signal,
      onResponse: (regionId, element) => {
        if (!enabled) return;
        if (!marginNotesInitialized) {
          initMarginNotes(element);
          marginNotesInitialized = true;
        }

        const region: DetectedRegion = {
          id: regionId,
          element,
          source: "adapter",
        };
        regions.push(region);
        handleStableRegion(region, element);
      },
    });

    chatObserver.start();

    // ── Fallback: if chat observer finds nothing within 5s, the adapter's
    // response_selector is likely stale. Stop the chat observer and activate
    // body-level detection so the page still gets annotated. ──
    setTimeout(() => {
      if (regions.length > 0) return; // Chat observer is working — no fallback needed

      console.warn(
        `[Oddity 1] Chat observer found no responses after 5s — adapter response_selector may be stale. Activating body-level fallback.`,
      );
      chatObserver.stop();
      activateBodyLevelDetection(adapters, matchedAdapter);
    }, 6000);

    return;
  }

  // ── Static site flow ──
  regions = detectReadingRegions(adapters);

  console.log(`[Oddity 1] Detected ${regions.length} reading region(s)`);

  // Initialize rendering layers (even with 0 initial regions — new content may appear)
  initOverlay();
  initManualAnnotations();
  initKeyboardNav();

  if (regions.length > 0) {
    initMarginNotes(regions[0]!.element);
    marginNotesInitFromBody = true;
  }

  // ── URL prediction: render instantly from previous visit ──
  // Non-blocking: kicks off speculative render while normal pipeline runs in parallel
  tryUrlPrediction().catch(() => {});

  // Fire speculative requests immediately for visible regions (skip stability wait)
  // The existing pendingRegions/annotatedRegions dedup prevents double-processing
  for (const region of regions) {
    handleStableRegion(region, region.element);
  }

  // Activate body-level detection (persistent watchers + body observer)
  activateBodyLevelDetection(adapters, matchedAdapter ?? null);
}

// ─── Body-Level Detection ───
// Reusable: called by both the static flow and the chat-mode fallback.
// Sets up persistent stability watchers + body-level MutationObserver
// that discovers new content regions as they appear.

let bodyDetectionActive = false;
let marginNotesInitFromBody = false;

function activateBodyLevelDetection(
  adapters: SiteAdapter[],
  adapter: SiteAdapter | null,
): void {
  if (bodyDetectionActive) return;
  bodyDetectionActive = true;

  // Set up persistent stability watchers for all currently known regions
  for (const region of regions) {
    const signal = adapter?.stability_signal ?? null;
    const watcher = createStabilityWatcher(signal, /* persistent */ true);

    watcher.onStable(async (element) => {
      await handleStableRegion(region, element);
    });

    watcher.observe(region.element);
  }

  // ── Body-level region discovery ──
  // Periodically re-runs detectReadingRegions when the DOM changes.
  // Catches: initially-empty pages that gain content (LLM chats without adapters),
  // new content sections appearing dynamically, SPA navigations.
  const knownElements = new WeakSet<Element>(regions.map((r) => r.element));
  let rescanTimer: ReturnType<typeof setTimeout> | null = null;

  const bodyObserver = new MutationObserver(() => {
    if (!enabled) return;
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      const detected = detectReadingRegions(adapters);
      for (const candidate of detected) {
        if (knownElements.has(candidate.element)) continue;

        // New region discovered after init
        knownElements.add(candidate.element);
        regions.push(candidate);
        console.log(`[Oddity 1] New region discovered: ${candidate.id}`);

        if (!marginNotesInitFromBody) {
          initMarginNotes(candidate.element);
          marginNotesInitFromBody = true;
        }

        handleStableRegion(candidate, candidate.element);

        // Set up persistent watcher for the new region
        const sig = adapter?.stability_signal ?? null;
        const w = createStabilityWatcher(sig, /* persistent */ true);
        w.onStable(async (el) => {
          await handleStableRegion(candidate, el);
        });
        w.observe(candidate.element);
      }
    }, 1500); // 1.5s debounce — wait for content to settle before re-scanning
  });

  bodyObserver.observe(document.body, { childList: true, subtree: true });
}

async function handleStableRegion(
  region: DetectedRegion,
  _element: Element,
): Promise<void> {
  if (!enabled) return;

  // Extract text first so we can use contentHash as the dedup key
  const extracted =
    region.source === "readability"
      ? extractWithReadability()
      : extractText(region);

  if (!extracted || !extracted.text) return;

  // Compute content hash
  const contentHash = await sha256(extracted.text);

  // Stale guard: if this region already had a different hash, the content changed.
  // Mark the old hash as stale so its in-flight response gets ignored.
  const previousHash = activeHashes.get(region.element);
  if (previousHash && previousHash !== contentHash) {
    pendingRegions.delete(previousHash);
    annotatedRegions.delete(previousHash);
    currentAnnotations.delete(previousHash);
    regionByHash.delete(previousHash);
    // Content changed — clean up stale DOM annotations and re-render remaining
    rerenderAll();
  }
  activeHashes.set(region.element, contentHash);

  if (annotatedRegions.has(contentHash) || pendingRegions.has(contentHash))
    return;

  // Store hash on the region element so manual annotations can reuse it
  (region.element as HTMLElement).dataset.oddityHash = contentHash;

  // Map hash → region so renderAnnotations can find the element
  regionByHash.set(contentHash, region);

  // Request annotations from service worker
  pendingRegions.add(contentHash);
  const isLong = isLongRequest(extracted.wordCount);
  if (isLong) {
    longWaitManager.start(contentHash);
  }
  console.log(
    `[Oddity 1] Requesting annotations for region ${region.id} (hash: ${contentHash.slice(0, 12)}…)`,
  );

  try {
    const result = await sendMessage<{ error?: string }>({
      action: "requestAnnotations",
      payload: {
        url: window.location.href,
        regionId: region.id,
        contentHash,
        text: extracted.text,
        intensity: currentIntensity,
        wordCount: extracted.wordCount,
      },
    });

    // Aborted request — silently ignore (a newer request superseded this one)
    if (result && "aborted" in result) {
      if (isLong) longWaitManager.completeWithoutAnnotations(contentHash);
      return;
    }

    if (result?.error) {
      if (result.error.includes("Sign in")) {
        console.warn(
          "[Oddity 1] Not signed in — open the Oddity extension to sign in",
        );
        showAuthToast();
      } else {
        console.error(`[Oddity 1] Annotation request failed: ${result.error}`);
      }
      pendingRegions.delete(contentHash);
      if (isLong) longWaitManager.completeWithoutAnnotations(contentHash);
    }
  } catch (err) {
    const errStr = String(err);
    if (errStr.includes("Auth") || errStr.includes("401")) {
      console.warn(
        "[Oddity 1] Not signed in — open the Oddity extension to sign in",
      );
      showAuthToast();
    } else {
      console.error(`[Oddity 1] Annotation request error:`, err);
    }
    pendingRegions.delete(contentHash);
    if (isLong) longWaitManager.completeWithoutAnnotations(contentHash);
  }
}

// ─── URL Prediction ───

async function tryUrlPrediction(): Promise<void> {
  const prediction = await sendMessage<{
    contentHash: string;
    intensity: string;
    annotations: Annotation[];
    feedback: AnnotationFeedback[];
  } | null>({
    action: "getUrlPrediction",
    payload: { url: window.location.href },
  });

  if (!prediction || !prediction.annotations?.length) return;
  if (prediction.intensity !== currentIntensity) return;

  // Use first region as the prediction target
  const region = regions[0];
  if (!region) return;

  const regionId = prediction.contentHash;

  // Don't overwrite if normal pipeline already finished
  if (annotatedRegions.has(regionId)) return;

  console.log(
    `[Oddity 1] URL prediction hit — rendering ${prediction.annotations.length} annotations instantly`,
  );

  // Store prediction hash so normal pipeline can verify
  regionByHash.set(regionId, region);
  (region.element as HTMLElement).dataset.oddityHash = regionId;
  activeHashes.set(region.element, regionId);
  // Render speculatively — do NOT add to pendingRegions/annotatedRegions
  // so handleStableRegion() can still fire and fetch fresh merged data from server
  currentAnnotations.set(regionId, prediction.annotations);
  currentFeedback.set(regionId, prediction.feedback ?? []);
  renderAnnotations(regionId, prediction.annotations);
}

// ─── Annotation Deletion ───

function handleAnnotationDeleted(annotationId: string): void {
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
  // Re-render overlay
  rerenderAll();
}

// ─── Rendering ───

function attachAnchorHoverListeners(
  spans: HTMLSpanElement[],
  annotationId: string,
): void {
  for (const span of spans) {
    span.addEventListener("mouseenter", () => onAnchorHoverStart(annotationId));
    span.addEventListener("mouseleave", () => onAnchorHoverEnd());
  }
}

function renderAnnotations(regionId: string, annotations: Annotation[]): void {
  const region =
    regionByHash.get(regionId) ?? regions.find((r) => r.id === regionId);
  const root = region?.element ?? document.body;
  const feedback = currentFeedback.get(regionId) ?? [];

  // Filter visible types first
  const visible = annotations.filter((a) => visibleTypes.includes(a.type));

  // Sort: background-type annotations first (highlight, insight), line-type last
  // This ensures underlines render on top in the DOM stacking order
  const backgroundTypes = new Set<AnnotationType>(["highlight", "insight"]);
  visible.sort((a, b) => {
    const aIsBg = backgroundTypes.has(a.type) ? 0 : 1;
    const bIsBg = backgroundTypes.has(b.type) ? 0 : 1;
    return aIsBg - bIsBg;
  });

  // Invalidate text-node index once before the batch — ensures a clean index.
  // The index is reused across all annotations in this region (5–10× fewer TreeWalker traversals).
  // Later annotations may see slightly shifted positions due to prior injectAnchors DOM mutations,
  // but the existing fuzzy fallback chain in resolveSelector handles these gracefully.
  invalidateTextNodeIndex(root);

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

    let anchors = injectAnchors(annotation, range);

    // Retry once: prior injectAnchors calls mutate the DOM (split/wrap text nodes),
    // which can invalidate the cached text-node index and produce stale Ranges.
    if (anchors.length === 0) {
      invalidateTextNodeIndex(root);
      const retryRange = resolveSelector(root, annotation.anchor);
      if (retryRange) {
        anchors = injectAnchors(annotation, retryRange);
      }
    }

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

    if (anchors.length > 0) {
      attachAnchorHoverListeners(anchors, annotation.id);
    }

    renderAnnotation(annotation, stableRange);
    const noteFeedback = feedback.filter(
      (f) => f.annotation_id === annotation.id,
    );
    addMarginNote(
      annotation,
      stableRange,
      noteFeedback,
      handleAnnotationDeleted,
    );
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

// ─── Region HTML Collection (for PDF export) ───

/**
 * Clone every detected region element, strip Oddity-injected instrumentation
 * (anchor spans, data attributes), and return the concatenated inner HTML.
 * This captures the page exactly as the user sees it — far more reliable
 * than Readability on dynamic sites like ChatGPT.
 */
function collectRegionHtml(): string {
  const elements = new Set<Element>();
  for (const region of regions) elements.add(region.element);
  for (const region of regionByHash.values()) elements.add(region.element);

  if (elements.size === 0) return "";

  const parts: string[] = [];
  for (const el of elements) {
    const clone = el.cloneNode(true) as Element;

    // Unwrap Oddity anchor spans to restore original text flow
    for (const span of clone.querySelectorAll("[data-oddity-id]")) {
      const parent = span.parentNode;
      if (!parent) continue;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }

    // Strip leftover Oddity data attributes
    for (const tagged of clone.querySelectorAll("[data-oddity-hash]")) {
      tagged.removeAttribute("data-oddity-hash");
    }

    // Resolve relative image URLs to absolute so they load in the export iframe
    for (const img of clone.querySelectorAll("img[src]")) {
      const src = img.getAttribute("src");
      if (src && !src.startsWith("http") && !src.startsWith("data:")) {
        try {
          img.setAttribute("src", new URL(src, window.location.href).href);
        } catch {
          /* skip */
        }
      }
    }

    parts.push(clone.innerHTML);
  }

  return parts.join("\n");
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
      // Collect page content from detected regions (live DOM).
      // This is far more reliable than Readability on dynamic / chat sites.
      const regionHtml = collectRegionHtml();
      return handleExportPdf(title, subtitle, allAnnotations, regionHtml)
        .then(() => ({ success: true }))
        .catch((err) => ({ success: false, error: String(err) }));
    }
    case "annotationReady": {
      // Progressive rendering: single annotation from streaming pipeline
      const { regionId: streamRegionId, annotation } = message.payload;

      // Stale guard
      if (!pendingRegions.has(streamRegionId)) break;
      longWaitManager.handleFirstAnnotation(streamRegionId);
      if (!enabled || !visibleTypes.includes(annotation.type)) break;

      const streamRegion =
        regionByHash.get(streamRegionId) ??
        regions.find((r) => r.id === streamRegionId);
      const streamRoot = streamRegion?.element ?? document.body;

      // Track the annotation in state
      const existing = currentAnnotations.get(streamRegionId) ?? [];
      existing.push(annotation);
      currentAnnotations.set(streamRegionId, existing);

      // Render the single annotation immediately
      const range = resolveSelector(streamRoot, annotation.anchor);
      if (range) {
        let anchors = injectAnchors(annotation, range);
        if (anchors.length === 0) {
          invalidateTextNodeIndex(streamRoot);
          const retryRange = resolveSelector(streamRoot, annotation.anchor);
          if (retryRange) {
            anchors = injectAnchors(annotation, retryRange);
          }
        }

        const stableRange = document.createRange();
        if (anchors.length > 0) {
          stableRange.setStartBefore(anchors[0]!);
          stableRange.setEndAfter(anchors[anchors.length - 1]!);
        } else {
          stableRange.setStart(range.startContainer, range.startOffset);
          stableRange.setEnd(range.endContainer, range.endOffset);
        }

        if (anchors.length > 0) {
          attachAnchorHoverListeners(anchors, annotation.id);
        }

        renderAnnotation(annotation, stableRange);
        const fb = currentFeedback.get(streamRegionId) ?? [];
        const noteFeedback = fb.filter(
          (f) => f.annotation_id === annotation.id,
        );
        addMarginNote(
          annotation,
          stableRange,
          noteFeedback,
          handleAnnotationDeleted,
        );
      }
      break;
    }
    case "annotationsReady": {
      const { regionId, annotations, feedback } = message.payload;

      // Stale response guard: ignore if this hash was invalidated by content change
      if (!pendingRegions.has(regionId) && !annotatedRegions.has(regionId)) {
        console.log(
          `[Oddity 1] Ignoring stale response for ${regionId.slice(0, 12)}…`,
        );
        break;
      }

      longWaitManager.handleFinalResult(regionId, annotations.length);

      annotatedRegions.add(regionId);
      pendingRegions.delete(regionId);
      currentFeedback.set(regionId, feedback);

      // Final annotationsReady: replace progressive annotations with complete set
      // (includes user annotations and proper feedback associations)
      const hadStreaming = currentAnnotations.has(regionId);
      currentAnnotations.set(regionId, annotations);

      if (enabled && hadStreaming) {
        // Re-render with complete set (clears progressive renders, adds user annotations)
        const region =
          regionByHash.get(regionId) ?? regions.find((r) => r.id === regionId);
        const root = region?.element ?? document.body;
        // Clear only this region's overlays and re-render
        clearOverlay();
        clearAllAnchors();
        clearMarginNotes();
        for (const [rid, anns] of currentAnnotations) {
          renderAnnotations(rid, anns);
        }
      } else if (enabled) {
        renderAnnotations(regionId, annotations);
      }
      break;
    }

    case "settingsUpdated": {
      const {
        enabled: newEnabled,
        intensity: newIntensity,
        visibleTypes: newVisibleTypes,
        annotationFont,
        annotationFontSize,
      } = message.payload;

      // Apply font/size changes immediately
      updateMarginNotesStyle(annotationFont, annotationFontSize);
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
        longWaitManager.reset();
      } else if (intensityChanged) {
        // Intensity changed: clear cache and re-request all regions
        clearOverlay();
        clearAllAnchors();
        clearMarginNotes();
        currentAnnotations.clear();
        annotatedRegions.clear();
        pendingRegions.clear();
        regionByHash.clear();
        longWaitManager.reset();
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
      handleAnnotationDeleted(message.payload.annotationId);
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

window.addEventListener("pagehide", () => {
  longWaitManager.reset();
});

init().catch((err) => {
  console.error("[Oddity 1] Content script init error:", err);
});
