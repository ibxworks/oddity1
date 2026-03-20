import type {
  Annotation,
  AnnotationFeedback,
  AnnotationFont,
  AnnotationFontSize,
  AnnotationType,
  ViewMode,
} from "@oddity/shared";
import { ANNOTATION_LABELS, getAnnotationColor } from "@oddity/shared";
import { sendMessage } from "../../shared/messaging.js";
import { getPageUrl } from "../page-url.js";
import { removeAnchors } from "./anchors.js";
import { addLiveFeedback, updateLiveFeedbackId } from "./arguments-box.js";
import {
  deemphasizeAnnotation,
  emphasizeAnnotation,
  removeAnnotation as removeAnnotationOverlay,
} from "./overlay.js";
import {
  getThemeMode,
  offThemeChange,
  onThemeChange,
} from "./theme-detector.js";

// ─── Types ───

type MarginNote = {
  id: string;
  annotation: Annotation;
  range: Range;
  /** The content region this note was anchored to at creation time. */
  region: Element;
  side: "left" | "right";
  anchorTopPx: number;
  topPx: number;
  height: number;
  collapsedHeight: number;
  element: HTMLDivElement;
};

type InlinePopover = {
  id: string;
  annotation: Annotation;
  range: Range;
  element: HTMLDivElement;
  visible: boolean;
};


// ─── State ───

let hostEl: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let regionEl: Element | null = null;
let notes: MarginNote[] = [];
let noteIndex = 0;
let visible = true;
let hiddenTypes = new Set<AnnotationType>();
let expandedId: string | null = null;
let pinnedId: string | null = null;
let collapseTimer: ReturnType<typeof setTimeout> | null = null;
let anchorHoverTimer: ReturnType<typeof setTimeout> | null = null;
let needsRedraw = false;
let fontLink: HTMLLinkElement | null = null;
let themeHandler: ((mode: "light" | "dark") => void) | null = null;
let docClickHandler: ((e: MouseEvent) => void) | null = null;
let justUnpinned = false;
let justPinnedFromCard = false;
let userName: string | null = null;
let sharedContentRight = 0;
let sharedContentLeftViewport = 0;
let timelineLineEl: HTMLDivElement | null = null;

// ─── Inline Popover State (Depth mode) ───
let currentAnnotationMode: ViewMode = "overview";
let inlinePopovers: Map<string, InlinePopover> = new Map();

// ─── Page Dim State (Overview mode) ───
let pageDimOverlay: HTMLDivElement | null = null;
let dimmedAnnotationId: string | null = null;
let inlineShowTimer: ReturnType<typeof setTimeout> | null = null;
let inlineHideTimer: ReturnType<typeof setTimeout> | null = null;
let inlineHoveredId: string | null = null;
let mouseInInlinePopover = false;
let mouseInAnchor = false;
let inlineHoverExpandTimer: ReturnType<typeof setTimeout> | null = null;

const NOTE_EXPANDED_WIDTH = 286;
const NOTE_GAP = 10;
const MARGIN_PADDING = 16;
const NOTE_MIN_WIDTH = NOTE_EXPANDED_WIDTH / 2;
const MIN_MARGIN_WIDTH = NOTE_MIN_WIDTH;

const FONT_MAP: Record<AnnotationFont, string> = {
  default: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  fraunces: "'Fraunces', Georgia, serif",
  kalam: "'Kalam', cursive, system-ui, sans-serif",
  helvetica: "Helvetica, 'Helvetica Neue', Arial, sans-serif",
  arial: "Arial, 'Helvetica Neue', sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
};
const SIZE_MAP: Record<AnnotationFontSize, string> = {
  small: "12px",
  default: "14px",
  large: "16px",
};

// ─── Public API ───

export function initMarginNotes(region: Element): void {
  regionEl = region;

  // Load Kalam font globally (font-face is always global, shadow DOM elements reference by name)
  if (!fontLink) {
    fontLink = document.createElement("link");
    fontLink.rel = "stylesheet";
    fontLink.href =
      "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;1,9..144,400&family=Inter:wght@300;400;500;600;700&family=Kalam:wght@400&display=swap";
    document.head.appendChild(fontLink);
  }

  if (hostEl) return;

  hostEl = document.createElement("div");
  hostEl.id = "oddity-margin-notes";
  hostEl.style.cssText =
    "position: absolute; top: 0; left: 0; width: 100%; pointer-events: none; z-index: 2147483645;";
  // Stop keyboard events from leaking to the host page
  for (const evt of [
    "keydown",
    "keyup",
    "keypress",
    "input",
    "beforeinput",
  ] as const) {
    hostEl.addEventListener(evt, (e) => e.stopPropagation());
  }
  document.body.appendChild(hostEl);

  shadowRoot = hostEl.attachShadow({ mode: "closed" });

  // Theme detection
  hostEl.dataset.theme = getThemeMode();
  themeHandler = (mode) => {
    if (hostEl) hostEl.dataset.theme = mode;
  };
  onThemeChange(themeHandler);

  const style = document.createElement("style");
  style.textContent = MARGIN_NOTES_CSS;
  shadowRoot.appendChild(style);

  // Timeline line disabled for now
  timelineLineEl = null;

  // Apply initial font/size from stored preferences
  chrome.storage.local.get("preferences", (result) => {
    const prefs = result["preferences"];
    if (prefs) {
      updateMarginNotesStyle(prefs.annotation_font, prefs.annotation_font_size);
    }
  });

  // Unpin on any click outside a card/anchor
  docClickHandler = (e: MouseEvent) => {
    // The card's click handler sets justPinnedFromCard synchronously;
    // the document handler fires in the same event dispatch.  Skip unpin
    // so the freshly-pinned card stays open.
    if (justPinnedFromCard) return;
    const target = e.target as Node;
    if ((target as Element).closest?.("[data-oddity-id]")) return;
    if (pinnedId) unpinAll();
  };
  document.addEventListener("click", docClickHandler);

  startTracking();

  // Sync edits/deletes from argument box to margin note reply bubbles
  document.addEventListener("oddity:feedback-edited", ((e: CustomEvent) => {
    const { feedbackId, replyText } = e.detail;
    if (!shadowRoot) return;
    const bubble = shadowRoot.querySelector(
      `.note-reply-bubble[data-feedback-id="${feedbackId}"]`,
    );
    if (bubble) bubble.textContent = replyText;
  }) as EventListener);

  document.addEventListener("oddity:feedback-deleted", ((e: CustomEvent) => {
    const { feedbackId, annotationId } = e.detail;
    if (!shadowRoot) return;
    // Remove reply bubble if present
    const bubble = shadowRoot.querySelector(`.note-reply-bubble[data-feedback-id="${feedbackId}"]`);
    if (bubble) bubble.remove();
    // Deactivate thumbs pill and remove reaction badge on the source margin note
    if (annotationId) {
      const noteEl = shadowRoot.querySelector(`.oddity-note[data-annotation-id="${annotationId}"]`);
      if (noteEl) {
        noteEl.dispatchEvent(new Event("oddity:reset-reaction"));
        const badge = noteEl.querySelector(".note-reaction-badge");
        if (badge) badge.remove();
      }
    }
  }) as EventListener);

  // Fetch user profile for name badge on manual annotations
  sendMessage({ action: "getProfile" } as any)
    .then((p: any) => {
      userName = p?.display_name?.split(" ")[0] ?? null;
    })
    .catch(() => {});
}

export function setMarginNoteMode(mode: ViewMode): void {
  currentAnnotationMode = mode;
}

export function addMarginNote(
  annotation: Annotation,
  range: Range,
  feedback: AnnotationFeedback[] = [],
  onDelete?: (annotationId: string) => void,
  contentHash?: string,
): void {
  if (!shadowRoot || !regionEl) return;

  // In overview/depth mode, use inline popovers (hover-to-show)
  // In "all" mode, depth annotations also use inline popovers; overview annotations use margin notes
  const useInlinePopover = annotation.type !== "user_written" && (
    currentAnnotationMode === "depth" ||
    currentAnnotationMode === "overview" ||
    (currentAnnotationMode === "all" && annotation.mode === "depth")
  );
  if (useInlinePopover) {
    addInlinePopover(annotation, range, feedback, onDelete, contentHash);
    return;
  }

  // Deduplicate: skip if a note for this annotation already exists
  if (notes.some((n) => n.id === annotation.id)) return;

  const rects = range.getClientRects();
  if (rects.length === 0) return;

  const anchorTopPx = rects[0]!.top + window.scrollY;

  // Snapshot the region for this note — each note keeps its own reference
  // so multi-response chat pages position correctly per response.
  const noteRegion = regionEl;

  // Always place notes on the left margin
  const bounds = getContentBounds(noteRegion, range);
  const leftMarginWidth = bounds.left - MARGIN_PADDING;

  if (leftMarginWidth < MIN_MARGIN_WIDTH) {
    // Left margin too narrow — skip this note
    noteIndex++;
    return;
  }

  const side: "left" | "right" = "left";

  noteIndex++;

  // Resolve content hash: prefer explicit param, then region's hash, then first hash on page
  const resolvedHash =
    contentHash ??
    (noteRegion as HTMLElement).dataset?.oddityHash ??
    document
      .querySelector("[data-oddity-hash]")
      ?.getAttribute("data-oddity-hash") ??
    "";

  const el = createNoteElement(
    annotation,
    side,
    feedback,
    onDelete,
    resolvedHash,
  );
  shadowRoot.appendChild(el);

  const note: MarginNote = {
    id: annotation.id,
    annotation,
    range,
    region: noteRegion,
    side,
    anchorTopPx,
    topPx: anchorTopPx,
    height: 0,
    collapsedHeight: 0,
    element: el,
  };

  notes.push(note);

  // Measure height in next frame, then resolve overlaps
  requestAnimationFrame(() => {
    note.height = el.offsetHeight;
    note.collapsedHeight = el.offsetHeight;
    resolveOverlaps();
    applyPositions();
  });
}

// ─── Inline Popover (Depth mode) ───

function addInlinePopover(
  annotation: Annotation,
  range: Range,
  feedback: AnnotationFeedback[] = [],
  onDelete?: (annotationId: string) => void,
  contentHash?: string,
): void {
  if (!shadowRoot) return;
  // Deduplicate
  if (inlinePopovers.has(annotation.id)) return;

  const rects = range.getClientRects();
  if (rects.length === 0) return;

  const noteRegion = regionEl;

  // Resolve content hash
  const resolvedHash = contentHash
    ?? (noteRegion as HTMLElement)?.dataset?.oddityHash
    ?? document.querySelector("[data-oddity-hash]")?.getAttribute("data-oddity-hash")
    ?? "";

  const el = createNoteElement(annotation, "left", feedback, onDelete, resolvedHash);
  el.classList.add("oddity-note--inline");

  // Overview: strip expanded content (buttons, thoughts, replies) and show full text
  if (currentAnnotationMode === "overview") {
    el.classList.add("oddity-note--overview");
    const expandedContent = el.querySelector(".note-expanded-content");
    if (expandedContent) expandedContent.remove();
  }

  // Override the default margin-note hover/click handlers on the card element.
  // The card's built-in mouseenter/mouseleave/click (from createNoteElement) still
  // work for internal interactions (buttons, inputs), but we add inline-specific
  // hover bridge behavior.
  el.addEventListener("mouseenter", () => {
    mouseInInlinePopover = true;
    cancelInlineHide();
    emphasizeAnnotation(annotation.id);
    // Depth only: expand after a short delay on hover
    if (currentAnnotationMode !== "overview" && !pinnedId && expandedId !== annotation.id) {
      if (inlineHoverExpandTimer) clearTimeout(inlineHoverExpandTimer);
      inlineHoverExpandTimer = setTimeout(() => {
        inlineHoverExpandTimer = null;
        if (mouseInInlinePopover && !pinnedId) {
          expandInlinePopover(annotation.id, false);
          emphasizeAnnotation(annotation.id);
        }
      }, 200);
    }
  });
  el.addEventListener("mouseleave", () => {
    mouseInInlinePopover = false;
    if (inlineHoverExpandTimer) {
      clearTimeout(inlineHoverExpandTimer);
      inlineHoverExpandTimer = null;
    }
    if (!pinnedId) {
      // Depth: collapse if expanded via hover (not pinned)
      if (currentAnnotationMode !== "overview") {
        const popover = inlinePopovers.get(annotation.id);
        if (popover && expandedId === annotation.id) {
          popover.element.classList.remove("expanded");
          expandedId = null;
          deemphasizeAnnotation();
          requestAnimationFrame(() => positionInlinePopover(popover));
        }
        scheduleInlineHide();
      } else {
        // Overview: schedule hide-all
        deemphasizeAnnotation();
        scheduleInlineHideAll();
      }
    }
  });
  // Click on the inline popover itself pins/unpins
  el.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, input, textarea, a, .note-feedback-pill, .note-icon-btn, .note-reply-input")) return;
    e.stopPropagation();
    if (pinnedId === annotation.id) {
      unpinInlinePopover();
    } else {
      justPinnedFromCard = true;
      setTimeout(() => { justPinnedFromCard = false; }, 0);
      if (currentAnnotationMode === "overview") {
        // Overview: pin + dim page, no card expansion
        pinnedId = annotation.id;
        hostEl?.classList.add("has-pinned");
        dimPage(annotation.id);
        emphasizeAnnotation(annotation.id);
        // Keep all popovers visible
        showAllInlinePopovers();
      } else {
        expandInlinePopover(annotation.id);
        emphasizeAnnotation(annotation.id);
      }
    }
  });

  const popover: InlinePopover = {
    id: annotation.id,
    annotation,
    range,
    element: el,
    visible: false,
  };

  inlinePopovers.set(annotation.id, popover);
}

function showInlinePopover(annotationId: string): void {
  if (!shadowRoot) return;
  const popover = inlinePopovers.get(annotationId);
  if (!popover) return;

  // Cancel any pending hide
  cancelInlineHide();
  cancelInlineShow();

  inlineHoveredId = annotationId;

  inlineShowTimer = setTimeout(() => {
    inlineShowTimer = null;
    if (!shadowRoot || !popover) return;

    // Hide any other visible inline popover (not pinned)
    if (!pinnedId) {
      for (const [id, p] of inlinePopovers) {
        if (id !== annotationId && p.visible) {
          p.element.remove();
          p.visible = false;
          p.element.classList.remove("expanded");
        }
      }
    }

    if (!popover.visible) {
      shadowRoot.appendChild(popover.element);
      popover.visible = true;
    }

    positionInlinePopover(popover);
  }, 150);
}

function hideInlinePopover(annotationId?: string): void {
  scheduleInlineHide(annotationId);
}

function scheduleInlineHide(annotationId?: string): void {
  cancelInlineHide();
  inlineHideTimer = setTimeout(() => {
    inlineHideTimer = null;
    if (mouseInInlinePopover || mouseInAnchor || pinnedId) return;

    if (annotationId) {
      const popover = inlinePopovers.get(annotationId);
      if (popover && popover.visible) {
        popover.element.remove();
        popover.visible = false;
        popover.element.classList.remove("expanded");
      }
    } else if (inlineHoveredId) {
      const popover = inlinePopovers.get(inlineHoveredId);
      if (popover && popover.visible) {
        popover.element.remove();
        popover.visible = false;
        popover.element.classList.remove("expanded");
      }
    }

    inlineHoveredId = null;
  }, 300);
}

/** Overview mode: hide ALL non-pinned popovers after a delay. */
function scheduleInlineHideAll(): void {
  cancelInlineHide();
  inlineHideTimer = setTimeout(() => {
    inlineHideTimer = null;
    if (mouseInInlinePopover || mouseInAnchor || pinnedId) return;
    hideAllInlinePopovers();
  }, 300);
}

function cancelInlineShow(): void {
  if (inlineShowTimer !== null) {
    clearTimeout(inlineShowTimer);
    inlineShowTimer = null;
  }
}

function cancelInlineHide(): void {
  if (inlineHideTimer !== null) {
    clearTimeout(inlineHideTimer);
    inlineHideTimer = null;
  }
}

function expandInlinePopover(annotationId: string, pin = true): void {
  const popover = inlinePopovers.get(annotationId);
  if (!popover) return;

  // Show the popover if not already visible
  if (!popover.visible && shadowRoot) {
    cancelInlineShow();
    cancelInlineHide();
    shadowRoot.appendChild(popover.element);
    popover.visible = true;
    positionInlinePopover(popover);
  }

  // Collapse any other expanded inline popover.
  // In overview mode with pin, keep others visible but collapsed.
  for (const [id, p] of inlinePopovers) {
    if (id !== annotationId && p.visible) {
      p.element.classList.remove("expanded");
      if (pin && currentAnnotationMode !== "overview") {
        p.element.remove();
        p.visible = false;
      }
    }
  }

  if (pin) {
    pinnedId = annotationId;
    hostEl?.classList.add("has-pinned");
    // Overview: ensure all popovers are visible (collapsed) alongside the pinned one
    if (currentAnnotationMode === "overview") {
      showAllInlinePopovers();
    }
  }
  // Overview has no expanded state on the card — only depth expands
  if (currentAnnotationMode !== "overview") {
    popover.element.classList.add("expanded");
    expandedId = annotationId;
  }

  // Overview: dim the page when pinned
  if (currentAnnotationMode === "overview") {
    dimPage(annotationId);
  }

  // Reposition after expansion (content may change height)
  requestAnimationFrame(() => positionInlinePopover(popover));
}

function unpinInlinePopover(): void {
  const id = pinnedId;
  pinnedId = null;
  expandedId = null;
  hostEl?.classList.remove("has-pinned");
  justUnpinned = true;
  setTimeout(() => { justUnpinned = false; }, 0);

  if (id) {
    const popover = inlinePopovers.get(id);
    if (popover && popover.visible) {
      popover.element.classList.remove("expanded");
    }
  }

  // Overview: remove page dim and hide ALL popovers (unless still hovering)
  if (currentAnnotationMode === "overview") {
    undimPage();
    if (!mouseInAnchor && !mouseInInlinePopover) {
      hideAllInlinePopovers();
    } else {
      // Still hovering – keep all visible in show-all mode
      showAllInlinePopovers(inlineHoveredId ?? undefined);
    }
  } else {
    // Depth: hide just the unpinned popover
    if (id && !mouseInAnchor && !mouseInInlinePopover) {
      scheduleInlineHide(id);
    }
  }
  undimAllNotes();
  deemphasizeAnnotation();
}

function positionInlinePopover(popover: InlinePopover): void {
  const rects = popover.range.getClientRects();
  if (rects.length === 0) return;

  const firstRect = rects[0]!;
  const lastRect = rects[rects.length - 1]!;
  const gap = 6;
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;

  const el = popover.element;

  // Measure dimensions in-place (element is position:fixed so this is accurate).
  // Avoid moving off-screen to measure — that triggers mouseleave/mouseenter
  // glitches when repositioning during hover-expand.
  const popWidth = el.offsetWidth;
  const popHeight = el.offsetHeight;

  // Position below ALL highlighted text (use last rect's bottom, not first)
  let top = lastRect.bottom + gap;
  let left = firstRect.left;

  // Get content bounds for alignment constraints
  const bounds = regionEl ? getContentBounds(regionEl, popover.range) : null;

  // Overview: align with content column leading edge, target 640px width
  if (currentAnnotationMode === "overview" && bounds) {
    left = bounds.left;
    const availableWidth = bounds.right - bounds.left;
    const width = Math.max(110, Math.min(640, availableWidth));
    el.style.width = `${width}px`;
  }

  // Flip above if not enough space below
  if (lastRect.bottom + gap + popHeight > viewportH) {
    top = firstRect.top - popHeight - gap;
  }

  // Depth: clamp right edge to content column boundary
  if (currentAnnotationMode !== "overview" && bounds) {
    if (left + popWidth > bounds.right) {
      left = bounds.right - popWidth;
    }
  }

  // Clamp horizontal to viewport
  if (left + popWidth > viewportW - 8) {
    left = viewportW - popWidth - 8;
  }
  if (left < 8) {
    left = 8;
  }

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function repositionVisibleInlinePopovers(): void {
  for (const [, popover] of inlinePopovers) {
    if (popover.visible) {
      positionInlinePopover(popover);
    }
  }
}

/**
 * Overview mode: show ALL inline popovers (collapsed) at once.
 * The emphasizedId popover gets visual emphasis; others appear but stay collapsed.
 */
function showAllInlinePopovers(emphasizedId?: string): void {
  if (!shadowRoot) return;
  cancelInlineShow();
  cancelInlineHide();

  for (const [id, popover] of inlinePopovers) {
    // Skip hidden types
    if (hiddenTypes.has(popover.annotation.type)) continue;

    if (!popover.visible) {
      shadowRoot.appendChild(popover.element);
      popover.visible = true;
    }
    positionInlinePopover(popover);

    // All notes stay fully visible above the fade — no dimming
    popover.element.classList.remove("dimmed");

    if (id === pinnedId) continue;

    // Emphasise the hovered one, keep others as-is
    if (id === emphasizedId && !pinnedId) {
      popover.element.classList.add("anchor-hovered");
    } else {
      popover.element.classList.remove("anchor-hovered");
      popover.element.classList.remove("expanded");
    }
  }

  inlineHoveredId = emphasizedId ?? null;
}

/**
 * Overview mode: hide every non-pinned inline popover.
 */
function hideAllInlinePopovers(): void {
  for (const [id, popover] of inlinePopovers) {
    if (id === pinnedId) continue;
    if (popover.visible) {
      popover.element.classList.remove("expanded");
      popover.element.classList.remove("anchor-hovered");
      popover.element.classList.remove("dimmed");
      popover.element.remove();
      popover.visible = false;
    }
  }
  inlineHoveredId = null;
}

/**
 * Build an SVG overlay that covers the entire viewport with a semi-transparent
 * fill, but punches out transparent rectangles where the highlighted text lives.
 * This avoids any z-index / stacking-context battles with the host page.
 */
function dimPage(annotationId: string): void {
  dimmedAnnotationId = annotationId;
  // Overview: all notes act as one system — cut out ALL highlights
  // Depth: cut out only the pinned annotation's highlights
  const selector = currentAnnotationMode === "overview"
    ? "[data-oddity-id]"
    : `[data-oddity-id="${annotationId}"]`;
  const anchors = document.querySelectorAll(selector);
  const cutouts: DOMRect[] = [];
  for (const anchor of anchors) {
    const rects = anchor.getClientRects();
    for (let i = 0; i < rects.length; i++) cutouts.push(rects[i]!);
  }

  const pad = 4; // breathing room around each cutout
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Build the SVG path: full-screen rect (clockwise) with cutout rects (counter-clockwise)
  let path = `M0,0 H${vw} V${vh} H0 Z`;
  for (const r of cutouts) {
    const x1 = Math.max(0, r.left - pad);
    const y1 = Math.max(0, r.top - pad);
    const x2 = Math.min(vw, r.right + pad);
    const y2 = Math.min(vh, r.bottom + pad);
    // Counter-clockwise rect creates a hole via even-odd fill
    path += ` M${x1},${y1} V${y2} H${x2} V${y1} Z`;
  }

  if (!pageDimOverlay) {
    pageDimOverlay = document.createElement("div");
    pageDimOverlay.id = "oddity-page-dim";
    pageDimOverlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483644;pointer-events:none;opacity:0;transition:opacity 0.4s cubic-bezier(0.4,0,0.2,1);";
    const dimColor = getThemeMode() === "light" ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.5)";
    pageDimOverlay.innerHTML =
      `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" style="display:block">` +
      `<path d="${path}" fill="${dimColor}" fill-rule="evenodd"/>` +
      `</svg>`;
    document.body.appendChild(pageDimOverlay);
    void pageDimOverlay.offsetHeight;
    pageDimOverlay.style.opacity = "1";
  } else {
    // Update the cutout path (in case of repositioning)
    const svgPath = pageDimOverlay.querySelector("path");
    if (svgPath) svgPath.setAttribute("d", path);
    if (!pageDimOverlay.parentElement) {
      pageDimOverlay.style.opacity = "0";
      document.body.appendChild(pageDimOverlay);
      void pageDimOverlay.offsetHeight;
    }
    pageDimOverlay.style.opacity = "1";
  }
}

function undimPage(): void {
  dimmedAnnotationId = null;
  if (pageDimOverlay) {
    pageDimOverlay.style.opacity = "0";
    const overlay = pageDimOverlay;
    pageDimOverlay = null;
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
    setTimeout(() => { if (overlay.parentElement) overlay.remove(); }, 500);
  }
}

/** Refresh the SVG cutout positions (called on scroll/resize while dimmed). */
function updateDimCutouts(): void {
  if (!pageDimOverlay || !dimmedAnnotationId) return;
  const selector = currentAnnotationMode === "overview"
    ? "[data-oddity-id]"
    : `[data-oddity-id="${dimmedAnnotationId}"]`;
  const anchors = document.querySelectorAll(selector);
  const cutouts: DOMRect[] = [];
  for (const anchor of anchors) {
    const rects = anchor.getClientRects();
    for (let i = 0; i < rects.length; i++) cutouts.push(rects[i]!);
  }
  const pad = 4;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let path = `M0,0 H${vw} V${vh} H0 Z`;
  for (const r of cutouts) {
    const x1 = Math.max(0, r.left - pad);
    const y1 = Math.max(0, r.top - pad);
    const x2 = Math.min(vw, r.right + pad);
    const y2 = Math.min(vh, r.bottom + pad);
    path += ` M${x1},${y1} V${y2} H${x2} V${y1} Z`;
  }
  const svgPath = pageDimOverlay.querySelector("path");
  if (svgPath) svgPath.setAttribute("d", path);
}

export function removeMarginNote(annotationId: string): void {
  // Check inline popovers
  const popover = inlinePopovers.get(annotationId);
  if (popover) {
    if (popover.visible) popover.element.remove();
    inlinePopovers.delete(annotationId);
    if (pinnedId === annotationId) pinnedId = null;
    if (expandedId === annotationId) expandedId = null;
    return;
  }

  const idx = notes.findIndex((n) => n.id === annotationId);
  if (idx === -1) return;

  const note = notes[idx]!;
  note.element.remove();
  notes.splice(idx, 1);

  if (expandedId === annotationId) expandedId = null;

  resolveOverlaps();
  applyPositions();
}

/** Update the displayed text of a margin note (both traditional and inline). */
export function updateMarginNoteText(annotationId: string, newNote: string): void {
  // Check inline popovers
  const popover = inlinePopovers.get(annotationId);
  if (popover) {
    popover.annotation.content.note = newNote;
    const textEl = popover.element.querySelector(".note-body-text") as HTMLElement | null;
    if (textEl) textEl.textContent = newNote;
    return;
  }
  // Traditional margin notes
  const note = notes.find((n) => n.id === annotationId);
  if (note) {
    note.annotation.content.note = newNote;
    const textEl = note.element.querySelector(".note-body-text") as HTMLElement | null;
    if (textEl) textEl.textContent = newNote;
  }
}

export function clearMarginNotes(): void {
  for (const note of notes) {
    note.element.remove();
  }
  notes = [];
  noteIndex = 0;
  expandedId = null;
  pinnedId = null;

  // Also clear inline popovers
  for (const [, popover] of inlinePopovers) {
    if (popover.visible) popover.element.remove();
  }
  inlinePopovers.clear();
  cancelInlineShow();
  cancelInlineHide();
  inlineHoveredId = null;
  mouseInInlinePopover = false;

  undimPage();
}

export function setMarginNotesVisible(v: boolean): void {
  visible = v;
  if (hostEl) {
    hostEl.style.display = v ? "" : "none";
  }
}

export function filterMarginNotesByTypes(types: AnnotationType[]): void {
  const typeSet = new Set(types);
  hiddenTypes = new Set<AnnotationType>();

  for (const note of notes) {
    const isVisible = typeSet.has(note.annotation.type);
    note.element.style.display = isVisible ? "" : "none";
    if (!isVisible) hiddenTypes.add(note.annotation.type);
  }

  // Also filter inline popovers
  for (const [, popover] of inlinePopovers) {
    const isVisible = typeSet.has(popover.annotation.type);
    if (!isVisible && popover.visible) {
      popover.element.remove();
      popover.visible = false;
    }
    if (!isVisible) hiddenTypes.add(popover.annotation.type);
  }

  resolveOverlaps();
  applyPositions();
}

export function expandMarginNote(annotationId: string): void {
  const note = notes.find((n) => n.id === annotationId);
  if (!note) return;

  // Collapse previous
  if (expandedId && expandedId !== annotationId) {
    const prev = notes.find((n) => n.id === expandedId);
    if (prev) prev.element.classList.remove("expanded");
  }

  expandedId = annotationId;
  note.element.classList.add("expanded");
}

export function collapseAllMarginNotes(): void {
  if (pinnedId) return; // Don't collapse hover-triggered while pinned
  forceCollapseAll();
}

function forceCollapseAll(): void {
  if (expandedId) {
    const note = notes.find((n) => n.id === expandedId);
    if (note) note.element.classList.remove("expanded");
    expandedId = null;
  }
}

export function onAnchorClick(annotationId: string): void {
  if (inlinePopovers.has(annotationId)) {
    if (pinnedId === annotationId) {
      unpinInlinePopover();
    } else if (currentAnnotationMode === "overview") {
      // Overview: pin without expanding the card
      if (pinnedId) unpinInlinePopover();
      if (!justUnpinned) {
        pinnedId = annotationId;
        hostEl?.classList.add("has-pinned");
        dimPage(annotationId);
        emphasizeAnnotation(annotationId);
        showAllInlinePopovers();
      }
    } else if (pinnedId) {
      unpinInlinePopover();
      expandInlinePopover(annotationId);
      emphasizeAnnotation(annotationId);
    } else if (!justUnpinned) {
      expandInlinePopover(annotationId);
      emphasizeAnnotation(annotationId);
    }
    return;
  }

  if (pinnedId) {
    unpinAll();
  } else if (!justUnpinned) {
    pinnedId = annotationId;
    hostEl?.classList.add("has-pinned");
    expandMarginNote(annotationId);
    emphasizeAnnotation(annotationId);
    dimOtherNotes(annotationId);
  }
}

function unpinAll(): void {
  if (pinnedId && inlinePopovers.has(pinnedId)) {
    unpinInlinePopover();
    return;
  }
  pinnedId = null;
  hostEl?.classList.remove("has-pinned");
  justUnpinned = true;
  setTimeout(() => {
    justUnpinned = false;
  }, 0);
  forceCollapseAll();
  undimAllNotes();
  deemphasizeAnnotation();
}

export function isAnyMarginNoteExpanded(): boolean {
  return expandedId !== null;
}

export function dimOtherNotes(annotationId: string): void {
  hostEl?.classList.add("has-dimmed");
  for (const note of notes) {
    if (note.id === annotationId) {
      note.element.classList.remove("dimmed");
    } else {
      note.element.classList.add("dimmed");
    }
  }
}

export function undimAllNotes(): void {
  hostEl?.classList.remove("has-dimmed");
  for (const note of notes) {
    note.element.classList.remove("dimmed");
  }
}

export function onAnchorHoverStart(annotationId: string): void {
  if (inlinePopovers.has(annotationId)) {
    mouseInAnchor = true;
    // Overview mode: show ALL popovers, emphasise the hovered one
    if (currentAnnotationMode === "overview") {
      if (pinnedId && pinnedId !== annotationId) {
        // A different note is pinned – still show all, but don't touch the pinned one
        showAllInlinePopovers(annotationId);
      } else {
        showAllInlinePopovers(annotationId);
      }
      emphasizeAnnotation(annotationId);
      return;
    }
    // Depth mode: original single-popover behaviour
    if (pinnedId && pinnedId !== annotationId) return;
    showInlinePopover(annotationId);
    emphasizeAnnotation(annotationId);
    return;
  }

  if (pinnedId && pinnedId !== annotationId) return;
  if (anchorHoverTimer) {
    clearTimeout(anchorHoverTimer);
    anchorHoverTimer = null;
  }
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
  emphasizeAnnotation(annotationId);
  dimOtherNotes(annotationId);
  const note = notes.find((n) => n.id === annotationId);
  note?.element.classList.add("anchor-hovered");
}

export function onAnchorHoverEnd(annotationId?: string): void {
  if (!annotationId || inlinePopovers.has(annotationId)) {
    mouseInAnchor = false;
    if (pinnedId) {
      // While pinned in overview, keep all non-pinned popovers visible
      if (currentAnnotationMode === "overview") {
        deemphasizeAnnotation();
        // Re-show all so the non-pinned ones stay visible (collapsed)
        showAllInlinePopovers();
        // Re-emphasise the pinned one
        emphasizeAnnotation(pinnedId);
      }
      return;
    }
    deemphasizeAnnotation();
    // Overview: hide ALL popovers; Depth: hide the single hovered one
    if (currentAnnotationMode === "overview") {
      scheduleInlineHideAll();
    } else {
      scheduleInlineHide();
    }
    return;
  }

  if (pinnedId) return;
  for (const note of notes) note.element.classList.remove("anchor-hovered");
  undimAllNotes();
  deemphasizeAnnotation();
  // If a note is already expanded the cursor entered it before mouseleave fired
  // on the anchor span (cross-DOM event ordering). Don't set a collapse timer —
  // the note will collapse normally when the cursor leaves it.
  if (expandedId) return;
  anchorHoverTimer = setTimeout(() => {
    collapseAllMarginNotes();
    anchorHoverTimer = null;
  }, 300);
}

export function destroyMarginNotes(): void {
  stopTracking();
  if (themeHandler) {
    offThemeChange(themeHandler);
    themeHandler = null;
  }
  if (docClickHandler) {
    document.removeEventListener("click", docClickHandler);
    docClickHandler = null;
  }
  hostEl?.remove();
  hostEl = null;
  shadowRoot = null;
  notes = [];
  noteIndex = 0;
  expandedId = null;
  pinnedId = null;
  fontLink?.remove();
  fontLink = null;
  timelineLineEl = null;

  // Clean up inline popover state
  inlinePopovers.clear();
  cancelInlineShow();
  cancelInlineHide();
  inlineHoveredId = null;
  mouseInInlinePopover = false;
}

export function getMarginNotesContentRight(): number {
  return sharedContentRight;
}

export function getMarginNotesContentLeft(): number {
  return sharedContentLeftViewport;
}

export function updateMarginNotesStyle(
  font?: AnnotationFont,
  fontSize?: AnnotationFontSize,
): void {
  const host = shadowRoot?.host as HTMLElement;
  if (!host) return;
  host.style.setProperty("--oddity-note-font", FONT_MAP[font ?? "fraunces"]);
  host.style.setProperty("--oddity-note-size", SIZE_MAP[fontSize ?? "default"]);
}

// ─── Note Element Construction ───

function createNoteElement(
  annotation: Annotation,
  side: "left" | "right",
  feedback: AnnotationFeedback[] = [],
  onDelete?: (annotationId: string) => void,
  contentHash = "",
): HTMLDivElement {
  const ENRICHMENT_TYPES = new Set(["insight", "recall", "study", "translation", "vocabulary"]);
  const OVERVIEW_TYPES = new Set(["core_claim", "evidence", "outcome", "background", "transition"]);
  const theme = getThemeMode();
  let color = getAnnotationColor(annotation.type, theme);
  // Green enrichment notes use a lighter accent in dark mode
  if (theme === "dark" && ENRICHMENT_TYPES.has(annotation.type)) {
    color = "#BFF3D3";
  }
  // Overview notes: deeper yellow label in light mode, but buttons stay #FFDD69
  const labelColor = (theme === "light" && OVERVIEW_TYPES.has(annotation.type))
    ? "#DCAF16"
    : color;
  const label = annotation.label || ANNOTATION_LABELS[annotation.type];
  const isManual = annotation.id.startsWith("manual-");

  const el = document.createElement("div");
  el.className = `oddity-note ${side}`;
  el.dataset.annotationId = annotation.id;
  el.dataset.annotationType = annotation.type;
  el.style.setProperty("--note-color", color);

  // Bracket
  const bracket = document.createElement("div");
  bracket.className = "note-bracket";
  bracket.style.borderColor = labelColor;

  // Label
  const labelEl = document.createElement("span");
  labelEl.className = "note-label";
  labelEl.style.color = labelColor;
  labelEl.textContent = label;

  // User name badge for manual annotations
  if (isManual && userName) {
    const userBadge = document.createElement("span");
    userBadge.className = "note-user-badge";
    userBadge.textContent = userName;
    labelEl.appendChild(userBadge);
  }

  // Reaction badge (collapsed state indicator) — deduplicate: pick only the latest thumb
  const thumbFeedback = feedback.filter(
    (f) => f.feedback_type === "thumbs_up" || f.feedback_type === "thumbs_down",
  );
  thumbFeedback.sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const latestThumb = thumbFeedback[0] ?? null;
  const existingThumbUp =
    latestThumb?.feedback_type === "thumbs_up" ? latestThumb : null;
  const existingThumbDown =
    latestThumb?.feedback_type === "thumbs_down" ? latestThumb : null;
  let reactionBadge: HTMLSpanElement | null = null;
  if (existingThumbUp || existingThumbDown) {
    reactionBadge = document.createElement("span");
    reactionBadge.className = "note-reaction-badge";
    reactionBadge.textContent = existingThumbUp ? "\u{1F44D}" : "\u{1F44E}";
    labelEl.appendChild(reactionBadge);
  }

  // Note text (collapsed: truncated)
  const textEl = document.createElement("div");
  textEl.className = "note-text";
  textEl.textContent = annotation.content.note;

  // Expanded content (hidden by default, shown on .expanded)
  const expandedContent = document.createElement("div");
  expandedContent.className = "note-expanded-content";

  if (annotation.content.why_it_matters) {
    const section = createSection(
      "Why it matters",
      annotation.content.why_it_matters,
    );
    expandedContent.appendChild(section);
  }

  if (annotation.content.question) {
    const section = createSection("Question", annotation.content.question);
    expandedContent.appendChild(section);
  }

  if (
    annotation.content.suggestions &&
    annotation.content.suggestions.length > 0
  ) {
    const sectionEl = document.createElement("div");
    sectionEl.className = "note-section";
    const sLabel = document.createElement("span");
    sLabel.className = "note-section-label";
    sLabel.textContent = "Suggestions";
    sectionEl.appendChild(sLabel);
    const ul = document.createElement("ul");
    for (const s of annotation.content.suggestions) {
      const li = document.createElement("li");
      li.textContent = s;
      ul.appendChild(li);
    }
    sectionEl.appendChild(ul);
    expandedContent.appendChild(sectionEl);
  }

  // ── Edit + Delete icon buttons (shared by both manual and AI annotations) ──
  const createEditDeleteIcons = (): DocumentFragment => {
    const frag = document.createDocumentFragment();

    const editBtn = document.createElement("button");
    editBtn.className = "note-icon-btn note-edit-btn";
    editBtn.title = "Edit";
    editBtn.innerHTML = `<span class="icon-dark"><svg width="17" height="17" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18.1641 1.33105C19.7393 -0.243794 22.2929 -0.243751 23.8682 1.33105C25.4435 2.90636 25.4435 5.46083 23.8682 7.03613L8.41699 22.4883C7.76597 23.1393 6.94983 23.6009 6.05664 23.8242L1.26465 25.0225C0.608468 25.1865 0.0136891 24.5917 0.177734 23.9355L1.37598 19.1436C1.59927 18.2504 2.0609 17.4342 2.71191 16.7832L18.1641 1.33105ZM16.4727 5.55664L3.97949 18.0508C3.55812 18.4722 3.25879 19 3.11426 19.5781L2.33887 22.6787L2.27832 22.9219L5.62207 22.0859C6.20018 21.9414 6.72804 21.6421 7.14941 21.2207L13.3965 14.9736L19.6426 8.72656L19.748 8.62109L19.6426 8.51465L16.5781 5.4502L16.4727 5.55664ZM22.6016 2.59863C21.726 1.72311 20.3062 1.72311 19.4307 2.59863L17.8457 4.18359L17.9512 4.29004L20.9092 7.24805L21.0156 7.35352L21.1211 7.24805L22.6016 5.76953C23.4771 4.89404 23.477 3.47416 22.6016 2.59863Z" fill="white" stroke="#363636" stroke-width="0.3"/></svg></span><span class="icon-light"><svg width="17" height="17" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18.1641 1.33105C19.7393 -0.243794 22.2929 -0.243751 23.8682 1.33105C25.4435 2.90636 25.4435 5.46083 23.8682 7.03613L8.41699 22.4883C7.76597 23.1393 6.94983 23.6009 6.05664 23.8242L1.26465 25.0225C0.608468 25.1865 0.0136891 24.5917 0.177734 23.9355L1.37598 19.1436C1.59927 18.2504 2.0609 17.4342 2.71191 16.7832L18.1641 1.33105ZM16.4727 5.55664L3.97949 18.0508C3.55812 18.4722 3.25879 19 3.11426 19.5781L2.33887 22.6787L2.27832 22.9219L5.62207 22.0859C6.20018 21.9414 6.72804 21.6421 7.14941 21.2207L13.3965 14.9736L19.6426 8.72656L19.748 8.62109L19.6426 8.51465L16.5781 5.4502L16.4727 5.55664ZM22.6016 2.59863C21.726 1.72311 20.3062 1.72311 19.4307 2.59863L17.8457 4.18359L17.9512 4.29004L20.9092 7.24805L21.0156 7.35352L21.1211 7.24805L22.6016 5.76953C23.4771 4.89404 23.477 3.47416 22.6016 2.59863Z" fill="#293038" stroke="white" stroke-width="0.3"/></svg></span>`;
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      enterEditMode(el, annotation, textEl, contentHash);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "note-icon-btn note-delete-btn";
    deleteBtn.title = "Delete";
    deleteBtn.innerHTML = `<span class="icon-dark"><svg width="15" height="18" viewBox="0 0 22 27" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18.9219 7.43945C19.5106 7.28746 20.0695 7.65114 20.1689 8.25781C20.1871 8.36904 20.1904 8.48758 20.1904 8.61621C20.1916 12.9442 20.1921 17.2726 20.1914 21.6006C20.191 23.8874 18.6924 25.7032 16.4473 26.127C16.1796 26.1775 15.898 26.1959 15.6172 26.1963C12.4044 26.2013 9.19156 26.2003 5.97852 26.1992C3.69159 26.1985 1.85256 24.6628 1.45312 22.418C1.41441 22.2002 1.39474 21.976 1.39453 21.7549C1.39094 17.3332 1.39019 12.9109 1.39355 8.48926C1.3939 8.11363 1.54191 7.815 1.7627 7.62891C1.98301 7.44332 2.28797 7.35899 2.62695 7.43457C3.04346 7.52748 3.36132 7.89535 3.39258 8.32715C3.39929 8.42013 3.3955 8.50965 3.39551 8.62207C3.39566 12.6316 3.39648 16.6411 3.39648 20.6787H3.39551L3.39648 20.6855C3.41225 21.17 3.37743 21.7036 3.45996 22.1953C3.65247 23.341 4.68451 24.1899 5.83789 24.1924C9.13566 24.1995 12.4336 24.1998 15.7314 24.1924C17.1037 24.1893 18.1861 23.0585 18.1865 21.6758C18.188 17.2823 18.1867 12.8885 18.1875 8.49512C18.1876 7.94499 18.484 7.55251 18.9219 7.43945Z" fill="white" stroke="#363636" stroke-width="0.4"/><path d="M7.26953 0.203125C9.62027 0.198508 11.9716 0.199014 14.3223 0.204102C14.6616 0.204899 14.922 0.314719 15.0977 0.492188C15.2735 0.670059 15.3822 0.934127 15.3848 1.27637C15.3898 1.9497 15.3867 2.62192 15.3867 3.29785V3.7998H15.9141C17.3757 3.79981 18.8361 3.79648 20.2969 3.80078C20.9586 3.80273 21.3942 4.24054 21.3867 4.82031C21.3799 5.3401 20.9666 5.77238 20.4453 5.80176C20.3502 5.8071 20.2583 5.80371 20.1475 5.80371H1.2666C0.639678 5.80015 0.20525 5.37415 0.200195 4.81543C0.195178 4.24231 0.62806 3.8045 1.26758 3.80176C2.72789 3.7955 4.1877 3.79982 5.64941 3.7998H6.1709L6.18359 3.61328C6.18866 3.53651 6.20002 3.43702 6.2002 3.34961C6.20145 2.65408 6.19707 1.96406 6.20215 1.27148C6.20465 0.931308 6.31364 0.668386 6.49023 0.491211C6.66684 0.314264 6.92879 0.203859 7.26953 0.203125ZM8.20312 3.7998H13.3838V2.21973H8.20312V3.7998Z" fill="white" stroke="#363636" stroke-width="0.4"/><path d="M8.31055 9.80664C8.83083 9.76813 9.2791 10.1133 9.37012 10.627C9.39137 10.7472 9.3973 10.8761 9.39746 11.0117C9.39941 12.7069 9.39844 14.4024 9.39844 16.126C9.39842 17.149 9.40636 18.1395 9.39648 19.1309C9.38809 19.9463 8.64467 20.4191 7.97754 20.1025C7.76977 20.0039 7.62709 19.8731 7.53516 19.7178C7.44262 19.5613 7.39442 19.3667 7.39453 19.1309C7.39576 16.499 7.39446 13.8671 7.39453 11.2354C7.39454 11.0691 7.39044 10.9185 7.39648 10.7646C7.41659 10.2586 7.81791 9.84333 8.31055 9.80664Z" fill="white" stroke="#363636" stroke-width="0.4"/><path d="M13.0742 9.80664C13.5841 9.74797 14.0478 10.0748 14.165 10.5918C14.1862 10.6852 14.1894 10.7898 14.1895 10.9092C14.1911 13.6331 14.189 16.3586 14.1934 19.083C14.1937 19.3328 14.1473 19.5393 14.0547 19.7041C13.9635 19.8663 13.8198 20.0013 13.6016 20.1006C13.3815 20.2006 13.1833 20.2215 13.001 20.1826C12.8191 20.1437 12.6362 20.0418 12.4521 19.8672C12.2593 19.6446 12.1865 19.3976 12.1865 19.1094C12.1869 16.3662 12.1849 13.6236 12.1885 10.8809C12.1893 10.2842 12.5612 9.86575 13.0742 9.80664Z" fill="white" stroke="#363636" stroke-width="0.4"/></svg></span><span class="icon-light"><svg width="15" height="18" viewBox="0 0 22 27" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18.9219 7.43945C19.5106 7.28746 20.0695 7.65114 20.1689 8.25781C20.1871 8.36904 20.1904 8.48758 20.1904 8.61621C20.1916 12.9442 20.1921 17.2726 20.1914 21.6006C20.191 23.8874 18.6924 25.7032 16.4473 26.127C16.1796 26.1775 15.898 26.1959 15.6172 26.1963C12.4044 26.2013 9.19156 26.2003 5.97852 26.1992C3.69159 26.1985 1.85256 24.6628 1.45312 22.418C1.41441 22.2002 1.39474 21.976 1.39453 21.7549C1.39094 17.3332 1.39019 12.9109 1.39355 8.48926C1.3939 8.11363 1.54191 7.815 1.7627 7.62891C1.98301 7.44332 2.28797 7.35899 2.62695 7.43457C3.04346 7.52748 3.36132 7.89535 3.39258 8.32715C3.39929 8.42013 3.3955 8.50965 3.39551 8.62207C3.39566 12.6316 3.39648 16.6411 3.39648 20.6787H3.39551L3.39648 20.6855C3.41225 21.17 3.37743 21.7036 3.45996 22.1953C3.65247 23.341 4.68451 24.1899 5.83789 24.1924C9.13566 24.1995 12.4336 24.1998 15.7314 24.1924C17.1037 24.1893 18.1861 23.0585 18.1865 21.6758C18.188 17.2823 18.1867 12.8885 18.1875 8.49512C18.1876 7.94499 18.484 7.55251 18.9219 7.43945Z" fill="#293038" stroke="white" stroke-width="0.4"/><path d="M7.26953 0.203125C9.62027 0.198508 11.9716 0.199014 14.3223 0.204102C14.6616 0.204899 14.922 0.314719 15.0977 0.492188C15.2735 0.670059 15.3822 0.934127 15.3848 1.27637C15.3898 1.9497 15.3867 2.62192 15.3867 3.29785V3.7998H15.9141C17.3757 3.79981 18.8361 3.79648 20.2969 3.80078C20.9586 3.80273 21.3942 4.24054 21.3867 4.82031C21.3799 5.3401 20.9666 5.77238 20.4453 5.80176C20.3502 5.8071 20.2583 5.80371 20.1475 5.80371H1.2666C0.639678 5.80015 0.20525 5.37415 0.200195 4.81543C0.195178 4.24231 0.62806 3.8045 1.26758 3.80176C2.72789 3.7955 4.1877 3.79982 5.64941 3.7998H6.1709L6.18359 3.61328C6.18866 3.53651 6.20002 3.43702 6.2002 3.34961C6.20145 2.65408 6.19707 1.96406 6.20215 1.27148C6.20465 0.931308 6.31364 0.668386 6.49023 0.491211C6.66684 0.314264 6.92879 0.203859 7.26953 0.203125ZM8.20312 3.7998H13.3838V2.21973H8.20312V3.7998Z" fill="#293038" stroke="white" stroke-width="0.4"/><path d="M8.31055 9.80664C8.83083 9.76813 9.2791 10.1133 9.37012 10.627C9.39137 10.7472 9.3973 10.8761 9.39746 11.0117C9.39941 12.7069 9.39844 14.4024 9.39844 16.126C9.39842 17.149 9.40636 18.1395 9.39648 19.1309C9.38809 19.9463 8.64467 20.4191 7.97754 20.1025C7.76977 20.0039 7.62709 19.8731 7.53516 19.7178C7.44262 19.5613 7.39442 19.3667 7.39453 19.1309C7.39576 16.499 7.39446 13.8671 7.39453 11.2354C7.39454 11.0691 7.39044 10.9185 7.39648 10.7646C7.41659 10.2586 7.81791 9.84333 8.31055 9.80664Z" fill="#293038" stroke="white" stroke-width="0.4"/><path d="M13.0742 9.80664C13.5841 9.74797 14.0478 10.0748 14.165 10.5918C14.1862 10.6852 14.1894 10.7898 14.1895 10.9092C14.1911 13.6331 14.189 16.3586 14.1934 19.083C14.1937 19.3328 14.1473 19.5393 14.0547 19.7041C13.9635 19.8663 13.8198 20.0013 13.6016 20.1006C13.3815 20.2006 13.1833 20.2215 13.001 20.1826C12.8191 20.1437 12.6362 20.0418 12.4521 19.8672C12.2593 19.6446 12.1865 19.3976 12.1865 19.1094C12.1869 16.3662 12.1849 13.6236 12.1885 10.8809C12.1893 10.2842 12.5612 9.86575 13.0742 9.80664Z" fill="#293038" stroke="white" stroke-width="0.4"/></svg></span>`;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (onDelete) onDelete(annotation.id);
      sendMessage({
        action: "deleteAnnotation",
        payload: {
          annotationId: annotation.id,
          url: getPageUrl(),
          contentHash: contentHash,
        },
      });
    });

    frag.appendChild(editBtn);
    frag.appendChild(deleteBtn);
    return frag;
  };

  if (isManual) {
    // ── User annotation: Edit + Delete in a single row ──
    const manualRow = document.createElement("div");
    manualRow.className = "note-feedback-row";
    const manualSpacer = document.createElement("div");
    manualSpacer.style.flex = "1";
    manualRow.appendChild(manualSpacer);
    manualRow.appendChild(createEditDeleteIcons());
    expandedContent.appendChild(manualRow);
  } else {
    // ── AI annotation: Reply thread + Feedback row + Edit/Delete ──

    // Reply thread
    const replies = feedback.filter((f) => f.feedback_type === "reply");
    const repliesContainer = document.createElement("div");
    repliesContainer.className = "note-replies";
    for (const reply of replies) {
      const bubble = document.createElement("div");
      bubble.className = "note-reply-bubble";
      bubble.dataset.feedbackId = reply.id;
      bubble.textContent = reply.reply_text ?? "";
      repliesContainer.appendChild(bubble);
    }
    expandedContent.appendChild(repliesContainer);

    // Reply input bar
    const replyBar = document.createElement("div");
    replyBar.className = "note-reply-bar";
    const replyInput = document.createElement("input");
    replyInput.type = "text";
    replyInput.placeholder = "Add a note...";
    replyInput.className = "note-reply-input";
    replyInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && replyInput.value.trim()) {
        submitReply(annotation, replyInput, repliesContainer, contentHash);
      }
    });
    const sendBtn = document.createElement("button");
    sendBtn.className = "note-reply-send";
    sendBtn.innerHTML = `<span class="arrow-light"><svg width="10" height="13" viewBox="0 0 12 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.05377 0.219671C5.76087 -0.0732222 5.286 -0.0732222 4.99311 0.219671L0.220136 4.99264C-0.0727572 5.28553 -0.0727572 5.76041 0.220136 6.0533C0.51303 6.3462 0.987903 6.3462 1.2808 6.0533L5.52344 1.81066L9.76608 6.0533C10.059 6.3462 10.5338 6.3462 10.8267 6.0533C11.1196 5.76041 11.1196 5.28553 10.8267 4.99264L6.05377 0.219671ZM5.52344 15.75H6.27344L6.27344 0.750001H5.52344H4.77344L4.77344 15.75H5.52344Z" fill="white"/></svg></span><span class="arrow-dark"><svg width="10" height="13" viewBox="0 0 12 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.05377 0.219671C5.76087 -0.0732222 5.286 -0.0732222 4.99311 0.219671L0.220136 4.99264C-0.0727572 5.28553 -0.0727572 5.76041 0.220136 6.0533C0.51303 6.3462 0.987903 6.3462 1.2808 6.0533L5.52344 1.81066L9.76608 6.0533C10.059 6.3462 10.5338 6.3462 10.8267 6.0533C11.1196 5.76041 11.1196 5.28553 10.8267 4.99264L6.05377 0.219671ZM5.52344 15.75H6.27344L6.27344 0.750001H5.52344H4.77344L4.77344 15.75H5.52344Z" fill="#293038"/></svg></span>`;
    sendBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (replyInput.value.trim()) {
        submitReply(annotation, replyInput, repliesContainer, contentHash);
      }
    });
    replyBar.appendChild(replyInput);
    replyBar.appendChild(sendBtn);
    expandedContent.appendChild(replyBar);

    // Feedback row (thumbs)
    const feedbackRow = document.createElement("div");
    feedbackRow.className = "note-feedback-row";

    let currentFeedbackId: string | null =
      existingThumbUp?.id ?? existingThumbDown?.id ?? null;

    // Listen for external feedback deletion (e.g. from argument box) to reset pill state
    el.addEventListener("oddity:reset-reaction", () => {
      thumbUp.classList.remove("active");
      thumbDown.classList.remove("active");
      currentFeedbackId = null;
    });

    const thumbUp = document.createElement("button");
    thumbUp.className = "note-feedback-pill" + (existingThumbUp ? " active" : "");
    thumbUp.textContent = "Agree";
    thumbUp.title = "Helpful";
    thumbUp.addEventListener("click", (e) => {
      e.stopPropagation();
      if (thumbUp.classList.contains("active")) {
        // Undo thumbs up
        thumbUp.classList.remove("active");
        reactionBadge = updateReactionBadge(
          labelEl,
          reactionBadge,
          "thumbs_up",
          false,
        );
        if (currentFeedbackId) {
          sendMessage({ action: "deleteFeedback", payload: { feedbackId: currentFeedbackId, contentHash, url: getPageUrl() } });
          currentFeedbackId = null;
        }
      } else {
        // Activate thumbs up, deactivate thumbs down
        thumbUp.classList.add("active");
        thumbDown.classList.remove("active");
        reactionBadge = updateReactionBadge(labelEl, reactionBadge, "thumbs_up", true);
        const noteExcerpt = annotation.content.note.length > 40
          ? annotation.content.note.slice(0, 37) + "\u2026"
          : annotation.content.note;
        const liveSortKey = addLiveFeedback("↳", "I agree", {
          type: "reply",
          replyHeader: noteExcerpt,
          annotationType: annotation.type,
          annotationId: annotation.id,
          contentHash: contentHash,
        });
        const doSave = () =>
          sendMessage({
            action: "saveFeedback",
            payload: {
              annotationId: annotation.id,
              contentHash: contentHash,
              url: getPageUrl(),
              feedbackType: "thumbs_up",
              pageTitle: document.title,
            },
          }).then((fb: any) => {
            if (fb?.id) {
              currentFeedbackId = fb.id;
              updateLiveFeedbackId(liveSortKey, fb.id);
              window.dispatchEvent(new CustomEvent("oddity:feedback-added", {
                detail: { feedback: fb, contentHash: contentHash },
              }));
            }
          });
        if (currentFeedbackId) {
          sendMessage({ action: "deleteFeedback", payload: { feedbackId: currentFeedbackId, contentHash, url: getPageUrl() } })
            .then(() => { currentFeedbackId = null; return doSave(); });
        } else {
          doSave();
        }
      }
    });

    const thumbDown = document.createElement("button");
    thumbDown.className =
      "note-feedback-pill note-feedback-pill--negative" +
      (existingThumbDown ? " active" : "");
    thumbDown.textContent = "Not helpful";
    thumbDown.title = "Not helpful";
    thumbDown.addEventListener("click", (e) => {
      e.stopPropagation();
      if (thumbDown.classList.contains("active")) {
        // Undo thumbs down
        thumbDown.classList.remove("active");
        reactionBadge = updateReactionBadge(
          labelEl,
          reactionBadge,
          "thumbs_down",
          false,
        );
        if (currentFeedbackId) {
          sendMessage({ action: "deleteFeedback", payload: { feedbackId: currentFeedbackId, contentHash, url: getPageUrl() } });
          currentFeedbackId = null;
        }
      } else {
        // Activate thumbs down, deactivate thumbs up
        thumbDown.classList.add("active");
        thumbUp.classList.remove("active");
        reactionBadge = updateReactionBadge(labelEl, reactionBadge, "thumbs_down", true);
        const noteExcerptDown = annotation.content.note.length > 40
          ? annotation.content.note.slice(0, 37) + "\u2026"
          : annotation.content.note;
        const liveSortKeyDown = addLiveFeedback("↳", "I don't think so", {
          type: "reply",
          replyHeader: noteExcerptDown,
          annotationType: annotation.type,
          annotationId: annotation.id,
          contentHash: contentHash,
        });
        const doSave = () =>
          sendMessage({
            action: "saveFeedback",
            payload: {
              annotationId: annotation.id,
              contentHash: contentHash,
              url: getPageUrl(),
              feedbackType: "thumbs_down",
              pageTitle: document.title,
            },
          }).then((fb: any) => {
            if (fb?.id) {
              currentFeedbackId = fb.id;
              updateLiveFeedbackId(liveSortKeyDown, fb.id);
              window.dispatchEvent(new CustomEvent("oddity:feedback-added", {
                detail: { feedback: fb, contentHash: contentHash },
              }));
            }
          });
        if (currentFeedbackId) {
          sendMessage({ action: "deleteFeedback", payload: { feedbackId: currentFeedbackId, contentHash, url: getPageUrl() } })
            .then(() => { currentFeedbackId = null; return doSave(); });
        } else {
          doSave();
        }
      }
    });

    const pillGroup = document.createElement("div");
    pillGroup.className = "note-pill-group";
    pillGroup.appendChild(thumbUp);
    pillGroup.appendChild(thumbDown);

    const iconGroup = document.createElement("div");
    iconGroup.className = "note-icon-group";
    iconGroup.appendChild(createEditDeleteIcons());

    feedbackRow.appendChild(pillGroup);
    feedbackRow.appendChild(iconGroup);
    expandedContent.appendChild(feedbackRow);
  }

  // Wrap expanded content children in an inner div for CSS grid animation
  const expandedInner = document.createElement("div");
  expandedInner.className = "note-expanded-inner";
  while (expandedContent.firstChild) {
    expandedInner.appendChild(expandedContent.firstChild);
  }
  expandedContent.appendChild(expandedInner);

  el.appendChild(bracket);
  el.appendChild(labelEl);
  el.appendChild(textEl);
  el.appendChild(expandedContent);

  // Hover expand/collapse + overlay emphasis (traditional margin notes only;
  // inline popovers add their own handlers in addInlinePopover).
  el.addEventListener("mouseenter", () => {
    if (el.classList.contains("oddity-note--inline")) return;
    if (pinnedId && pinnedId !== annotation.id) return;
    if (anchorHoverTimer) {
      clearTimeout(anchorHoverTimer);
      anchorHoverTimer = null;
    }
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
    expandMarginNote(annotation.id);
    emphasizeAnnotation(annotation.id);
    dimOtherNotes(annotation.id);
  });

  el.addEventListener("click", (e) => {
    if (el.classList.contains("oddity-note--inline")) return;
    e.stopPropagation();
    // Don't unpin when clicking interactive elements inside the card
    if ((e.target as HTMLElement).closest('button, input, textarea')) return;
    if (pinnedId === annotation.id) {
      unpinAll();
    } else if (pinnedId) {
      // Clicking a different note while one is pinned: switch to the new one
      unpinAll();
      pinnedId = annotation.id;
      hostEl?.classList.add('has-pinned');
      expandMarginNote(annotation.id);
      emphasizeAnnotation(annotation.id);
      dimOtherNotes(annotation.id);
    } else if (!justUnpinned) {
      pinnedId = annotation.id;
      hostEl?.classList.add("has-pinned");
      expandMarginNote(annotation.id);
      emphasizeAnnotation(annotation.id);
      dimOtherNotes(annotation.id);
    }
  });

  el.addEventListener("mouseleave", () => {
    if (el.classList.contains("oddity-note--inline")) return;
    if (pinnedId) return;
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      collapseAllMarginNotes();
      undimAllNotes();
      deemphasizeAnnotation();
    }, 100);
  });

  return el;
}

// ─── Interaction Helpers ───

function submitReply(
  annotation: Annotation,
  input: HTMLInputElement,
  container: HTMLDivElement,
  hash: string,
): void {
  const text = input.value.trim();
  if (!text) return;

  // Add bubble immediately
  const bubble = document.createElement("div");
  bubble.className = "note-reply-bubble";
  bubble.textContent = text;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;

  const excerpt = annotation.content.note.length > 40
    ? annotation.content.note.slice(0, 37) + "\u2026"
    : annotation.content.note;
  const liveSortKeyReply = addLiveFeedback("↳", text, {
    type: "reply",
    replyHeader: excerpt,
    annotationType: annotation.type,
    annotationId: annotation.id,
    contentHash: hash,
  });

  // Send to background
  sendMessage({
    action: "saveFeedback",
    payload: {
      annotationId: annotation.id,
      contentHash: hash,
      url: getPageUrl(),
      feedbackType: "reply",
      replyText: text,
      pageTitle: document.title,
    },
  }).then((fb: any) => {
    if (fb?.id) {
      bubble.dataset.feedbackId = fb.id;
      updateLiveFeedbackId(liveSortKeyReply, fb.id);
      // Update in-memory feedback stores so syncArgumentsBox doesn't lose this
      window.dispatchEvent(new CustomEvent("oddity:feedback-added", {
        detail: { feedback: fb, contentHash: hash },
      }));
    }
  }).catch(() => {});


  input.value = "";
}

function enterEditMode(
  noteEl: HTMLDivElement,
  annotation: Annotation,
  textEl: HTMLDivElement,
  contentHash = "",
): void {
  if (noteEl.querySelector(".note-edit-textarea")) return;

  const textarea = document.createElement("textarea");
  textarea.className = "note-edit-textarea";
  textarea.value = annotation.content.note;
  textarea.rows = 3;
  textarea.addEventListener("keydown", (e) => e.stopPropagation());

  const editActions = document.createElement("div");
  editActions.className = "note-edit-actions";

  const saveBtn = document.createElement("button");
  saveBtn.className = "note-save-btn";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const newNote = textarea.value.trim();
    if (!newNote) return;

    const updatedAnnotation = {
      ...annotation,
      content: { ...annotation.content, note: newNote },
    };

    sendMessage({
      action: "updateAnnotation",
      payload: {
        annotationId: annotation.id,
        annotation: updatedAnnotation,
        url: getPageUrl(),
        contentHash: contentHash,
        pageTitle: document.title,
      },
    }).then(() => {
      annotation.content.note = newNote;
      textEl.textContent = newNote;
      exitEditMode(noteEl, textarea, editActions, textEl);
      // Notify content script so in-memory stores and argument box are updated
      document.dispatchEvent(
        new CustomEvent("oddity:annotation-edited", {
          detail: { annotationId: annotation.id, note: newNote, contentHash },
        }),
      );
    });
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "note-cancel-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    exitEditMode(noteEl, textarea, editActions, textEl);
  });

  editActions.appendChild(saveBtn);
  editActions.appendChild(cancelBtn);

  textEl.style.display = "none";
  textEl.parentElement!.insertBefore(textarea, textEl.nextSibling);
  textEl.parentElement!.insertBefore(editActions, textarea.nextSibling);
  textarea.focus();
}

function exitEditMode(
  _noteEl: HTMLDivElement,
  textarea: HTMLTextAreaElement,
  editActions: HTMLDivElement,
  textEl: HTMLDivElement,
): void {
  textarea.remove();
  editActions.remove();
  textEl.style.display = "";
}

function hideNoteWithAnimation(el: HTMLDivElement, annotationId: string): void {
  el.classList.add("hiding");

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    removeMarginNote(annotationId);
    removeAnnotationOverlay(annotationId);
    removeAnchors(annotationId);
  };

  el.addEventListener("transitionend", cleanup, { once: true });
  // Safety fallback
  setTimeout(cleanup, 400);
}

function updateReactionBadge(
  labelEl: HTMLSpanElement,
  existingBadge: HTMLSpanElement | null,
  type: "thumbs_up" | "thumbs_down",
  isActive: boolean,
): HTMLSpanElement | null {
  const emoji = type === "thumbs_up" ? "\u{1F44D}" : "\u{1F44E}";
  if (isActive) {
    if (existingBadge) {
      existingBadge.textContent = emoji;
      return existingBadge;
    } else {
      const badge = document.createElement("span");
      badge.className = "note-reaction-badge";
      badge.textContent = emoji;
      labelEl.appendChild(badge);
      return badge;
    }
  } else {
    if (existingBadge) existingBadge.remove();
    return null;
  }
}

function createSection(labelText: string, content: string): HTMLDivElement {
  const section = document.createElement("div");
  section.className = "note-section";
  const label = document.createElement("span");
  label.className = "note-section-label";
  label.textContent = labelText;
  const text = document.createElement("p");
  text.textContent = content;
  section.appendChild(label);
  section.appendChild(text);
  return section;
}

// ─── Layout ───

/**
 * Get the viewport-relative left/right bounds of the content column that
 * a note should sit beside.
 *
 * On news/article sites `region` is the article element — its bounding rect
 * gives clean column edges.
 *
 * On chat sites `regionEl` may be `document.body` (before any response has
 * loaded) which is full-viewport-wide and useless for margin positioning.
 * In that case (or whenever the region is wider than 80% of the viewport —
 * a reliable heuristic for "this is body or a full-width wrapper"), we
 * fall back to the note's own text range.  The range sits inside the actual
 * message bubble, so its bounding rect gives us the real content column.
 */
function getContentBounds(
  region: Element,
  range: Range,
): { left: number; right: number } {
  const regionRect = region.getBoundingClientRect();
  const viewportWidth = window.innerWidth;

  // If the region is narrower than 80% of the viewport it's a real content
  // column (article, card, etc.) — use it directly.
  if (regionRect.width < viewportWidth * 0.8) {
    return { left: regionRect.left, right: regionRect.right };
  }

  // Region is (near-)full-width — derive bounds from the range's container.
  // Walk up from the range's common ancestor to find the tightest block
  // element that represents the content column.
  let el: Element | null =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;

  while (el && el !== document.body && el !== document.documentElement) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.width < viewportWidth * 0.8) {
      return { left: rect.left, right: rect.right };
    }
    el = el.parentElement;
  }

  // Last resort: use the range's own bounding rect to approximate.
  const rangeRect = range.getBoundingClientRect();
  if (rangeRect.width > 0) {
    return { left: rangeRect.left, right: rangeRect.right };
  }

  // Absolute fallback — center a 700px column.
  const center = viewportWidth / 2;
  return { left: center - 350, right: center + 350 };
}

function resolveOverlaps(): void {
  const visibleNotes = notes.filter((n) => n.element.style.display !== "none");
  resolveOverlapsForSide(visibleNotes);
}

function resolveOverlapsForSide(sideNotes: MarginNote[]): void {
  sideNotes.sort((a, b) => a.anchorTopPx - b.anchorTopPx);

  // Reset topPx to anchor position before resolving
  for (const note of sideNotes) {
    note.topPx = note.anchorTopPx;
  }

  for (let i = 1; i < sideNotes.length; i++) {
    const prev = sideNotes[i - 1]!;
    const curr = sideNotes[i]!;
    const minTop = prev.topPx + prev.height + NOTE_GAP;
    if (curr.topPx < minTop) {
      curr.topPx = minTop;
    }
  }
}

function applyPositions(): void {
  // Compute a single shared contentLeft for all left-side notes so they
  // all align on the same leading edge with no stagger.
  const leftNotes = notes.filter((n) => n.side === "left");
  let sharedContentLeft = Infinity;
  let maxContentRight = 0;
  for (const note of leftNotes) {
    const bounds = getContentBounds(note.region, note.range);
    const cl = bounds.left + window.scrollX;
    if (cl < sharedContentLeft) sharedContentLeft = cl;
  }
  if (!isFinite(sharedContentLeft)) sharedContentLeft = 0;
  // Only update the shared left if we have notes — preserve the last known
  // value so the mode toggle doesn't jump when notes are cleared (e.g. depth mode).
  if (leftNotes.length > 0) {
    sharedContentLeftViewport = sharedContentLeft - window.scrollX;
  }

  for (const note of notes) {
    const bounds = getContentBounds(note.region, note.range);
    const contentRight = bounds.right + window.scrollX;
    if (contentRight > maxContentRight) maxContentRight = contentRight;

    note.element.style.right = "auto";

    if (note.side === "left") {
      const availableWidth = sharedContentLeft - MARGIN_PADDING - 8;
      const noteWidth = Math.min(
        NOTE_EXPANDED_WIDTH,
        Math.max(100, availableWidth),
      );
      note.element.style.width = `${noteWidth}px`;
      note.element.style.left = `${Math.max(8, sharedContentLeft - MARGIN_PADDING - noteWidth)}px`;
    } else {
      note.element.style.left = `${contentRight + MARGIN_PADDING}px`;
    }
    note.element.style.top = `${note.topPx}px`;
  }
  sharedContentRight = maxContentRight;

  // Update the timeline line (overview mode only)
  updateTimelineLine(leftNotes, sharedContentLeft);

  document.dispatchEvent(new CustomEvent("oddity:layoutUpdated"));
}

function updateTimelineLine(leftNotes: MarginNote[], sharedContentLeft: number): void {
  if (!timelineLineEl) return;

  // Only show in overview mode with 2+ visible notes
  const visibleNotes = leftNotes.filter((n) => n.element.style.display !== "none");
  if (currentAnnotationMode === "depth" || visibleNotes.length < 2) {
    timelineLineEl.style.display = "none";
    return;
  }

  // Sort by topPx to find first and last
  const sorted = [...visibleNotes].sort((a, b) => a.topPx - b.topPx);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  // Line runs from center of first note to center of last note
  const noteWidth = Math.min(NOTE_EXPANDED_WIDTH, Math.max(100, sharedContentLeft - MARGIN_PADDING - 8));
  const noteLeft = Math.max(8, sharedContentLeft - MARGIN_PADDING - noteWidth);
  const lineCenterX = noteLeft + noteWidth / 2;

  const lineTop = first.topPx;
  const lineBottom = last.topPx + last.collapsedHeight;
  const lineHeight = lineBottom - lineTop;

  if (lineHeight <= 0) {
    timelineLineEl.style.display = "none";
    return;
  }

  timelineLineEl.style.display = "";
  timelineLineEl.style.left = `${lineCenterX}px`;
  timelineLineEl.style.top = `${lineTop}px`;
  timelineLineEl.style.height = `${lineHeight}px`;
}

// ─── Scroll / Resize Tracking ───

function recomputePositions(): void {
  for (const note of notes) {
    const rects = note.range.getClientRects();
    if (rects.length > 0) {
      note.anchorTopPx = rects[0]!.top + window.scrollY;
      note.topPx = note.anchorTopPx;
    }
    // Only update collapsedHeight when not expanded so expanding never shifts other notes
    if (!note.element.classList.contains("expanded")) {
      note.collapsedHeight = note.element.offsetHeight;
    }
    note.height = note.collapsedHeight;
  }

  resolveOverlaps();
  applyPositions();
}

function scheduleRedraw(): void {
  if (!needsRedraw) {
    needsRedraw = true;
    requestAnimationFrame(() => {
      repositionVisibleInlinePopovers();
      updateDimCutouts();
      recomputePositions();
      needsRedraw = false;
    });
  }
}

let cleanupTracking: (() => void) | null = null;

function startTracking(): void {
  window.addEventListener("scroll", scheduleRedraw, {
    passive: true,
    capture: true,
  });
  window.addEventListener("resize", scheduleRedraw, { passive: true });

  cleanupTracking = () => {
    window.removeEventListener("scroll", scheduleRedraw, { capture: true });
    window.removeEventListener("resize", scheduleRedraw);
  };
}

function stopTracking(): void {
  cleanupTracking?.();
  cleanupTracking = null;
}

// ─── CSS ───

const MARGIN_NOTES_CSS = `
  :host {
    --oddity-note-font: 'Inter', system-ui, -apple-system, sans-serif;
    --oddity-note-size: 11.5px;
  }

  .oddity-note {
    position: absolute;
    width: ${NOTE_EXPANDED_WIDTH}px;
    padding: 13px 18px;
    font-family: var(--oddity-note-font);
    font-size: var(--oddity-note-size);
    line-height: 1.6;
    color: #FFFFFF;
    pointer-events: auto;
    cursor: default;
    background: rgba(255, 255, 255, 0.15);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-radius: 6.5px;
    box-shadow: 0 3px 14px rgba(0,0,0,0.35), 0 1px 3px rgba(0,0,0,0.2);
    opacity: 1;
    transition: opacity 0.25s ease-in, filter 0.25s ease-in, box-shadow 0.2s;
    box-sizing: border-box;
  }

  .oddity-note:hover {
    opacity: 1;
  }

  .oddity-note.dimmed {
    opacity: 0.3;
    filter: grayscale(0.7) brightness(0.6);
    box-shadow: none;
    pointer-events: none;
  }

  /* Bracket hidden in new card design */
  .note-bracket {
    display: none;
  }

  .note-label {
    display: block;
    font-family: var(--oddity-note-font);
    font-style: normal;
    font-size: var(--oddity-note-size);
    font-weight: 700;
    letter-spacing: normal;
    text-transform: lowercase;
    margin-bottom: 4px;
  }

  .note-label::first-letter {
    text-transform: uppercase;
  }

  .note-text {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    word-break: break-word;
    font-family: var(--oddity-note-font);
    font-style: normal;
    font-size: var(--oddity-note-size);
    font-weight: 370;
    line-height: 1.6;
    color: #FFFFFF;
  }

  /* Overview inline popovers: always show full text, no expand/collapse */
  .oddity-note--overview {
    min-width: 110px;
    max-width: 640px;
  }

  .oddity-note--overview .note-text {
    display: block;
    -webkit-line-clamp: unset;
    overflow: visible;
  }

  /* Expanded state */
  .oddity-note.expanded {
    width: ${NOTE_EXPANDED_WIDTH}px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.3);
    opacity: 1;
    z-index: 10;
  }

  .oddity-note.anchor-hovered:not(.expanded) {
    box-shadow: 0 6px 24px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.3);
  }

  .oddity-note.expanded .note-text {
    display: block;
    -webkit-line-clamp: unset;
    overflow: visible;
  }

  .note-expanded-content {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    margin-top: 0;
    transition: grid-template-rows 0.25s ease, opacity 0.2s ease, margin-top 0.2s ease;
  }

  .note-expanded-inner {
    overflow: hidden;
    min-height: 0;
  }

  .oddity-note.expanded .note-expanded-content {
    grid-template-rows: 1fr;
    opacity: 1;
    margin-top: 10px;
  }

  .note-section {
    margin-bottom: 8px;
  }

  .note-section-label {
    display: block;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.45);
    margin-bottom: 3px;
  }

  .note-section p {
    margin: 0;
    font-family: var(--oddity-note-font);
    font-style: normal;
    font-size: var(--oddity-note-size);
    line-height: 1.45;
    color: #FFFFFF;
  }

  .note-section ul {
    margin: 2px 0 0;
    padding-left: 16px;
    font-size: 12px;
    color: #FFFFFF;
  }

  .note-section li {
    margin-bottom: 1px;
  }

  /* ── Reply thread ── */
  .note-replies {
    max-height: 100px;
    overflow-y: auto;
    margin-top: 6px;
  }

  .note-reply-bubble {
    background: rgba(255,255,255,0.08);
    border-radius: 8px;
    padding: 4px 10px;
    font-size: var(--oddity-note-size);
    margin-bottom: 3px;
    word-break: break-word;
    font-family: 'Inter', system-ui, sans-serif;
    color: #FFFFFF;
  }

  /* ── Reply input bar (ace-input-row style) ── */
  .note-reply-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    margin-bottom: 14px;
  }

  .note-reply-input {
    all: unset;
    flex: 1;
    min-width: 0;
    background: #FFFFFF;
    border: 1px solid #DFE7EF;
    border-radius: 100px;
    padding: 5px 12px;
    font-size: var(--oddity-note-size);
    font-weight: 450;
    color: #293038;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    line-height: 1;
    box-sizing: border-box;
  }

  .note-reply-input::placeholder {
    color: #6D6D6D;
  }

  .note-reply-send {
    all: unset;
    cursor: pointer;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--note-color, #748DBF);
    color: #fff;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }

  .note-reply-send:hover {
    opacity: 0.85;
  }

  /* ── Feedback row ── */
  .note-feedback-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
  }

  .note-pill-group {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .note-icon-group {
    display: flex;
    gap: 6px;
  }

  /* Feedback pills (ace-quick style) */
  .note-feedback-pill {
    all: unset;
    cursor: pointer;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 12.5px;
    font-weight: 450;
    padding: 5px 12px;
    border-radius: 100px;
    background: var(--note-color);
    color: #fff;
    opacity: 1;
    transition: opacity 0.15s;
    white-space: nowrap;
  }

  .note-feedback-pill:hover {
    opacity: 0.8;
  }

  .note-feedback-pill.active {
    opacity: 1;
  }

  /* ── Icon theme switching (dark = white icons for dark mode, light = dark icons for light mode) ── */
  .icon-light { display: none; }
  .icon-dark { display: inline-flex; }
  :host([data-theme="light"]) .icon-light { display: inline-flex; }
  :host([data-theme="light"]) .icon-dark { display: none; }

  /* ── Arrow theme switching ── */
  /* Default: light arrow (white) for most colors */
  .arrow-light { display: inline-flex; }
  .arrow-dark { display: none; }

  /* Yellow (overview) in both modes: dark arrow */
  [data-annotation-type="core_claim"] .arrow-light,
  [data-annotation-type="evidence"] .arrow-light,
  [data-annotation-type="outcome"] .arrow-light,
  [data-annotation-type="background"] .arrow-light,
  [data-annotation-type="transition"] .arrow-light { display: none; }
  [data-annotation-type="core_claim"] .arrow-dark,
  [data-annotation-type="evidence"] .arrow-dark,
  [data-annotation-type="outcome"] .arrow-dark,
  [data-annotation-type="background"] .arrow-dark,
  [data-annotation-type="transition"] .arrow-dark { display: inline-flex; }

  /* Green (enrichment) in dark mode: dark arrow */
  :host(:not([data-theme="light"])) [data-annotation-type="insight"] .arrow-light,
  :host(:not([data-theme="light"])) [data-annotation-type="recall"] .arrow-light,
  :host(:not([data-theme="light"])) [data-annotation-type="study"] .arrow-light,
  :host(:not([data-theme="light"])) [data-annotation-type="translation"] .arrow-light,
  :host(:not([data-theme="light"])) [data-annotation-type="vocabulary"] .arrow-light { display: none; }
  :host(:not([data-theme="light"])) [data-annotation-type="insight"] .arrow-dark,
  :host(:not([data-theme="light"])) [data-annotation-type="recall"] .arrow-dark,
  :host(:not([data-theme="light"])) [data-annotation-type="study"] .arrow-dark,
  :host(:not([data-theme="light"])) [data-annotation-type="translation"] .arrow-dark,
  :host(:not([data-theme="light"])) [data-annotation-type="vocabulary"] .arrow-dark { display: inline-flex; }

  /* ── Dark text for yellow feedback pills (both modes) ── */
  [data-annotation-type="core_claim"] .note-feedback-pill,
  [data-annotation-type="evidence"] .note-feedback-pill,
  [data-annotation-type="outcome"] .note-feedback-pill,
  [data-annotation-type="background"] .note-feedback-pill,
  [data-annotation-type="transition"] .note-feedback-pill {
    color: #293038;
  }

  /* ── Dark text for green feedback pills (dark mode only) ── */
  :host(:not([data-theme="light"])) [data-annotation-type="insight"] .note-feedback-pill,
  :host(:not([data-theme="light"])) [data-annotation-type="recall"] .note-feedback-pill,
  :host(:not([data-theme="light"])) [data-annotation-type="study"] .note-feedback-pill,
  :host(:not([data-theme="light"])) [data-annotation-type="translation"] .note-feedback-pill,
  :host(:not([data-theme="light"])) [data-annotation-type="vocabulary"] .note-feedback-pill {
    color: #293038;
  }

  /* ── Green accent override in dark mode: #BFF3D3 ── */
  :host(:not([data-theme="light"])) [data-annotation-type="insight"],
  :host(:not([data-theme="light"])) [data-annotation-type="recall"],
  :host(:not([data-theme="light"])) [data-annotation-type="study"],
  :host(:not([data-theme="light"])) [data-annotation-type="translation"],
  :host(:not([data-theme="light"])) [data-annotation-type="vocabulary"] {
    --note-color: #BFF3D3;
  }


  /* Icon buttons */
  .note-icon-btn {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    color: #FFFFFF;
    transition: color 0.15s, background 0.15s;
  }

  .note-icon-btn:hover {
    color: #FFFFFF;
    background: rgba(255,255,255,0.08);
  }

  .note-icon-btn.note-delete-btn:hover {
    color: #f87171;
    background: rgba(248, 113, 113, 0.12);
  }

  /* ── Hide animation ── */
  .oddity-note.hiding {
    opacity: 0;
    transform: translateX(20px);
    transition: opacity 0.3s, transform 0.3s;
    pointer-events: none;
  }

  /* ── Edit mode ── */
  .note-edit-textarea {
    all: unset;
    display: block;
    width: 100%;
    font-size: var(--oddity-note-size);
    padding: 6px 10px;
    border: 1.5px solid rgba(255,255,255,0.15);
    border-radius: 8px;
    font-family: var(--oddity-note-font);
    resize: vertical;
    min-height: 48px;
    box-sizing: border-box;
    background: rgba(255,255,255,0.06);
    color: #FFFFFF;
    margin-top: 6px;
  }

  .note-edit-actions {
    display: flex;
    gap: 4px;
    margin-top: 6px;
    justify-content: flex-end;
  }

  .note-save-btn, .note-cancel-btn {
    all: unset;
    cursor: pointer;
    font-size: 10.5px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 100px;
    font-family: var(--oddity-note-font);
    transition: opacity 0.15s;
  }

  .note-save-btn {
    background: var(--note-color);
    color: #fff;
    opacity: 0.8;
  }

  .note-save-btn:hover {
    opacity: 1;
  }

  .note-cancel-btn {
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.12);
    color: rgba(255, 255, 255, 0.6);
  }

  .note-cancel-btn:hover {
    background: rgba(255,255,255,0.12);
  }

  .note-reaction-badge {
    font-size: 10px;
    margin-left: 4px;
  }

  .note-user-badge {
    font-size: 9px;
    background: rgba(255,255,255,0.1);
    color: rgba(255, 255, 255, 0.6);
    padding: 1px 5px;
    border-radius: 8px;
    margin-left: 4px;
    font-family: 'Inter', system-ui, sans-serif;
    font-weight: 500;
    text-transform: none;
    letter-spacing: normal;
  }

  /* ── Light mode overrides ── */
  :host([data-theme="light"]) .oddity-note {
    color: #293038;
    box-shadow: -4px 2px 10px rgba(0,0,0,0.10), -1px 1px 3px rgba(0,0,0,0.06);
  }

  :host([data-theme="light"]) .oddity-note.expanded {
    box-shadow: -5px 3px 16px rgba(0,0,0,0.13), -2px 1px 4px rgba(0,0,0,0.07);
  }

  :host([data-theme="light"]) .oddity-note.anchor-hovered:not(.expanded) {
    box-shadow: -5px 3px 20px rgba(0,0,0,0.2), -2px 1px 4px rgba(0,0,0,0.07);
  }

  :host([data-theme="light"]) .note-text,
  :host([data-theme="light"]) .note-section p,
  :host([data-theme="light"]) .note-section ul,
  :host([data-theme="light"]) .note-reply-bubble {
    color: #293038;
  }

  :host([data-theme="light"]) .note-edit-textarea {
    color: #293038;
    background: rgba(0,0,0,0.05);
    border-color: rgba(0,0,0,0.15);
  }

  :host([data-theme="light"]) .note-section-label {
    color: rgba(41, 48, 56, 0.45);
  }

  :host([data-theme="light"]) .note-icon-btn,
  :host([data-theme="light"]) .note-icon-btn:hover {
    color: #293038;
  }

  :host([data-theme="light"]) .note-cancel-btn {
    color: rgba(41, 48, 56, 0.7);
    background: rgba(0,0,0,0.06);
    border-color: rgba(0,0,0,0.12);
  }

  :host([data-theme="light"]) .note-user-badge {
    color: rgba(41, 48, 56, 0.6);
  }

  :host([data-theme="light"].has-dimmed) .oddity-note.expanded {
    box-shadow: -8px 4px 28px rgba(0,0,0,0.22), -3px 2px 8px rgba(0,0,0,0.12);
  }

  /* ── Timeline line (Overview mode) ── */
  .oddity-timeline-line {
    position: absolute;
    width: 2px;
    background: #DCAF16;
    opacity: 0.4;
    pointer-events: none;
    z-index: 0;
    border-radius: 1px;
    transition: opacity 0.25s ease;
  }

  :host(.has-dimmed) .oddity-timeline-line {
    opacity: 0.05;
  }

  /* ── Inline popover (Depth mode) ── */
  .oddity-note.oddity-note--inline {
    position: fixed;
    width: 320px;
    max-width: 90vw;
    pointer-events: auto;
    z-index: 10;
    box-shadow: 0 6px 24px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.3);
    opacity: 0;
    transform: translateY(4px) scale(0.98);
    animation: inlinePopoverIn 0.2s ease-out forwards;
  }

  .oddity-note.oddity-note--inline.expanded {
    width: 360px;
    max-width: 90vw;
    box-shadow: 0 10px 36px rgba(0,0,0,0.5), 0 4px 12px rgba(0,0,0,0.35);
  }

  @keyframes inlinePopoverIn {
    from {
      opacity: 0;
      transform: translateY(4px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

`;
