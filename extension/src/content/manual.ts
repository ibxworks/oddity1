import type { Annotation } from '@oddity/shared';
import { ANNOTATION_LABELS, getAnnotationColor } from '@oddity/shared';
import { sendMessage, onMessage } from '../shared/messaging.js';
import { sha256 } from '../shared/hash.js';
import { resolveSelector } from './selector.js';
import { getPageUrl } from './page-url.js';
import { renderAnnotation, removeAnnotation } from './renderer/overlay.js';
import { injectAnchors, removeAnchors } from './renderer/anchors.js';
import { addLiveFeedback } from './renderer/arguments-box.js';
import { addMarginNote, removeMarginNote } from './renderer/margin-notes.js';
import { getThemeMode } from './renderer/theme-detector.js';

// ─── Theme Color Maps ───

function getAccent(): string {
  return getAnnotationColor('user_written', getThemeMode());
}

const LIGHT_COLORS = {
  cardBg: 'rgba(255,255,255,0.35)',
  cardBorder: 'rgba(0,0,0,0.08)',
  cardText: '#111111',
  previewBg: 'rgba(0,0,0,0.04)',
  previewText: '#555555',
  inputBorder: 'rgba(0,0,0,0.15)',
  inputBg: 'rgba(255,255,255,0.5)',
  labelColor: '#111111',
  cancelBg: 'transparent',
  cancelText: '#111111',
  cancelBorder: 'rgba(0,0,0,0.2)',
};

const DARK_COLORS = {
  cardBg: 'rgba(18,18,18,0.55)',
  cardBorder: 'rgba(255,255,255,0.08)',
  cardText: '#f0f0f0',
  previewBg: 'rgba(255,255,255,0.05)',
  previewText: '#aaaaaa',
  inputBorder: 'rgba(255,255,255,0.15)',
  inputBg: 'rgba(255,255,255,0.07)',
  labelColor: '#f0f0f0',
  cancelBg: 'transparent',
  cancelText: '#f0f0f0',
  cancelBorder: 'rgba(255,255,255,0.2)',
};

// ─── State ───

let fabHost: HTMLElement | null = null;
let fabShadow: ShadowRoot | null = null;
let editorHost: HTMLElement | null = null;
let editorShadow: ShadowRoot | null = null;
let currentRange: Range | null = null;
let selectionChangeListener: (() => void) | null = null;
let mouseDownListener: ((e: MouseEvent) => void) | null = null;
let mouseUpListener: ((e: MouseEvent) => void) | null = null;
let escapeListener: ((e: KeyboardEvent) => void) | null = null;
let outsideClickListener: ((e: MouseEvent) => void) | null = null;
let tempHighlightContainer: HTMLDivElement | null = null;
let isMouseDragging = false;
let mouseDownX = 0;
let mouseDownY = 0;

// GDocs canvas mode: window.getSelection() doesn't reflect visual selections.
// We capture text via copy-event interception and position via kix-selection-overlay.
let gdocsSelectedText: string | null = null;
let gdocsAnchorRect: DOMRect | null = null;

/**
 * Initialize manual annotation creation UI.
 * Listens for text selections and shows a floating action button.
 * Also listens for context menu messages from the background script.
 */
export function initManualAnnotations(): void {
  selectionChangeListener = handleSelectionChange;
  document.addEventListener('selectionchange', selectionChangeListener);

  // Track mouse state to avoid interfering with drag-to-select
  mouseDownListener = (e: MouseEvent) => {
    const target = e.target as Node;
    // Don't track clicks on our own UI (FAB / editor) as drags
    if (fabHost?.contains(target) || editorHost?.contains(target)) return;
    isMouseDragging = true;
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
  };
  mouseUpListener = (e: MouseEvent) => {
    if (!isMouseDragging) return;
    isMouseDragging = false;

    if (window.location.hostname === 'docs.google.com') {
      // GDocs canvas mode — skip DOM selection handling entirely.
      const dx = e.clientX - mouseDownX;
      const dy = e.clientY - mouseDownY;
      if (Math.sqrt(dx * dx + dy * dy) < 5) return;

      // Simulate Ctrl+C on the GDocs editor so GDocs writes canvas selection to clipboard.
      // document.execCommand('copy') only copies DOM selection (empty in GDocs).
      const editorEl = document.querySelector<HTMLElement>('.kix-appview-editor') ?? document.body;
      editorEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true }));
      editorEl.dispatchEvent(new KeyboardEvent('keyup',   { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true }));

      const clientX = e.clientX;
      const clientY = e.clientY;
      // Delay to let GDocs process the copy event before reading clipboard
      setTimeout(() => {
        navigator.clipboard.readText().then(text => {
          const trimmed = text.trim();
          if (trimmed.length >= 2) {
            gdocsSelectedText = trimmed;
            gdocsAnchorRect = new DOMRect(clientX, clientY, 0, 0);
            showGDocsFab(gdocsAnchorRect);
          } else {
            gdocsSelectedText = null;
            gdocsAnchorRect = null;
          }
        }).catch(() => {
          gdocsSelectedText = null;
          gdocsAnchorRect = null;
        });
      }, 150);
    } else {
      // Non-GDocs: use normal DOM selection
      handleSelectionChange();
    }
  };
  document.addEventListener('mousedown', mouseDownListener);
  document.addEventListener('mouseup', mouseUpListener);

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
  if (mouseDownListener) {
    document.removeEventListener('mousedown', mouseDownListener);
    mouseDownListener = null;
  }
  if (mouseUpListener) {
    document.removeEventListener('mouseup', mouseUpListener);
    mouseUpListener = null;
  }
  dismissFab();
  dismissEditor();
}

// ─── Selection Handling ───

function handleSelectionChange(): void {
  // Don't show FAB while user is still dragging — wait for mouseup
  if (isMouseDragging) return;

  // Don't interfere if the editor is open
  if (editorHost) return;

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

  currentRange = sel.getRangeAt(0).cloneRange();
  if (!currentRange) return;

  showFab(sel.getRangeAt(0));
}

// ─── Floating Action Button ───

const PENCIL_SVG = `<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="20" fill="#748DBF"/><path d="M25.1904 9.96387C26.5284 8.62594 28.6981 8.62607 30.0361 9.96387C31.3741 11.3019 31.3741 13.4716 30.0361 14.8096L16.792 28.0537C16.238 28.6077 15.5433 29.0014 14.7832 29.1914L10.6758 30.2178C10.1365 30.3526 9.64773 29.8645 9.78223 29.3252L10.8096 25.2168C10.9996 24.4569 11.3924 23.7629 11.9463 23.209L25.1904 9.96387ZM23.6963 13.541L12.9883 24.25C12.6231 24.6152 12.3635 25.0732 12.2383 25.5742L11.5742 28.2324L11.5088 28.4912L11.7676 28.4268L14.4258 27.7617C14.9267 27.6365 15.3848 27.3778 15.75 27.0127L21.1045 21.6582L26.458 16.3027L26.5713 16.1904L26.458 16.0771L23.9229 13.541L23.8096 13.4287L23.6963 13.541ZM28.9941 11.0059C28.2314 10.2433 26.9951 10.2432 26.2324 11.0059L24.9639 12.2734L24.8516 12.3867L24.9639 12.5L27.5 15.0352L27.6123 15.1484L27.7256 15.0352L28.9941 13.7676C29.7569 13.0049 29.7569 11.7686 28.9941 11.0059Z" fill="white" stroke="#748DBF" stroke-width="0.32"/></svg>`;

function mountFab(left: number, top: number, onClick: (e: MouseEvent) => void): void {
  fabHost = document.createElement('div');
  fabHost.id = 'oddity-manual-fab';
  fabHost.style.cssText = `position: fixed; left: ${left}px; top: ${top}px; pointer-events: auto; z-index: 2147483647;`;
  document.body.appendChild(fabHost);
  fabShadow = fabHost.attachShadow({ mode: 'closed' });

  const button = document.createElement('button');
  button.innerHTML = PENCIL_SVG;
  button.setAttribute('aria-label', 'Annotate selection');
  button.style.cssText = `all: initial; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; background: transparent; cursor: pointer; border: none; padding: 0; transition: transform 0.1s; box-sizing: border-box;`;
  button.addEventListener('mouseenter', () => { button.style.transform = 'scale(1.1)'; });
  button.addEventListener('mouseleave', () => { button.style.transform = 'scale(1)'; });
  button.addEventListener('click', onClick);
  fabShadow.appendChild(button);

  escapeListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { dismissFab(); dismissEditor(); }
  };
  document.addEventListener('keydown', escapeListener);

  setTimeout(() => {
    outsideClickListener = (e: MouseEvent) => {
      const target = e.target as Node;
      if (fabHost?.contains(target) || editorHost?.contains(target)) return;
      dismissFab();
    };
    document.addEventListener('mousedown', outsideClickListener);
  }, 100);
}

function showFab(range: Range): void {
  dismissFab();
  const rect = range.getBoundingClientRect();
  mountFab(rect.right + 4, rect.top - 4, (e) => {
    e.preventDefault();
    e.stopPropagation();
    applyTempHighlight();
    window.getSelection()?.removeAllRanges();
    showEditor();
  });
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

// ─── GDocs Canvas Selection FAB ───

/**
 * Polls for kix-selection-overlay elements after a GDocs mouseup.
 * If a selection exists, shows the FAB.
 */
/**
 * Shows the pencil FAB for a GDocs canvas selection.
 * Text was already captured in mouseUpListener; just show the FAB.
 */
function showGDocsFab(anchorRect: DOMRect): void {
  dismissFab();
  // Position FAB to the right of the mouse release point
  mountFab(anchorRect.x + 8, anchorRect.y - 16, (e) => {
    e.preventDefault();
    e.stopPropagation();
    showEditor();
  });
}

// ─── Temporary Highlight (replaces OS selection visually) ───

function applyTempHighlight(): void {
  removeTempHighlight();
  if (!currentRange) return;

  tempHighlightContainer = document.createElement('div');
  tempHighlightContainer.style.cssText =
    'position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2147483645;';
  document.body.appendChild(tempHighlightContainer);

  drawTempRects();

  const onScrollResize = () => requestAnimationFrame(drawTempRects);
  window.addEventListener('scroll', onScrollResize, { passive: true, capture: true });
  window.addEventListener('resize', onScrollResize, { passive: true });

  (tempHighlightContainer as HTMLDivElement & { _cleanup?: () => void })._cleanup = () => {
    window.removeEventListener('scroll', onScrollResize, { capture: true });
    window.removeEventListener('resize', onScrollResize);
  };
}

function drawTempRects(): void {
  if (!tempHighlightContainer || !currentRange) return;
  tempHighlightContainer.innerHTML = '';

  const bgColor = getAccent() + '26'; // 15% opacity, same as annotation highlights
  const rects = currentRange.getClientRects();

  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]!;
    if (rect.width === 0 || rect.height === 0) continue;

    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${rect.top}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      background-color: ${bgColor};
      border-bottom: 1.5px solid ${getAccent()};
      pointer-events: none;
    `;
    tempHighlightContainer.appendChild(el);
  }
}

function removeTempHighlight(): void {
  if (tempHighlightContainer) {
    (tempHighlightContainer as HTMLDivElement & { _cleanup?: () => void })._cleanup?.();
    tempHighlightContainer.remove();
    tempHighlightContainer = null;
  }
}

// ─── Annotation Editor ───

function showEditor(): void {
  dismissFab();
  dismissEditor(true);

  // Determine anchor position (viewport-relative)
  let anchorLeft: number;
  let anchorTop: number;

  if (currentRange) {
    const r = currentRange.getBoundingClientRect();
    anchorLeft = r.left;
    anchorTop = r.bottom + 8;
  } else if (gdocsAnchorRect) {
    anchorLeft = gdocsAnchorRect.left;
    anchorTop = gdocsAnchorRect.bottom + 8;
  } else {
    return;
  }

  editorHost = document.createElement('div');
  editorHost.id = 'oddity-manual-editor';
  editorHost.style.cssText = `position: fixed; left: ${anchorLeft}px; top: ${anchorTop}px; z-index: 2147483647; pointer-events: auto;`;
  for (const evt of ['keydown', 'keyup', 'keypress', 'input', 'beforeinput'] as const) {
    editorHost.addEventListener(evt, (e) => e.stopPropagation());
  }
  document.body.appendChild(editorHost);
  editorShadow = editorHost.attachShadow({ mode: 'closed' });

  const colors = getThemeMode() === 'dark' ? DARK_COLORS : LIGHT_COLORS;

  const container = document.createElement('div');
  container.style.cssText = `
    all: initial;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
    background: ${colors.cardBg};
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.18);
    border: 1px solid ${colors.cardBorder};
    font-family: var(--oddity-note-font, system-ui, -apple-system, sans-serif);
    font-size: 13px;
    color: ${colors.cardText};
    width: 320px;
  `;

  // Note textarea
  const noteLabel = document.createElement('label');
  noteLabel.textContent = 'Note';
  noteLabel.style.cssText = `font-weight: 400; font-size: 12px; color: ${colors.labelColor};`;
  container.appendChild(noteLabel);

  const noteArea = document.createElement('textarea');
  noteArea.placeholder = 'Add a note...';
  noteArea.rows = 3;
  noteArea.style.cssText = `
    all: initial;
    font-family: var(--oddity-note-font, system-ui, sans-serif);
    font-size: 13px;
    padding: 6px 8px;
    border: 1px solid ${colors.inputBorder};
    border-radius: 10px;
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
    font-family: var(--oddity-note-font, system-ui, sans-serif);
    font-size: 12px;
    padding: 6px 12px;
    border: 1px solid ${colors.cancelBorder};
    border-radius: 999px;
    background: ${colors.cancelBg};
    color: ${colors.cancelText};
    cursor: pointer;
    font-weight: 400;
  `;
  cancelBtn.addEventListener('click', () => dismissEditor());

  const submitBtn = document.createElement('button');
  submitBtn.textContent = 'Save';
  submitBtn.style.cssText = `
    all: initial;
    font-family: var(--oddity-note-font, system-ui, sans-serif);
    font-size: 12px;
    padding: 6px 12px;
    border: none;
    border-radius: 999px;
    background: #748DBF;
    color: #ffffff;
    cursor: pointer;
    font-weight: 400;
  `;
  submitBtn.addEventListener('click', () => {
    handleSubmit(noteArea.value.trim());
  });

  buttonRow.appendChild(cancelBtn);
  buttonRow.appendChild(submitBtn);
  container.appendChild(buttonRow);

  editorShadow.appendChild(container);

  setTimeout(() => noteArea.focus(), 50);

  // Escape to dismiss
  const editorEscapeListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      dismissEditor();
      document.removeEventListener('keydown', editorEscapeListener);
    }
  };
  document.addEventListener('keydown', editorEscapeListener);
}

function dismissEditor(keepHighlight = false): void {
  if (!keepHighlight) removeTempHighlight();
  editorHost?.remove();
  editorHost = null;
  editorShadow = null;
}

// ─── Submit ───

async function handleSubmit(note: string): Promise<void> {
  const type = 'user_written' as const;

  // GDocs canvas mode: no DOM range — use captured text from copy-event intercept.
  const isGDocs = !currentRange && !!gdocsSelectedText;

  if (!currentRange && !gdocsSelectedText) return;

  const exact = isGDocs
    ? gdocsSelectedText!
    : currentRange!.toString().trim();
  if (!exact) return;

  let root: Element = document.body;
  let prefix: string | undefined;
  let suffix: string | undefined;

  if (!isGDocs) {
    // Build prefix/suffix from surrounding text
    const container = currentRange!.commonAncestorContainer;
    root = container.nodeType === Node.ELEMENT_NODE
      ? container as Element
      : container.parentElement ?? document.body;
    const fullText = root.textContent ?? '';
    const idx = fullText.indexOf(exact);
    if (idx > 0) {
      prefix = fullText.slice(Math.max(0, idx - 32), idx).trim();
    }
    if (idx >= 0 && idx + exact.length < fullText.length) {
      suffix = fullText.slice(idx + exact.length, idx + exact.length + 32).trim();
    }
  }

  // Determine current mode from stored preferences
  const storedPrefs = await new Promise<Record<string, unknown>>((resolve) => {
    chrome.storage.local.get("preferences", (result) => {
      resolve((result["preferences"] ?? {}) as Record<string, unknown>);
    });
  });
  const rawMode = storedPrefs.annotation_mode as string | undefined;
  // Manual annotations need a concrete mode (overview/depth), not "all"
  const annotationMode: "overview" | "depth" = rawMode === "depth" ? "depth" : "overview";

  const annotation: Annotation = {
    id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mode: annotationMode,
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

  // For GDocs: find the hash-tagged region element set by the main pipeline.
  // For other pages: walk up from the range's container.
  let contentHash: string;
  if (isGDocs) {
    const hashEl = document.querySelector('[data-oddity-hash]');
    contentHash = hashEl?.getAttribute('data-oddity-hash')
      ?? await sha256(exact.slice(0, 1000));
  } else {
    const hashEl = root.closest('[data-oddity-hash]');
    const fullText = root.textContent ?? '';
    contentHash = hashEl?.getAttribute('data-oddity-hash')
      ?? await sha256(fullText.slice(0, 1000));
  }

  sendMessage({
    action: 'saveManualAnnotation',
    payload: {
      url: getPageUrl(),
      contentHash,
      annotation,
      pageTitle: document.title,
    },
  });

  // Remove temp highlight before rendering permanent one
  removeTempHighlight();

  // GDocs canvas: DOM rendering won't work — let the main pipeline handle it
  // via the oddity:manualAnnotationCreated event below.
  if (!isGDocs) {
    renderManualAnnotation(annotation, root, contentHash);
  }

  // Notify index.ts to store the annotation so it survives mode switches.
  // For GDocs, also trigger a re-render so the annotation appears immediately.
  document.dispatchEvent(new CustomEvent('oddity:manualAnnotationCreated', {
    detail: { annotation, contentHash },
  }));
  if (isGDocs) {
    document.dispatchEvent(new CustomEvent('oddity:gdocs:rerenderAnnotations'));
  }

  addLiveFeedback("✎", annotation.content.note, {
    quote: annotation.anchor.exact,
    type: "manual",
    annotationId: annotation.id,
    contentHash,
  });

  dismissEditor();
  window.getSelection()?.removeAllRanges();
  currentRange = null;
  gdocsSelectedText = null;
  gdocsAnchorRect = null;
}

function renderManualAnnotation(annotation: Annotation, root: Element, contentHash?: string): void {
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
    // Notify index.ts to remove from stores and sync argument box
    document.dispatchEvent(new CustomEvent('oddity:annotation-deleted', {
      detail: { annotationId },
    }));
  };

  addMarginNote(annotation, stableRange, [], handleDelete, contentHash);
}
