import type { Annotation, AnnotationType } from '@oddity/shared';
import { ALL_ANNOTATION_TYPES, ANNOTATION_LABELS, ANNOTATION_COLORS } from '@oddity/shared';
import { sendMessage, onMessage } from '../shared/messaging.js';
import { sha256 } from '../shared/hash.js';
import { resolveSelector } from './selector.js';
import { renderAnnotation, removeAnnotation } from './renderer/overlay.js';
import { injectAnchors, removeAnchors } from './renderer/anchors.js';
import { addLiveFeedback } from './renderer/arguments-box.js';
import { addMarginNote, removeMarginNote } from './renderer/margin-notes.js';
import { getThemeMode } from './renderer/theme-detector.js';

// ─── Theme Color Maps ───

const LIGHT_COLORS = {
  cardBg: 'white',
  cardBorder: '#E5E7EB',
  cardText: '#1F2937',
  previewBg: '#F9FAFB',
  previewText: '#6B7280',
  inputBorder: '#D1D5DB',
  inputBg: 'white',
  labelColor: '#374151',
  cancelBg: 'white',
  cancelText: '#374151',
  cancelBorder: '#D1D5DB',
};

const DARK_COLORS = {
  cardBg: '#1e293b',
  cardBorder: '#334155',
  cardText: '#e2e8f0',
  previewBg: '#0f172a',
  previewText: '#94a3b8',
  inputBorder: '#475569',
  inputBg: '#0f172a',
  labelColor: '#cbd5e1',
  cancelBg: '#334155',
  cancelText: '#e2e8f0',
  cancelBorder: '#475569',
};

// ─── State ───

let fabHost: HTMLElement | null = null;
let fabShadow: ShadowRoot | null = null;
let editorHost: HTMLElement | null = null;
let editorShadow: ShadowRoot | null = null;
let currentSelection: Selection | null = null;
let currentRange: Range | null = null;
let selectionChangeListener: (() => void) | null = null;
let escapeListener: ((e: KeyboardEvent) => void) | null = null;
let outsideClickListener: ((e: MouseEvent) => void) | null = null;

/**
 * Initialize manual annotation creation UI.
 * Listens for text selections and shows a floating action button.
 * Also listens for context menu messages from the background script.
 */
export function initManualAnnotations(): void {
  selectionChangeListener = handleSelectionChange;
  document.addEventListener('selectionchange', selectionChangeListener);

  // Listen for context menu action from background
  onMessage((message) => {
    if (message.action === 'saveManualAnnotation') {
      // This is a response, not a request to create — ignore here
      return;
    }
    // Handle context menu trigger if background sends a custom action
    // (context menu integration can be added via a dedicated message action)
  });
}

/**
 * Tear down manual annotation UI and all listeners.
 */
export function destroyManualAnnotations(): void {
  if (selectionChangeListener) {
    document.removeEventListener('selectionchange', selectionChangeListener);
    selectionChangeListener = null;
  }
  dismissFab();
  dismissEditor();
}

// ─── Selection Handling ───

function handleSelectionChange(): void {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    // Delay dismiss slightly so click on FAB can register
    setTimeout(() => {
      const sel2 = window.getSelection();
      if (!sel2 || sel2.isCollapsed) {
        dismissFab();
      }
    }, 200);
    return;
  }

  const text = sel.toString().trim();
  if (text.length < 2) {
    dismissFab();
    return;
  }

  currentSelection = sel;
  currentRange = sel.getRangeAt(0).cloneContents() ? sel.getRangeAt(0).cloneRange() : null;
  if (!currentRange) return;

  showFab(sel.getRangeAt(0));
}

// ─── Floating Action Button ───

function showFab(range: Range): void {
  dismissFab();

  fabHost = document.createElement('div');
  fabHost.style.cssText = 'position: absolute; z-index: 2147483647; pointer-events: auto;';
  document.body.appendChild(fabHost);

  fabShadow = fabHost.attachShadow({ mode: 'closed' });

  const rect = range.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  fabHost.style.left = `${rect.right + scrollX + 4}px`;
  fabHost.style.top = `${rect.top + scrollY - 4}px`;

  const button = document.createElement('button');
  button.textContent = '+';
  button.setAttribute('aria-label', 'Annotate selection');
  button.style.cssText = `
    all: initial;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #3B82F6;
    color: white;
    font-size: 18px;
    font-weight: bold;
    font-family: system-ui, sans-serif;
    cursor: pointer;
    border: 2px solid white;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    transition: transform 0.1s;
    line-height: 1;
  `;

  button.addEventListener('mouseenter', () => {
    button.style.transform = 'scale(1.1)';
  });
  button.addEventListener('mouseleave', () => {
    button.style.transform = 'scale(1)';
  });
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showEditor();
  });

  fabShadow.appendChild(button);

  // Dismiss on Escape
  escapeListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      dismissFab();
      dismissEditor();
    }
  };
  document.addEventListener('keydown', escapeListener);

  // Dismiss on outside click (delayed to avoid immediate dismissal)
  setTimeout(() => {
    outsideClickListener = (e: MouseEvent) => {
      const target = e.target as Node;
      if (fabHost && fabHost.contains(target)) return;
      if (editorHost && editorHost.contains(target)) return;
      dismissFab();
    };
    document.addEventListener('mousedown', outsideClickListener);
  }, 100);
}

function dismissFab(): void {
  fabHost?.remove();
  fabHost = null;
  fabShadow = null;

  if (escapeListener) {
    document.removeEventListener('keydown', escapeListener);
    escapeListener = null;
  }
  if (outsideClickListener) {
    document.removeEventListener('mousedown', outsideClickListener);
    outsideClickListener = null;
  }
}

// ─── Annotation Editor ───

function showEditor(): void {
  dismissFab();
  dismissEditor();

  if (!currentRange) return;

  const rangeRect = currentRange.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  editorHost = document.createElement('div');
  editorHost.style.cssText = `
    position: absolute;
    z-index: 2147483647;
    pointer-events: auto;
    left: ${rangeRect.left + scrollX}px;
    top: ${rangeRect.bottom + scrollY + 8}px;
  `;
  document.body.appendChild(editorHost);

  editorShadow = editorHost.attachShadow({ mode: 'closed' });

  const colors = getThemeMode() === 'dark' ? DARK_COLORS : LIGHT_COLORS;

  const container = document.createElement('div');
  container.style.cssText = `
    all: initial;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: ${colors.cardBg};
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    border: 1px solid ${colors.cardBorder};
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    color: ${colors.cardText};
    min-width: 240px;
    max-width: 320px;
  `;

  // Selected text preview
  const preview = document.createElement('div');
  const selectedText = currentRange.toString().trim();
  preview.textContent = selectedText.length > 80 ? selectedText.slice(0, 80) + '...' : selectedText;
  preview.style.cssText = `
    padding: 6px 8px;
    background: ${colors.previewBg};
    border-radius: 4px;
    font-style: italic;
    color: ${colors.previewText};
    font-size: 12px;
    line-height: 1.4;
    border-left: 3px solid #3B82F6;
  `;
  container.appendChild(preview);

  // Type selector
  const typeLabel = document.createElement('label');
  typeLabel.textContent = 'Type';
  typeLabel.style.cssText = `font-weight: 600; font-size: 12px; color: ${colors.labelColor};`;
  container.appendChild(typeLabel);

  const typeSelect = document.createElement('select');
  typeSelect.style.cssText = `
    all: initial;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    padding: 6px 8px;
    border: 1px solid ${colors.inputBorder};
    border-radius: 4px;
    background: ${colors.inputBg};
    color: ${colors.cardText};
    cursor: pointer;
    width: 100%;
    box-sizing: border-box;
  `;

  for (const type of ALL_ANNOTATION_TYPES) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = ANNOTATION_LABELS[type];
    option.style.cssText = `color: ${ANNOTATION_COLORS[type]};`;
    typeSelect.appendChild(option);
  }
  container.appendChild(typeSelect);

  // Note textarea
  const noteLabel = document.createElement('label');
  noteLabel.textContent = 'Note (optional)';
  noteLabel.style.cssText = `font-weight: 600; font-size: 12px; color: ${colors.labelColor};`;
  container.appendChild(noteLabel);

  const noteArea = document.createElement('textarea');
  noteArea.placeholder = 'Add a note...';
  noteArea.rows = 3;
  noteArea.style.cssText = `
    all: initial;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    padding: 6px 8px;
    border: 1px solid ${colors.inputBorder};
    border-radius: 4px;
    background: ${colors.inputBg};
    color: ${colors.cardText};
    resize: vertical;
    width: 100%;
    box-sizing: border-box;
    line-height: 1.4;
  `;
  container.appendChild(noteArea);

  // Buttons
  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `
    all: initial;
    font-family: system-ui, sans-serif;
    font-size: 12px;
    padding: 6px 12px;
    border: 1px solid ${colors.cancelBorder};
    border-radius: 4px;
    background: ${colors.cancelBg};
    color: ${colors.cancelText};
    cursor: pointer;
    font-weight: 500;
  `;
  cancelBtn.addEventListener('click', () => dismissEditor());

  const submitBtn = document.createElement('button');
  submitBtn.textContent = 'Save';
  submitBtn.style.cssText = `
    all: initial;
    font-family: system-ui, sans-serif;
    font-size: 12px;
    padding: 6px 12px;
    border: none;
    border-radius: 4px;
    background: #3B82F6;
    color: white;
    cursor: pointer;
    font-weight: 600;
  `;
  submitBtn.addEventListener('click', () => {
    handleSubmit(
      typeSelect.value as AnnotationType,
      noteArea.value.trim(),
    );
  });

  buttonRow.appendChild(cancelBtn);
  buttonRow.appendChild(submitBtn);
  container.appendChild(buttonRow);

  editorShadow.appendChild(container);

  // Escape to dismiss
  const editorEscapeListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      dismissEditor();
      document.removeEventListener('keydown', editorEscapeListener);
    }
  };
  document.addEventListener('keydown', editorEscapeListener);
}

function dismissEditor(): void {
  editorHost?.remove();
  editorHost = null;
  editorShadow = null;
}

// ─── Submit ───

async function handleSubmit(type: AnnotationType, note: string): Promise<void> {
  if (!currentRange) return;

  const exact = currentRange.toString().trim();
  if (!exact) return;

  // Build prefix/suffix from surrounding text
  const container = currentRange.commonAncestorContainer;
  const root = container.nodeType === Node.ELEMENT_NODE
    ? container as Element
    : container.parentElement ?? document.body;
  const fullText = root.textContent ?? '';
  const idx = fullText.indexOf(exact);

  let prefix: string | undefined;
  let suffix: string | undefined;
  if (idx > 0) {
    prefix = fullText.slice(Math.max(0, idx - 32), idx).trim();
  }
  if (idx >= 0 && idx + exact.length < fullText.length) {
    suffix = fullText.slice(idx + exact.length, idx + exact.length + 32).trim();
  }

  const annotation: Annotation = {
    id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    anchor: {
      type: 'TextQuoteSelector',
      exact,
      prefix,
      suffix,
    },
    content: {
      note: note || `Manual ${ANNOTATION_LABELS[type].toLowerCase()} annotation`,
    },
  };

  // Use the hash computed by the main pipeline if available, otherwise fall back
  const hashEl = root.closest('[data-oddity-hash]');
  const contentHash = hashEl?.getAttribute('data-oddity-hash')
    ?? await sha256(fullText.slice(0, 1000));

  sendMessage({
    action: 'saveManualAnnotation',
    payload: {
      url: window.location.href,
      contentHash,
      annotation,
    },
  });

  // Render immediately
  renderManualAnnotation(annotation, root);

  const label = ANNOTATION_LABELS[type];
  addLiveFeedback("✎", `(${label}) ${annotation.content.note}`);

  dismissEditor();
  window.getSelection()?.removeAllRanges();
  currentRange = null;
  currentSelection = null;
}

function renderManualAnnotation(annotation: Annotation, root: Element): void {
  const range = resolveSelector(root, annotation.anchor);
  if (!range) return;

  const anchors = injectAnchors(annotation, range);

  // Create stable range from anchor spans (survives splitText DOM mutations)
  const stableRange = document.createRange();
  if (anchors.length > 0) {
    stableRange.setStartBefore(anchors[0]!);
    stableRange.setEndAfter(anchors[anchors.length - 1]!);
  } else {
    stableRange.setStart(range.startContainer, range.startOffset);
    stableRange.setEnd(range.endContainer, range.endOffset);
  }

  renderAnnotation(annotation, stableRange);

  const handleDelete = (annotationId: string) => {
    removeMarginNote(annotationId);
    removeAnchors(annotationId);
    removeAnnotation(annotationId);
  };

  addMarginNote(annotation, stableRange, [], handleDelete);
}
