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
  side: "left" | "right";
  anchorTopPx: number;
  topPx: number;
  height: number;
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
let collapseTimer: ReturnType<typeof setTimeout> | null = null;
let anchorHoverTimer: ReturnType<typeof setTimeout> | null = null;
let needsRedraw = false;
let fontLink: HTMLLinkElement | null = null;
let themeHandler: ((mode: "light" | "dark") => void) | null = null;
let userName: string | null = null;

const NOTE_MAX_WIDTH = 180;
const NOTE_EXPANDED_WIDTH = 220;
const NOTE_GAP = 10;
const MARGIN_PADDING = 16;
const MIN_MARGIN_WIDTH = 120;

const FONT_MAP: Record<AnnotationFont, string> = {
  default: "system-ui, -apple-system, 'Segoe UI', sans-serif",
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
      "https://fonts.googleapis.com/css2?family=Kalam:wght@400&display=swap";
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

  // Determine side
  const regionRect = regionEl.getBoundingClientRect();
  const leftMarginWidth = regionRect.left - MARGIN_PADDING;
  const rightMarginWidth =
    window.innerWidth - regionRect.right - MARGIN_PADDING;

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
    side,
    anchorTopPx,
    topPx: anchorTopPx,
    height: 0,
    element: el,
  };

  notes.push(note);

  // Measure height in next frame, then resolve overlaps
  requestAnimationFrame(() => {
    note.height = el.offsetHeight;
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
  if (expandedId) {
    const note = notes.find((n) => n.id === expandedId);
    if (note) note.element.classList.remove("expanded");
    expandedId = null;
  }
}

export function isAnyMarginNoteExpanded(): boolean {
  return expandedId !== null;
}

export function dimOtherNotes(annotationId: string): void {
  for (const note of notes) {
    if (note.id === annotationId) {
      note.element.classList.remove("dimmed");
    } else {
      note.element.classList.add("dimmed");
    }
  }
}

export function undimAllNotes(): void {
  for (const note of notes) {
    note.element.classList.remove("dimmed");
  }
}

export function onAnchorHoverStart(annotationId: string): void {
  if (anchorHoverTimer) { clearTimeout(anchorHoverTimer); anchorHoverTimer = null; }
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  expandMarginNote(annotationId);
  emphasizeAnnotation(annotationId);
  dimOtherNotes(annotationId);
}

export function onAnchorHoverEnd(): void {
  anchorHoverTimer = setTimeout(() => {
    collapseAllMarginNotes();
    undimAllNotes();
    anchorHoverTimer = null;
  }, 300);
  deemphasizeAnnotation();
}

export function destroyMarginNotes(): void {
  stopTracking();
  if (themeHandler) {
    offThemeChange(themeHandler);
    themeHandler = null;
  }
  hostEl?.remove();
  hostEl = null;
  shadowRoot = null;
  notes = [];
  noteIndex = 0;
  expandedId = null;
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
        const doSave = () =>
          sendMessage({
            action: "saveFeedback",
            payload: {
              annotationId: annotation.id,
              contentHash: getAnnotationContentHash(annotation),
              url: window.location.href,
              feedbackType: "thumbs_up",
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
        const doSave = () =>
          sendMessage({
            action: "saveFeedback",
            payload: {
              annotationId: annotation.id,
              contentHash: getAnnotationContentHash(annotation),
              url: window.location.href,
              feedbackType: "thumbs_down",
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

  el.appendChild(bracket);
  el.appendChild(labelEl);
  el.appendChild(textEl);
  el.appendChild(expandedContent);

  // Hover expand/collapse + overlay emphasis
  el.addEventListener("mouseenter", () => {
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
    if (anchorHoverTimer) {
      clearTimeout(anchorHoverTimer);
      anchorHoverTimer = null;
    }
    expandMarginNote(annotation.id);
    emphasizeAnnotation(annotation.id);
    dimOtherNotes(annotation.id);
  });

  el.addEventListener("mouseleave", () => {
    collapseTimer = setTimeout(() => {
      collapseAllMarginNotes();
      undimAllNotes();
      collapseTimer = null;
    }, 300);
    deemphasizeAnnotation();
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
    },
  });

  input.value = "";
}

function enterEditMode(
  noteEl: HTMLDivElement,
  annotation: Annotation,
  textEl: HTMLDivElement,
): void {
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
  if (!regionEl) return;

  const regionRect = regionEl.getBoundingClientRect();
  const regionLeft = regionRect.left + window.scrollX;
  const regionRight = regionRect.right + window.scrollX;

  for (const note of notes) {
    if (note.side === "left") {
      const rightEdge = regionLeft - MARGIN_PADDING;
      note.element.style.left = "auto";
      note.element.style.right = `${hostEl!.offsetWidth - rightEdge}px`;
    } else {
      note.element.style.right = "auto";
      note.element.style.left = `${regionRight + MARGIN_PADDING}px`;
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
    note.height = note.element.offsetHeight;
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
    --oddity-note-font: system-ui, -apple-system, 'Segoe UI', sans-serif;
    --oddity-note-size: 14px;
  }

  .oddity-note {
    position: absolute;
    max-width: ${NOTE_MAX_WIDTH}px;
    padding: 6px 10px;
    font-family: var(--oddity-note-font);
    font-size: var(--oddity-note-size);
    line-height: 1.4;
    color: #374151;
    pointer-events: auto;
    cursor: default;
    opacity: 0.85;
    transition: opacity 0.15s, max-width 0.2s, box-shadow 0.2s;
    box-sizing: border-box;
  }

  .oddity-note:hover {
    opacity: 1;
  }

  .oddity-note.dimmed {
    opacity: 0.5;
    filter: grayscale(0.8);
    transition: opacity 0.15s, filter 0.15s;
  }

  /* Bracket on text-facing edge */
  .note-bracket {
    position: absolute;
    top: 4px;
    bottom: 4px;
    width: 6px;
    border-style: solid;
    border-width: 0;
  }

  /* Right-side notes: bracket on left edge */
  .oddity-note.right .note-bracket {
    left: 0;
    border-left-width: 2px;
    border-top-width: 2px;
    border-bottom-width: 2px;
  }

  .oddity-note.left {
    text-align: right;
  }

  .oddity-note.left.expanded {
    text-align: left;
  }

  /* Left-side notes: bracket on right edge */
  .oddity-note.left .note-bracket {
    right: 0;
    border-right-width: 2px;
    border-top-width: 2px;
    border-bottom-width: 2px;
  }

  .note-label {
    display: block;
    font-family: var(--oddity-note-font);
    font-style: italic;
    font-size: 13px;
    font-weight: 700;
    margin-bottom: 2px;
  }

  .note-text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    word-break: break-word;
  }

  /* Expanded state */
  .oddity-note.expanded {
    max-width: ${NOTE_EXPANDED_WIDTH}px;
    background: white;
    box-shadow: 0 2px 8px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.08);
    border-radius: 4px;
    padding: 8px 12px;
    opacity: 1;
    z-index: 10;
    border-left: 3px solid var(--note-color);
  }

  .oddity-note.expanded .note-bracket {
    display: none;
  }

  .oddity-note.expanded .note-text {
    display: block;
    -webkit-line-clamp: unset;
    overflow: visible;
  }

  .note-expanded-content {
    display: none;
  }

  .oddity-note.expanded .note-expanded-content {
    display: block;
    margin-top: 6px;
  }

  .note-section {
    margin-top: 6px;
  }

  .note-section-label {
    display: block;
    font-size: 11px;
    font-weight: 700;
    color: #374151;
    margin-bottom: 1px;
    font-family: system-ui, -apple-system, sans-serif;
  }

  .note-section p {
    margin: 0;
    font-size: calc(var(--oddity-note-size) - 1px);
  }

  .note-section ul {
    margin: 2px 0 0;
    padding-left: 16px;
    font-size: 12px;
  }

  .note-section li {
    margin-bottom: 1px;
  }

  .note-icon-btn {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    color: #64748b;
    opacity: 0.5;
    transition: opacity 0.15s, background 0.15s, color 0.15s;
  }

  .note-icon-btn:hover {
    opacity: 0.7;
    background: #f1f5f9;
  }

  .note-icon-btn.note-delete-btn:hover {
    color: #ef4444;
    background: #fef2f2;
  }

  /* ── Dark-mode overrides ── */
  :host([data-theme="dark"]) .oddity-note {
    color: #e2e8f0;
  }

  :host([data-theme="dark"]) .oddity-note.dimmed {
    opacity: 0.4;
  }

  :host([data-theme="dark"]) .oddity-note.expanded {
    background: #1a1a2e;
    box-shadow: 0 2px 12px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.3);
  }

  :host([data-theme="dark"]) .note-section-label {
    color: #cbd5e1;
  }

  :host([data-theme="dark"]) .note-icon-btn {
    color: #94a3b8;
  }

  :host([data-theme="dark"]) .note-icon-btn:hover {
    background: #334155;
  }

  :host([data-theme="dark"]) .note-icon-btn.note-delete-btn:hover {
    color: #f87171;
    background: #451a1a;
  }

  :host([data-theme="dark"]) .note-feedback-pill {
    background: transparent;
    border: 1px solid var(--note-color);
    color: var(--note-color);
  }

  :host([data-theme="dark"]) .note-feedback-pill.active {
    background: var(--note-color);
    color: #fff;
  }

  /* ── Hide animation ── */
  .oddity-note.hiding {
    opacity: 0;
    transform: translateX(20px);
    transition: opacity 0.3s, transform 0.3s;
    pointer-events: none;
  }

  /* ── Reply thread ── */
  .note-replies {
    max-height: 120px;
    overflow-y: auto;
    margin-top: 6px;
  }

  .note-reply-bubble {
    background: #f1f5f9;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    margin-bottom: 3px;
    word-break: break-word;
    font-family: system-ui, -apple-system, sans-serif;
  }

  :host([data-theme="dark"]) .note-reply-bubble {
    background: #334155;
    color: #e2e8f0;
  }

  /* ── Reply input bar ── */
  .note-reply-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 6px;
  }

  .note-reply-input {
    all: unset;
    flex: 1;
    font-size: 11px;
    padding: 4px 8px;
    border: 1px solid #e2e8f0;
    border-radius: 4px;
    font-family: system-ui, -apple-system, sans-serif;
    background: #fff;
    color: #1a1a1a;
  }

  :host([data-theme="dark"]) .note-reply-input {
    border-color: #475569;
    background: #1e293b;
    color: #e2e8f0;
  }

  .note-reply-send {
    all: unset;
    cursor: pointer;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--note-color, #1a1a1a);
    color: #fff;
    font-size: 12px;
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
    gap: 6px;
  }

  .note-icon-group {
    display: flex;
    gap: 2px;
  }

  .note-feedback-pill {
    all: unset;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 4px;
    font-family: system-ui, -apple-system, sans-serif;
    background: var(--note-color);
    color: #fff;
    opacity: 0.45;
    transition: opacity 0.15s;
  }

  .note-feedback-pill:hover {
    opacity: 0.7;
  }

  .note-feedback-pill.active {
    opacity: 1;
  }

  /* ── Edit mode ── */
  .note-edit-textarea {
    all: unset;
    display: block;
    width: 100%;
    font-size: 12px;
    padding: 4px 6px;
    border: 1px solid #1a1a1a;
    border-radius: 4px;
    font-family: var(--oddity-note-font);
    resize: vertical;
    min-height: 48px;
    box-sizing: border-box;
    background: #fff;
    color: #1a1a1a;
  }

  :host([data-theme="dark"]) .note-edit-textarea {
    background: #1e293b;
    color: #e2e8f0;
    border-color: #1a1a1a;
  }

  .note-edit-actions {
    display: flex;
    gap: 4px;
    margin-top: 4px;
    justify-content: flex-end;
  }

  .note-save-btn, .note-cancel-btn {
    all: unset;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 3px;
    font-family: system-ui, -apple-system, sans-serif;
    transition: background 0.15s;
  }

  .note-save-btn {
    color: #1a1a1a;
  }

  .note-save-btn:hover {
    background: #f3f4f6;
  }

  .note-cancel-btn {
    color: #6b7280;
  }

  .note-cancel-btn:hover {
    background: #f3f4f6;
  }

  :host([data-theme="dark"]) .note-save-btn:hover {
    background: #334155;
  }

  :host([data-theme="dark"]) .note-cancel-btn:hover {
    background: #334155;
  }

  .note-reaction-badge {
    font-size: 10px;
    margin-left: 4px;
  }

  .note-user-badge {
    font-size: 9px;
    background: #E5E7EB;
    color: #6B7280;
    padding: 1px 5px;
    border-radius: 8px;
    margin-left: 4px;
    font-family: system-ui, -apple-system, sans-serif;
    font-weight: 500;
    text-transform: none;
    letter-spacing: normal;
  }

  :host([data-theme="dark"]) .note-user-badge {
    background: #334155;
    color: #94a3b8;
  }

`;
