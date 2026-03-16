import type {
  Annotation,
  AnnotationFeedback,
  AnnotationMode,
  AnnotationType,
  DepthPersonality,
  ExtensionMessage,
  SiteAdapter,
  ViewMode,
} from "@oddity/shared";
import { ALL_ANNOTATION_TYPES, ALL_DEPTH_TYPES, ALL_OVERVIEW_TYPES, DEFAULT_ENABLED_SITES, isBlockedDomain, MAX_TEXT_LENGTH } from "@oddity/shared";
import { sha256 } from "../shared/hash.js";
import { onMessage, sendMessage } from "../shared/messaging.js";
import { showAuthToast } from "./auth-toast.js";
import { createChatObserver, type ChatObserver } from "./chat-observer.js";
import { detectReadingRegions, type DetectedRegion } from "./detector.js";
import { handleExportPdf } from "./export-pdf.js";
import { extractText, extractWithReadability } from "./extractor.js";
import { isLongRequest } from "./long-request.js";
import { LongWaitManager } from "./long-wait-manager.js";
import { hideLongWaitToast, showLongWaitToast } from "./long-wait-toast.js";
import {
  destroyManualAnnotations,
  initManualAnnotations,
} from "./manual.js";
import {
  destroyArgumentsBox,
  handleRemoteSignIn,
  handleRemoteSignOut,
  initArgumentsBox,
  setArgumentsBoxVisible,
  setArgumentsBoxEnabled,
  setArgumentsBoxDimmed,
  setArgumentsBoxBlocked,
  setManualRunCallback,
  setSignOutCallback,
  setInputTextProvider,
  appendSketchChunk,
  showEmptyAnnotationsBubble,
  hideEmptyAnnotationsBubble,
  updateArgumentsBox,
  updateArgumentsBoxStyle,
} from "./renderer/arguments-box.js";
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
  destroyMarginNotes,
  expandMarginNote,
  filterMarginNotesByTypes,
  initMarginNotes,
  isAnyMarginNoteExpanded,
  onAnchorClick,
  onAnchorHoverEnd,
  onAnchorHoverStart,
  removeMarginNote,
  setMarginNoteMode,
  setMarginNotesVisible,
  updateMarginNoteText,
  updateMarginNotesStyle,
} from "./renderer/margin-notes.js";
import {
  clearOverlay,
  destroyOverlay,
  filterByTypes,
  initOverlay,
  renderAnnotation,
  setOverlayVisible,
} from "./renderer/overlay.js";
import { invalidateTextNodeIndex, resolveSelector } from "./selector.js";
import { createStabilityWatcher } from "./stability.js";

// ─── Extension context guard ───
// After extension reload/update, content scripts lose access to chrome.* APIs.
// Catch these errors globally so they don't surface as uncaught exceptions.

const _contextInvalidRe = /Extension context invalidated/;

window.addEventListener("error", (e) => {
  if (_contextInvalidRe.test(e.message)) {
    e.preventDefault();
  }
});

window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  if (
    reason instanceof Error &&
    _contextInvalidRe.test(reason.message)
  ) {
    e.preventDefault();
  }
});

// ─── State ───

const annotatedRegions = new Set<string>();
const pendingRegions = new Set<string>();
/** Regions that received at least one streaming `annotationReady` message. */
const streamedRegions = new Set<string>();

// ─── Dual-mode annotation stores ───
const overviewAnnotations = new Map<string, Annotation[]>();
const overviewFeedback = new Map<string, AnnotationFeedback[]>();
const depthAnnotations = new Map<string, Annotation[]>();
const depthFeedback = new Map<string, AnnotationFeedback[]>();
const overviewGenerated = new Set<string>();
const depthGenerated = new Set<string>();
/**
 * Tracks which mode each pending request was for, keyed by contentHash.
 * In "all" mode, a hash may appear twice (once per mode).
 * Used by annotationsReady to correctly route empty responses.
 */
const pendingModeByHash = new Map<string, Set<AnnotationMode>>();

/** Returns the active mode's annotation map */
function currentAnnotations(): Map<string, Annotation[]> {
  return currentMode === "overview" ? overviewAnnotations : depthAnnotations;
}
/** Returns the active mode's feedback map */
function currentFeedbackMap(): Map<string, AnnotationFeedback[]> {
  return currentMode === "overview" ? overviewFeedback : depthFeedback;
}
/** Returns the active mode's generated set */
function currentGenerated(): Set<string> {
  return currentMode === "overview" ? overviewGenerated : depthGenerated;
}

/**
 * Returns annotations for rendering. Always includes user_written notes from
 * both stores so they appear regardless of which mode the user was in when
 * they created the note.
 */
function effectiveAnnotations(): Map<string, Annotation[]> {
  if (currentMode === "all") {
    // Merge everything from both stores
    return mergeMaps(overviewAnnotations, depthAnnotations);
  }
  // Single mode: start with current store, then add user_written from the other store
  const primary = currentAnnotations();
  const other = currentMode === "overview" ? depthAnnotations : overviewAnnotations;
  return mergeMapsWithUserWritten(primary, other);
}

/**
 * Returns feedback for rendering. In single modes, also includes feedback
 * for user_written annotations that live in the other store.
 */
function effectiveFeedbackMap(): Map<string, AnnotationFeedback[]> {
  if (currentMode === "all") {
    return mergeMaps(overviewFeedback, depthFeedback);
  }
  // Single mode: merge feedback from both stores so user_written note
  // feedback is available
  return mergeMaps(currentFeedbackMap(),
    currentMode === "overview" ? depthFeedback : overviewFeedback);
}

/** Merge two maps, deduplicating items by id. */
function mergeMaps<T extends { id: string }>(
  a: Map<string, T[]>,
  b: Map<string, T[]>,
): Map<string, T[]> {
  const merged = new Map<string, T[]>();
  const seenIds = new Set<string>();
  for (const src of [a, b]) {
    for (const [k, v] of src) {
      const existing = merged.get(k) ?? [];
      for (const item of v) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          existing.push(item);
        }
      }
      merged.set(k, existing);
    }
  }
  return merged;
}

/**
 * Take all annotations from `primary`, then add only `user_written`
 * annotations from `other` (deduplicating by id).
 */
function mergeMapsWithUserWritten(
  primary: Map<string, Annotation[]>,
  other: Map<string, Annotation[]>,
): Map<string, Annotation[]> {
  const merged = new Map<string, Annotation[]>();
  const seenIds = new Set<string>();
  // Add everything from primary
  for (const [k, v] of primary) {
    const existing = merged.get(k) ?? [];
    for (const ann of v) {
      if (!seenIds.has(ann.id)) {
        seenIds.add(ann.id);
        existing.push(ann);
      }
    }
    merged.set(k, existing);
  }
  // Add only user_written from other store
  for (const [k, v] of other) {
    const existing = merged.get(k) ?? [];
    for (const ann of v) {
      if (ann.type === "user_written" && !seenIds.has(ann.id)) {
        seenIds.add(ann.id);
        existing.push(ann);
      }
    }
    merged.set(k, existing);
  }
  return merged;
}

/** Copy user_written annotations from one mode store to the other so they survive mode switches. */
function syncUserWrittenToBothStores(regionId: string, annotations: Annotation[], fromMode: AnnotationMode): void {
  const userWritten = annotations.filter((a) => a.type === "user_written");
  if (userWritten.length === 0) return;
  const otherStore = fromMode === "overview" ? depthAnnotations : overviewAnnotations;
  const otherList = otherStore.get(regionId) ?? [];
  const existingIds = new Set(otherList.map((a) => a.id));
  for (const uw of userWritten) {
    if (!existingIds.has(uw.id)) otherList.push(uw);
  }
  otherStore.set(regionId, otherList);
}

const regionByHash = new Map<string, DetectedRegion>();
/** Tracks current content hash per region element — used for stale response guards */
const activeHashes = new Map<Element, string>();
/** Annotation IDs that were deleted locally — prevents re-addition from in-flight server responses. */
const deletedAnnotationIds = new Set<string>();
/** Feedback IDs that were deleted locally — prevents re-addition from in-flight server responses. */
const deletedFeedbackIds = new Set<string>();
/** Elements currently tracked by the chat observer (including in-progress streaming). */
const chatTrackedElements = new WeakSet<Element>();
let siteWhitelisted = false;
let manualRunTriggered = false;
let blocked = false;

let enabled = true;
let currentMode: ViewMode = "all";
let currentPersonality: DepthPersonality = "jerry";
let visibleTypes: AnnotationType[] = [...ALL_ANNOTATION_TYPES, "user_written"];
let regions: DetectedRegion[] = [];
let pipelineInitialized = false;
const longWaitManager = new LongWaitManager(
  { show: showLongWaitToast, hide: hideLongWaitToast },
  500,
);

// ─── SPA Navigation State ───

/** Module-level reference to chat observer for cleanup on SPA navigation. */
let activeChatObserver: ChatObserver | null = null;
/** Module-level reference to body MutationObserver for cleanup on SPA navigation. */
let activeBodyObserver: MutationObserver | null = null;
/** Timer for body-level detection rescan debounce. */
let activeRescanTimer: ReturnType<typeof setTimeout> | null = null;
/** Last known URL — used to detect SPA navigation. */
let lastKnownUrl = window.location.href;
/** Interval ID for URL polling. */
let urlPollInterval: ReturnType<typeof setInterval> | null = null;

// ─── Input Text Provider (for Sketch my Argument) ───

/** Collect the same text that was sent for annotation generation from all regions. */
function collectInputText(): string {
  const parts: string[] = [];
  for (const region of regions) {
    const extracted =
      region.source === "readability"
        ? extractWithReadability()
        : extractText(region);
    if (extracted?.text) parts.push(extracted.text);
  }
  // Also include regions tracked by hash (chat observer regions)
  for (const [, region] of regionByHash) {
    if (regions.includes(region)) continue; // already added
    const extracted =
      region.source === "readability"
        ? extractWithReadability()
        : extractText(region);
    if (extracted?.text) parts.push(extracted.text);
  }
  return parts.join("\n\n");
}

// ─── Arguments Box Sync ───

function syncArgumentsBox(): void {
  // Merge both modes' annotations and feedback, deduplicating by ID
  const mergedAnnotations = new Map<string, Annotation[]>();
  const seenAnnIds = new Set<string>();
  for (const src of [overviewAnnotations, depthAnnotations]) {
    for (const [k, v] of src) {
      const existing = mergedAnnotations.get(k) ?? [];
      for (const ann of v) {
        if (!seenAnnIds.has(ann.id)) {
          seenAnnIds.add(ann.id);
          existing.push(ann);
        }
      }
      mergedAnnotations.set(k, existing);
    }
  }
  const mergedFeedback = new Map<string, AnnotationFeedback[]>();
  const seenFbIds = new Set<string>();
  for (const src of [overviewFeedback, depthFeedback]) {
    for (const [k, v] of src) {
      const existing = mergedFeedback.get(k) ?? [];
      for (const fb of v) {
        if (!seenFbIds.has(fb.id)) {
          seenFbIds.add(fb.id);
          existing.push(fb);
        }
      }
      mergedFeedback.set(k, existing);
    }
  }
  updateArgumentsBox(mergedAnnotations, mergedFeedback);
}

// ─── SPA Navigation: State Reset ───

/**
 * Completely tear down all annotation state and DOM artifacts.
 * Called on SPA navigation so the new page starts with a clean slate.
 */
function resetAnnotationState(): void {
  console.log("[Oddity 1] Resetting annotation state (SPA navigation)");

  // Stop observers
  activeChatObserver?.stop();
  activeChatObserver = null;
  activeBodyObserver?.disconnect();
  activeBodyObserver = null;
  if (activeRescanTimer) {
    clearTimeout(activeRescanTimer);
    activeRescanTimer = null;
  }

  // Reset whitelist state
  manualRunTriggered = false;
  siteWhitelisted = false;

  // Clear in-flight state
  longWaitManager.reset();
  annotatedRegions.clear();
  pendingRegions.clear();
  pendingModeByHash.clear();
  streamedRegions.clear();
  overviewAnnotations.clear();
  overviewFeedback.clear();
  depthAnnotations.clear();
  depthFeedback.clear();
  overviewGenerated.clear();
  depthGenerated.clear();
  deletedAnnotationIds.clear();
  regionByHash.clear();
  activeHashes.clear();
  regions = [];
  pipelineInitialized = false;
  bodyDetectionActive = false;
  marginNotesInitFromBody = false;
  keyboardFocusIndex = -1;

  // Tear down all DOM artefacts (overlays, anchors, margin notes, etc.)
  clearAllAnchors();
  destroyOverlay();
  destroyMarginNotes();
  destroyArgumentsBox();
  destroyManualAnnotations();
}

// ─── SPA Navigation: URL Change Watcher ───

/**
 * Detect SPA navigations and re-initialise the annotation pipeline.
 *
 * Content scripts run in an isolated world — monkey-patching
 * history.pushState/replaceState only affects the isolated copy, NOT the
 * page's real History API calls. So we use a lightweight URL poll (every
 * 500 ms) combined with the popstate event (instant on back/forward).
 *
 * Called once at script load.
 */
function watchUrlChanges(): void {
  function onUrlChange(): void {
    const newUrl = window.location.href;
    if (newUrl === lastKnownUrl) return;

    console.log(
      `[Oddity 1] SPA navigation detected: ${lastKnownUrl} → ${newUrl}`,
    );
    lastKnownUrl = newUrl;

    resetAnnotationState();
    init().catch((err) => {
      console.error("[Oddity 1] Re-init after SPA navigation failed:", err);
    });
  }

  // popstate fires instantly on back/forward
  window.addEventListener("popstate", onUrlChange);

  // Poll for pushState/replaceState navigations that don't fire popstate.
  // 500ms is imperceptible to users but catches navigations promptly.
  urlPollInterval = setInterval(onUrlChange, 500);
}

// ─── Domain Whitelist ───

function extractDomain(): string {
  return window.location.hostname.replace(/^www\./, '');
}

function isDomainWhitelisted(domain: string, sites: string[]): boolean {
  return sites.some(site => domain === site || domain.endsWith('.' + site));
}

function manualRun(): void {
  if (blocked) return;
  manualRunTriggered = true;
  setArgumentsBoxDimmed(false);
  pipelineInitialized = false;
  startPipeline().catch(console.error);

  // Clear the ⌘O badge
  sendMessage({ action: "setBadge", payload: { text: "" } }).catch(() => {});
}

// ─── Pipeline ───

async function init(): Promise<void> {
  console.log("[Oddity 1] Content script initializing");

  // Keep URL in sync (used by SPA navigation watcher)
  lastKnownUrl = window.location.href;

  // Redirect oddity1.com landing page → app.oddity1.com dashboard (signed-in users only)
  const domain = extractDomain();
  if (domain === 'oddity1.com') {
    try {
      const authResult = await chrome.runtime.sendMessage({ action: "getAuthStatus", payload: {} });
      if (authResult?.authenticated) {
        window.location.replace('https://app.oddity1.com');
        return;
      }
    } catch {}
  }

  // Block pipeline on app.oddity1.com — the webapp has its own annotation system
  if (isBlockedDomain(domain)) {
    blocked = true;
    return;
  }

  // Load stored preferences before doing any work
  const stored = await chrome.storage.local.get("preferences");
  const prefs = stored?.preferences;

  // Restore personality from stored preferences (mode always resets to "all" on page load)
  if (prefs?.depth_personality) {
    currentPersonality = (prefs.depth_personality as string) === "gary" ? "sally" : prefs.depth_personality;
  }
  // Always reset stored mode to "all" on page load so popup/background stay in sync
  if (prefs && prefs.annotation_mode !== "all") {
    chrome.storage.local.set({ preferences: { ...prefs, annotation_mode: "all" } });
  }
  visibleTypes = [
    ...(currentMode === "all" ? ALL_ANNOTATION_TYPES : currentMode === "overview" ? ALL_OVERVIEW_TYPES : ALL_DEPTH_TYPES),
    "user_written",
  ];
  setMarginNoteMode(currentMode);

  if (prefs?.enabled === false) {
    enabled = false;
    console.log("[Oddity 1] Extension is disabled — skipping initialization");
    initArgumentsBox();
    setArgumentsBoxEnabled(false);
    setManualRunCallback(manualRun);
    setInputTextProvider(collectInputText);
    return;
  }

  // Auth check — require sign-in before any whitelist/manual-run functionality
  const authStatus = await sendMessage<{ authenticated: boolean }>({
    action: "getAuthStatus",
    payload: {},
  });

  if (!authStatus?.authenticated) {
    console.log("[Oddity 1] Not signed in — showing auth toast");
    showAuthToast();
    initArgumentsBox();
    setArgumentsBoxEnabled(enabled);
    setManualRunCallback(manualRun);
    setInputTextProvider(collectInputText);
    return;
  }

  // Whitelist check — only auto-run on enabled sites
  const enabledSites: string[] = prefs?.enabled_sites ?? DEFAULT_ENABLED_SITES;
  const currentDomain = extractDomain();

  // Check if this site was manually enabled earlier this session (survives page refresh)
  let sessionEnabled = false;
  try { sessionEnabled = sessionStorage.getItem("oddity1_session_enabled") === "1"; } catch {}

  if (isDomainWhitelisted(currentDomain, enabledSites) || sessionEnabled) {
    siteWhitelisted = true;
    if (sessionEnabled) manualRunTriggered = true;
    await startPipeline();
  } else {
    siteWhitelisted = false;
    console.log(`[Oddity 1] Site not whitelisted: ${currentDomain} — waiting for manual run`);
    initArgumentsBox();
    setInputTextProvider(collectInputText);
    setArgumentsBoxEnabled(enabled);
    setArgumentsBoxDimmed(true);
    setManualRunCallback(manualRun);

    // Set ⌘O / Ctrl+O badge to hint about the shortcut
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    sendMessage({ action: "setBadge", payload: { text: isMac ? "\u2318O" : "^O", color: "#6B7280" } }).catch(() => {});
  }
}

async function startPipeline(): Promise<void> {
  if (pipelineInitialized) return;
  pipelineInitialized = true;

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
    initArgumentsBox();
    setArgumentsBoxEnabled(enabled);
    setInputTextProvider(collectInputText);

    // Eagerly create the margin-notes shadow DOM container so addMarginNote()
    // never silently returns. We pass document.body as a temporary regionEl;
    // the onResponse callback updates it to the actual response element for
    // accurate left/right margin measurement.
    initMarginNotes(document.body);
    setOverlayVisible(true);
    setMarginNotesVisible(true);

    const chatObserver = createChatObserver({
      responseSelector: matchedAdapter.response_selector,
      stabilitySignal: matchedAdapter.stability_signal,
      onTrack: (element) => {
        // Mark element as owned by the chat observer so body-level detection
        // doesn't send a request for partial streaming text.
        chatTrackedElements.add(element);
      },
      onResponse: (regionId, element) => {
        if (!enabled) return;

        // Update regionEl to the actual content element so margin notes
        // compute left/right positioning correctly.
        initMarginNotes(element);

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
    activeChatObserver = chatObserver;

    // Also activate body-level detection as a parallel safety net.
    // On fresh chat pages, the chat observer correctly waits for the first
    // streaming response to complete. Body-level detection handles edge cases
    // (stale selectors, SPA navigations). Content-hash dedup in
    // handleStableRegion prevents double-processing.
    activateBodyLevelDetection(adapters, matchedAdapter);

    return;
  }

  // ── Static site flow ──
  regions = detectReadingRegions(adapters);

  console.log(`[Oddity 1] Detected ${regions.length} reading region(s)`);

  // Initialize rendering layers (even with 0 initial regions — new content may appear)
  initOverlay();
  initManualAnnotations();
  initKeyboardNav();
  initArgumentsBox();
  setInputTextProvider(collectInputText);
  setArgumentsBoxEnabled(enabled);

  if (regions.length > 0) {
    initMarginNotes(regions[0]!.element);
    marginNotesInitFromBody = true;
  }

  setOverlayVisible(true);
  setMarginNotesVisible(true);

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

/** Check if an element (or any of its ancestors) is being tracked by the chat observer. */
function isTrackedByChat(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    if (chatTrackedElements.has(node)) return true;
    node = node.parentElement;
  }
  return false;
}

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
  // NOTE: knownElements is checked against both this set AND the live regions array
  // to avoid duplicating elements already tracked by the chat observer.
  const knownElements = new WeakSet<Element>(regions.map((r) => r.element));

  const bodyObserver = new MutationObserver(() => {
    if (!enabled) return;
    if (activeRescanTimer) clearTimeout(activeRescanTimer);
    activeRescanTimer = setTimeout(() => {
      activeRescanTimer = null;
      // Re-snapshot elements the chat observer may have added since last scan
      for (const r of regions) knownElements.add(r.element);

      const detected = detectReadingRegions(adapters);
      for (const candidate of detected) {
        if (knownElements.has(candidate.element)) continue;
        // Skip elements the chat observer is actively tracking (still streaming).
        // The chat observer will fire onResponse when streaming completes,
        // at which point it gets annotated with the full text.
        // Check both the element itself and its ancestors — content_selectors
        // may match a child of the response_selector element.
        if (isTrackedByChat(candidate.element)) continue;

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
  activeBodyObserver = bodyObserver;
}

async function handleStableRegion(
  region: DetectedRegion,
  _element: Element,
): Promise<void> {
  if (!enabled) return;

  // In "all" mode, fire requests for both modes
  if (currentMode === "all") {
    handleStableRegionForMode(region, _element, "overview");
    handleStableRegionForMode(region, _element, "depth");
    return;
  }

  // Extract text first so we can use contentHash as the dedup key
  const extracted =
    region.source === "readability"
      ? extractWithReadability()
      : extractText(region);

  if (!extracted || !extracted.text) return;

  // Guard: skip if no real words (whitespace/symbols only)
  if (extracted.wordCount <= 0) return;

  // Guard: truncate text exceeding backend limit and recalculate word count
  if (extracted.text.length > MAX_TEXT_LENGTH) {
    console.log(`[Oddity 1] Text too long (${extracted.text.length} chars), truncating to ${MAX_TEXT_LENGTH}`);
    extracted.text = extracted.text.slice(0, MAX_TEXT_LENGTH);
    extracted.wordCount = extracted.text.split(/\s+/).filter(Boolean).length;
    if (extracted.wordCount <= 0) return;
  }

  // Compute content hash
  const contentHash = await sha256(extracted.text);

  // Stale guard: if this region already had a different hash, the content changed.
  const previousHash = activeHashes.get(region.element);
  if (previousHash && previousHash !== contentHash) {
    pendingRegions.delete(previousHash);
    annotatedRegions.delete(previousHash);
    overviewAnnotations.delete(previousHash);
    depthAnnotations.delete(previousHash);
    overviewGenerated.delete(previousHash);
    depthGenerated.delete(previousHash);
    regionByHash.delete(previousHash);
    rerenderAll();
    syncArgumentsBox();
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
  const reqMode = currentMode as AnnotationMode;
  const modes = pendingModeByHash.get(contentHash) ?? new Set();
  modes.add(reqMode);
  pendingModeByHash.set(contentHash, modes);
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
        mode: currentMode as AnnotationMode,
        personality: currentPersonality,
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

/**
 * Request annotations for a specific mode (used by "all" mode to fire both overview + depth).
 * Uses per-mode generated sets to dedup instead of the shared annotatedRegions/pendingRegions.
 */
async function handleStableRegionForMode(
  region: DetectedRegion,
  _element: Element,
  requestMode: AnnotationMode,
): Promise<void> {
  if (!enabled) return;

  const generated = requestMode === "overview" ? overviewGenerated : depthGenerated;

  const extracted =
    region.source === "readability"
      ? extractWithReadability()
      : extractText(region);

  if (!extracted || !extracted.text) return;
  if (extracted.wordCount <= 0) return;

  if (extracted.text.length > MAX_TEXT_LENGTH) {
    extracted.text = extracted.text.slice(0, MAX_TEXT_LENGTH);
    extracted.wordCount = extracted.text.split(/\s+/).filter(Boolean).length;
    if (extracted.wordCount <= 0) return;
  }

  const contentHash = await sha256(extracted.text);
  activeHashes.set(region.element, contentHash);

  // Skip if this mode already generated for this hash
  if (generated.has(contentHash)) return;

  (region.element as HTMLElement).dataset.oddityHash = contentHash;
  regionByHash.set(contentHash, region);

  // Use a mode-specific pending key to avoid collision between overview/depth requests
  const pendingKey = `${requestMode}:${contentHash}`;
  if (pendingRegions.has(pendingKey)) return;
  pendingRegions.add(pendingKey);
  const modes = pendingModeByHash.get(contentHash) ?? new Set();
  modes.add(requestMode);
  pendingModeByHash.set(contentHash, modes);

  console.log(
    `[Oddity 1] Requesting ${requestMode} annotations for region ${region.id} (hash: ${contentHash.slice(0, 12)}…)`,
  );

  try {
    const result = await sendMessage<{ error?: string }>({
      action: "requestAnnotations",
      payload: {
        url: window.location.href,
        regionId: region.id,
        contentHash,
        text: extracted.text,
        mode: requestMode,
        personality: currentPersonality,
        wordCount: extracted.wordCount,
      },
    });

    if (result && "aborted" in result) {
      pendingRegions.delete(pendingKey);
      const modes = pendingModeByHash.get(contentHash);
      if (modes) { modes.delete(requestMode); if (modes.size === 0) pendingModeByHash.delete(contentHash); }
      return;
    }

    if (result?.error) {
      if (result.error.includes("Sign in")) {
        showAuthToast();
      } else {
        console.error(`[Oddity 1] Annotation request failed: ${result.error}`);
      }
      pendingRegions.delete(pendingKey);
      const modes = pendingModeByHash.get(contentHash);
      if (modes) { modes.delete(requestMode); if (modes.size === 0) pendingModeByHash.delete(contentHash); }
    }
  } catch (err) {
    const errStr = String(err);
    if (errStr.includes("Auth") || errStr.includes("401")) {
      showAuthToast();
    } else {
      console.error(`[Oddity 1] Annotation request error:`, err);
    }
    pendingRegions.delete(pendingKey);
    const modes = pendingModeByHash.get(contentHash);
    if (modes) { modes.delete(requestMode); if (modes.size === 0) pendingModeByHash.delete(contentHash); }
  }
}

// ─── URL Prediction ───

async function tryUrlPrediction(): Promise<void> {
  const prediction = await sendMessage<{
    contentHash: string;
    mode: string;
    annotations: Annotation[];
    feedback: AnnotationFeedback[];
  } | null>({
    action: "getUrlPrediction",
    payload: { url: window.location.href },
  });

  if (!prediction || !prediction.annotations?.length) return;
  // In "all" mode, accept predictions for either mode; in single mode, must match
  const predMode = prediction.mode as AnnotationMode;
  if (currentMode !== "all" && predMode !== currentMode) return;

  // Use first region as the prediction target
  const region = regions[0];
  if (!region) return;

  const regionId = prediction.contentHash;

  // Don't overwrite if normal pipeline already finished for this mode
  const predGenerated = predMode === "overview" ? overviewGenerated : depthGenerated;
  if (predGenerated.has(regionId)) return;

  console.log(
    `[Oddity 1] URL prediction hit — rendering ${prediction.annotations.length} ${predMode} annotations instantly`,
  );

  // Store prediction hash so normal pipeline can verify
  regionByHash.set(regionId, region);
  (region.element as HTMLElement).dataset.oddityHash = regionId;
  activeHashes.set(region.element, regionId);
  // Route to the correct mode store
  const predAnnStore = predMode === "overview" ? overviewAnnotations : depthAnnotations;
  const predFbStore = predMode === "overview" ? overviewFeedback : depthFeedback;
  predAnnStore.set(regionId, prediction.annotations);
  predFbStore.set(regionId, prediction.feedback ?? []);
  syncUserWrittenToBothStores(regionId, prediction.annotations, predMode);
  renderAnnotations(regionId, prediction.annotations);
  syncArgumentsBox();
}

// ─── Annotation Deletion ───

function handleAnnotationDeleted(annotationId: string): void {
  // Track locally so in-flight server responses don't re-add it
  deletedAnnotationIds.add(annotationId);

  // Find the contentHash for this annotation so we can tell the server
  let deletedContentHash: string | undefined;
  for (const store of [overviewAnnotations, depthAnnotations]) {
    for (const [regionId, annotations] of store) {
      if (annotations.some((a) => a.id === annotationId)) {
        deletedContentHash = regionId;
      }
      const filtered = annotations.filter((a) => a.id !== annotationId);
      if (filtered.length !== annotations.length) {
        store.set(regionId, filtered);
      }
    }
  }

  // Also remove orphaned feedback for this annotation from both stores
  for (const store of [overviewFeedback, depthFeedback]) {
    for (const [regionId, fbs] of store) {
      const filtered = fbs.filter((f) => f.annotation_id !== annotationId);
      if (filtered.length !== fbs.length) {
        store.set(regionId, filtered);
      }
    }
  }

  // Delete from server so it doesn't come back on future requests
  sendMessage({
    action: "deleteAnnotation",
    payload: {
      annotationId,
      url: window.location.href,
      contentHash: deletedContentHash ?? "",
    },
  });

  // Remove from DOM
  removeAnchors(annotationId);
  removeMarginNote(annotationId);
  // Re-render overlay
  rerenderAll();
  syncArgumentsBox();
}

// ─── Rendering ───

function attachAnchorHoverListeners(
  spans: HTMLSpanElement[],
  annotationId: string,
): void {
  for (const span of spans) {
    span.addEventListener("mouseenter", () => onAnchorHoverStart(annotationId));
    span.addEventListener("mouseleave", () => onAnchorHoverEnd(annotationId));
    span.addEventListener("click", (e) => { e.stopPropagation(); onAnchorClick(annotationId); });
  }
}

/**
 * Remove annotations whose anchors overlap with an earlier annotation in the
 * same render batch. Uses the root element's text content to find positions.
 * Annotations whose exact string cannot be located are passed through unchanged.
 */
function deduplicateOverlappingAnchors(annotations: Annotation[], root: Element): Annotation[] {
  const text = root.textContent ?? '';
  type Positioned = { ann: Annotation; start: number; end: number };
  const locatable: Positioned[] = [];
  const unlocatable: Annotation[] = [];

  for (const ann of annotations) {
    const pos = findBestMatch(text, ann.anchor.exact, ann.anchor.prefix, ann.anchor.suffix);
    if (pos === -1) {
      unlocatable.push(ann);
    } else {
      locatable.push({ ann, start: pos, end: pos + ann.anchor.exact.length });
    }
  }

  locatable.sort((a, b) => a.start - b.start);

  const kept: Positioned[] = [];
  for (const item of locatable) {
    const overlaps = kept.some((k) => item.start < k.end && item.end > k.start);
    if (!overlaps) kept.push(item);
  }

  return [...kept.map((k) => k.ann), ...unlocatable];
}

/** Find the best occurrence of `exact` in `text` using prefix/suffix context. */
function findBestMatch(text: string, exact: string, prefix?: string, suffix?: string): number {
  if (!prefix && !suffix) return text.indexOf(exact);

  let searchFrom = 0;
  let bestPos = -1;
  let bestScore = -1;

  while (searchFrom < text.length) {
    const pos = text.indexOf(exact, searchFrom);
    if (pos === -1) break;

    let score = 0;
    if (prefix) {
      const before = text.slice(Math.max(0, pos - prefix.length - 10), pos);
      if (before.includes(prefix)) score += 2;
    }
    if (suffix) {
      const after = text.slice(pos + exact.length, pos + exact.length + suffix.length + 10);
      if (after.includes(suffix)) score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestPos = pos;
    }

    searchFrom = pos + 1;
  }

  return bestPos;
}

function renderAnnotations(regionId: string, annotations: Annotation[]): void {
  const region =
    regionByHash.get(regionId) ?? regions.find((r) => r.id === regionId);
  const root = region?.element ?? document.body;

  // Guard: skip if the root element has been detached from the DOM (common on SPAs like ChatGPT)
  if (root !== document.body && !root.isConnected) {
    console.warn(`[Oddity 1] Skipping render for ${regionId.slice(0, 12)}… — element detached`);
    return;
  }

  const feedback = effectiveFeedbackMap().get(regionId) ?? [];

  // Filter visible types first
  const visible = annotations.filter((a) => visibleTypes.includes(a.type));

  // Sort: background-type annotations first (core_claim, insight), line-type last
  // This ensures underlines render on top in the DOM stacking order
  const backgroundTypes = new Set<AnnotationType>(["core_claim", "insight"]);
  visible.sort((a, b) => {
    const aIsBg = backgroundTypes.has(a.type) ? 0 : 1;
    const bIsBg = backgroundTypes.has(b.type) ? 0 : 1;
    return aIsBg - bIsBg;
  });

  // Remove annotations whose anchors overlap with an earlier annotation
  const nonOverlapping = deduplicateOverlappingAnchors(visible, root);

  // Invalidate text-node index once before the batch — ensures a clean index.
  // The index is reused across all annotations in this region (5–10× fewer TreeWalker traversals).
  // Later annotations may see slightly shifted positions due to prior injectAnchors DOM mutations,
  // but the existing fuzzy fallback chain in resolveSelector handles these gracefully.
  invalidateTextNodeIndex(root);

  // Single-pass: resolve + render one annotation at a time
  // This avoids stale ranges from prior DOM mutations (injectAnchors splits text nodes)
  for (const annotation of nonOverlapping) {
    try {
      const range = resolveSelector(root, annotation.anchor);
      if (!range) {
        console.debug(
          `[Oddity 1] Could not resolve selector for annotation ${annotation.id} — text may have changed or not yet rendered`,
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
        regionId,
      );
    } catch (err) {
      console.warn(`[Oddity 1] Render failed for annotation ${annotation.id}:`, err);
    }
  }
}

function rerenderAll(): void {
  clearOverlay();
  clearAllAnchors();
  clearMarginNotes();

  for (const [regionId, annotations] of effectiveAnnotations()) {
    renderAnnotations(regionId, annotations);
  }
}

// ─── Mode Switching ───

function switchMode(newMode: ViewMode, newPersonality?: DepthPersonality): void {
  // Clear current rendering
  clearOverlay();
  clearAllAnchors();
  clearMarginNotes();

  // Update state
  currentMode = newMode;
  setMarginNoteMode(newMode);
  if (newPersonality) currentPersonality = newPersonality;

  // Update visible types for new mode
  visibleTypes = [
    ...(currentMode === "all" ? ALL_ANNOTATION_TYPES : currentMode === "overview" ? ALL_OVERVIEW_TYPES : ALL_DEPTH_TYPES),
    "user_written",
  ];

  // Clear pending/annotated tracking (these are per-request, not per-mode)
  annotatedRegions.clear();
  pendingRegions.clear();
  pendingModeByHash.clear();
  streamedRegions.clear();
  longWaitManager.reset();

  if (currentMode === "all") {
    // "All" mode: render from both stores, request whichever is missing
    const hasOverview = overviewAnnotations.size > 0;
    const hasDepth = depthAnnotations.size > 0;

    if (hasOverview || hasDepth) {
      setOverlayVisible(true);
      setMarginNotesVisible(true);
      rerenderAll();
      syncArgumentsBox();
    }

    // Request whichever mode hasn't been generated via API yet.
    // Use the generated sets (not store size) since stores may contain
    // user_written notes synced from the other mode.
    const needsOverview = overviewGenerated.size === 0;
    const needsDepth = depthGenerated.size === 0;

    if (needsOverview || needsDepth) {
      setOverlayVisible(true);
      setMarginNotesVisible(true);
      setArgumentsBoxVisible(true);
      for (const region of regions) {
        if (needsOverview) handleStableRegionForMode(region, region.element, "overview");
        if (needsDepth) handleStableRegionForMode(region, region.element, "depth");
      }
    }
  } else {
    // Single mode: use the generated set to decide if API call is needed.
    // The store may contain user_written notes from the other mode,
    // so store.size > 0 is not a reliable signal.
    const generated = currentGenerated();
    const hasRealData = generated.size > 0;

    // Always render what we have (user_written notes + any cached annotations)
    setOverlayVisible(true);
    setMarginNotesVisible(true);
    rerenderAll();
    syncArgumentsBox();

    // If this mode was never generated, fire API requests
    if (!hasRealData) {
      setArgumentsBoxVisible(true);
      for (const region of regions) {
        handleStableRegion(region, region.element);
      }
    }
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
      const allAnnotations: Annotation[] = [];
      for (const annotations of effectiveAnnotations().values()) {
        allAnnotations.push(...annotations);
      }
      // Collect page content from detected regions (live DOM).
      // This is far more reliable than Readability on dynamic / chat sites.
      const regionHtml = collectRegionHtml();
      return handleExportPdf(title, subtitle, allAnnotations, regionHtml)
        .then(() => ({ success: true }))
        .catch((err) => ({ success: false, error: String(err) }));
    }
    case "sketchChunk": {
      const { text, done } = message.payload;
      appendSketchChunk(text, done);
      break;
    }
    case "annotationReady": {
      // Progressive rendering: single annotation from streaming pipeline
      const { regionId: streamRegionId, annotation } = message.payload;

      // Skip annotations that were locally deleted (in-flight response race)
      if (deletedAnnotationIds.has(annotation.id)) break;

      // Stale guard — check both plain and mode-prefixed pending keys
      const plainPending = pendingRegions.has(streamRegionId);
      const modePending = pendingRegions.has(`${annotation.mode}:${streamRegionId}`);
      if (!plainPending && !modePending) break;
      streamedRegions.add(streamRegionId);
      longWaitManager.handleFirstAnnotation(streamRegionId);
      hideEmptyAnnotationsBubble();

      // Always store the annotation regardless of current visible types —
      // it may be needed when the user switches mode later.
      const annStore = annotation.mode === "overview" ? overviewAnnotations : depthAnnotations;
      const existing = annStore.get(streamRegionId) ?? [];
      existing.push(annotation);
      annStore.set(streamRegionId, existing);

      // user_written annotations go in BOTH stores so they survive mode switches
      if (annotation.type === "user_written") {
        const otherAnnStore = annotation.mode === "overview" ? depthAnnotations : overviewAnnotations;
        const otherExisting = otherAnnStore.get(streamRegionId) ?? [];
        if (!otherExisting.some((a) => a.id === annotation.id)) {
          otherExisting.push(annotation);
          otherAnnStore.set(streamRegionId, otherExisting);
        }
      }

      syncArgumentsBox();

      // Skip rendering if disabled or type is not visible in current mode
      if (!enabled || !visibleTypes.includes(annotation.type)) break;

      const streamRegion =
        regionByHash.get(streamRegionId) ??
        regions.find((r) => r.id === streamRegionId);
      const streamRoot = streamRegion?.element ?? document.body;

      // Skip if the element has been detached (common on SPAs like ChatGPT)
      if (streamRoot !== document.body && !streamRoot.isConnected) break;

      // Render the single annotation immediately
      try {
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
          const fb = effectiveFeedbackMap().get(streamRegionId) ?? [];
          const noteFeedback = fb.filter(
            (f: AnnotationFeedback) => f.annotation_id === annotation.id,
          );
          addMarginNote(
            annotation,
            stableRange,
            noteFeedback,
            handleAnnotationDeleted,
            streamRegionId,
          );
        }
      } catch (err) {
        console.warn(`[Oddity 1] Stream render failed for annotation ${annotation.id}:`, err);
      }
      break;
    }
    case "annotationsReady": {
      const { regionId, annotations: rawAnnotations, feedback: rawFeedback } = message.payload;

      // Filter out annotations and feedback that were locally deleted (prevents re-addition from in-flight responses)
      const annotations = rawAnnotations.filter((a: Annotation) => !deletedAnnotationIds.has(a.id));
      const feedback = rawFeedback.filter((f: AnnotationFeedback) => !deletedFeedbackIds.has(f.id));

      // Determine which mode this response belongs to.
      // Priority: annotation data > pendingModeByHash tracking > fallback.
      let responseMode: AnnotationMode;
      if (annotations.length > 0 && annotations[0]!.mode) {
        responseMode = annotations[0]!.mode as AnnotationMode;
      } else {
        // Empty response — use our tracking map to determine which mode was requested
        const trackedModes = pendingModeByHash.get(regionId);
        if (trackedModes && trackedModes.size === 1) {
          responseMode = trackedModes.values().next().value!;
        } else {
          // Fallback: check which mode-prefixed pending key exists
          if (pendingRegions.has(`overview:${regionId}`)) responseMode = "overview";
          else if (pendingRegions.has(`depth:${regionId}`)) responseMode = "depth";
          else responseMode = currentMode === "depth" ? "depth" : "overview";
        }
      }

      const responseAnnStore = responseMode === "overview" ? overviewAnnotations : depthAnnotations;
      const responseFbStore = responseMode === "overview" ? overviewFeedback : depthFeedback;
      const responseGenerated = responseMode === "overview" ? overviewGenerated : depthGenerated;

      // Stale response guard — check both plain and mode-prefixed pending keys
      const modePendingKey = `${responseMode}:${regionId}`;
      const isPlainPending = pendingRegions.has(regionId);
      const isModePending = pendingRegions.has(modePendingKey);
      if (!isPlainPending && !isModePending && !responseGenerated.has(regionId)) {
        console.log(
          `[Oddity 1] Ignoring stale ${responseMode} response for ${regionId.slice(0, 12)}…`,
        );
        break;
      }

      longWaitManager.handleFinalResult(regionId, annotations.length);

      // Show/hide empty-annotations bubble when the Input Guard returns []
      if (annotations.length === 0 && !responseGenerated.has(regionId)) {
        // Check if ALL regions across both stores are empty (no AI annotations)
        const allEmpty = [...overviewAnnotations.values(), ...depthAnnotations.values()]
          .every((arr) => arr.every((a) => a.type === "user_written"));
        if (allEmpty) showEmptyAnnotationsBubble();
      } else if (annotations.length > 0) {
        hideEmptyAnnotationsBubble();
      }

      // Stale-while-revalidate: mode already generated and no active pending request
      if (responseGenerated.has(regionId) && !isPlainPending && !isModePending) {
        const prev = responseAnnStore.get(regionId) ?? [];
        const prevFb = responseFbStore.get(regionId) ?? [];
        responseAnnStore.set(regionId, annotations);
        responseFbStore.set(regionId, feedback);
        syncUserWrittenToBothStores(regionId, annotations, responseMode);
        syncArgumentsBox();

        const prevAnnIds = new Set(prev.map((a) => a.id));
        const annsChanged = annotations.length !== prev.length ||
          annotations.some((a) => !prevAnnIds.has(a.id));
        const prevFbIds = new Set(prevFb.map((f) => f.id));
        const fbChanged = feedback.length !== prevFb.length ||
          feedback.some((f) => !prevFbIds.has(f.id));
        if ((annsChanged || fbChanged) && enabled) {
          clearOverlay();
          clearAllAnchors();
          clearMarginNotes();
          for (const [rid, anns] of effectiveAnnotations()) {
            renderAnnotations(rid, anns);
          }
        }
        break;
      }

      // Clean up pending state for THIS mode only (don't block the other mode)
      pendingRegions.delete(regionId);
      pendingRegions.delete(modePendingKey);
      // Remove this mode from the tracked set
      const trackedSet = pendingModeByHash.get(regionId);
      if (trackedSet) {
        trackedSet.delete(responseMode);
        if (trackedSet.size === 0) pendingModeByHash.delete(regionId);
      }

      responseGenerated.add(regionId);
      responseFbStore.set(regionId, feedback);

      const hadStreaming = streamedRegions.has(regionId);
      streamedRegions.delete(regionId);
      responseAnnStore.set(regionId, annotations);
      syncUserWrittenToBothStores(regionId, annotations, responseMode);
      syncArgumentsBox();

      // Always do a full re-render from effectiveAnnotations to ensure both
      // stores are merged correctly (critical for "all" mode)
      if (enabled) {
        clearOverlay();
        clearAllAnchors();
        clearMarginNotes();
        for (const [rid, anns] of effectiveAnnotations()) {
          renderAnnotations(rid, anns);
        }
      }
      break;
    }

    case "settingsUpdated": {
      const {
        enabled: newEnabled,
        annotationMode: newMode,
        depthPersonality: newPersonality,
        visibleTypes: newVisibleTypes,
        annotationFont,
        annotationFontSize,
      } = message.payload;

      // Apply font/size changes immediately
      updateMarginNotesStyle(annotationFont, annotationFontSize);
      updateArgumentsBoxStyle(annotationFont, annotationFontSize);
      const wasEnabled = enabled;
      const viewMode = newMode as ViewMode;
      const modeChanged = viewMode !== currentMode;
      const personalityChanged = newPersonality !== currentPersonality;
      enabled = newEnabled;
      visibleTypes = newVisibleTypes.length > 0 ? newVisibleTypes : [
        ...(viewMode === "all" ? ALL_ANNOTATION_TYPES : viewMode === "overview" ? ALL_OVERVIEW_TYPES : ALL_DEPTH_TYPES),
        "user_written",
      ];

      console.log(
        `[Oddity 1] Settings updated — enabled: ${enabled}, mode: ${viewMode}, personality: ${newPersonality}`,
      );

      setArgumentsBoxEnabled(enabled);

      if (!enabled) {
        setOverlayVisible(false);
        setMarginNotesVisible(false);
        clearAllAnchors();
        longWaitManager.reset();
      } else if (modeChanged) {
        // Mode changed: switch annotation display
        switchMode(viewMode, newPersonality);
      } else if (personalityChanged) {
        // Personality only affects depth annotations — preserve user-written notes and their feedback
        currentPersonality = newPersonality;
        clearOverlay();
        clearAllAnchors();
        clearMarginNotes();

        // Preserve user-written annotations and their feedback before clearing
        const savedUserWritten = new Map<string, Annotation[]>();
        const savedUserFeedback = new Map<string, AnnotationFeedback[]>();
        for (const store of [overviewAnnotations, depthAnnotations]) {
          for (const [hash, anns] of store) {
            const uw = anns.filter((a) => a.type === "user_written");
            if (uw.length > 0) {
              const existing = savedUserWritten.get(hash) ?? [];
              const ids = new Set(existing.map((a) => a.id));
              for (const a of uw) { if (!ids.has(a.id)) existing.push(a); }
              savedUserWritten.set(hash, existing);
            }
          }
        }
        for (const store of [overviewFeedback, depthFeedback]) {
          for (const [hash, fbs] of store) {
            const existing = savedUserFeedback.get(hash) ?? [];
            const ids = new Set(existing.map((f) => f.id));
            for (const f of fbs) { if (!ids.has(f.id)) existing.push(f); }
            savedUserFeedback.set(hash, existing);
          }
        }

        // Only clear depth (personality doesn't affect overview)
        depthAnnotations.clear();
        depthFeedback.clear();
        depthGenerated.clear();

        // Restore user-written annotations and all feedback to both stores
        for (const [hash, anns] of savedUserWritten) {
          for (const store of [overviewAnnotations, depthAnnotations]) {
            const list = store.get(hash) ?? [];
            const ids = new Set(list.map((a) => a.id));
            for (const a of anns) { if (!ids.has(a.id)) list.push(a); }
            store.set(hash, list);
          }
        }
        for (const [hash, fbs] of savedUserFeedback) {
          for (const store of [overviewFeedback, depthFeedback]) {
            const list = store.get(hash) ?? [];
            const ids = new Set(list.map((f) => f.id));
            for (const f of fbs) { if (!ids.has(f.id)) list.push(f); }
            store.set(hash, list);
          }
        }

        annotatedRegions.clear();
        pendingRegions.clear();
        pendingModeByHash.clear();
        streamedRegions.clear();
        longWaitManager.reset();
        syncArgumentsBox();
        setOverlayVisible(true);
        setMarginNotesVisible(true);
        setArgumentsBoxVisible(true);
        for (const region of regions) {
          handleStableRegion(region, region.element);
        }
      } else if (!wasEnabled && enabled) {
        if (!pipelineInitialized) {
          startPipeline().catch(console.error);
        } else {
          setOverlayVisible(true);
          setMarginNotesVisible(true);
          rerenderAll();
        }
      } else {
        filterByTypes(visibleTypes);
        filterMarginNotesByTypes(visibleTypes);
      }
      break;
    }

    case "deleteAnnotation": {
      handleAnnotationDeleted(message.payload.annotationId);
      break;
    }

    case "triggerManualRun": {
      if (blocked) break;
      if (!siteWhitelisted && !manualRunTriggered && enabled) {
        manualRun();
      }
      break;
    }

    case "enabledSitesUpdated": {
      if (blocked) break;
      const { sites } = message.payload;
      const currentDomain = extractDomain();
      if (!siteWhitelisted && isDomainWhitelisted(currentDomain, sites)) {
        siteWhitelisted = true;
        setArgumentsBoxDimmed(false);
        sendMessage({ action: "setBadge", payload: { text: "" } }).catch(() => {});
        if (!pipelineInitialized) {
          startPipeline().catch(console.error);
        }
      }
      break;
    }

    case "authStateChanged": {
      const { authenticated } = message.payload;
      if (!authenticated) {
        // signOutCb (via handleRemoteSignOut) handles state reset + DOM teardown
        handleRemoteSignOut();
      } else {
        const user = (message.payload as { user: { email: string; display_name: string | null; tier: string; annotation_count: number } }).user;
        // init() returned early (unauthenticated), so re-check whitelist and start pipeline
        if (!pipelineInitialized) {
          (async () => {
            const stored = await chrome.storage.local.get("preferences");
            const enabledSites: string[] = stored?.preferences?.enabled_sites ?? DEFAULT_ENABLED_SITES;
            const domain = extractDomain();
            const whitelisted = isDomainWhitelisted(domain, enabledSites);
            await handleRemoteSignIn(user);
            if (whitelisted) {
              siteWhitelisted = true;
              setArgumentsBoxDimmed(false);
              await startPipeline();
            }
          })().catch(console.error);
        } else {
          handleRemoteSignIn(user).catch(() => {});
        }
      }
      break;
    }
  }
});

// ─── Local Sign-In (same tab) — background skips authStateChanged for the signing-in tab ───
document.addEventListener("oddity:localSignIn", () => {
  if (!pipelineInitialized) {
    (async () => {
      const stored = await chrome.storage.local.get("preferences");
      const enabledSites: string[] = stored?.preferences?.enabled_sites ?? DEFAULT_ENABLED_SITES;
      const domain = extractDomain();
      if (isDomainWhitelisted(domain, enabledSites)) {
        siteWhitelisted = true;
        setArgumentsBoxDimmed(false);
        await startPipeline();
      }
    })().catch(console.error);
  }
});

// ─── Keyboard Navigation ───
// Tab: move between annotations, Enter: open popover, Escape: close popover

let keyboardFocusIndex = -1;
let keyboardNavInitialized = false;

function initKeyboardNav(): void {
  if (keyboardNavInitialized) return;
  keyboardNavInitialized = true;

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

// ─── Export PDF DOM Event (from arguments-box dashboard) ───

document.addEventListener("oddity:exportPdf", (e) => {
  const { title, subtitle } = (e as CustomEvent<{ title: string; subtitle: string }>).detail;
  const allAnnotations: Annotation[] = [];
  for (const annotations of effectiveAnnotations().values()) {
    allAnnotations.push(...annotations);
  }
  const regionHtml = collectRegionHtml();
  handleExportPdf(title, subtitle, allAnnotations, regionHtml).catch(() => {});
});

// ─── Mode Change Handler (from arguments-box toggle) ───

document.addEventListener("oddity:scroll-to-annotation", ((e: CustomEvent) => {
  const { annotationId } = e.detail;
  if (!annotationId) return;
  const anchor = document.querySelector(`[data-oddity-id="${CSS.escape(annotationId)}"]`);
  if (anchor) {
    anchor.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}) as EventListener);

document.addEventListener("oddity:annotation-deleted", (e) => {
  const { annotationId } = (e as CustomEvent<{ annotationId: string }>).detail;
  handleAnnotationDeleted(annotationId);
});

document.addEventListener("oddity:feedback-deleted", (e) => {
  const { feedbackId } = (e as CustomEvent<{ feedbackId: string; annotationId?: string }>).detail;
  deletedFeedbackIds.add(feedbackId);

  // Remove from both in-memory feedback stores
  for (const store of [overviewFeedback, depthFeedback]) {
    for (const [regionId, fbs] of store) {
      const filtered = fbs.filter((f) => f.id !== feedbackId);
      if (filtered.length !== fbs.length) {
        store.set(regionId, filtered);
      }
    }
  }
});

document.addEventListener("oddity:modeChange", (e) => {
  const { mode } = (e as CustomEvent<{ mode: ViewMode }>).detail;
  if (mode === currentMode) return;

  // Persist to storage so the service worker broadcasts settingsUpdated
  chrome.storage.local.get("preferences", (result) => {
    const prefs = (result["preferences"] ?? {}) as Record<string, unknown>;
    chrome.storage.local.set({
      preferences: { ...prefs, annotation_mode: mode },
    });
  });

  switchMode(mode);
});

// ─── Manual Annotation Store Sync ───

document.addEventListener("oddity:manualAnnotationCreated", (e) => {
  const { annotation, contentHash } = (e as CustomEvent<{ annotation: Annotation; contentHash: string }>).detail;
  // Store in BOTH stores so the note survives any mode switch.
  // effectiveAnnotations() deduplicates by id, so no double-render.
  for (const store of [overviewAnnotations, depthAnnotations]) {
    const list = store.get(contentHash) ?? [];
    if (!list.some((a) => a.id === annotation.id)) {
      list.push(annotation);
      store.set(contentHash, list);
    }
  }
});

// ─── Annotation / Feedback Edit Sync ───
// Edits from either margin notes or argument box dispatch these events.
// We update the in-memory stores so mode switches and re-renders show the latest text,
// then sync both views.

document.addEventListener("oddity:annotation-edited", (e) => {
  const { annotationId, note } = (e as CustomEvent<{
    annotationId: string;
    note: string;
    contentHash?: string;
  }>).detail;

  // Update in-memory stores (both modes) so mode switches keep the edit
  for (const store of [overviewAnnotations, depthAnnotations]) {
    for (const [, anns] of store) {
      const ann = anns.find((a) => a.id === annotationId);
      if (ann) ann.content.note = note;
    }
  }

  // Update the margin note DOM (in case the edit came from the argument box)
  updateMarginNoteText(annotationId, note);

  // Update the argument box (in case the edit came from the margin note)
  syncArgumentsBox();
});

document.addEventListener("oddity:feedback-edited", (e) => {
  const { feedbackId, replyText } = (e as CustomEvent<{
    feedbackId: string;
    replyText: string;
  }>).detail;

  // Update in-memory feedback stores
  for (const store of [overviewFeedback, depthFeedback]) {
    for (const [, fbs] of store) {
      const fb = fbs.find((f) => f.id === feedbackId);
      if (fb) fb.reply_text = replyText;
    }
  }

  // Sync the argument box view
  syncArgumentsBox();
});

// ─── Ctrl+O Manual Run Handler ───

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
    if (blocked) return;
    if (!siteWhitelisted && !manualRunTriggered && enabled) {
      e.preventDefault();
      manualRun();
    }
  }
});

// ─── Start ───

window.addEventListener("pagehide", () => {
  longWaitManager.reset();
  destroyArgumentsBox();
});

// Clear all annotations and reset pipeline state when the user signs out
setSignOutCallback(() => {
  destroyOverlay();
  destroyMarginNotes();
  clearAllAnchors();
  overviewAnnotations.clear();
  overviewFeedback.clear();
  depthAnnotations.clear();
  depthFeedback.clear();
  overviewGenerated.clear();
  depthGenerated.clear();
  deletedAnnotationIds.clear();
  annotatedRegions.clear();
  pendingRegions.clear();
  pendingModeByHash.clear();
  streamedRegions.clear();
  regionByHash.clear();
  activeHashes.clear();
  regions = [];
  pipelineInitialized = false;
  bodyDetectionActive = false;
  marginNotesInitFromBody = false;
  longWaitManager.reset();
});

// Install SPA navigation watcher once (survives across re-inits)
watchUrlChanges();

init().catch((err) => {
  console.error("[Oddity 1] Content script init error:", err);
});
