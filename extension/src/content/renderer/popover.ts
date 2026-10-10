import type { Annotation } from '@oddity/shared';
import { ALL_OVERVIEW_TYPES, POPOVER_SHOW_DELAY_MS, POPOVER_HIDE_DELAY_MS } from '@oddity/shared';
import { getVisual } from './styles.js';
import { renderMiniMarkdown } from './mini-markdown.js';

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
  const visual = getVisual(annotation.type, 'light', annotation.label);
  // Overview yellow is unreadable as small text on a light card; use the
  // deeper readable yellow for the tag while the dot keeps the hue.
  const isOverview = (ALL_OVERVIEW_TYPES as readonly string[]).includes(annotation.type);
  const tagColor = isOverview ? '#DCAF16' : visual.color;

  // Host element
  hostEl = document.createElement('div');
  hostEl.style.cssText = `position: absolute; z-index: ${Z_INDEX};`;
  document.body.appendChild(hostEl);

  // Closed shadow DOM for full isolation
  shadowRoot = hostEl.attachShadow({ mode: 'closed' });

  // Build popover DOM
  const container = document.createElement('div');
  container.className = 'oddity-popover';
  container.style.borderLeftColor = visual.color;

  // ── Dot bullet ──
  const dot = document.createElement('div');
  dot.className = 'annotation-dot';
  dot.style.background = visual.color;
  container.appendChild(dot);

  // ── Tag ──
  const tag = document.createElement('div');
  tag.className = 'annotation-tag';
  tag.style.color = tagColor;
  tag.textContent = visual.label;
  container.appendChild(tag);

  // ── Note text ──
  const text = document.createElement('div');
  text.className = 'annotation-text';
  text.innerHTML = renderMiniMarkdown(annotation.content.note);
  container.appendChild(text);

  // ── Reactions ──
  const reactions = document.createElement('div');
  reactions.className = 'annotation-reactions';
  for (const label of ['Push back', 'Develop', 'Agree']) {
    const btn = document.createElement('button');
    btn.className = 'reaction-btn';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      const wasActive = btn.classList.contains('active');
      reactions.querySelectorAll('.reaction-btn').forEach(b => b.classList.remove('active'));
      if (!wasActive) btn.classList.add('active');
    });
    reactions.appendChild(btn);
  }
  container.appendChild(reactions);

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
  *, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  .oddity-popover {
    position: relative;
    width: 240px;
    max-width: 90vw;
    background: #FFFFFF;
    border: 1px solid #E0E2E5;
    border-left-width: 3px;
    border-radius: 10px;
    padding: 12px 14px;
    box-shadow: 0 0 0 1px #E0E2E5, 0 12px 32px rgba(31, 33, 36, 0.14);
    overflow: visible;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    animation: popoverIn 0.2s cubic-bezier(0.23, 1, 0.32, 1);
  }

  .annotation-dot {
    position: absolute;
    left: -5px;
    top: 14px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
  }

  .annotation-tag {
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin-bottom: 6px;
  }

  .annotation-text {
    font-size: 15px;
    line-height: 1.5;
    color: #1F2124;
  }

  .annotation-text p {
    margin: 0 0 4px;
  }

  .annotation-text p:last-child {
    margin-bottom: 0;
  }

  .annotation-text strong {
    font-weight: 600;
  }

  .annotation-text ul {
    margin: 4px 0;
    padding-left: 16px;
    list-style: disc;
  }

  .annotation-text li {
    margin-bottom: 2px;
  }

  .annotation-text br {
    display: block;
    content: "";
    margin-top: 4px;
  }

  .annotation-reactions {
    display: flex;
    gap: 6px;
    margin-top: 10px;
    flex-wrap: wrap;
  }

  .reaction-btn {
    all: unset;
    font-size: 11px;
    background: transparent;
    border: 1px solid #E0E2E5;
    border-radius: 999px;
    color: #62656B;
    padding: 3px 10px;
    cursor: pointer;
    transition: border-color 0.2s, color 0.2s, background 0.2s;
    letter-spacing: 0.04em;
  }

  .reaction-btn:hover {
    color: #1F2124;
    border-color: #9A9DA3;
    background: #F4F5F6;
  }

  .reaction-btn.active {
    background: #E9F3FF;
    border-color: #0285FF;
    color: #0070DD;
  }

  @keyframes popoverIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .oddity-popover {
      animation-duration: 0.01ms;
    }
    .reaction-btn {
      transition-duration: 0.01ms;
    }
  }
`;
