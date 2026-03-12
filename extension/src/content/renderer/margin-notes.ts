import type {
  Annotation,
  AnnotationFeedback,
  AnnotationFont,
  AnnotationFontSize,
  AnnotationType,
} from "@oddity/shared";
import { ANNOTATION_COLORS, ANNOTATION_LABELS } from "@oddity/shared";
import { sendMessage } from "../../shared/messaging.js";
import { removeAnchors } from "./anchors.js";
import {
  deemphasizeAnnotation,
  emphasizeAnnotation,
  removeAnnotation as removeAnnotationOverlay,
} from "./overlay.js";
import { addLiveFeedback } from "./arguments-box.js";
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
let userName: string | null = null;

const NOTE_EXPANDED_WIDTH = 220;
const NOTE_GAP = 10;
const MARGIN_PADDING = 16;
const MIN_MARGIN_WIDTH = 120;

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

  // Apply initial font/size from stored preferences
  chrome.storage.local.get("preferences", (result) => {
    const prefs = result["preferences"];
    if (prefs) {
      updateMarginNotesStyle(prefs.annotation_font, prefs.annotation_font_size);
    }
  });

  // Unpin on any click outside a card/anchor
  docClickHandler = () => { if (pinnedId) unpinAll(); };
  document.addEventListener("click", docClickHandler);

  startTracking();

  // Fetch user profile for name badge on manual annotations
  sendMessage({ action: "getProfile" } as any).then((p: any) => {
    userName = p?.display_name?.split(" ")[0] ?? null;
  }).catch(() => {});
}

export function addMarginNote(
  annotation: Annotation,
  range: Range,
  feedback: AnnotationFeedback[] = [],
  onDelete?: (annotationId: string) => void,
): void {
  if (!shadowRoot || !regionEl) return;
  // Deduplicate: skip if a note for this annotation already exists
  if (notes.some((n) => n.id === annotation.id)) return;

  const rects = range.getClientRects();
  if (rects.length === 0) return;

  const anchorTopPx = rects[0]!.top + window.scrollY;

  // Snapshot the region for this note — each note keeps its own reference
  // so multi-response chat pages position correctly per response.
  const noteRegion = regionEl;

  // Determine side using the content column bounds
  const bounds = getContentBounds(noteRegion, range);
  const leftMarginWidth = bounds.left - MARGIN_PADDING;
  const rightMarginWidth =
    window.innerWidth - bounds.right - MARGIN_PADDING;

  let side: "left" | "right";
  const preferLeft = noteIndex % 2 === 0;

  if (preferLeft && leftMarginWidth >= MIN_MARGIN_WIDTH) {
    side = "left";
  } else if (!preferLeft && rightMarginWidth >= MIN_MARGIN_WIDTH) {
    side = "right";
  } else if (leftMarginWidth >= MIN_MARGIN_WIDTH) {
    side = "left";
  } else if (rightMarginWidth >= MIN_MARGIN_WIDTH) {
    side = "right";
  } else {
    // Both margins too narrow — skip this note
    noteIndex++;
    return;
  }

  noteIndex++;

  const el = createNoteElement(annotation, side, feedback, onDelete);
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

export function removeMarginNote(annotationId: string): void {
  const idx = notes.findIndex((n) => n.id === annotationId);
  if (idx === -1) return;

  const note = notes[idx]!;
  note.element.remove();
  notes.splice(idx, 1);

  if (expandedId === annotationId) expandedId = null;

  resolveOverlaps();
  applyPositions();
}

export function clearMarginNotes(): void {
  for (const note of notes) {
    note.element.remove();
  }
  notes = [];
  noteIndex = 0;
  expandedId = null;
  pinnedId = null;
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
  if (pinnedId) {
    unpinAll();
  } else if (!justUnpinned) {
    pinnedId = annotationId;
    hostEl?.classList.add('has-pinned');
    expandMarginNote(annotationId);
    emphasizeAnnotation(annotationId);
    dimOtherNotes(annotationId);
  }
}

function unpinAll(): void {
  pinnedId = null;
  hostEl?.classList.remove('has-pinned');
  justUnpinned = true;
  setTimeout(() => { justUnpinned = false; }, 0);
  forceCollapseAll();
  undimAllNotes();
  deemphasizeAnnotation();
}

export function isAnyMarginNoteExpanded(): boolean {
  return expandedId !== null;
}

export function dimOtherNotes(annotationId: string): void {
  hostEl?.classList.add('has-dimmed');
  for (const note of notes) {
    if (note.id === annotationId) {
      note.element.classList.remove("dimmed");
    } else {
      note.element.classList.add("dimmed");
    }
  }
}

export function undimAllNotes(): void {
  hostEl?.classList.remove('has-dimmed');
  for (const note of notes) {
    note.element.classList.remove("dimmed");
  }
}

export function onAnchorHoverStart(annotationId: string): void {
  if (pinnedId && pinnedId !== annotationId) return;
  if (anchorHoverTimer) { clearTimeout(anchorHoverTimer); anchorHoverTimer = null; }
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  emphasizeAnnotation(annotationId);
  dimOtherNotes(annotationId);
  const note = notes.find((n) => n.id === annotationId);
  note?.element.classList.add('anchor-hovered');
}

export function onAnchorHoverEnd(): void {
  if (pinnedId) return;
  for (const note of notes) note.element.classList.remove('anchor-hovered');
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
}

export function updateMarginNotesStyle(
  font?: AnnotationFont,
  fontSize?: AnnotationFontSize,
): void {
  const host = shadowRoot?.host as HTMLElement;
  if (!host) return;
  host.style.setProperty("--oddity-note-font", FONT_MAP[font ?? "default"]);
  host.style.setProperty("--oddity-note-size", SIZE_MAP[fontSize ?? "default"]);
}

// ─── Note Element Construction ───

function createNoteElement(
  annotation: Annotation,
  side: "left" | "right",
  feedback: AnnotationFeedback[] = [],
  onDelete?: (annotationId: string) => void,
): HTMLDivElement {
  const color = ANNOTATION_COLORS[annotation.type];
  const label = ANNOTATION_LABELS[annotation.type];
  const isManual = annotation.id.startsWith("manual-");

  const el = document.createElement("div");
  el.className = `oddity-note ${side}`;
  el.dataset.annotationId = annotation.id;
  el.dataset.annotationType = annotation.type;
  el.style.setProperty("--note-color", color);

  // Bracket
  const bracket = document.createElement("div");
  bracket.className = "note-bracket";
  bracket.style.borderColor = color;

  // Label
  const labelEl = document.createElement("span");
  labelEl.className = "note-label";
  labelEl.style.color = color;
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
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const latestThumb = thumbFeedback[0] ?? null;
  const existingThumbUp = latestThumb?.feedback_type === "thumbs_up" ? latestThumb : null;
  const existingThumbDown = latestThumb?.feedback_type === "thumbs_down" ? latestThumb : null;
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
    editBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      enterEditMode(el, annotation, textEl);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "note-icon-btn note-delete-btn";
    deleteBtn.title = "Delete";
    deleteBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (onDelete) onDelete(annotation.id);
      sendMessage({
        action: "deleteAnnotation",
        payload: {
          annotationId: annotation.id,
          url: window.location.href,
          contentHash: getAnnotationContentHash(annotation),
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
      bubble.textContent = reply.reply_text ?? "";
      repliesContainer.appendChild(bubble);
    }
    expandedContent.appendChild(repliesContainer);

    // Reply input bar
    const replyBar = document.createElement("div");
    replyBar.className = "note-reply-bar";
    const replyInput = document.createElement("input");
    replyInput.type = "text";
    replyInput.placeholder = "Thoughts?";
    replyInput.className = "note-reply-input";
    replyInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && replyInput.value.trim()) {
        submitReply(annotation, replyInput, repliesContainer);
      }
    });
    const sendBtn = document.createElement("button");
    sendBtn.className = "note-reply-send";
    sendBtn.innerHTML = "&#8593;"; // up arrow
    sendBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (replyInput.value.trim()) {
        submitReply(annotation, replyInput, repliesContainer);
      }
    });
    replyBar.appendChild(replyInput);
    replyBar.appendChild(sendBtn);
    expandedContent.appendChild(replyBar);

    // Feedback row (thumbs)
    const feedbackRow = document.createElement("div");
    feedbackRow.className = "note-feedback-row";

    let currentFeedbackId: string | null = existingThumbUp?.id ?? existingThumbDown?.id ?? null;

    const thumbUp = document.createElement("button");
    thumbUp.className = "note-feedback-pill" + (existingThumbUp ? " active" : "");
    thumbUp.textContent = "Exactly!";
    thumbUp.title = "Helpful";
    thumbUp.addEventListener("click", (e) => {
      e.stopPropagation();
      if (thumbUp.classList.contains("active")) {
        // Undo thumbs up
        thumbUp.classList.remove("active");
        reactionBadge = updateReactionBadge(labelEl, reactionBadge, "thumbs_up", false);
        if (currentFeedbackId) {
          sendMessage({ action: "deleteFeedback", payload: { feedbackId: currentFeedbackId } });
          currentFeedbackId = null;
        }
      } else {
        // Activate thumbs up, deactivate thumbs down
        thumbUp.classList.add("active");
        thumbDown.classList.remove("active");
        reactionBadge = updateReactionBadge(labelEl, reactionBadge, "thumbs_up", true);
        addLiveFeedback("✓", annotation.content.note);
        const doSave = () =>
          sendMessage({
            action: "saveFeedback",
            payload: {
              annotationId: annotation.id,
              contentHash: getAnnotationContentHash(annotation),
              url: window.location.href,
              feedbackType: "thumbs_up",
              pageTitle: document.title,
            },
          }).then((fb: any) => {
            if (fb?.id) currentFeedbackId = fb.id;
          });
        if (currentFeedbackId) {
          sendMessage({ action: "deleteFeedback", payload: { feedbackId: currentFeedbackId } })
            .then(() => { currentFeedbackId = null; return doSave(); });
        } else {
          doSave();
        }
      }
    });

    const thumbDown = document.createElement("button");
    thumbDown.className = "note-feedback-pill note-feedback-pill--negative" + (existingThumbDown ? " active" : "");
    thumbDown.textContent = "Hmm..?";
    thumbDown.title = "Not helpful";
    thumbDown.addEventListener("click", (e) => {
      e.stopPropagation();
      if (thumbDown.classList.contains("active")) {
        // Undo thumbs down
        thumbDown.classList.remove("active");
        reactionBadge = updateReactionBadge(labelEl, reactionBadge, "thumbs_down", false);
        if (currentFeedbackId) {
          sendMessage({ action: "deleteFeedback", payload: { feedbackId: currentFeedbackId } });
          currentFeedbackId = null;
        }
      } else {
        // Activate thumbs down, deactivate thumbs up
        thumbDown.classList.add("active");
        thumbUp.classList.remove("active");
        reactionBadge = updateReactionBadge(labelEl, reactionBadge, "thumbs_down", true);
        addLiveFeedback("✗", annotation.content.note);
        const doSave = () =>
          sendMessage({
            action: "saveFeedback",
            payload: {
              annotationId: annotation.id,
              contentHash: getAnnotationContentHash(annotation),
              url: window.location.href,
              feedbackType: "thumbs_down",
              pageTitle: document.title,
            },
          }).then((fb: any) => {
            if (fb?.id) currentFeedbackId = fb.id;
          });
        if (currentFeedbackId) {
          sendMessage({ action: "deleteFeedback", payload: { feedbackId: currentFeedbackId } })
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
  const expandedInner = document.createElement('div');
  expandedInner.className = 'note-expanded-inner';
  while (expandedContent.firstChild) {
    expandedInner.appendChild(expandedContent.firstChild);
  }
  expandedContent.appendChild(expandedInner);

  el.appendChild(bracket);
  el.appendChild(labelEl);
  el.appendChild(textEl);
  el.appendChild(expandedContent);

  // Hover expand/collapse + overlay emphasis
  el.addEventListener("mouseenter", () => {
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
    e.stopPropagation();
    // Don't unpin when clicking interactive elements inside the card
    if ((e.target as HTMLElement).closest('button, input, textarea')) return;
    if (pinnedId) {
      unpinAll();
    } else if (!justUnpinned) {
      pinnedId = annotation.id;
      hostEl?.classList.add('has-pinned');
      expandMarginNote(annotation.id);
      emphasizeAnnotation(annotation.id);
      dimOtherNotes(annotation.id);
    }
  });

  el.addEventListener("mouseleave", () => {
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

function getAnnotationContentHash(_annotation: Annotation): string {
  // Get the content hash from the closest region element
  const hashEl = document.querySelector(
    "[data-oddity-hash]",
  ) as HTMLElement | null;
  return hashEl?.dataset.oddityHash ?? "";
}

function submitReply(
  annotation: Annotation,
  input: HTMLInputElement,
  container: HTMLDivElement,
): void {
  const text = input.value.trim();
  if (!text) return;

  // Add bubble immediately
  const bubble = document.createElement("div");
  bubble.className = "note-reply-bubble";
  bubble.textContent = text;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;

  // Send to background
  sendMessage({
    action: "saveFeedback",
    payload: {
      annotationId: annotation.id,
      contentHash: getAnnotationContentHash(annotation),
      url: window.location.href,
      feedbackType: "reply",
      replyText: text,
      pageTitle: document.title,
    },
  });

  const excerpt = annotation.content.note.length > 60
    ? annotation.content.note.slice(0, 57) + "..."
    : annotation.content.note;
  addLiveFeedback("↳", `Re "${excerpt}": ${text}`);

  input.value = "";
}

function enterEditMode(
  noteEl: HTMLDivElement,
  annotation: Annotation,
  textEl: HTMLDivElement,
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
        url: window.location.href,
        contentHash: getAnnotationContentHash(annotation),
        pageTitle: document.title,
      },
    }).then(() => {
      annotation.content.note = newNote;
      textEl.textContent = newNote;
      exitEditMode(noteEl, textarea, editActions, textEl);
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
  const leftNotes = notes.filter(
    (n) => n.side === "left" && n.element.style.display !== "none",
  );
  const rightNotes = notes.filter(
    (n) => n.side === "right" && n.element.style.display !== "none",
  );

  resolveOverlapsForSide(leftNotes);
  resolveOverlapsForSide(rightNotes);
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
  for (const note of notes) {
    const bounds = getContentBounds(note.region, note.range);
    const contentLeft = bounds.left + window.scrollX;
    const contentRight = bounds.right + window.scrollX;

    // Always use `left` positioning — `right` depends on the containing
    // block width which varies across pages and changes on scroll/resize.
    note.element.style.right = "auto";

    if (note.side === "left") {
      const noteWidth = note.element.offsetWidth || NOTE_EXPANDED_WIDTH;
      const rightEdge = contentLeft - MARGIN_PADDING;
      note.element.style.left = `${rightEdge - noteWidth}px`;
    } else {
      note.element.style.left = `${contentRight + MARGIN_PADDING}px`;
    }
    note.element.style.top = `${note.topPx}px`;
  }
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
    if (!note.element.classList.contains('expanded')) {
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
    padding: 10px 12px;
    font-family: var(--oddity-note-font);
    font-size: var(--oddity-note-size);
    line-height: 1.45;
    color: #FFFFFF;
    pointer-events: auto;
    cursor: default;
    background: rgba(255, 255, 255, 0.15);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-radius: 12px;
    box-shadow: 0 3px 14px rgba(0,0,0,0.35), 0 1px 3px rgba(0,0,0,0.2);
    opacity: 1;
    transition: opacity 0.25s ease-in, filter 0.25s ease-in, box-shadow 0.2s;
    box-sizing: border-box;
  }

  .oddity-note:hover {
    opacity: 1;
  }

  .oddity-note.dimmed {
    opacity: 0.45;
    filter: grayscale(0.6);
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
    font-weight: 900;
    letter-spacing: normal;
    text-transform: lowercase;
    margin-bottom: 4px;
  }

  .note-label::first-letter {
    text-transform: uppercase;
  }

  .note-text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    word-break: break-word;
    font-family: var(--oddity-note-font);
    font-style: normal;
    font-size: var(--oddity-note-size);
    font-weight: 250;
    line-height: 1.45;
    color: #FFFFFF;
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
    gap: 6px;
    margin-top: 10px;
    margin-bottom: 7px;
  }

  .note-reply-input {
    all: unset;
    flex: 1;
    min-width: 0;
    background: #DFE7EF;
    border-radius: 100px;
    padding: 5px 12px;
    font-size: var(--oddity-note-size);
    font-weight: 450;
    color: #293038;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    line-height: 1;
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
    background: var(--note-color, #c4913a);
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
    gap: 5px;
    flex-wrap: wrap;
  }

  .note-icon-group {
    display: flex;
    gap: 2px;
  }

  /* Feedback pills (ace-quick style) */
  .note-feedback-pill {
    all: unset;
    cursor: pointer;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 11.5px;
    font-weight: 450;
    padding: 4px 10px;
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

  /* Dark text for light accent colors */
  [data-annotation-type="highlight"] .note-feedback-pill,
  [data-annotation-type="insight"] .note-feedback-pill {
    color: #293038;
  }

  /* Dark arrow for light-colored send buttons */
  [data-annotation-type="insight"] .note-reply-send,
  [data-annotation-type="highlight"] .note-reply-send {
    color: #293038;
  }

  /* Vocab and recall label color override */
  [data-annotation-type="vocabulary"] .note-label,
  [data-annotation-type="recall"] .note-label {
    color: #779EDA !important;
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
    font-size: 12px;
    padding: 6px 10px;
    border: 1.5px solid rgba(255,255,255,0.15);
    border-radius: 8px;
    font-family: 'Inter', system-ui, sans-serif;
    resize: vertical;
    min-height: 48px;
    box-sizing: border-box;
    background: rgba(255,255,255,0.06);
    color: #FFFFFF;
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
    font-family: 'Inter', system-ui, sans-serif;
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
  :host([data-theme="light"]) .note-reply-bubble,
  :host([data-theme="light"]) .note-edit-textarea {
    color: #293038;
  }

  :host([data-theme="light"]) .note-section-label {
    color: rgba(41, 48, 56, 0.45);
  }

  :host([data-theme="light"]) .note-icon-btn,
  :host([data-theme="light"]) .note-icon-btn:hover {
    color: #293038;
  }

  :host([data-theme="light"]) .note-cancel-btn {
    color: rgba(41, 48, 56, 0.6);
  }

  :host([data-theme="light"]) .note-user-badge {
    color: rgba(41, 48, 56, 0.6);
  }

  :host([data-theme="light"]) [data-annotation-type="highlight"] .note-label {
    color: #EAB308 !important;
  }

  :host([data-theme="light"]) [data-annotation-type="recall"] .note-label,
  :host([data-theme="light"]) [data-annotation-type="vocabulary"] .note-label {
    color: #243C61 !important;
  }

  :host([data-theme="light"]) [data-annotation-type="insight"] .note-label {
    color: #70AC87 !important;
  }

  :host([data-theme="light"].has-dimmed) .oddity-note.expanded {
    box-shadow: -8px 4px 28px rgba(0,0,0,0.22), -3px 2px 8px rgba(0,0,0,0.12);
  }

`;
