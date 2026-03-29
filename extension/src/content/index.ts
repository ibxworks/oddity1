import type {
  Annotation,
  AnnotationFeedback,
  AnnotationMode,
  AnnotationType,
  ExtensionMessage,
  SiteAdapter,
  UserContext,
  UserContextMode,
  ViewMode,
} from "@oddity/shared";
import { ALL_ANNOTATION_TYPES, ALL_DEPTH_TYPES, ALL_OVERVIEW_TYPES, DEFAULT_ENABLED_SITES, isBlockedDomain, MAX_TEXT_LENGTH } from "@oddity/shared";
import { sha256 } from "../shared/hash.js";
import { onMessage, sendMessage } from "../shared/messaging.js";
import { showAuthToast } from "./auth-toast.js";
import { showContextPopup, hideContextPopup } from "./context-popup.js";
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
  setArgumentsBoxPdf,
  setPdfRunCallback,
  updateContextLink,
} from "./renderer/arguments-box.js";
import {
  clearAllAnchors,
  getAllAnchorsInOrder,
  getAnnotationId,
  hasAnchors,
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
import type { ChunkRange } from "./renderer/margin-notes.js";
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
import { getPageUrl } from "./page-url.js";

// ─── Extension context guard ───
// After extension reload/update, content scripts lose access to chrome.* APIs.
// Catch these errors globally so they don't surface as uncaught exceptions.

const _contextInvalidRe = /Extension context invalidated/;

/** Check whether the extension context is still valid (false after reload/update). */
function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/** Tear down all polling/observers when context is invalidated. */
function teardownOnInvalidContext(): void {
  if (urlPollInterval) {
    clearInterval(urlPollInterval);
    urlPollInterval = null;
  }
  activeChatObserver?.stop();
  activeChatObserver = null;
  activeBodyObserver?.disconnect();
  activeBodyObserver = null;
  if (activeRescanTimer) {
    clearTimeout(activeRescanTimer);
    activeRescanTimer = null;
  }
}

window.addEventListener("error", (e) => {
  if (_contextInvalidRe.test(e.message)) {
    e.preventDefault();
    teardownOnInvalidContext();
  }
});

window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  if (
    reason instanceof Error &&
    _contextInvalidRe.test(reason.message)
  ) {
    e.preventDefault();
    teardownOnInvalidContext();
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

/**
 * Replace the annotation list for a region in the given store, but preserve
 * any user_written annotations that aren't in the new list.  API responses
 * never include user_written annotations, so a plain `.set()` would silently
 * discard them.
 */
function setAnnotationsPreservingUserWritten(
  store: Map<string, Annotation[]>,
  regionId: string,
  incoming: Annotation[],
): void {
  const prev = store.get(regionId) ?? [];
  const incomingIds = new Set(incoming.map((a) => a.id));
  const preserved = prev.filter((a) => a.type === "user_written" && !incomingIds.has(a.id));
  store.set(regionId, [...incoming, ...preserved]);
}

/**
 * Replace the feedback list for a region in the given store, but preserve
 * any locally-added feedback entries (e.g. user replies) that aren't in the
 * new list.  This prevents user-created feedback from being silently dropped
 * when an API response replaces the store.
 */
function setFeedbackPreservingLocal(
  store: Map<string, AnnotationFeedback[]>,
  regionId: string,
  incoming: AnnotationFeedback[],
): void {
  const prev = store.get(regionId) ?? [];
  const incomingIds = new Set(incoming.map((f) => f.id));
  const preserved = prev.filter((f) => !incomingIds.has(f.id));
  store.set(regionId, [...incoming, ...preserved]);
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
let currentMode: ViewMode = "overview";
let currentContextMode: UserContextMode | undefined = undefined;
let currentContextNote: string = "";
let hasShownContextPopupThisPage = false;
let visibleTypes: AnnotationType[] = [...ALL_OVERVIEW_TYPES, "user_written"];
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

// ─── React-safe Anchor Guard ───
// React-based sites (Claude.ai, ChatGPT, etc.) may re-render DOM regions that
// contain our injected anchor <span> elements.  If React's reconciliation
// encounters unexpected nodes it crashes (error boundary).
//
// Strategy: listen for clicks outside the annotated content region in the
// capture phase (runs before React's synthetic event handlers).  Strip all
// anchor spans so React re-renders against clean DOM.  After the layout
// settles, re-inject anchors via rerenderAll().
//
// Also use a ResizeObserver on each region to detect layout shifts (sidebar
// open, panel resize) and recover anchors that may have been destroyed.

let anchorGuardRerenderTimer: ReturnType<typeof setTimeout> | null = null;

function startAnchorGuard(): void {
  // ── Capture-phase click guard ──
  document.addEventListener(
    "click",
    (e) => {
      if (!enabled || !hasAnchors()) return;

      const target = e.target as Element | null;
      if (!target) return;

      // Skip clicks on Oddity's own UI elements — these never trigger React
      // re-renders and must not interfere with mode switches or other controls.
      if (
        target.closest("oddity-arguments-box") ||
        target.closest("#oddity-margin-notes") ||
        target.closest("#oddity-page-dim")
      ) return;

      // If the click is inside an annotated region, let it through — the user
      // is interacting with Oddity highlights, not triggering a layout change.
      const allRegionEls = new Set<Element>();
      for (const r of regions) allRegionEls.add(r.element);
      for (const r of regionByHash.values()) allRegionEls.add(r.element);

      for (const el of allRegionEls) {
        if (el.contains(target)) return;
      }

      // Click is outside all content regions — pre-emptively strip anchors
      // so a potential React re-render doesn't crash on unexpected DOM nodes.
      clearAllAnchors();
      clearOverlay();
      clearMarginNotes();
      for (const r of regions) invalidateTextNodeIndex(r.element);
      for (const r of regionByHash.values()) invalidateTextNodeIndex(r.element);

      // Schedule a re-render after the layout settles.
      if (anchorGuardRerenderTimer) clearTimeout(anchorGuardRerenderTimer);
      anchorGuardRerenderTimer = setTimeout(() => {
        anchorGuardRerenderTimer = null;
        if (enabled) rerenderAll();
      }, 400);
    },
    { capture: true },
  );

  // ── ResizeObserver recovery ──
  // When a region's container resizes (sidebar open, panel toggle) anchors may
  // have been destroyed by the framework's re-render.  Detect this and recover.
  if (typeof ResizeObserver !== "undefined") {
    let resizeRerenderTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (!enabled) return;
      // If the anchor guard scheduled a premature re-render, cancel it —
      // we'll recover after the layout fully settles.
      if (anchorGuardRerenderTimer) {
        clearTimeout(anchorGuardRerenderTimer);
        anchorGuardRerenderTimer = null;
      }
      // Debounce — a sidebar toggle may trigger multiple resize entries
      if (resizeRerenderTimer) clearTimeout(resizeRerenderTimer);
      resizeRerenderTimer = setTimeout(() => {
        resizeRerenderTimer = null;
        // Check if anchors survived.  If not, re-render to restore them.
        const domAnchors = document.querySelectorAll("[data-oddity-id]");
        if (domAnchors.length === 0 && (overviewAnnotations.size > 0 || depthAnnotations.size > 0)) {
          for (const r of regions) invalidateTextNodeIndex(r.element);
          for (const r of regionByHash.values()) invalidateTextNodeIndex(r.element);
          rerenderAll();
        }
      }, 500);
    });

    // Observe all current regions
    for (const r of regions) ro.observe(r.element);
    for (const r of regionByHash.values()) ro.observe(r.element);
  }
}

// ─── SPA Navigation: State Reset ───

/**
 * Completely tear down all annotation state and DOM artifacts.
 * Called on SPA navigation so the new page starts with a clean slate.
 */
function resetAnnotationState(): void {
  console.log("[Oddity 1] Resetting annotation state (SPA navigation)");

  // Abort all in-flight annotation requests in the background service worker
  sendMessage({ action: "abortAllRequests", payload: {} }).catch(() => {});

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
  hasShownContextPopupThisPage = false;

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
    // After extension reload/update, stop polling — chrome.* APIs are dead
    if (!isContextValid()) {
      teardownOnInvalidContext();
      return;
    }

    const newUrl = window.location.href;
    if (newUrl === lastKnownUrl) return;

    console.log(
      `[Oddity 1] SPA navigation detected: ${lastKnownUrl} → ${newUrl}`,
    );
    lastKnownUrl = newUrl;

    resetAnnotationState();
    init().catch((err) => {
      // Suppress "Extension context invalidated" — expected after reload
      if (_contextInvalidRe.test(String(err))) {
        teardownOnInvalidContext();
        return;
      }
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

function isPdfPage(): boolean {
  // Most reliable: browser sets contentType for PDF responses
  if (document.contentType === "application/pdf") return true;
  // Fallback: URL ends in .pdf
  if (window.location.pathname.toLowerCase().endsWith(".pdf")) return true;
  // Fallback: Chrome's PDF viewer embed
  if (document.querySelector('embed[type="application/pdf"]')) return true;
  return false;
}

async function handlePdfConversion(): Promise<void> {
  const pdfUrl = window.location.href;
  try {
    const { convertPdfToHtml } = await import("./pdf-converter.js");
    const html = await convertPdfToHtml(pdfUrl);

    // Tell background to inject content script into the next new tab
    await sendMessage({ action: "injectNextNewTab", payload: {} });

    // Open converted HTML in a new tab via blob URL
    const blob = new Blob([html], { type: "text/html" });
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, "_blank");
  } catch (err) {
    console.error("[Oddity 1] PDF conversion failed:", err);
  }
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
  // Bail out immediately if the extension context is dead (reload/update)
  if (!isContextValid()) return;

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

  // PDF detection — show conversion overlay instead of normal pipeline
  if (isPdfPage()) {
    console.log("[Oddity 1] PDF detected — showing conversion overlay");
    initArgumentsBox();
    setArgumentsBoxEnabled(true);
    setArgumentsBoxPdf(true);
    setPdfRunCallback(handlePdfConversion);
    return;
  }

  // Load stored preferences before doing any work
  let stored: Record<string, unknown>;
  try {
    if (!chrome?.storage?.local) return;
    stored = await chrome.storage.local.get("preferences");
  } catch {
    // Extension context invalidated mid-init (reload/update)
    return;
  }
  const prefs = stored?.preferences;

  // Always start in overview mode on page load for stability.
  // Mode is not restored from storage — the user switches manually after load.
  // (Restoring caused cross-tab interference and unpredictable state on refresh.)
  if (prefs?.depth_context_mode) {
    currentContextMode = prefs.depth_context_mode as UserContextMode;
  }
  if (prefs?.depth_context_note) {
    currentContextNote = prefs.depth_context_note;
  }
  // currentMode defaults to "overview" (line 315), visibleTypes to overview types (line 317)
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

  if (isDomainWhitelisted(currentDomain, enabledSites)) {
    siteWhitelisted = true;
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

  // ── React-safe anchor guard ──
  // On React-based sites clicking UI controls outside the annotated content
  // region can trigger React re-renders.  Pre-emptively strip anchors in the
  // capture phase and re-render after the layout settles.
  startAnchorGuard();
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
    pendingRegions.delete(`overview:${previousHash}`);
    pendingRegions.delete(`depth:${previousHash}`);
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

  // Use mode-prefixed pending key so that a stale-while-revalidate response
  // from a DIFFERENT mode cannot steal this mode's pending state.
  const reqMode = currentMode as AnnotationMode;
  const pendingKey = `${reqMode}:${contentHash}`;

  if (annotatedRegions.has(contentHash) || pendingRegions.has(pendingKey))
    return;

  // Store hash on the region element so manual annotations can reuse it
  (region.element as HTMLElement).dataset.oddityHash = contentHash;

  // Map hash → region so renderAnnotations can find the element
  regionByHash.set(contentHash, region);

  // Request annotations from service worker
  pendingRegions.add(pendingKey);
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
        url: getPageUrl(),
        regionId: region.id,
        contentHash,
        text: extracted.text,
        mode: currentMode as AnnotationMode,
        userContext: { mode: currentContextMode, note: currentContextNote || undefined } as UserContext,
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
      pendingRegions.delete(pendingKey);
      if (isLong) longWaitManager.completeWithoutAnnotations(contentHash);
    }
  } catch (err) {
    const errStr = String(err);
    // Chrome closes the sendMessage channel when the service worker responds
    // via sendToTab instead of sendResponse. This is expected in our streaming
    // pattern — annotations still arrive via sendToTab, so don't clean up.
    if (errStr.includes("message channel closed") || errStr.includes("message port closed")) {
      console.debug(`[Oddity 1] Message channel closed (expected during streaming)`);
      return;
    }
    if (errStr.includes("Auth") || errStr.includes("401")) {
      console.warn(
        "[Oddity 1] Not signed in — open the Oddity extension to sign in",
      );
      showAuthToast();
    } else {
      console.error(`[Oddity 1] Annotation request error:`, err);
    }
    pendingRegions.delete(pendingKey);
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
        url: getPageUrl(),
        regionId: region.id,
        contentHash,
        text: extracted.text,
        mode: requestMode,
        userContext: { mode: currentContextMode, note: currentContextNote || undefined } as UserContext,
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
    // Chrome closes the sendMessage channel when the service worker responds
    // via sendToTab instead of sendResponse. This is expected in our streaming
    // pattern — annotations still arrive via sendToTab, so don't clean up.
    if (errStr.includes("message channel closed") || errStr.includes("message port closed")) {
      console.debug(`[Oddity 1] Message channel closed (expected during streaming)`);
      return;
    }
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
    payload: { url: getPageUrl() },
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
  setAnnotationsPreservingUserWritten(predAnnStore, regionId, prediction.annotations);
  setFeedbackPreservingLocal(predFbStore, regionId, prediction.feedback ?? []);
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
      url: getPageUrl(),
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
 * Check if a Range overlaps with any already-injected anchor spans in the DOM.
 * Uses Selection/Range intersection: if the range contains (or is contained by)
 * any existing anchor span, they overlap.
 */
/**
 * Find the nearest block-level ancestor of a node.
 */
function nearestBlock(node: Node): Element {
  let el: Element | null =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  while (el && el !== document.body && el !== document.documentElement) {
    try {
      const display = getComputedStyle(el).display;
      if (
        display === "block" ||
        display === "list-item" ||
        display === "flex" ||
        display === "grid" ||
        display === "table-cell"
      ) {
        return el;
      }
    } catch {
      // getComputedStyle can fail for detached nodes
    }
    el = el.parentElement;
  }
  return document.body;
}

function rangeOverlapsExistingAnchors(range: Range, root: Element): boolean {
  // Query all anchor spans anywhere in the document (handles cross-region overlap)
  const anchors = (root === document.body ? root : document.body).querySelectorAll("[data-oddity-id]");

  // Get the new range's bounding rect and block ancestor for proximity check
  const newRect = range.getBoundingClientRect();
  const newBlock = nearestBlock(range.startContainer);

  const seenIds = new Set<string>();
  for (const anchor of anchors) {
    try {
      if (!anchor.isConnected) continue;
      const anchorRange = document.createRange();
      anchorRange.selectNodeContents(anchor);

      // 1. Geometric overlap check
      const aEndVsBStart = range.compareBoundaryPoints(Range.END_TO_START, anchorRange);
      const bEndVsAStart = anchorRange.compareBoundaryPoints(Range.END_TO_START, range);
      if (aEndVsBStart > 0 && bEndVsAStart > 0) return true;

      // 2. Same-sentence proximity check (one per annotation ID)
      const id = anchor.getAttribute("data-oddity-id");
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      // Skip if they're in different block containers (different paragraphs)
      const anchorBlock = nearestBlock(anchor);
      if (anchorBlock !== newBlock) continue;

      // Same block — check if their vertical positions overlap (same line cluster)
      const anchorRect = anchor.getBoundingClientRect();
      if (anchorRect.height === 0 || newRect.height === 0) continue;
      const verticalOverlap =
        newRect.top < anchorRect.bottom + 4 &&
        anchorRect.top < newRect.bottom + 4;
      if (verticalOverlap) return true;
    } catch {
      // Skip detached or incomparable nodes
    }
  }

  return false;
}

/** Resolve chunk boundary anchors to DOM ranges for brace rendering. */
function resolveChunkRange(root: Element, annotation: Annotation): ChunkRange | null {
  if (!annotation.chunk) return null;
  const startRange = resolveSelector(root, annotation.chunk.start);
  const endRange = resolveSelector(root, annotation.chunk.end);
  if (!startRange || !endRange) return null;
  // Build a full range spanning the entire chunk (start of first word → end of last word)
  try {
    const fullRange = document.createRange();
    fullRange.setStart(startRange.startContainer, startRange.startOffset);
    fullRange.setEnd(endRange.endContainer, endRange.endOffset);
    return { startRange, endRange, fullRange };
  } catch {
    return { startRange, endRange, fullRange: null };
  }
}

function renderAnnotations(regionId: string, annotations: Annotation[]): void {
  const region =
    regionByHash.get(regionId) ?? regions.find((r) => r.id === regionId);
  const root = region?.element ?? document.body;

  // Guard: skip if the root element has been detached from the DOM (common on SPAs like ChatGPT)
  if (root !== document.body && !root.isConnected) {
    console.debug(`[Oddity 1] Skipping render for ${regionId.slice(0, 12)}… — element detached`);
    return;
  }

  const feedback = effectiveFeedbackMap().get(regionId) ?? [];

  // Filter visible types first
  const visible = annotations.filter((a) => visibleTypes.includes(a.type));

  // Sort: background-type annotations first (core_claim, insight), line-type next,
  // user_written last (renders on top, bypasses overlap detection)
  const backgroundTypes = new Set<AnnotationType>(["core_claim", "insight"]);
  visible.sort((a, b) => {
    if (a.type === "user_written" && b.type !== "user_written") return 1;
    if (b.type === "user_written" && a.type !== "user_written") return -1;
    const aIsBg = backgroundTypes.has(a.type) ? 0 : 1;
    const bIsBg = backgroundTypes.has(b.type) ? 0 : 1;
    return aIsBg - bIsBg;
  });

  // Invalidate text-node index once before the batch — ensures a clean index.
  invalidateTextNodeIndex(root);

  // Render one annotation at a time. Before each, check if its resolved range
  // overlaps with any already-injected anchor spans in the DOM. This handles
  // both within-region and cross-region overlap robustly.
  for (const annotation of visible) {
    try {
      const range = resolveSelector(root, annotation.anchor);
      if (!range) {
        console.debug(
          `[Oddity 1] Could not resolve selector for annotation ${annotation.id} — text may have changed or not yet rendered`,
        );
        continue;
      }

      // Skip if this range overlaps with any already-rendered anchor span
      // (user_written notes always render — the user explicitly created them)
      if (annotation.type !== "user_written" && rangeOverlapsExistingAnchors(range, root)) continue;

      let anchors = injectAnchors(annotation, range);

      // injectAnchors mutates the DOM (splits/wraps text nodes), so invalidate
      // the text-node index immediately. This ensures the NEXT annotation's
      // resolveSelector + overlap check operates on fresh DOM state.
      if (anchors.length > 0) {
        invalidateTextNodeIndex(root);
      }

      // Retry once if injection produced no spans (stale index before first call).
      if (anchors.length === 0) {
        invalidateTextNodeIndex(root);
        const retryRange = resolveSelector(root, annotation.anchor);
        if (retryRange) {
          // Re-check overlap after index invalidation
          if (annotation.type !== "user_written" && rangeOverlapsExistingAnchors(retryRange, root)) continue;
          anchors = injectAnchors(annotation, retryRange);
          if (anchors.length > 0) {
            invalidateTextNodeIndex(root);
          }
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
      const chunkRng = resolveChunkRange(root, annotation);
      addMarginNote(
        annotation,
        stableRange,
        noteFeedback,
        handleAnnotationDeleted,
        regionId,
        chunkRng,
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

function switchMode(newMode: ViewMode, newContextMode?: UserContextMode, newContextNote?: string): void {
  // Cancel any pending anchor guard re-render — switchMode handles its own rendering
  if (anchorGuardRerenderTimer) {
    clearTimeout(anchorGuardRerenderTimer);
    anchorGuardRerenderTimer = null;
  }

  // Clear current rendering
  clearOverlay();
  clearAllAnchors();
  clearMarginNotes();

  // Invalidate text-node index for all regions — clearAllAnchors mutates the
  // DOM (unwraps spans, normalizes text nodes) which makes cached indices stale.
  for (const region of regions) invalidateTextNodeIndex(region.element);
  for (const region of regionByHash.values()) invalidateTextNodeIndex(region.element);

  // Update state
  currentMode = newMode;
  setMarginNoteMode(newMode);
  if (newContextMode !== undefined) currentContextMode = newContextMode;
  if (newContextNote !== undefined) currentContextNote = newContextNote;

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
      // Stagger requests to avoid burst rate limiting
      for (let i = 0; i < regions.length; i++) {
        const region = regions[i]!;
        const delay = i * 500;
        if (needsOverview) {
          if (i === 0) handleStableRegionForMode(region, region.element, "overview");
          else setTimeout(() => handleStableRegionForMode(region, region.element, "overview"), delay);
        }
        if (needsDepth) {
          // Offset depth requests by 250ms from overview to interleave
          const depthDelay = delay + (needsOverview ? 250 : 0);
          if (depthDelay === 0) handleStableRegionForMode(region, region.element, "depth");
          else setTimeout(() => handleStableRegionForMode(region, region.element, "depth"), depthDelay);
        }
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

      // Don't sync arguments box here — streaming annotations don't add
      // argument items (only feedback does). Syncing on every annotation
      // causes the box to rebuild repeatedly, glitching replies and UI state.
      // The final "annotationsReady" message handles the sync.

      // Skip rendering if disabled or type is not visible in current mode
      if (!enabled || !visibleTypes.includes(annotation.type)) break;

      const streamRegion =
        regionByHash.get(streamRegionId) ??
        regions.find((r) => r.id === streamRegionId);
      const streamRoot = streamRegion?.element ?? document.body;

      // Skip if the element has been detached (common on SPAs like ChatGPT)
      if (streamRoot !== document.body && !streamRoot.isConnected) break;

      // Render the single annotation immediately (with overlap check)
      try {
        // Invalidate stale text-node index — prior anchor injections or
        // clearAllAnchors during mode switch may have mutated the DOM.
        invalidateTextNodeIndex(streamRoot);
        const range = resolveSelector(streamRoot, annotation.anchor);
        if (range) {
          // Check if this range overlaps with any existing anchor spans
          if (rangeOverlapsExistingAnchors(range, streamRoot)) {
            // Store the annotation but skip rendering — it will be deduped on full re-render
            break;
          }

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
          // Invalidate stale text-node index after anchor injection so
          // chunk boundary selectors can resolve against current DOM.
          invalidateTextNodeIndex(streamRoot);
          const streamChunkRng = resolveChunkRange(streamRoot, annotation);
          addMarginNote(
            annotation,
            stableRange,
            noteFeedback,
            handleAnnotationDeleted,
            streamRegionId,
            streamChunkRng,
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
        setAnnotationsPreservingUserWritten(responseAnnStore, regionId, annotations);
        setFeedbackPreservingLocal(responseFbStore, regionId, feedback);
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
      setFeedbackPreservingLocal(responseFbStore, regionId, feedback);

      const hadStreaming = streamedRegions.has(regionId);
      streamedRegions.delete(regionId);
      setAnnotationsPreservingUserWritten(responseAnnStore, regionId, annotations);
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
        depthContextMode: newContextMode,
        depthContextNote: newContextNote,
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
      const contextChanged = newContextMode !== currentContextMode || (newContextNote ?? "") !== currentContextNote;
      enabled = newEnabled;
      visibleTypes = newVisibleTypes.length > 0 ? newVisibleTypes : [
        ...(viewMode === "all" ? ALL_ANNOTATION_TYPES : viewMode === "overview" ? ALL_OVERVIEW_TYPES : ALL_DEPTH_TYPES),
        "user_written",
      ];

      console.log(
        `[Oddity 1] Settings updated — enabled: ${enabled}, mode: ${viewMode}, contextMode: ${newContextMode}`,
      );

      setArgumentsBoxEnabled(enabled);

      if (!enabled) {
        setOverlayVisible(false);
        setMarginNotesVisible(false);
        clearAllAnchors();
        longWaitManager.reset();
      } else if (modeChanged) {
        // Mode changed: switch annotation display
        switchMode(viewMode, newContextMode, newContextNote);
      } else if (contextChanged) {
        // Context only affects depth annotations — preserve user-written notes and their feedback
        currentContextMode = newContextMode;
        currentContextNote = newContextNote ?? "";
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

        // Only clear depth (context mode doesn't affect overview)
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

        // Re-render existing overview annotations immediately (they were cleared above)
        rerenderAll();

        // Fire new depth requests with the updated context — staggered to avoid rate limits
        for (let i = 0; i < regions.length; i++) {
          const region = regions[i]!;
          if (i === 0) {
            handleStableRegionForMode(region, region.element, "depth");
          } else {
            // Stagger subsequent requests by 500ms each to avoid burst rate limiting
            const delay = i * 500;
            setTimeout(() => handleStableRegionForMode(region, region.element, "depth"), delay);
          }
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
            const stored = chrome?.storage?.local ? await chrome.storage.local.get("preferences") : {};
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
      const stored = chrome?.storage?.local ? await chrome.storage.local.get("preferences") : {};
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
  const { annotationId, itemType } = e.detail;
  if (!annotationId) return;

  // 1. Fast path: anchor span exists in the DOM
  const anchor = document.querySelector(`[data-oddity-id="${CSS.escape(annotationId)}"]`);
  if (anchor) {
    anchor.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  // 2. Fallback: resolve the annotation's selector against known regions
  //    (anchor span may not exist if annotation is from the other mode,
  //     failed overlap detection, or the page re-rendered its content)
  let found: Annotation | undefined;
  for (const store of [overviewAnnotations, depthAnnotations]) {
    for (const [, anns] of store) {
      const match = anns.find((a) => a.id === annotationId);
      if (match) { found = match; break; }
    }
    if (found) break;
  }
  if (found) {
    for (const region of regionByHash.values()) {
      const range = resolveSelector(region.element, found.anchor);
      if (range) {
        const rects = range.getClientRects();
        if (rects.length > 0) {
          const targetY = rects[0]!.top + window.scrollY - window.innerHeight / 2;
          window.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });
          return;
        }
      }
    }
  }

  // 3. Could not resolve — show toast
  if (itemType === "reply") {
    document.dispatchEvent(
      new CustomEvent("oddity:scroll-to-annotation-missing", {
        detail: { isReply: true },
      }),
    );
  } else {
    document.dispatchEvent(
      new CustomEvent("oddity:scroll-to-annotation-missing"),
    );
  }
}) as EventListener);

document.addEventListener("oddity:annotation-deleted", (e) => {
  const { annotationId } = (e as CustomEvent<{ annotationId: string }>).detail;
  handleAnnotationDeleted(annotationId);
});

// ─── Feedback Added Sync ───
// When a user submits a reply/reaction, the saved feedback must be added
// to the in-memory stores so that syncArgumentsBox() doesn't lose it.

window.addEventListener("oddity:feedback-added", (e) => {
  const { feedback, contentHash } = (e as CustomEvent<{
    feedback: AnnotationFeedback;
    contentHash: string;
  }>).detail;
  if (!feedback?.id || !contentHash) return;

  // Add to both feedback stores so it survives mode switches
  for (const store of [overviewFeedback, depthFeedback]) {
    const list = store.get(contentHash) ?? [];
    if (!list.some((f) => f.id === feedback.id)) {
      list.push(feedback);
      store.set(contentHash, list);
    }
  }
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

const CONTEXT_MODE_LABELS: Record<string, string> = {
  "info-takeaway": "Info Takeaway",
  "brainstorm": "Brainstorm",
  "argument-formation": "Argument",
  "decision": "Decision",
  "learning": "Learning",
};

document.addEventListener("oddity:modeChange", async (e) => {
  const { mode } = (e as CustomEvent<{ mode: ViewMode }>).detail;
  if (mode === currentMode) return;

  // Dismiss context popup if switching away while it's open
  hideContextPopup();

  // Show context popup on first depth switch this page
  if ((mode === "depth" || mode === "all") && !hasShownContextPopupThisPage) {
    hasShownContextPopupThisPage = true;
    const result = await showContextPopup(currentContextMode, currentContextNote);
    if (result) {
      currentContextMode = result.mode;
      currentContextNote = result.note;
      updateContextLink(CONTEXT_MODE_LABELS[result.mode]);
      // Persist context to storage
      if (chrome?.storage?.local) {
        chrome.storage.local.get("preferences", (r) => {
          const prefs = (r["preferences"] ?? {}) as Record<string, unknown>;
          chrome.storage.local.set({
            preferences: { ...prefs, depth_context_mode: result.mode, depth_context_note: result.note },
          });
        });
      }
    }
    // Show context link even if skipped
    updateContextLink(currentContextMode ? CONTEXT_MODE_LABELS[currentContextMode] : undefined);
  }

  // Persist mode to storage so the service worker broadcasts settingsUpdated
  if (chrome?.storage?.local) {
    chrome.storage.local.get("preferences", (result) => {
      const prefs = (result["preferences"] ?? {}) as Record<string, unknown>;
      const modeTypes = mode === "all"
        ? ALL_ANNOTATION_TYPES
        : mode === "overview" ? ALL_OVERVIEW_TYPES : ALL_DEPTH_TYPES;
      chrome.storage.local.set({
        preferences: { ...prefs, annotation_mode: mode, visible_types: [...modeTypes, "user_written"] },
      });
    });
  }

  switchMode(mode);
});

// ─── Change Context (re-open popup from arguments-box link) ───

document.addEventListener("oddity:openContextPopup", async () => {
  const previousMode = currentContextMode;
  const result = await showContextPopup(currentContextMode, currentContextNote);
  if (result) {
    currentContextMode = result.mode;
    currentContextNote = result.note;
    updateContextLink(CONTEXT_MODE_LABELS[result.mode]);
    if (chrome?.storage?.local) {
      chrome.storage.local.get("preferences", (r) => {
        const prefs = (r["preferences"] ?? {}) as Record<string, unknown>;
        chrome.storage.local.set({
          preferences: { ...prefs, depth_context_mode: result.mode, depth_context_note: result.note },
        });
      });
    }

    // If context actually changed and we're in depth/all mode, re-fire depth annotations
    if (result.mode !== previousMode && (currentMode === "depth" || currentMode === "all")) {
      // Clear existing depth data so switchMode treats it as fresh
      depthAnnotations.clear();
      depthFeedback.clear();
      depthGenerated.clear();
      annotatedRegions.clear();
      pendingRegions.clear();
      pendingModeByHash.clear();
      streamedRegions.clear();
      longWaitManager.reset();

      // Clear rendered depth annotations and re-trigger
      clearOverlay();
      clearAllAnchors();
      clearMarginNotes();
      for (const region of regions) invalidateTextNodeIndex(region.element);

      for (const region of regions) {
        handleStableRegionForMode(region, region.element, "depth");
      }
    }
  }
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
