// ─── Context Popup ───
// Floating modal that asks the user for their reading context before depth annotations.
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

export function showContextPopup(
  currentMode?: UserContextMode,
  currentNote?: string,
): Promise<ContextPopupResult | null> {
  // If already visible, dismiss the old one first
  if (hostEl) {
    resolve(null);
  }

  return new Promise<ContextPopupResult | null>((res) => {
    pendingResolve = res;

    hostEl = document.createElement("oddity-context-popup");
    hostEl.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:auto;";

    // Block keyboard events from leaking to the page
    for (const evt of ["keydown", "keyup", "keypress", "input", "beforeinput"]) {
      hostEl.addEventListener(evt, (e) => e.stopPropagation());
    }

    const shadow = hostEl.attachShadow({ mode: "closed" });

    let selected: UserContextMode | null = currentMode ?? null;

    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    // Backdrop
    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";
    backdrop.addEventListener("click", () => resolve(null));
    shadow.appendChild(backdrop);

    // Card
    const card = document.createElement("div");
    card.className = "card";
    card.addEventListener("click", (e) => e.stopPropagation());

    const title = document.createElement("h2");
    title.className = "title";
    title.textContent = "What are you reading for?";
    card.appendChild(title);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = "This shapes how depth annotations respond to the text.";
    card.appendChild(subtitle);

    // Mode buttons
    const modeGrid = document.createElement("div");
    modeGrid.className = "mode-grid";

    const btnEls: HTMLButtonElement[] = [];
    for (const opt of MODE_OPTIONS) {
      const btn = document.createElement("button");
      btn.className = "mode-btn" + (opt.value === selected ? " active" : "");
      btn.dataset.value = opt.value;

      const label = document.createElement("span");
      label.className = "mode-label";
      label.textContent = opt.label;

      const desc = document.createElement("span");
      desc.className = "mode-desc";
      desc.textContent = opt.desc;

      btn.appendChild(label);
      btn.appendChild(desc);
      btnEls.push(btn);

      btn.addEventListener("click", () => {
        selected = opt.value as UserContextMode;
        btnEls.forEach((b) => b.classList.toggle("active", b.dataset.value === selected));
        continueBtn.disabled = false;
        continueBtn.classList.add("ready");
      });

      modeGrid.appendChild(btn);
    }
    card.appendChild(modeGrid);

    // Note input
    const noteLabel = document.createElement("label");
    noteLabel.className = "note-label";
    noteLabel.textContent = "Anything specific? (optional)";
    card.appendChild(noteLabel);

    const noteInput = document.createElement("input");
    noteInput.className = "note-input";
    noteInput.type = "text";
    noteInput.placeholder = "e.g. I'm comparing this to last week's report";
    noteInput.maxLength = 500;
    noteInput.value = currentNote ?? "";
    card.appendChild(noteInput);

    // Buttons
    const btnRow = document.createElement("div");
    btnRow.className = "btn-row";

    const skipBtn = document.createElement("button");
    skipBtn.className = "btn skip";
    skipBtn.textContent = "Skip";
    skipBtn.addEventListener("click", () => resolve(null));

    const continueBtn = document.createElement("button");
    continueBtn.className = "btn continue" + (selected ? " ready" : "");
    continueBtn.textContent = "Continue";
    continueBtn.disabled = !selected;
    continueBtn.addEventListener("click", () => {
      if (!selected) return;
      resolve({ mode: selected, note: noteInput.value.trim() });
    });

    // Enter key submits
    noteInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && selected) {
        resolve({ mode: selected, note: noteInput.value.trim() });
      }
    });

    btnRow.appendChild(skipBtn);
    btnRow.appendChild(continueBtn);
    card.appendChild(btnRow);

    shadow.appendChild(card);
    document.body.appendChild(hostEl);

    // Animate in
    requestAnimationFrame(() => {
      backdrop.classList.add("visible");
      card.classList.add("visible");
    });
  });
}

function resolve(result: ContextPopupResult | null): void {
  const cb = pendingResolve;
  pendingResolve = null;

  if (hostEl) {
    const shadow = hostEl.shadowRoot ?? (hostEl as any).__shadow;
    // Attempt fade-out, then remove
    const backdrop = hostEl.shadowRoot
      ? hostEl.shadowRoot.querySelector(".backdrop")
      : null;
    // Since shadow is closed, just remove immediately
    hostEl.remove();
    hostEl = null;
  }

  if (cb) cb(result);
}

// ─── CSS ───

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@400;500;600&display=swap');

  :host {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
  }

  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0);
    transition: background 0.2s ease;
  }
  .backdrop.visible {
    background: rgba(0, 0, 0, 0.35);
  }

  .card {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) scale(0.96);
    opacity: 0;
    transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease;
    width: 400px;
    max-width: calc(100vw - 32px);
    background: #fff;
    border-radius: 16px;
    padding: 28px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.1);
    z-index: 1;
  }
  .card.visible {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }

  .title {
    font-family: 'Fraunces', Georgia, serif;
    font-size: 20px;
    font-weight: 600;
    color: #111;
    margin: 0 0 4px;
    letter-spacing: -0.3px;
  }

  .subtitle {
    font-size: 13px;
    color: #888;
    margin: 0 0 20px;
  }

  .mode-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 18px;
  }

  .mode-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 14px;
    border: 1.5px solid #e8e8e2;
    border-radius: 10px;
    background: #fff;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
    font-family: inherit;
  }
  .mode-btn:hover {
    border-color: #ccc;
    background: #fafaf8;
  }
  .mode-btn.active {
    border-color: #111;
    background: #111;
  }
  .mode-btn.active .mode-label {
    color: #fff;
    font-weight: 600;
  }
  .mode-btn.active .mode-desc {
    color: rgba(255, 255, 255, 0.6);
  }

  .mode-label {
    font-size: 13.5px;
    font-weight: 500;
    color: #222;
  }
  .mode-desc {
    font-size: 12px;
    color: #999;
  }

  .note-label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: #666;
    margin-bottom: 6px;
  }
  .note-input {
    width: 100%;
    padding: 9px 12px;
    border: 1.5px solid #e8e8e2;
    border-radius: 10px;
    font-size: 13px;
    font-family: inherit;
    outline: none;
    color: #222;
    transition: border-color 0.15s;
    box-sizing: border-box;
  }
  .note-input:focus {
    border-color: #111;
  }
  .note-input::placeholder {
    color: #bbb;
  }

  .btn-row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }

  .btn {
    padding: 8px 18px;
    border-radius: 100px;
    font-size: 13px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
    border: 1.5px solid transparent;
  }
  .btn.skip {
    background: none;
    color: #888;
    border-color: #e8e8e2;
  }
  .btn.skip:hover {
    color: #555;
    border-color: #ccc;
  }
  .btn.continue {
    background: #ddd;
    color: #999;
    border-color: transparent;
    pointer-events: none;
  }
  .btn.continue.ready {
    background: #111;
    color: #fff;
    pointer-events: auto;
  }
  .btn.continue.ready:hover {
    background: #333;
  }
`;
