// ─── Context Popup ───
// Compact popover for selecting reading purpose. Positioned near the mode toggle.
// Self-contained: custom element + closed shadow DOM, appended to document.body.

import type { UserContextMode } from "@oddity/shared";

export type ContextPopupResult = { mode: UserContextMode; note: string };

const MODE_OPTIONS: { value: UserContextMode; label: string; desc: string }[] = [
  { value: "info-takeaway", label: "Info Takeaway", desc: "Extract reliable facts" },
  { value: "brainstorm", label: "Brainstorm", desc: "Find creative seeds" },
  { value: "argument-formation", label: "Argument", desc: "Build your position" },
  { value: "decision", label: "Decision", desc: "Decide whether to act" },
  { value: "learning", label: "Learning", desc: "Learn a new topic" },
];

let hostEl: HTMLElement | null = null;
let pendingResolve: ((result: ContextPopupResult | null) => void) | null = null;

export function isContextPopupVisible(): boolean {
  return hostEl !== null;
}

export function hideContextPopup(): void {
  if (!hostEl) return;
  resolve(null);
}

/**
 * Show compact popover anchored near the given element (the mode toggle wrapper).
 * If no anchor is provided, falls back to bottom-right fixed positioning.
 */
export function showContextPopup(
  currentMode?: UserContextMode,
  _currentNote?: string,
  anchorRect?: DOMRect,
): Promise<ContextPopupResult | null> {
  // If already visible, dismiss the old one first
  if (hostEl) {
    resolve(null);
  }

  return new Promise<ContextPopupResult | null>((res) => {
    pendingResolve = res;

    hostEl = document.createElement("oddity-context-popup");
    hostEl.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";

    // Block keyboard events from leaking to the page
    for (const evt of ["keydown", "keyup", "keypress", "input", "beforeinput"]) {
      hostEl.addEventListener(evt, (e) => e.stopPropagation());
    }

    const shadow = hostEl.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    // Invisible click-away layer
    const clickAway = document.createElement("div");
    clickAway.className = "click-away";
    clickAway.addEventListener("click", () => resolve(null));
    shadow.appendChild(clickAway);

    // Popover container
    const popover = document.createElement("div");
    popover.className = "popover";
    popover.addEventListener("click", (e) => e.stopPropagation());

    // Position near anchor
    if (anchorRect) {
      popover.style.position = "fixed";
      popover.style.right = `${window.innerWidth - anchorRect.right}px`;
      popover.style.bottom = `${window.innerHeight - anchorRect.top + 8}px`;
    } else {
      // Fallback: bottom-right
      popover.style.position = "fixed";
      popover.style.right = "24px";
      popover.style.bottom = "80px";
    }

    const title = document.createElement("div");
    title.className = "popover-title";
    title.textContent = "Reading purpose";
    popover.appendChild(title);

    // Mode options — click to select immediately
    for (const opt of MODE_OPTIONS) {
      const btn = document.createElement("button");
      btn.className = "mode-option" + (opt.value === currentMode ? " active" : "");

      const label = document.createElement("span");
      label.className = "option-label";
      label.textContent = opt.label;

      const desc = document.createElement("span");
      desc.className = "option-desc";
      desc.textContent = opt.desc;

      btn.appendChild(label);
      btn.appendChild(desc);

      btn.addEventListener("click", () => {
        resolve({ mode: opt.value, note: "" });
      });

      popover.appendChild(btn);
    }

    shadow.appendChild(popover);
    document.body.appendChild(hostEl);

    // Animate in
    requestAnimationFrame(() => {
      popover.classList.add("visible");
    });
  });
}

function resolve(result: ContextPopupResult | null): void {
  const cb = pendingResolve;
  pendingResolve = null;

  if (hostEl) {
    hostEl.remove();
    hostEl = null;
  }

  if (cb) cb(result);
}

// ─── CSS ───

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');

  :host {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
  }

  .click-away {
    position: fixed;
    inset: 0;
    pointer-events: auto;
  }

  .popover {
    width: 220px;
    background: #1a1a1a;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    pointer-events: auto;
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  .popover.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .popover-title {
    font-size: 11px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.4);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 4px 8px 6px;
  }

  .mode-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    cursor: pointer;
    transition: background 0.1s ease;
    text-align: left;
    font-family: inherit;
  }
  .mode-option:hover {
    background: rgba(255, 255, 255, 0.08);
  }
  .mode-option.active {
    background: rgba(255, 255, 255, 0.12);
  }

  .option-label {
    font-size: 13px;
    font-weight: 500;
    color: #e8e8e8;
  }
  .option-desc {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.35);
    flex-shrink: 0;
  }

  .mode-option.active .option-label {
    color: #fff;
  }
  .mode-option.active .option-desc {
    color: rgba(255, 255, 255, 0.5);
  }
`;
