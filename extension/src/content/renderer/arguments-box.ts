import type { Annotation, AnnotationFeedback } from "@oddity/shared";
import { ANNOTATION_LABELS } from "@oddity/shared";
import {
  getThemeMode,
  offThemeChange,
  onThemeChange,
} from "./theme-detector.js";

// ─── Types ───

type ArgumentItem = { icon: string; text: string; sortKey: string };

// ─── State ───

let hostEl: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let panelEl: HTMLDivElement | null = null;
let listEl: HTMLDivElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;
let expanded = false;
let canonicalItems: ArgumentItem[] = [];
let liveItems: ArgumentItem[] = [];
let themeHandler: ((mode: "light" | "dark") => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Public API ───

export function initArgumentsBox(): void {
  if (hostEl) return;

  hostEl = document.createElement("oddity-arguments-box");
  hostEl.style.cssText =
    "position: fixed; bottom: 0; right: 0; z-index: 2147483647; pointer-events: none;";
  document.body.appendChild(hostEl);

  shadowRoot = hostEl.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = ARGUMENTS_BOX_CSS;
  shadowRoot.appendChild(style);

  // Theme
  hostEl.dataset.theme = getThemeMode();
  themeHandler = (mode) => {
    if (hostEl) hostEl.dataset.theme = mode;
  };
  onThemeChange(themeHandler);

  // Toggle button
  toggleBtn = document.createElement("button");
  toggleBtn.className = "args-toggle";
  const logoImg = document.createElement("img");
  logoImg.src = chrome.runtime.getURL("Terry.png");
  logoImg.alt = "My Arguments";
  logoImg.className = "args-toggle-logo";
  toggleBtn.appendChild(logoImg);
  toggleBtn.title = "My Arguments";
  toggleBtn.addEventListener("click", () => toggle());
  shadowRoot.appendChild(toggleBtn);

  // Panel
  panelEl = document.createElement("div");
  panelEl.className = "args-panel";

  // Header
  const header = document.createElement("div");
  header.className = "args-header";

  const title = document.createElement("span");
  title.className = "args-title";
  title.textContent = "My Arguments";

  const copyBtn = document.createElement("button");
  copyBtn.className = "args-copy-btn";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => handleCopy(copyBtn));

  header.appendChild(title);
  header.appendChild(copyBtn);
  panelEl.appendChild(header);

  // List
  listEl = document.createElement("div");
  listEl.className = "args-list";
  panelEl.appendChild(listEl);

  // Empty state
  renderList();

  shadowRoot.appendChild(panelEl);
}

export function updateArgumentsBox(
  annotations: Map<string, Annotation[]>,
  feedback: Map<string, AnnotationFeedback[]>,
): void {
  if (!hostEl) return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    canonicalItems = buildItems(annotations, feedback);
    liveItems = []; // Server state is canonical — clear live items
    renderList();
  }, 150);
}

export function addLiveFeedback(icon: string, text: string): void {
  if (!hostEl) return;
  liveItems.push({ icon, text, sortKey: `live-${Date.now()}` });
  renderList();
}

export function setArgumentsBoxVisible(visible: boolean): void {
  if (!hostEl) return;
  hostEl.style.display = visible ? "" : "none";
}

export function setArgumentsBoxEnabled(enabled: boolean): void {
  if (!toggleBtn) return;
  toggleBtn.classList.toggle("oddity-enabled", enabled);
}

export function destroyArgumentsBox(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (themeHandler) {
    offThemeChange(themeHandler);
    themeHandler = null;
  }
  hostEl?.remove();
  hostEl = null;
  shadowRoot = null;
  panelEl = null;
  listEl = null;
  toggleBtn = null;
  expanded = false;
  canonicalItems = [];
  liveItems = [];
}

// ─── Internal ───

function toggle(): void {
  expanded = !expanded;
  panelEl?.classList.toggle("visible", expanded);
  toggleBtn?.classList.toggle("active", expanded);
}

function buildItems(
  annotations: Map<string, Annotation[]>,
  feedback: Map<string, AnnotationFeedback[]>,
): ArgumentItem[] {
  const items: ArgumentItem[] = [];

  // Manual annotations
  for (const [, anns] of annotations) {
    for (const ann of anns) {
      if (ann.id.startsWith("manual-")) {
        const label = ANNOTATION_LABELS[ann.type] ?? ann.type;
        items.push({
          icon: "✎",
          text: `(${label}) ${ann.content.note}`,
          sortKey: ann.id,
        });
      }
    }
  }

  // Feedback items
  for (const [, fbs] of feedback) {
    for (const fb of fbs) {
      if (fb.feedback_type === "thumbs_up") {
        items.push({
          icon: "✓",
          text:
            fb.reply_text || findAnnotationNote(annotations, fb.annotation_id),
          sortKey: fb.created_at,
        });
      } else if (fb.feedback_type === "thumbs_down") {
        items.push({
          icon: "✗",
          text:
            fb.reply_text || findAnnotationNote(annotations, fb.annotation_id),
          sortKey: fb.created_at,
        });
      } else if (fb.feedback_type === "reply") {
        const note = findAnnotationNote(annotations, fb.annotation_id);
        const excerpt = note.length > 60 ? note.slice(0, 57) + "..." : note;
        items.push({
          icon: "↳",
          text: `Re "${excerpt}": ${fb.reply_text ?? ""}`,
          sortKey: fb.created_at,
        });
      }
    }
  }

  items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return items;
}

function findAnnotationNote(
  annotations: Map<string, Annotation[]>,
  annotationId: string,
): string {
  for (const [, anns] of annotations) {
    const ann = anns.find((a) => a.id === annotationId);
    if (ann) return ann.content.note;
  }
  return "(annotation)";
}

function renderList(): void {
  if (!listEl) return;

  const allItems = [...canonicalItems, ...liveItems];
  listEl.innerHTML = "";

  if (allItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "args-empty";
    empty.textContent =
      "No arguments yet. React to annotations or create your own!";
    listEl.appendChild(empty);
    // Update badge
    if (toggleBtn) toggleBtn.dataset.count = "";
    return;
  }

  for (const item of allItems) {
    const row = document.createElement("div");
    row.className = "args-item";

    const icon = document.createElement("span");
    icon.className = "args-icon";
    icon.textContent = item.icon;

    const text = document.createElement("span");
    text.className = "args-text";
    text.textContent = item.text;

    row.appendChild(icon);
    row.appendChild(text);
    listEl.appendChild(row);
  }

  // Update badge count
  if (toggleBtn) {
    toggleBtn.dataset.count = String(allItems.length);
  }
}

function handleCopy(btn: HTMLButtonElement): void {
  const allItems = [...canonicalItems, ...liveItems];
  const text = allItems.map((i) => `${i.icon} ${i.text}`).join("\n");
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => {
      btn.textContent = orig;
    }, 1500);
  });
}

// ─── Assets ───

// ─── CSS ───

const ARGUMENTS_BOX_CSS = `
  * { box-sizing: border-box; }

  .args-toggle {
    all: unset;
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: #fff;
    border: 2.5px solid rgba(0, 0, 0, 0.08);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    pointer-events: auto;
    overflow: hidden;
    transition: transform 0.15s, box-shadow 0.15s, border-color 0.2s;
    z-index: 2;
  }

  .args-toggle.oddity-enabled {
    border-color: #4ade80;
  }

  .args-toggle-logo {
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: none;
  }

  .args-toggle:hover {
    transform: scale(1.08);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
  }

  .args-toggle.active {
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
  }

  /* Badge count */
  .args-toggle[data-count]:not([data-count=""])::after {
    content: attr(data-count);
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 18px;
    height: 18px;
    border-radius: 9px;
    background: #3b82f6;
    color: white;
    font-size: 10px;
    font-weight: 700;
    font-family: system-ui, -apple-system, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
    line-height: 1;
  }

  .args-panel {
    position: fixed;
    bottom: 70px;
    right: 20px;
    width: 300px;
    max-height: 250px;
    background: rgba(255, 255, 255, 0.88);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12);
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 13px;
    color: #1e293b;
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 1;

    /* Hidden by default */
    opacity: 0;
    transform: translateY(8px) scale(0.96);
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease;
  }

  .args-panel.visible {
    opacity: 1;
    transform: translateY(0) scale(1);
    pointer-events: auto;
  }

  .args-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.06);
    flex-shrink: 0;
  }

  .args-title {
    font-weight: 600;
    font-size: 13px;
    color: #334155;
  }

  .args-copy-btn {
    all: unset;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    color: #3b82f6;
    padding: 3px 8px;
    border-radius: 4px;
    transition: background 0.15s;
    font-family: system-ui, -apple-system, sans-serif;
  }

  .args-copy-btn:hover {
    background: rgba(59, 130, 246, 0.08);
  }

  .args-list {
    overflow-y: auto;
    flex: 1;
    padding: 6px 0;
  }

  .args-item {
    display: flex;
    gap: 8px;
    padding: 5px 14px;
    line-height: 1.4;
    align-items: flex-start;
  }

  .args-item:hover {
    background: rgba(0, 0, 0, 0.03);
  }

  .args-icon {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
    font-size: 13px;
    color: #64748b;
    padding-top: 1px;
  }

  .args-text {
    font-size: 12px;
    color: #334155;
    word-break: break-word;
    line-height: 1.45;
  }

  .args-empty {
    padding: 20px 14px;
    text-align: center;
    color: #94a3b8;
    font-size: 12px;
    line-height: 1.5;
  }

  /* ── Dark mode ── */

  :host([data-theme="dark"]) .args-panel {
    background: rgba(15, 23, 42, 0.9);
    border-color: rgba(255, 255, 255, 0.08);
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
    color: #e2e8f0;
  }

  :host([data-theme="dark"]) .args-header {
    border-bottom-color: rgba(255, 255, 255, 0.06);
  }

  :host([data-theme="dark"]) .args-title {
    color: #e2e8f0;
  }

  :host([data-theme="dark"]) .args-copy-btn {
    color: #60a5fa;
  }

  :host([data-theme="dark"]) .args-copy-btn:hover {
    background: rgba(96, 165, 250, 0.1);
  }

  :host([data-theme="dark"]) .args-item:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  :host([data-theme="dark"]) .args-icon {
    color: #94a3b8;
  }

  :host([data-theme="dark"]) .args-text {
    color: #cbd5e1;
  }

  :host([data-theme="dark"]) .args-empty {
    color: #64748b;
  }
`;
