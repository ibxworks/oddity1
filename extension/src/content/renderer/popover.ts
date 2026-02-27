import type { Annotation } from '@oddity/shared';
import { POPOVER_SHOW_DELAY_MS, POPOVER_HIDE_DELAY_MS } from '@oddity/shared';
import { getVisual } from './styles.js';
import { getThemeMode } from './theme-detector.js';

// ─── State ───

let hostEl: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let mouseInAnchor = false;
let mouseInPopover = false;
let currentAnchor: HTMLElement | null = null;

const Z_INDEX = 2147483647;

// ─── Public API ───

/**
 * Show a popover for `annotation` anchored to `anchorEl`.
 * Uses a show-delay so the popover only appears after a short hover.
 */
export function showPopover(annotation: Annotation, anchorEl: HTMLElement): void {
  mouseInAnchor = true;
  cancelHide();

  // Already showing for this anchor
  if (currentAnchor === anchorEl && hostEl) return;

  cancelShow();
  showTimer = setTimeout(() => {
    createPopover(annotation, anchorEl);
    showTimer = null;
  }, POPOVER_SHOW_DELAY_MS);
}

/**
 * Hide the popover. Respects the hide-delay hover bridge: the popover
 * only disappears if the mouse is outside both the anchor and popover
 * for the full delay period.
 */
export function hidePopover(): void {
  mouseInAnchor = false;
  scheduleHide();
}

/**
 * Returns whether the popover host element currently exists in the DOM.
 */
export function isPopoverVisible(): boolean {
  return hostEl !== null;
}

// ─── Construction ───

function createPopover(annotation: Annotation, anchorEl: HTMLElement): void {
  destroy();

  currentAnchor = anchorEl;
  const visual = getVisual(annotation.type);

  // Host element
  hostEl = document.createElement('div');
  hostEl.style.cssText = `position: absolute; z-index: ${Z_INDEX};`;
  hostEl.dataset.theme = getThemeMode();
  document.body.appendChild(hostEl);

  // Closed shadow DOM for full isolation
  shadowRoot = hostEl.attachShadow({ mode: 'closed' });

  // Build popover DOM
  const container = document.createElement('div');
  container.className = 'oddity-popover';

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'popover-header';

  const dot = document.createElement('span');
  dot.className = 'type-dot';
  dot.style.backgroundColor = visual.color;

  const label = document.createElement('span');
  label.className = 'type-label';
  label.textContent = visual.label;

  header.appendChild(dot);
  header.appendChild(label);
  container.appendChild(header);

  // ── Body ──
  const body = document.createElement('div');
  body.className = 'popover-body';

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = annotation.content.note;
  body.appendChild(note);

  if (annotation.content.why_it_matters) {
    const section = document.createElement('div');
    section.className = 'section';
    const sectionLabel = document.createElement('span');
    sectionLabel.className = 'section-label';
    sectionLabel.textContent = 'Why it matters';
    const sectionText = document.createElement('p');
    sectionText.textContent = annotation.content.why_it_matters;
    section.appendChild(sectionLabel);
    section.appendChild(sectionText);
    body.appendChild(section);
  }

  if (annotation.content.question) {
    const section = document.createElement('div');
    section.className = 'section';
    const sectionLabel = document.createElement('span');
    sectionLabel.className = 'section-label';
    sectionLabel.textContent = 'Question';
    const sectionText = document.createElement('p');
    sectionText.textContent = annotation.content.question;
    section.appendChild(sectionLabel);
    section.appendChild(sectionText);
    body.appendChild(section);
  }

  if (annotation.content.suggestions && annotation.content.suggestions.length > 0) {
    const section = document.createElement('div');
    section.className = 'section';
    const sectionLabel = document.createElement('span');
    sectionLabel.className = 'section-label';
    sectionLabel.textContent = 'Suggestions';
    const list = document.createElement('ul');
    for (const suggestion of annotation.content.suggestions) {
      const li = document.createElement('li');
      li.textContent = suggestion;
      list.appendChild(li);
    }
    section.appendChild(sectionLabel);
    section.appendChild(list);
    body.appendChild(section);
  }

  container.appendChild(body);

  // ── Footer ──
  const footer = document.createElement('div');
  footer.className = 'popover-footer';

  const editBtn = document.createElement('button');
  editBtn.className = 'action-btn';
  editBtn.textContent = 'Edit';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'action-btn delete-btn';
  deleteBtn.textContent = 'Delete';

  footer.appendChild(editBtn);
  footer.appendChild(deleteBtn);
  container.appendChild(footer);

  // ── Styles (inside shadow DOM) ──
  const style = document.createElement('style');
  style.textContent = POPOVER_CSS;
  shadowRoot.appendChild(style);
  shadowRoot.appendChild(container);

  // ── Hover bridge listeners on popover ──
  container.addEventListener('mouseenter', () => {
    mouseInPopover = true;
    cancelHide();
  });
  container.addEventListener('mouseleave', () => {
    mouseInPopover = false;
    scheduleHide();
  });

  // ── Position ──
  position(anchorEl);
}

// ─── Positioning ───

function position(anchorEl: HTMLElement): void {
  if (!hostEl) return;

  const anchorRect = anchorEl.getBoundingClientRect();
  const gap = 6;

  // Temporarily place off-screen to measure
  hostEl.style.left = '-9999px';
  hostEl.style.top = '-9999px';

  // Wait for layout
  requestAnimationFrame(() => {
    if (!hostEl || !shadowRoot) return;

    const popoverEl = shadowRoot.querySelector('.oddity-popover') as HTMLElement | null;
    if (!popoverEl) return;

    const popRect = popoverEl.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    // Default: below the anchor, centered
    let top = anchorRect.bottom + gap + window.scrollY;
    let left = anchorRect.left + anchorRect.width / 2 - popRect.width / 2 + window.scrollX;

    // Flip above if not enough space below
    if (anchorRect.bottom + gap + popRect.height > viewportH) {
      top = anchorRect.top - popRect.height - gap + window.scrollY;
    }

    // Clamp horizontal to viewport
    if (left < window.scrollX + 8) {
      left = window.scrollX + 8;
    } else if (left + popRect.width > window.scrollX + viewportW - 8) {
      left = window.scrollX + viewportW - popRect.width - 8;
    }

    hostEl.style.left = `${left}px`;
    hostEl.style.top = `${top}px`;
  });
}

// ─── Hover Bridge Timers ───

function cancelShow(): void {
  if (showTimer !== null) {
    clearTimeout(showTimer);
    showTimer = null;
  }
}

function cancelHide(): void {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function scheduleHide(): void {
  cancelHide();
  hideTimer = setTimeout(() => {
    if (!mouseInAnchor && !mouseInPopover) {
      destroy();
    }
    hideTimer = null;
  }, POPOVER_HIDE_DELAY_MS);
}

function destroy(): void {
  cancelShow();
  cancelHide();
  hostEl?.remove();
  hostEl = null;
  shadowRoot = null;
  currentAnchor = null;
  mouseInAnchor = false;
  mouseInPopover = false;
}

// ─── Popover CSS (injected into shadow DOM) ───

const POPOVER_CSS = `
  .oddity-popover {
    box-sizing: border-box;
    width: 320px;
    max-width: 90vw;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: #1e293b;
    overflow: hidden;
  }

  .popover-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid #f1f5f9;
  }

  .type-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .type-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #64748b;
  }

  .popover-body {
    padding: 10px 12px;
  }

  .note {
    margin: 0 0 6px;
  }

  .section {
    margin-top: 8px;
  }

  .section-label {
    display: block;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #94a3b8;
    margin-bottom: 2px;
  }

  .section p {
    margin: 0;
  }

  .section ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }

  .section li {
    margin-bottom: 2px;
  }

  .popover-footer {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    padding: 6px 12px;
    border-top: 1px solid #f1f5f9;
  }

  .action-btn {
    all: unset;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    padding: 4px 10px;
    border-radius: 4px;
    color: #475569;
    transition: background 0.15s;
  }

  .action-btn:hover {
    background: #f1f5f9;
  }

  .delete-btn {
    color: #ef4444;
  }

  .delete-btn:hover {
    background: #fef2f2;
  }

  /* ── Dark-mode overrides ── */
  :host([data-theme="dark"]) .oddity-popover {
    background: #1e293b;
    border-color: #334155;
    color: #e2e8f0;
  }

  :host([data-theme="dark"]) .popover-header {
    border-bottom-color: #334155;
  }

  :host([data-theme="dark"]) .type-label {
    color: #94a3b8;
  }

  :host([data-theme="dark"]) .section-label {
    color: #64748b;
  }

  :host([data-theme="dark"]) .popover-footer {
    border-top-color: #334155;
  }

  :host([data-theme="dark"]) .action-btn {
    color: #94a3b8;
  }

  :host([data-theme="dark"]) .action-btn:hover {
    background: #334155;
  }

  :host([data-theme="dark"]) .delete-btn {
    color: #f87171;
  }

  :host([data-theme="dark"]) .delete-btn:hover {
    background: #451a1a;
  }
`;
