import type { Annotation, AnnotationFeedback, AnnotationFont, AnnotationFontSize, AnnotationType } from '@oddity/shared';
import { ANNOTATION_COLORS, ANNOTATION_LABELS } from '@oddity/shared';
import { sendMessage } from '../../shared/messaging.js';
import { emphasizeAnnotation, deemphasizeAnnotation, removeAnnotation as removeAnnotationOverlay } from './overlay.js';
import { removeAnchors } from './anchors.js';
import { getThemeMode, onThemeChange, offThemeChange } from './theme-detector.js';

// ─── Types ───

type MarginNote = {
  id: string;
  annotation: Annotation;
  range: Range;
  side: 'left' | 'right';
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
let needsRedraw = false;
let fontLink: HTMLLinkElement | null = null;
let themeHandler: ((mode: 'light' | 'dark') => void) | null = null;

const NOTE_MAX_WIDTH = 180;
const NOTE_EXPANDED_WIDTH = 220;
const NOTE_GAP = 10;
const MARGIN_PADDING = 16;
const MIN_MARGIN_WIDTH = 120;

const FONT_MAP: Record<AnnotationFont, string> = {
  default: "'Kalam', cursive, system-ui, sans-serif",
  helvetica: "Helvetica, 'Helvetica Neue', Arial, sans-serif",
  arial: "Arial, 'Helvetica Neue', sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
};
const SIZE_MAP: Record<AnnotationFontSize, string> = { small: '11px', default: '13px', large: '15px' };

// ─── Public API ───

export function initMarginNotes(region: Element): void {
  regionEl = region;

  // Load Kalam font globally (font-face is always global, shadow DOM elements reference by name)
  if (!fontLink) {
    fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Kalam:wght@400&display=swap';
    document.head.appendChild(fontLink);
  }

  if (hostEl) return;

  hostEl = document.createElement('div');
  hostEl.id = 'oddity-margin-notes';
  hostEl.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; pointer-events: none; z-index: 2147483645;';
  document.body.appendChild(hostEl);

  shadowRoot = hostEl.attachShadow({ mode: 'closed' });

  // Theme detection
  hostEl.dataset.theme = getThemeMode();
  themeHandler = (mode) => {
    if (hostEl) hostEl.dataset.theme = mode;
  };
  onThemeChange(themeHandler);

  const style = document.createElement('style');
  style.textContent = MARGIN_NOTES_CSS;
  shadowRoot.appendChild(style);

  // Apply initial font/size from stored preferences
  chrome.storage.local.get('preferences', (result) => {
    const prefs = result['preferences'];
    if (prefs) {
      updateMarginNotesStyle(prefs.annotation_font, prefs.annotation_font_size);
    }
  });

  startTracking();
}

export function addMarginNote(annotation: Annotation, range: Range, feedback: AnnotationFeedback[] = []): void {
  if (!shadowRoot || !regionEl) return;
  // Deduplicate: skip if a note for this annotation already exists
  if (notes.some((n) => n.id === annotation.id)) return;

  const rects = range.getClientRects();
  if (rects.length === 0) return;

  const anchorTopPx = rects[0]!.top + window.scrollY;

  // Determine side
  const regionRect = regionEl.getBoundingClientRect();
  const leftMarginWidth = regionRect.left - MARGIN_PADDING;
  const rightMarginWidth = window.innerWidth - regionRect.right - MARGIN_PADDING;

  let side: 'left' | 'right';
  const preferLeft = noteIndex % 2 === 0;

  if (preferLeft && leftMarginWidth >= MIN_MARGIN_WIDTH) {
    side = 'left';
  } else if (!preferLeft && rightMarginWidth >= MIN_MARGIN_WIDTH) {
    side = 'right';
  } else if (leftMarginWidth >= MIN_MARGIN_WIDTH) {
    side = 'left';
  } else if (rightMarginWidth >= MIN_MARGIN_WIDTH) {
    side = 'right';
  } else {
    // Both margins too narrow — skip this note
    noteIndex++;
    return;
  }

  noteIndex++;

  const el = createNoteElement(annotation, side, feedback);
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
    hostEl.style.display = v ? '' : 'none';
  }
}

export function filterMarginNotesByTypes(types: AnnotationType[]): void {
  const typeSet = new Set(types);
  hiddenTypes = new Set<AnnotationType>();

  for (const note of notes) {
    const isVisible = typeSet.has(note.annotation.type);
    note.element.style.display = isVisible ? '' : 'none';
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
    if (prev) prev.element.classList.remove('expanded');
  }

  expandedId = annotationId;
  note.element.classList.add('expanded');
}

export function collapseAllMarginNotes(): void {
  if (expandedId) {
    const note = notes.find((n) => n.id === expandedId);
    if (note) note.element.classList.remove('expanded');
    expandedId = null;
  }
}

export function isAnyMarginNoteExpanded(): boolean {
  return expandedId !== null;
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

export function updateMarginNotesStyle(font?: AnnotationFont, fontSize?: AnnotationFontSize): void {
  const host = shadowRoot?.host as HTMLElement;
  if (!host) return;
  host.style.setProperty('--oddity-note-font', FONT_MAP[font ?? 'default']);
  host.style.setProperty('--oddity-note-size', SIZE_MAP[fontSize ?? 'default']);
}

// ─── Note Element Construction ───

function createNoteElement(annotation: Annotation, side: 'left' | 'right', feedback: AnnotationFeedback[] = []): HTMLDivElement {
  const color = ANNOTATION_COLORS[annotation.type];
  const label = ANNOTATION_LABELS[annotation.type];
  const isManual = annotation.id.startsWith('manual-');

  const el = document.createElement('div');
  el.className = `oddity-note ${side}`;
  el.dataset.annotationId = annotation.id;
  el.dataset.annotationType = annotation.type;

  // Bracket
  const bracket = document.createElement('div');
  bracket.className = 'note-bracket';
  bracket.style.borderColor = color;

  // Label
  const labelEl = document.createElement('span');
  labelEl.className = 'note-label';
  labelEl.style.color = color;
  labelEl.textContent = label;

  // Note text (collapsed: truncated)
  const textEl = document.createElement('div');
  textEl.className = 'note-text';
  textEl.textContent = annotation.content.note;

  // Expanded content (hidden by default, shown on .expanded)
  const expandedContent = document.createElement('div');
  expandedContent.className = 'note-expanded-content';

  if (annotation.content.why_it_matters) {
    const section = createSection('Why it matters', annotation.content.why_it_matters);
    expandedContent.appendChild(section);
  }

  if (annotation.content.question) {
    const section = createSection('Question', annotation.content.question);
    expandedContent.appendChild(section);
  }

  if (annotation.content.suggestions && annotation.content.suggestions.length > 0) {
    const sectionEl = document.createElement('div');
    sectionEl.className = 'note-section';
    const sLabel = document.createElement('span');
    sLabel.className = 'note-section-label';
    sLabel.textContent = 'Suggestions';
    sectionEl.appendChild(sLabel);
    const ul = document.createElement('ul');
    for (const s of annotation.content.suggestions) {
      const li = document.createElement('li');
      li.textContent = s;
      ul.appendChild(li);
    }
    sectionEl.appendChild(ul);
    expandedContent.appendChild(sectionEl);
  }

  if (isManual) {
    // ── User annotation: Edit + Delete ──
    const actions = document.createElement('div');
    actions.className = 'note-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'note-action-btn note-edit-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      enterEditMode(el, annotation, textEl);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'note-action-btn note-delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sendMessage({
        action: 'deleteAnnotation',
        payload: { annotationId: annotation.id },
      });
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    expandedContent.appendChild(actions);
  } else {
    // ── AI annotation: Reply thread + Feedback row ──

    // Reply thread
    const replies = feedback.filter((f) => f.feedback_type === 'reply');
    const repliesContainer = document.createElement('div');
    repliesContainer.className = 'note-replies';
    for (const reply of replies) {
      const bubble = document.createElement('div');
      bubble.className = 'note-reply-bubble';
      bubble.textContent = reply.reply_text ?? '';
      repliesContainer.appendChild(bubble);
    }
    expandedContent.appendChild(repliesContainer);

    // Reply input bar
    const replyBar = document.createElement('div');
    replyBar.className = 'note-reply-bar';
    const replyInput = document.createElement('input');
    replyInput.type = 'text';
    replyInput.placeholder = 'Reply...';
    replyInput.className = 'note-reply-input';
    replyInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && replyInput.value.trim()) {
        submitReply(annotation, replyInput, repliesContainer);
      }
    });
    const sendBtn = document.createElement('button');
    sendBtn.className = 'note-reply-send';
    sendBtn.innerHTML = '&#8593;'; // up arrow
    sendBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (replyInput.value.trim()) {
        submitReply(annotation, replyInput, repliesContainer);
      }
    });
    replyBar.appendChild(replyInput);
    replyBar.appendChild(sendBtn);
    expandedContent.appendChild(replyBar);

    // Feedback row (thumbs)
    const feedbackRow = document.createElement('div');
    feedbackRow.className = 'note-feedback-row';

    const existingThumbsUp = feedback.find((f) => f.feedback_type === 'thumbs_up');

    const thumbUp = document.createElement('button');
    thumbUp.className = 'note-thumb-btn' + (existingThumbsUp ? ' active' : '');
    thumbUp.innerHTML = '&#128077;'; // 👍
    thumbUp.title = 'Helpful';
    thumbUp.addEventListener('click', (e) => {
      e.stopPropagation();
      thumbUp.classList.toggle('active');
      sendMessage({
        action: 'saveFeedback',
        payload: {
          annotationId: annotation.id,
          contentHash: getAnnotationContentHash(annotation),
          url: window.location.href,
          feedbackType: 'thumbs_up',
        },
      });
    });

    const thumbDown = document.createElement('button');
    thumbDown.className = 'note-thumb-btn';
    thumbDown.innerHTML = '&#128078;'; // 👎
    thumbDown.title = 'Not helpful';
    thumbDown.addEventListener('click', (e) => {
      e.stopPropagation();
      // Save feedback
      sendMessage({
        action: 'saveFeedback',
        payload: {
          annotationId: annotation.id,
          contentHash: getAnnotationContentHash(annotation),
          url: window.location.href,
          feedbackType: 'thumbs_down',
        },
      });
      // Animate hide
      hideNoteWithAnimation(el, annotation.id);
    });

    feedbackRow.appendChild(thumbUp);
    feedbackRow.appendChild(thumbDown);
    expandedContent.appendChild(feedbackRow);
  }

  el.appendChild(bracket);
  el.appendChild(labelEl);
  el.appendChild(textEl);
  el.appendChild(expandedContent);

  // Hover expand/collapse + overlay emphasis
  el.addEventListener('mouseenter', () => {
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
    expandMarginNote(annotation.id);
    emphasizeAnnotation(annotation.id);
  });

  el.addEventListener('mouseleave', () => {
    collapseTimer = setTimeout(() => {
      collapseAllMarginNotes();
      collapseTimer = null;
    }, 300);
    deemphasizeAnnotation();
  });

  return el;
}

// ─── Interaction Helpers ───

function getAnnotationContentHash(_annotation: Annotation): string {
  // Get the content hash from the closest region element
  const hashEl = document.querySelector('[data-oddity-hash]') as HTMLElement | null;
  return hashEl?.dataset.oddityHash ?? '';
}

function submitReply(
  annotation: Annotation,
  input: HTMLInputElement,
  container: HTMLDivElement,
): void {
  const text = input.value.trim();
  if (!text) return;

  // Add bubble immediately
  const bubble = document.createElement('div');
  bubble.className = 'note-reply-bubble';
  bubble.textContent = text;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;

  // Send to background
  sendMessage({
    action: 'saveFeedback',
    payload: {
      annotationId: annotation.id,
      contentHash: getAnnotationContentHash(annotation),
      url: window.location.href,
      feedbackType: 'reply',
      replyText: text,
    },
  });

  input.value = '';
}

function enterEditMode(
  noteEl: HTMLDivElement,
  annotation: Annotation,
  textEl: HTMLDivElement,
): void {
  const textarea = document.createElement('textarea');
  textarea.className = 'note-edit-textarea';
  textarea.value = annotation.content.note;
  textarea.rows = 3;
  textarea.addEventListener('keydown', (e) => e.stopPropagation());

  const editActions = document.createElement('div');
  editActions.className = 'note-edit-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'note-save-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const newNote = textarea.value.trim();
    if (!newNote) return;

    const updatedAnnotation = {
      ...annotation,
      content: { ...annotation.content, note: newNote },
    };

    sendMessage({
      action: 'updateAnnotation',
      payload: { annotationId: annotation.id, annotation: updatedAnnotation },
    }).then(() => {
      annotation.content.note = newNote;
      textEl.textContent = newNote;
      exitEditMode(noteEl, textarea, editActions, textEl);
    });
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'note-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exitEditMode(noteEl, textarea, editActions, textEl);
  });

  editActions.appendChild(saveBtn);
  editActions.appendChild(cancelBtn);

  textEl.style.display = 'none';
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
  textEl.style.display = '';
}

function hideNoteWithAnimation(el: HTMLDivElement, annotationId: string): void {
  el.classList.add('hiding');

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    removeMarginNote(annotationId);
    removeAnnotationOverlay(annotationId);
    removeAnchors(annotationId);
  };

  el.addEventListener('transitionend', cleanup, { once: true });
  // Safety fallback
  setTimeout(cleanup, 400);
}

function createSection(labelText: string, content: string): HTMLDivElement {
  const section = document.createElement('div');
  section.className = 'note-section';
  const label = document.createElement('span');
  label.className = 'note-section-label';
  label.textContent = labelText;
  const text = document.createElement('p');
  text.textContent = content;
  section.appendChild(label);
  section.appendChild(text);
  return section;
}

// ─── Layout ───

function resolveOverlaps(): void {
  const leftNotes = notes.filter((n) => n.side === 'left' && n.element.style.display !== 'none');
  const rightNotes = notes.filter((n) => n.side === 'right' && n.element.style.display !== 'none');

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
    if (note.side === 'left') {
      const rightEdge = regionLeft - MARGIN_PADDING;
      note.element.style.left = 'auto';
      note.element.style.right = `${hostEl!.offsetWidth - rightEdge}px`;
    } else {
      note.element.style.right = 'auto';
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
  window.addEventListener('scroll', scheduleRedraw, { passive: true, capture: true });
  window.addEventListener('resize', scheduleRedraw, { passive: true });

  cleanupTracking = () => {
    window.removeEventListener('scroll', scheduleRedraw, { capture: true });
    window.removeEventListener('resize', scheduleRedraw);
  };
}

function stopTracking(): void {
  cleanupTracking?.();
  cleanupTracking = null;
}

// ─── CSS ───

const MARGIN_NOTES_CSS = `
  :host {
    --oddity-note-font: 'Kalam', cursive, system-ui, sans-serif;
    --oddity-note-size: 13px;
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
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-bottom: 2px;
    font-family: system-ui, -apple-system, sans-serif;
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
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
    border-radius: 6px;
    opacity: 1;
    z-index: 10;
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
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #94a3b8;
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

  .note-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 8px;
  }

  .note-action-btn {
    all: unset;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 3px;
    font-family: system-ui, -apple-system, sans-serif;
    color: #475569;
    transition: background 0.15s;
  }

  .note-action-btn:hover {
    background: #f1f5f9;
  }

  .note-delete-btn {
    color: #ef4444;
  }

  .note-delete-btn:hover {
    background: #fef2f2;
  }

  /* ── Dark-mode overrides ── */
  :host([data-theme="dark"]) .oddity-note {
    color: #e2e8f0;
  }

  :host([data-theme="dark"]) .oddity-note.expanded {
    background: #1e293b;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
  }

  :host([data-theme="dark"]) .note-section-label {
    color: #64748b;
  }

  :host([data-theme="dark"]) .note-action-btn {
    color: #94a3b8;
  }

  :host([data-theme="dark"]) .note-action-btn:hover {
    background: #334155;
  }

  :host([data-theme="dark"]) .note-delete-btn {
    color: #f87171;
  }

  :host([data-theme="dark"]) .note-delete-btn:hover {
    background: #451a1a;
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
    border-radius: 10px;
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
    border-radius: 12px;
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
    background: #1a1a1a;
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
    gap: 6px;
    margin-top: 8px;
    justify-content: flex-start;
  }

  .note-thumb-btn {
    all: unset;
    cursor: pointer;
    font-size: 14px;
    opacity: 0.4;
    transition: opacity 0.15s;
    padding: 2px;
  }

  .note-thumb-btn:hover {
    opacity: 0.7;
  }

  .note-thumb-btn.active {
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
    font-family: 'Kalam', cursive, system-ui, sans-serif;
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

  .note-edit-btn {
    color: #1a1a1a;
  }

  .note-edit-btn:hover {
    background: #f3f4f6;
  }

  :host([data-theme="dark"]) .note-edit-btn:hover {
    background: #334155;
  }
`;
