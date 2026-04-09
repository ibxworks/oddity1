// gdocs-comments.ts
// Posts depth annotations as Google Docs native comments using keyboard
// simulation — same approach as gdocs.ts uses for suggestion mode.
// No OAuth or Google Cloud Console setup required.

import type { Annotation } from "@oddity/shared";
import { ANNOTATION_LABELS } from "@oddity/shared";
import { sendMessage } from "../shared/messaging.js";
import { getPageUrl } from "./page-url.js";
import { addLiveFeedback, updateLiveFeedbackId } from "./renderer/arguments-box.js";

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
  annotationByNoteFingerprint.clear();
}

// ─── Annotation data store (for reply detection) ─────────────────────────────

interface StoredAnnotation {
  annotation: Annotation;
  contentHash: string;
}

/** First 200 chars of note text — used to match GDocs comment back to annotation. */
function noteFingerprint(note: string): string {
  return note.slice(0, 200).trim();
}

const annotationByNoteFingerprint = new Map<string, StoredAnnotation>();

/**
 * Lookup function injected from index.ts. Given a note text fingerprint,
 * returns the matching annotation + contentHash from the live stores.
 */
let _lookupAnnotation: ((fp: string) => StoredAnnotation | null) | null = null;

export function setGDocsAnnotationLookup(
  fn: (fp: string) => StoredAnnotation | null,
): void {
  _lookupAnnotation = fn;
}

/**
 * Called by gdocs.ts after posting annotations as GDocs comments.
 * Registers each annotation so the reply observer can match threads.
 * The commentText format used by gdocs.ts is: "[Label] note\n\nquestion"
 */
export function registerGDocsCommentAnnotations(
  annotations: Array<{ type: string; anchor: { exact: string }; content: { note: string; question?: string }; id?: string }>,
  contentHash: string,
): void {
  for (const ann of annotations) {
    const label = ann.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const commentText = `[${label}] ${ann.content.note}${ann.content.question ? "\n\n" + ann.content.question : ""}`;

    // Store keyed by the full comment text (what .docos-replyview-body shows)
    annotationByNoteFingerprint.set(noteFingerprint(commentText), {
      annotation: ann as unknown as Annotation,
      contentHash,
    });
    // Also store keyed by just the note text as fallback
    annotationByNoteFingerprint.set(noteFingerprint(ann.content.note), {
      annotation: ann as unknown as Annotation,
      contentHash,
    });
  }
  // Re-snapshot threads now that we have annotation data
  _rescanThreads?.();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueues a depth annotation to be posted as a Google Docs native comment
 * via keyboard simulation. Each annotation is posted at most once per
 * page load.
 */
export function postAnnotationAsGDocsComment(annotation: Annotation, contentHash: string): void {
  const text = annotation.content.note;
  if (!text) return;

  const label =
    ANNOTATION_LABELS[annotation.type] ??
    annotation.type.replace(/_/g, " ").toUpperCase();

  // Always register the annotation for reply lookup, even if already posted.
  const commentText = `[Oddity · ${label}]\n\n${text}`;
  annotationByNoteFingerprint.set(noteFingerprint(text), { annotation, contentHash });
  annotationByNoteFingerprint.set(noteFingerprint(commentText), { annotation, contentHash });

  if (postedAnnotationIds.has(annotation.id)) return;
  postedAnnotationIds.add(annotation.id);
  commentQueue.push({ text: commentText, annotationId: annotation.id });

  // Kick off the queue (no-op if already running)
  drainCommentQueue().catch((err) => {
    console.warn("[Oddity 1] GDocs comment queue error:", err);
  });
}

// ─── GDocs reply observer ─────────────────────────────────────────────────────

/** Each thread is a .docos-anchoreddocoview; each comment/reply inside is a .docos-replyview. */
function getThreads(): Element[] {
  return Array.from(document.querySelectorAll(".docos-anchoreddocoview"));
}

/** Returns all .docos-replyview-body elements within a thread (index 0 = root comment, 1+ = replies). */
function getCommentTextEls(thread: Element): Element[] {
  return Array.from(thread.querySelectorAll(".docos-replyview-body"));
}

/**
 * Look up the stored annotation by matching the first comment's body text.
 */
function findAnnotationForThread(firstCommentText: string): StoredAnnotation | null {
  const fp = noteFingerprint(firstCommentText);

  // In-session map (annotations posted in this page load)
  const direct = annotationByNoteFingerprint.get(fp);
  if (direct) return direct;

  // Live store lookup (annotations from previous sessions already in GDocs)
  if (_lookupAnnotation) {
    return _lookupAnnotation(fp);
  }

  return null;
}

/**
 * Sets up a MutationObserver that detects when the user types a reply into a
 * Google Docs comment thread created by Oddity. The reply is then routed into
 * the argument box exactly like a margin-note reply.
 *
 * Must be called once per page load.
 */
export function initGDocsReplyObserver(): void {
  if (!isGoogleDoc()) return;

  // Keyed by the first comment's text (stable even when GDocs recreates the DOM element).
  // Value = number of replies already processed for that thread.
  const processedReplyCount = new Map<string, number>();

  function processThreads(): void {
    const threads = getThreads();

    for (const thread of threads) {
      const commentEls = getCommentTextEls(thread);
      if (commentEls.length === 0) continue;

      const firstText = (commentEls[0]!.textContent ?? "").trim();
      const stored = findAnnotationForThread(firstText);
      if (!stored) continue;

      // replies start at index 1
      const currentReplyCount = commentEls.length - 1;

      if (!processedReplyCount.has(firstText)) {
        // First encounter: snapshot existing reply count, don't fire callback
        processedReplyCount.set(firstText, currentReplyCount);
        continue;
      }

      const alreadySeen = processedReplyCount.get(firstText)!;
      if (currentReplyCount <= alreadySeen) continue;

      // Process only the new replies
      for (let i = alreadySeen + 1; i <= currentReplyCount; i++) {
        const replyEl = commentEls[i]!;
        const replyText = replyEl.textContent?.trim();
        if (!replyText) continue;
        handleGDocsReply(replyText, stored.annotation, stored.contentHash);
      }
      processedReplyCount.set(firstText, currentReplyCount);
    }
  }

  // Expose so index.ts can re-snapshot threads after depth annotations load
  _rescanThreads = processThreads;

  // Initial snapshot
  processThreads();

  const observer = new MutationObserver(() => {
    processThreads();
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

let _rescanThreads: (() => void) | null = null;

/**
 * Re-snapshot all Oddity comment threads in GDocs. Call this after depth
 * annotations have been loaded so the observer has a fresh baseline before
 * the user starts replying.
 */
export function rescanGDocsThreads(): void {
  _rescanThreads?.();
}

/**
 * Called when the user submits a reply to an Oddity comment in the GDocs sidebar.
 * Mirrors the submitReply() flow in margin-notes.ts: adds to argument box
 * immediately and saves to backend.
 */
function handleGDocsReply(text: string, annotation: Annotation, contentHash: string): void {
  const excerpt =
    annotation.content.note.length > 40
      ? annotation.content.note.slice(0, 37) + "\u2026"
      : annotation.content.note;

  const liveSortKey = addLiveFeedback("↳", text, {
    type: "reply",
    replyHeader: excerpt,
    replyFullNote: annotation.content.note,
    replyAnchor: annotation.anchor.exact,
    annotationType: annotation.type,
    annotationId: annotation.id,
    contentHash,
  });

  sendMessage({
    action: "saveFeedback",
    payload: {
      annotationId: annotation.id,
      contentHash,
      url: getPageUrl(),
      feedbackType: "reply",
      replyText: text,
      pageTitle: document.title,
    },
  }).then((fb: any) => {
    if (fb?.id) {
      updateLiveFeedbackId(liveSortKey, fb.id);
      window.dispatchEvent(
        new CustomEvent("oddity:feedback-added", {
          detail: { feedback: fb, contentHash },
        }),
      );
    }
  }).catch(() => {});
}
