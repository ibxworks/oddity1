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
let containerEl: HTMLDivElement | null = null;
let closeBtnEl: HTMLButtonElement | null = null;
let listEl: HTMLDivElement | null = null;
let panelToggleInput: HTMLInputElement | null = null;
let panelToggleLabelEl: HTMLSpanElement | null = null;
let expanded = false;
let canonicalItems: ArgumentItem[] = [];
let liveItems: ArgumentItem[] = [];
let themeHandler: ((mode: "light" | "dark") => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let closeBtnHideTimer: ReturnType<typeof setTimeout> | null = null;

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

  // ── Morphing container (button → panel) ──
  containerEl = document.createElement("div");
  containerEl.className = "args-container";
  containerEl.addEventListener("click", () => {
    if (!expanded) toggle();
  });

  // Button face (Terry.png, visible when collapsed)
  const buttonFace = document.createElement("div");
  buttonFace.className = "args-button-face";
  const logoImg = document.createElement("img");
  logoImg.src = chrome.runtime.getURL("Terry.png");
  logoImg.alt = "My Arguments";
  logoImg.className = "args-toggle-logo";
  buttonFace.appendChild(logoImg);
  // Content clip wrapper — clips button/panel faces during morph, sits inside container
  const contentClip = document.createElement("div");
  contentClip.className = "args-content-clip";
  contentClip.appendChild(buttonFace);

  // Panel face (visible when expanded)
  const panelFace = document.createElement("div");
  panelFace.className = "args-panel-face";
  panelFace.addEventListener("click", (e) => e.stopPropagation());

  // ── Panel header: "Oddity 1" + toggle ──
  const panelHeader = document.createElement("div");
  panelHeader.className = "args-panel-header";

  const mainTitle = document.createElement("span");
  mainTitle.className = "args-main-title";
  mainTitle.textContent = "Oddity 1";

  const toggleRow = document.createElement("div");
  toggleRow.className = "args-toggle-row";

  panelToggleLabelEl = document.createElement("span");
  panelToggleLabelEl.className = "args-enabled-label";
  panelToggleLabelEl.textContent = "On";

  panelToggleInput = document.createElement("input");
  panelToggleInput.type = "checkbox";
  panelToggleInput.className = "args-panel-toggle-input";
  panelToggleInput.id = "args-panel-toggle-chk";
  panelToggleInput.checked = true;

  const panelToggleSlider = document.createElement("label");
  panelToggleSlider.className = "args-panel-toggle-slider";
  panelToggleSlider.htmlFor = "args-panel-toggle-chk";

  panelToggleInput.addEventListener("change", (e) => {
    e.stopPropagation();
    const en = panelToggleInput!.checked;
    panelToggleLabelEl!.textContent = en ? "On" : "Off";
    chrome.storage.local.get("preferences").then((stored) => {
      const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
      chrome.storage.local.set({ preferences: { ...prefs, enabled: en } });
    });
  });

  toggleRow.appendChild(panelToggleLabelEl);
  toggleRow.appendChild(panelToggleInput);
  toggleRow.appendChild(panelToggleSlider);
  panelHeader.appendChild(mainTitle);
  panelHeader.appendChild(toggleRow);
  panelFace.appendChild(panelHeader);

  // ── Section title ──
  const sectionTitle = document.createElement("div");
  sectionTitle.className = "args-section-title";
  sectionTitle.textContent = "Argument Box";
  panelFace.appendChild(sectionTitle);

  // ── List ──
  listEl = document.createElement("div");
  listEl.className = "args-list";
  panelFace.appendChild(listEl);
  renderList();

  // ── Copy button ──
  const copyBtnFull = document.createElement("button");
  copyBtnFull.className = "args-copy-btn-full";
  copyBtnFull.textContent = "Copy";
  copyBtnFull.addEventListener("click", (e) => {
    e.stopPropagation();
    handleCopy(copyBtnFull);
  });
  panelFace.appendChild(copyBtnFull);

  // ── Footer ──
  const footer = document.createElement("div");
  footer.className = "args-footer";

  const footerText = document.createElement("span");
  footerText.className = "args-footer-text";
  footerText.textContent = "Go to Dashboard";
  footerText.addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: "openPopup", payload: {} });
  });

  const footerAvatar = document.createElement("div");
  footerAvatar.className = "args-footer-avatar";
  const footerAvatarImg = document.createElement("img");
  footerAvatarImg.src = chrome.runtime.getURL("Terry.png");
  footerAvatarImg.alt = "Terry";
  footerAvatarImg.className = "args-footer-avatar-img";
  footerAvatar.appendChild(footerAvatarImg);

  footer.appendChild(footerText);
  footer.appendChild(footerAvatar);
  panelFace.appendChild(footer);

  contentClip.appendChild(panelFace);
  containerEl.appendChild(contentClip);

  // Hover → show close button when expanded
  containerEl.addEventListener("mouseenter", () => {
    if (expanded) showCloseBtn();
  });
  containerEl.addEventListener("mouseleave", () => hideCloseBtn());

  // ── Close button — absolute child so it follows container corner during morph ──
  closeBtnEl = document.createElement("button");
  closeBtnEl.className = "args-close-btn";
  closeBtnEl.title = "Close";
  closeBtnEl.addEventListener("mouseenter", () => showCloseBtn());
  closeBtnEl.addEventListener("mouseleave", () => hideCloseBtn());
  closeBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (expanded) toggle();
  });
  containerEl.appendChild(closeBtnEl);

  shadowRoot.appendChild(containerEl);
}

export function updateArgumentsBox(
  annotations: Map<string, Annotation[]>,
  feedback: Map<string, AnnotationFeedback[]>,
): void {
  if (!hostEl) return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    canonicalItems = buildItems(annotations, feedback);
    liveItems = [];
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
  if (!containerEl) return;
  containerEl.classList.toggle("oddity-enabled", enabled);
  if (panelToggleInput) panelToggleInput.checked = enabled;
  if (panelToggleLabelEl) panelToggleLabelEl.textContent = enabled ? "On" : "Off";
}

export function destroyArgumentsBox(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (closeBtnHideTimer) clearTimeout(closeBtnHideTimer);
  if (themeHandler) {
    offThemeChange(themeHandler);
    themeHandler = null;
  }
  hostEl?.remove();
  hostEl = null;
  shadowRoot = null;
  containerEl = null;
  closeBtnEl = null;
  listEl = null;
  panelToggleInput = null;
  panelToggleLabelEl = null;
  expanded = false;
  canonicalItems = [];
  liveItems = [];
}

// ─── Internal ───

function toggle(): void {
  expanded = !expanded;
  containerEl?.classList.toggle("expanded", expanded);
  if (!expanded) {
    if (closeBtnHideTimer) clearTimeout(closeBtnHideTimer);
    closeBtnEl?.classList.remove("hovered");
  } else if (containerEl?.matches(":hover")) {
    // Cursor was already inside when panel opened — show close button immediately
    showCloseBtn();
  }
}

function showCloseBtn(): void {
  if (!expanded) return;
  if (closeBtnHideTimer) { clearTimeout(closeBtnHideTimer); closeBtnHideTimer = null; }
  closeBtnEl?.classList.add("hovered");
}

function hideCloseBtn(): void {
  closeBtnHideTimer = setTimeout(() => {
    closeBtnEl?.classList.remove("hovered");
    closeBtnHideTimer = null;
  }, 80);
}

function buildItems(
  annotations: Map<string, Annotation[]>,
  feedback: Map<string, AnnotationFeedback[]>,
): ArgumentItem[] {
  const items: ArgumentItem[] = [];

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

  for (const [, fbs] of feedback) {
    for (const fb of fbs) {
      if (fb.feedback_type === "thumbs_up") {
        items.push({
          icon: "✓",
          text: fb.reply_text || findAnnotationNote(annotations, fb.annotation_id),
          sortKey: fb.created_at,
        });
      } else if (fb.feedback_type === "thumbs_down") {
        items.push({
          icon: "✗",
          text: fb.reply_text || findAnnotationNote(annotations, fb.annotation_id),
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
    empty.textContent = "No arguments yet. React to annotations or create your own!";
    listEl.appendChild(empty);
    return;
  }

  for (const item of allItems) {
    const row = document.createElement("div");
    row.className = "args-item";

    const bullet = document.createElement("span");
    bullet.className = "args-bullet";
    bullet.textContent = "·";

    const text = document.createElement("span");
    text.className = "args-text";
    text.textContent = item.text;

    row.appendChild(bullet);
    row.appendChild(text);
    listEl.appendChild(row);
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

// ─── CSS ───

const ARGUMENTS_BOX_CSS = `
  * { box-sizing: border-box; }

  /* ── Morphing container ── */

  .args-container {
    all: unset;
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2;
    pointer-events: auto;
    overflow: visible;
    background: rgba(255, 255, 255, 0.15);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    cursor: pointer;

    /* Collapsed (button) state */
    width: 44px;
    height: 44px;
    border-radius: 50%;
    box-shadow: 0 3px 14px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.2);

    transition:
      width 0.4s cubic-bezier(0.4, 0, 0.2, 1),
      height 0.4s cubic-bezier(0.4, 0, 0.2, 1),
      border-radius 0.4s cubic-bezier(0.4, 0, 0.2, 1),
      box-shadow 0.3s;
  }

  .args-container:not(.expanded):hover {
    transform: scale(1.08);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.2);
    transition:
      transform 0.15s,
      box-shadow 0.15s,
      width 0.4s cubic-bezier(0.4, 0, 0.2, 1),
      height 0.4s cubic-bezier(0.4, 0, 0.2, 1),
      border-radius 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .args-container.oddity-enabled {
    box-shadow: 0 3px 14px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.2), 0 0 0 2.5px #4ade80;
  }

  /* Expanded (panel) state */
  .args-container.expanded {
    width: 292px;
    height: 400px;
    border-radius: 16px;
    box-shadow: 0 3px 14px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.2);
    cursor: default;
  }

  /* ── Transparent hover buffer (20px around panel when expanded) ── */

  .args-container.expanded::before {
    content: '';
    position: absolute;
    inset: -20px;
    border-radius: 36px; /* slightly larger than panel's 16px */
    pointer-events: auto;
    z-index: -1;
  }

  /* ── Content clip (clips faces during morph) ── */

  .args-content-clip {
    position: absolute;
    inset: 0;
    overflow: hidden;
    border-radius: inherit;
  }

  /* ── Button face ── */

  .args-button-face {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 1;
    transition: opacity 0.15s ease;
    pointer-events: none;
    background: #fff;
    border-radius: inherit;
  }

  .args-container.expanded .args-button-face {
    opacity: 0;
    transition: opacity 0.1s ease;
  }

  .args-toggle-logo {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  /* ── Panel face ── */

  .args-panel-face {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
  }

  .args-container.expanded .args-panel-face {
    opacity: 1;
    pointer-events: auto;
    transition: opacity 0.2s ease 0.2s;
  }

  /* ── Panel header ── */

  .args-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px 0;
    flex-shrink: 0;
  }

  .args-main-title {
    font-weight: 600;
    font-size: 17px;
    color: #fff;
    letter-spacing: 0.3px;
    font-family: "Fraunces", Georgia, serif;
  }

  .args-toggle-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .args-enabled-label {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.7);
    font-family: system-ui, -apple-system, sans-serif;
  }

  .args-panel-toggle-input {
    display: none;
  }

  .args-panel-toggle-slider {
    display: inline-block;
    position: relative;
    width: 36px;
    height: 21px;
    background: rgba(255, 255, 255, 0.25);
    border-radius: 100px;
    cursor: pointer;
    transition: background 0.2s;
    flex-shrink: 0;
  }

  .args-panel-toggle-slider::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.2s;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .args-panel-toggle-input:checked + .args-panel-toggle-slider {
    background: #22c55e;
  }

  .args-panel-toggle-input:checked + .args-panel-toggle-slider::after {
    transform: translateX(15px);
  }

  /* ── Section title ── */

  .args-section-title {
    font-weight: 500;
    font-size: 14px;
    color: #fff;
    padding: 12px 18px 6px;
    flex-shrink: 0;
    font-family: "Fraunces", Georgia, serif;
  }

  /* ── List ── */

  .args-list {
    flex: 1;
    padding: 0 18px;
    overflow-y: auto;
    min-height: 0;
  }

  .args-item {
    display: flex;
    align-items: flex-start;
    gap: 5px;
    padding: 4px 0;
  }

  .args-bullet {
    flex-shrink: 0;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
    line-height: 1.5;
  }

  .args-text {
    font-family: Georgia, 'Times New Roman', serif;
    font-style: italic;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.85);
    line-height: 1.5;
    word-break: break-word;
  }

  .args-empty {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.4);
    line-height: 1.5;
    padding: 8px 0 4px;
    font-family: system-ui, -apple-system, sans-serif;
  }

  /* ── Copy button ── */

  .args-copy-btn-full {
    all: unset;
    display: block;
    margin: 12px 18px 0;
    padding: 11px 16px;
    background: #000;
    border: 1px solid #000;
    color: #fff;
    font-size: 14px;
    font-weight: 400;
    font-family: system-ui, -apple-system, sans-serif;
    text-align: center;
    border-radius: 100px;
    cursor: pointer;
    transition: background 0.15s;
    flex-shrink: 0;
  }

  .args-copy-btn-full:hover {
    background: #222;
  }

  /* ── Footer ── */

  .args-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 10px 18px 14px;
    flex-shrink: 0;
  }

  .args-footer-text {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    font-family: "Fraunces", Georgia, serif;
    font-weight: 400;
  }

  .args-footer-text:hover {
    color: rgba(255, 255, 255, 0.9);
  }

  .args-footer-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: #fff;
    flex-shrink: 0;
  }

  .args-footer-avatar-img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  /* ── Close button (Terry circle, top-right corner of panel) ── */

  .args-close-btn {
    all: unset;
    position: absolute;
    /* Centered on top-left corner of container */
    top: -10px;
    left: -10px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    cursor: pointer;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s ease, transform 0.15s ease;
    z-index: 3;
  }

  .args-close-btn::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 10px;
    height: 10px;
    background: #757575;
    /* Wide isosceles triangle pointing bottom-right (southeast) */
    clip-path: polygon(0% 90%, 90% 0%, 100% 100%);
  }

  .args-close-btn.hovered {
    opacity: 1;
    pointer-events: auto;
  }

  .args-close-btn:hover {
    transform: scale(1.1);
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
  }

  /* ── Light mode overrides ── */

  :host([data-theme="light"]) .args-container {
    background: rgba(255, 255, 255, 0.65);
  }

  :host([data-theme="light"]) .args-main-title {
    color: #1a1a1a;
  }

  :host([data-theme="light"]) .args-enabled-label {
    color: rgba(0, 0, 0, 0.55);
  }

  :host([data-theme="light"]) .args-panel-toggle-slider {
    background: rgba(0, 0, 0, 0.18);
  }

  :host([data-theme="light"]) .args-panel-toggle-input:checked + .args-panel-toggle-slider {
    background: #22c55e;
  }

  :host([data-theme="light"]) .args-section-title {
    color: #606060;
  }

  :host([data-theme="light"]) .args-bullet {
    color: rgba(0, 0, 0, 0.35);
  }

  :host([data-theme="light"]) .args-text {
    color: #606060;
  }

  :host([data-theme="light"]) .args-empty {
    color: rgba(0, 0, 0, 0.4);
  }

  :host([data-theme="light"]) .args-copy-btn-full {
    background: #1a1f27;
    border-color: #1a1f27;
    color: #fff;
  }

  :host([data-theme="light"]) .args-copy-btn-full:hover {
    background: #2e3440;
  }

  :host([data-theme="light"]) .args-footer-text {
    color: rgba(0, 0, 0, 0.5);
  }

  :host([data-theme="light"]) .args-footer-text:hover {
    color: rgba(0, 0, 0, 0.8);
  }

  :host([data-theme="light"]) .args-footer-avatar {
    border-color: rgba(0, 0, 0, 0.12);
  }
`;
