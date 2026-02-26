import type { Annotation, AnnotationType } from '@oddity/shared';
import { ANNOTATION_COLORS, ANNOTATION_LABELS } from '@oddity/shared';
import { sendMessage } from '../../shared/messaging.js';
import { emphasizeAnnotation, deemphasizeAnnotation } from './overlay.js';

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

const NOTE_MAX_WIDTH = 180;
const NOTE_EXPANDED_WIDTH = 220;
const NOTE_GAP = 10;
const MARGIN_PADDING = 16;
const MIN_MARGIN_WIDTH = 120;

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

  const style = document.createElement('style');
  style.textContent = MARGIN_NOTES_CSS;
  shadowRoot.appendChild(style);

  startTracking();
}

export function addMarginNote(annotation: Annotation, range: Range): void {
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

  const el = createNoteElement(annotation, side);
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
  hostEl?.remove();
  hostEl = null;
  shadowRoot = null;
  notes = [];
  noteIndex = 0;
  expandedId = null;
  fontLink?.remove();
  fontLink = null;
}

// ─── Note Element Construction ───

function createNoteElement(annotation: Annotation, side: 'left' | 'right'): HTMLDivElement {
  const color = ANNOTATION_COLORS[annotation.type];
  const label = ANNOTATION_LABELS[annotation.type];

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

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'note-actions';

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

  actions.appendChild(deleteBtn);
  expandedContent.appendChild(actions);

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
      note.element.style.left = `${Math.max(8, regionLeft - MARGIN_PADDING - NOTE_MAX_WIDTH)}px`;
    } else {
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
    font-family: 'Kalam', cursive, system-ui, sans-serif;
  }

  .oddity-note {
    position: absolute;
    max-width: ${NOTE_MAX_WIDTH}px;
    padding: 6px 10px;
    font-family: 'Kalam', cursive, system-ui, sans-serif;
    font-size: 13px;
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
    font-size: 12px;
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
`;
