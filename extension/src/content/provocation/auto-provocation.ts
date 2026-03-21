/**
 * Auto-Provocation: Ghost-text provocations that appear while the user writes.
 *
 * Shows a greyed-out inline provocation (like VS Code autocomplete) after the
 * user pauses typing for ~4 seconds. The provocation is purely inspirational —
 * Tab/Escape/keep-typing all dismiss it without inserting.
 *
 * Supports: <textarea>, contenteditable elements, and Google Docs.
 */

import { sendMessage } from "../../shared/messaging.js";

// ─── Constants ───

const DEBOUNCE_MS = 4000;
const COOLDOWN_MS = 30000;
const MIN_DRAFT_LENGTH = 10;
const MAX_DRAFT_CHARS = 2000;
const MAX_CONTEXT_CHARS = 3000;

// ─── Module State ───

let enabled = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let cooldownUntil = 0;
let shownProvocations: string[] = [];
let currentGhostEl: HTMLElement | null = null;
let shadowHost: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let activeAdapter: InputAdapter | null = null;
let provocationBuffer = "";
let isStreaming = false;

// ─── Input Adapter Interface ───

interface InputAdapter {
  getDraftText(): string;
  getCursorPixelPosition(): { x: number; y: number; lineHeight: number } | null;
  isActive(): boolean;
  getComputedFont(): { fontFamily: string; fontSize: string; lineHeight: string };
}

// ─── Textarea Adapter ───

class TextareaAdapter implements InputAdapter {
  constructor(private el: HTMLTextAreaElement) {}

  getDraftText(): string {
    return this.el.value;
  }

  getCursorPixelPosition(): { x: number; y: number; lineHeight: number } | null {
    const computed = getComputedStyle(this.el);
    const mirror = document.createElement("div");

    const props = [
      "font",
      "letterSpacing",
      "wordSpacing",
      "lineHeight",
      "padding",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "border",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "boxSizing",
      "whiteSpace",
      "wordWrap",
      "overflowWrap",
      "width",
    ];
    for (const prop of props) {
      mirror.style.setProperty(prop, computed.getPropertyValue(prop));
    }
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.height = "auto";
    mirror.style.overflow = "hidden";

    const textBefore = this.el.value.substring(0, this.el.selectionStart);
    mirror.textContent = textBefore;
    const marker = document.createElement("span");
    marker.textContent = "\u200b"; // zero-width space
    mirror.appendChild(marker);

    document.body.appendChild(mirror);

    const rect = this.el.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();

    const x = rect.left + (markerRect.left - mirrorRect.left) - this.el.scrollLeft;
    const y = rect.top + (markerRect.top - mirrorRect.top) - this.el.scrollTop;
    const lineHeight =
      parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.2;

    document.body.removeChild(mirror);

    // Check if cursor position is within the textarea's visible area
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      return null;
    }

    return { x, y, lineHeight };
  }

  isActive(): boolean {
    return document.activeElement === this.el;
  }

  getComputedFont(): { fontFamily: string; fontSize: string; lineHeight: string } {
    const computed = getComputedStyle(this.el);
    return {
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      lineHeight: computed.lineHeight,
    };
  }
}

// ─── ContentEditable Adapter ───

class ContentEditableAdapter implements InputAdapter {
  constructor(private el: HTMLElement) {}

  getDraftText(): string {
    return this.el.innerText;
  }

  getCursorPixelPosition(): { x: number; y: number; lineHeight: number } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(false);

    let rect = range.getBoundingClientRect();

    // If range rect is zero-size (e.g., empty line), use a temp span
    if (rect.width === 0 && rect.height === 0) {
      const span = document.createElement("span");
      span.textContent = "\u200b";
      range.insertNode(span);
      rect = span.getBoundingClientRect();
      span.remove();
      this.el.normalize();
    }

    if (rect.height === 0) return null;

    return { x: rect.right || rect.left, y: rect.top, lineHeight: rect.height };
  }

  isActive(): boolean {
    return this.el.contains(document.activeElement) || document.activeElement === this.el;
  }

  getComputedFont(): { fontFamily: string; fontSize: string; lineHeight: string } {
    const computed = getComputedStyle(this.el);
    return {
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      lineHeight: computed.lineHeight,
    };
  }
}

// ─── Google Docs Adapter ───

class GoogleDocsAdapter implements InputAdapter {
  getDraftText(): string {
    // Try multiple selectors for Google Docs text extraction.
    // Google Docs uses different DOM structures depending on version:
    // - Legacy: .kix-lineview contains text nodes
    // - Canvas-era: .kix-wordhtmlgenerator-word-node contains text
    // - Accessibility: [role="textbox"] aria content

    // 1. Try kix-lineview (legacy rendering)
    const lineViews = document.querySelectorAll(".kix-lineview");
    if (lineViews.length > 0) {
      const texts: string[] = [];
      lineViews.forEach((lv) => {
        const text = lv.textContent?.trim();
        if (text) texts.push(text);
      });
      const result = texts.join("\n");
      if (result.length > 0) return result;
    }

    // 2. Try word nodes
    const wordNodes = document.querySelectorAll(".kix-wordhtmlgenerator-word-node");
    if (wordNodes.length > 0) {
      return Array.from(wordNodes)
        .map((w) => w.textContent ?? "")
        .join("");
    }

    // 3. Try accessibility textbox
    const textbox = document.querySelector('[role="textbox"][aria-label]');
    if (textbox) {
      return (textbox.textContent ?? "").trim();
    }

    // 4. Try kix-page
    const pages = document.querySelectorAll(".kix-page");
    if (pages.length > 0) {
      return Array.from(pages)
        .map((p) => p.textContent?.trim() ?? "")
        .filter(Boolean)
        .join("\n");
    }

    // 5. Final fallback: try to get any visible text content from the editor area
    const editor = document.querySelector(".kix-appview-editor");
    if (editor) {
      return (editor.textContent ?? "").trim();
    }

    return "";
  }

  getCursorPixelPosition(): { x: number; y: number; lineHeight: number } | null {
    // Google Docs renders a visible cursor element.
    // Try multiple selectors for different GDocs versions.
    const cursor = (
      document.querySelector(".kix-cursor-caret") ??
      document.querySelector(".kix-cursor")
    ) as HTMLElement | null;
    if (!cursor) return null;

    const rect = cursor.getBoundingClientRect();
    if (rect.height === 0) return null;

    return { x: rect.left + rect.width, y: rect.top, lineHeight: rect.height };
  }

  isActive(): boolean {
    // Google Docs is "active" when focused
    return document.hasFocus();
  }

  getComputedFont(): { fontFamily: string; fontSize: string; lineHeight: string } {
    // Try to detect font from the current line or editor area
    for (const selector of [".kix-lineview", ".kix-wordhtmlgenerator-word-node", ".kix-appview-editor"]) {
      const el = document.querySelector(selector);
      if (el) {
        const computed = getComputedStyle(el);
        if (computed.fontFamily) {
          return {
            fontFamily: computed.fontFamily,
            fontSize: computed.fontSize || "11pt",
            lineHeight: computed.lineHeight || "1.5",
          };
        }
      }
    }
    return { fontFamily: "Arial, sans-serif", fontSize: "11pt", lineHeight: "1.5" };
  }
}

// ─── Adapter Selection ───

function isGoogleDocs(): boolean {
  return window.location.hostname === "docs.google.com";
}

function getAdapterForElement(el: Element): InputAdapter | null {
  if (isGoogleDocs()) {
    return new GoogleDocsAdapter();
  }

  if (el instanceof HTMLTextAreaElement) {
    return new TextareaAdapter(el);
  }

  if (
    el instanceof HTMLElement &&
    (el.isContentEditable || el.closest("[contenteditable]"))
  ) {
    const editable =
      el.isContentEditable
        ? el
        : (el.closest("[contenteditable]") as HTMLElement);
    if (editable) return new ContentEditableAdapter(editable);
  }

  return null;
}

// ─── Shadow DOM Setup ───

function ensureShadowRoot(): ShadowRoot {
  if (shadowRoot) return shadowRoot;

  shadowHost = document.createElement("div");
  shadowHost.id = "oddity-provocation-host";
  shadowHost.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;overflow:visible;";
  document.body.appendChild(shadowHost);

  shadowRoot = shadowHost.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    .oddity-ghost-text {
      position: fixed;
      pointer-events: none;
      color: rgba(128, 128, 128, 0.55);
      white-space: pre-wrap;
      opacity: 0;
      transition: opacity 200ms ease-in;
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .oddity-ghost-text.visible {
      opacity: 1;
    }
  `;
  shadowRoot.appendChild(style);

  return shadowRoot;
}

// ─── Ghost Text Rendering ───

function showGhostText(text: string): void {
  if (!activeAdapter) return;

  const pos = activeAdapter.getCursorPixelPosition();
  if (!pos) return;

  const root = ensureShadowRoot();
  const font = activeAdapter.getComputedFont();

  if (!currentGhostEl) {
    currentGhostEl = document.createElement("span");
    currentGhostEl.className = "oddity-ghost-text";
    root.appendChild(currentGhostEl);
  }

  currentGhostEl.textContent = text;
  currentGhostEl.style.left = `${pos.x}px`;
  currentGhostEl.style.top = `${pos.y}px`;
  currentGhostEl.style.fontFamily = font.fontFamily;
  currentGhostEl.style.fontSize = font.fontSize;
  currentGhostEl.style.lineHeight = font.lineHeight;

  // Force reflow then fade in
  void currentGhostEl.offsetHeight;
  currentGhostEl.classList.add("visible");
}

function dismissGhostText(): void {
  if (currentGhostEl) {
    currentGhostEl.remove();
    currentGhostEl = null;
  }
  provocationBuffer = "";
  isStreaming = false;
}

// ─── Context Extraction ───

function getPageContext(): string {
  // For chat sites: try to get recent messages
  const chatMessages = document.querySelectorAll(
    // Common selectors for LLM chat response containers
    '[data-message-author-role="assistant"], .agent-turn, .message-content, .prose, .markdown-body'
  );

  if (chatMessages.length > 0) {
    const recent = Array.from(chatMessages)
      .slice(-3) // last 3 messages
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n");
    return recent.slice(0, MAX_CONTEXT_CHARS);
  }

  // General page: get main content
  const article = document.querySelector("article, main, [role='main']");
  if (article) {
    return (article.textContent ?? "").trim().slice(0, MAX_CONTEXT_CHARS);
  }

  return "";
}

// ─── Provocation Request ───

function requestProvocation(): void {
  if (!activeAdapter || !activeAdapter.isActive()) return;

  const draftText = activeAdapter.getDraftText();
  if (draftText.trim().length < MIN_DRAFT_LENGTH) return;

  // Cooldown check
  if (Date.now() < cooldownUntil) return;

  const pageContext = getPageContext();

  provocationBuffer = "";
  isStreaming = true;

  sendMessage({
    action: "requestProvocation",
    payload: {
      draftText: draftText.slice(-MAX_DRAFT_CHARS),
      pageContext: pageContext.slice(0, MAX_CONTEXT_CHARS),
      pageUrl: window.location.href,
      alreadyShown: shownProvocations.slice(-10), // last 10 for dedup
    },
  }).catch(() => {
    // Extension context may be invalidated — silently fail
    isStreaming = false;
  });
}

// ─── Chunk Handler (called from index.ts) ───

export function handleProvocationChunk(payload: {
  text: string;
  done: boolean;
}): void {
  if (!enabled) return;

  if (payload.done) {
    isStreaming = false;
    if (provocationBuffer.trim()) {
      // Check for SKIP signal from LLM
      if (provocationBuffer.trim().toUpperCase() === "SKIP") {
        dismissGhostText();
        return;
      }
      shownProvocations.push(provocationBuffer.trim());
      cooldownUntil = Date.now() + COOLDOWN_MS;
    }
    return;
  }

  if (payload.text) {
    provocationBuffer += payload.text;
    // Only show once we have a reasonable amount of text
    if (provocationBuffer.length > 3) {
      showGhostText(provocationBuffer);
    }
  }
}

// ─── Event Handlers ───

function onFocusIn(e: FocusEvent): void {
  const target = e.target;
  if (!(target instanceof Element)) return;

  // Special case: Google Docs — always use GoogleDocsAdapter
  if (isGoogleDocs()) {
    activeAdapter = new GoogleDocsAdapter();
    return;
  }

  const adapter = getAdapterForElement(target);
  if (adapter) {
    activeAdapter = adapter;
  }
}

function onFocusOut(): void {
  clearDebounce();
  dismissGhostText();
  activeAdapter = null;
}

function onInput(): void {
  // Immediately dismiss any visible ghost text
  dismissGhostText();
  clearDebounce();

  if (!activeAdapter || !activeAdapter.isActive()) return;
  if (Date.now() < cooldownUntil) return;

  debounceTimer = setTimeout(() => {
    requestProvocation();
  }, DEBOUNCE_MS);
}

function onKeyDown(e: KeyboardEvent): void {
  if (!currentGhostEl) return;

  if (e.key === "Tab" || e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    dismissGhostText();
  }
  // Any other key: the 'input' event will handle dismissal
}

function onScroll(): void {
  if (currentGhostEl) {
    dismissGhostText();
  }
}

function clearDebounce(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

// ─── Google Docs: Cursor-based Input Detection ───

let gdocsCursorObserver: MutationObserver | null = null;

function onGoogleDocsKeyDown(e: KeyboardEvent): void {
  // Ghost text dismiss via Tab/Escape
  if (currentGhostEl && (e.key === "Tab" || e.key === "Escape")) {
    e.preventDefault();
    e.stopPropagation();
    dismissGhostText();
    return;
  }

  // Ignore non-character keys (arrows, shift, ctrl, etc.)
  if (e.key.length > 1 && !["Backspace", "Delete", "Enter"].includes(e.key)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // User is typing — dismiss ghost text and reset debounce
  dismissGhostText();
  clearDebounce();

  if (Date.now() < cooldownUntil) return;

  debounceTimer = setTimeout(() => {
    if (!activeAdapter) activeAdapter = new GoogleDocsAdapter();
    requestProvocation();
  }, DEBOUNCE_MS);
}

function setupGoogleDocsObserver(): void {
  // Google Docs intercepts keyboard events through a hidden iframe,
  // but keydown events still bubble on the main document.
  // Use keydown as the primary typing signal.
  document.addEventListener("keydown", onGoogleDocsKeyDown, true);

  // Also try to observe cursor position changes as a secondary signal
  const cursorCheck = () => {
    const cursor = document.querySelector(".kix-cursor");
    if (!cursor) {
      // Retry — Google Docs may not have loaded yet
      setTimeout(cursorCheck, 3000);
      return;
    }

    gdocsCursorObserver = new MutationObserver(() => {
      // Cursor moved = user is typing or navigating
      dismissGhostText();
      clearDebounce();

      if (Date.now() < cooldownUntil) return;

      debounceTimer = setTimeout(() => {
        if (!activeAdapter) activeAdapter = new GoogleDocsAdapter();
        requestProvocation();
      }, DEBOUNCE_MS);
    });

    gdocsCursorObserver.observe(cursor, {
      attributes: true,
      attributeFilter: ["style"],
      subtree: true,
    });
  };

  cursorCheck();
}

// ─── Lifecycle ───

export function initAutoProvocation(): void {
  if (enabled) return;
  enabled = true;

  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll, true);

  // Google Docs special handling
  if (isGoogleDocs()) {
    activeAdapter = new GoogleDocsAdapter();
    setupGoogleDocsObserver();
  }
}

export function destroyAutoProvocation(): void {
  if (!enabled) return;
  enabled = false;

  clearDebounce();
  dismissGhostText();

  document.removeEventListener("focusin", onFocusIn, true);
  document.removeEventListener("focusout", onFocusOut, true);
  document.removeEventListener("input", onInput, true);
  document.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onScroll, true);

  document.removeEventListener("keydown", onGoogleDocsKeyDown, true);

  if (gdocsCursorObserver) {
    gdocsCursorObserver.disconnect();
    gdocsCursorObserver = null;
  }

  if (shadowHost) {
    shadowHost.remove();
    shadowHost = null;
    shadowRoot = null;
  }

  activeAdapter = null;
  shownProvocations = [];
  cooldownUntil = 0;
}
