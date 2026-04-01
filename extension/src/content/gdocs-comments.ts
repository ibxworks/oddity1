// gdocs-comments.ts
// Posts depth annotations as Google Docs native comments using keyboard
// simulation — same approach as gdocs.ts uses for suggestion mode.
// No OAuth or Google Cloud Console setup required.

import type { Annotation } from "@oddity/shared";
import { ANNOTATION_LABELS } from "@oddity/shared";

// ─── Google Doc detection ─────────────────────────────────────────────────────

/**
 * Returns true when the current page is a Google Doc.
 */
export function isGoogleDoc(): boolean {
  return (
    window.location.hostname === "docs.google.com" &&
    window.location.pathname.startsWith("/document/d/")
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Finds the comment input textarea/div that appears when Ctrl+Alt+M is
 * triggered in Google Docs. Tries multiple selectors with a timeout.
 */
async function waitForCommentInput(timeoutMs = 2500): Promise<HTMLElement | null> {
  const selectors = [
    // Modern Google Docs comment box
    ".docos-input-textarea",
    ".docos-replybox-textarea",
    // Contenteditable comment box
    "[aria-label='Add a comment']",
    "[aria-label='Comment']",
    "[placeholder='Add a comment…']",
    "[placeholder='Add a comment']",
    // Fallback: any visible contenteditable inside a comment container
    ".docos-streamdocument-container [contenteditable='true']",
    ".docos-docosbody-container [contenteditable='true']",
  ];

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of selectors) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.offsetParent !== null) return el; // must be visible
    }
    await sleep(100);
  }
  return null;
}

/**
 * Types text into the comment input. Handles both <textarea> and
 * contenteditable <div> elements.
 */
function setCommentText(el: HTMLElement, text: string): void {
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const ta = el as HTMLTextAreaElement;
    ta.focus();
    ta.value = text;
    ta.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    // contenteditable div
    el.focus();
    // execCommand is deprecated but still works in Google Docs
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
  }
}

/**
 * Submits the currently-open comment box via Ctrl+Enter.
 */
function submitComment(el: HTMLElement): void {
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  el.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      ctrlKey: true,
      bubbles: true,
    }),
  );
}

/**
 * Triggers Google Docs' "Insert Comment" keyboard shortcut on the
 * text-event-target iframe (the same iframe gdocs.ts uses for insertions).
 * Mac: Cmd+Option+M   Windows/Linux: Ctrl+Alt+M
 */
async function triggerCommentShortcut(): Promise<void> {
  const iframe = document.querySelector<HTMLIFrameElement>(
    ".docs-texteventtarget-iframe",
  );
  if (!iframe?.contentDocument?.body) {
    console.warn("[Oddity 1] GDocs comment: text-event-target iframe not found");
    return;
  }

  const body = iframe.contentDocument.body as HTMLElement;
  body.focus();
  await sleep(80);

  const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
  const eventProps = {
    key: "m",
    code: "KeyM",
    keyCode: 77,
    which: 77,
    metaKey: isMac,
    ctrlKey: !isMac,
    altKey: true,
    bubbles: true,
    cancelable: true,
  };

  body.dispatchEvent(new KeyboardEvent("keydown", eventProps));
  body.dispatchEvent(new KeyboardEvent("keyup", { ...eventProps, cancelable: false }));
}

// ─── Sequential comment queue ─────────────────────────────────────────────────
// Annotations arrive rapidly (streaming). We queue them and process one at a
// time so comment boxes don't overlap each other.

let commentQueue: Array<{ text: string; annotationId: string }> = [];
let queueRunning = false;

async function drainCommentQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;

  while (commentQueue.length > 0) {
    const item = commentQueue.shift()!;
    await insertOneComment(item.text);
    // Small gap between successive comments to let GDocs settle
    await sleep(400);
  }

  queueRunning = false;
}

async function insertOneComment(text: string): Promise<void> {
  await triggerCommentShortcut();
  const input = await waitForCommentInput();

  if (!input) {
    console.warn("[Oddity 1] GDocs comment: input box did not appear");
    return;
  }

  setCommentText(input, text);
  await sleep(150);
  submitComment(input);
  await sleep(300);
}

// ─── Comment deduplication ───────────────────────────────────────────────────

const postedAnnotationIds = new Set<string>();

export function resetPostedAnnotations(): void {
  postedAnnotationIds.clear();
  commentQueue = [];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueues a depth annotation to be posted as a Google Docs native comment
 * via keyboard simulation. Each annotation is posted at most once per
 * page load.
 */
export function postAnnotationAsGDocsComment(annotation: Annotation): void {
  if (postedAnnotationIds.has(annotation.id)) return;

  const text = annotation.content.note;
  if (!text) return;

  const label =
    ANNOTATION_LABELS[annotation.type] ??
    annotation.type.replace(/_/g, " ").toUpperCase();
  const commentText = `[Oddity · ${label}]\n\n${text}`;

  postedAnnotationIds.add(annotation.id);
  commentQueue.push({ text: commentText, annotationId: annotation.id });

  // Kick off the queue (no-op if already running)
  drainCommentQueue().catch((err) => {
    console.warn("[Oddity 1] GDocs comment queue error:", err);
  });
}
