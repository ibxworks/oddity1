// Oddity GDocs — essay writing assistant for Google Docs
// Flow: user enters topic → MCQ questions → essay generation → edit mode on essay tab
import { registerGDocsCommentAnnotations } from "./gdocs-comments.js";
import { fetchGoogleDocsText } from "./google-docs.js";
import {
  getGDocsEditInlineErrorMessage,
  isGDocsEditAuthError,
  resolveGDocsDocumentText,
} from "./gdocs-helpers.js";

interface GDocsMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface OddityGDocsSession {
  docId: string;
  tabId: string;
  chatHistory: GDocsMessage[];
  createdAt: number;
  essayContent?: string;
  essayTabId?: string;
  essayVersions?: string[];
  editSuggestions?: Array<{ find: string; replace: string }[]>;
}

// Matches the McqOption / McqQuestion types exported from backend/lib/gemini.ts.
// Claude Code pattern: each option has a label (1-5 words) + description (trade-off explanation).
interface McqOption {
  label: string;
  description: string;
}
interface McqQuestion {
  question: string;
  header: string;      // ≤12 char chip shown above the question
  options: McqOption[]; // 2-4 options; "Other" is added by the UI automatically
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ─── State ────────────────────────────────────────────────────────────────────
let docContext = '';
let streaming = false;
let currentStreamText = '';
let inputBar: HTMLDivElement | null = null;
let topicTextarea: HTMLTextAreaElement | null = null;
let submitBtn: HTMLButtonElement | null = null;
let commentBtn: HTMLButtonElement | null = null;
let shadowWrapper: HTMLElement | null = null;
let activeDocId = '';
let activeTabId = '';
let essayTabId = '';
let pendingEditMode = false;
let docHasContent = false;
let activeSession: OddityGDocsSession | null = null;
let reviewPanelEl: HTMLElement | null = null;
let importedContext = '';

// ─── MCQ state ────────────────────────────────────────────────────────────────
let mcqActive = false;
let mcqPreviousQA: Array<{ question: string; answer: string }> = [];
let mcqQuestionIndex = 0;
let mcqAllQuestions: McqQuestion[] = [];
let mcqTopic = '';
let mcqCardEl: HTMLElement | null = null;
let mcqOverlayEl: HTMLElement | null = null;
let mcqCompletionCallback: (() => void) | null = null;
let mcqOriginalPrompt = '';
let mcqResources: Array<{ name: string; content: string }> = [];
let mcqMemos: Array<{ note: string; reply: string }> = [];
const MAX_MCQ_QUESTIONS = 5;

// ─── Mode selection ───────────────────────────────────────────────────────────
let userMode: 'auto' | 'fast' | 'plan' = 'auto';

// ─── Plan Mode state ──────────────────────────────────────────────────────────
let pendingOutlineMode = false;
let pendingSkeletonMode = false;    // true while streaming the skeleton
let pendingSkeletonApproval = false; // true while skeleton is shown and awaiting user action
let pendingPlanTopic = '';
let currentOutlineText = '';
let currentSkeletonText = '';

// ─── Chat history (for edit mode) ─────────────────────────────────────────────
const chatHistory: GDocsMessage[] = [];

// Maximum turns to keep in chat history before pruning the oldest pairs.
// Mirrors Claude Code's context-window management: truncate at a hard limit
// with a note so the model knows history was compressed.
const MAX_CHAT_HISTORY_TURNS = 10; // 10 user+assistant pairs = 20 messages

function pruneChatHistoryIfNeeded(): void {
  // Each "turn" is 1 user + 1 assistant message (2 entries).
  const maxMessages = MAX_CHAT_HISTORY_TURNS * 2;
  if (chatHistory.length <= maxMessages) return;
  // Remove oldest pairs from the front, always keeping pairs intact.
  const excess = chatHistory.length - maxMessages;
  chatHistory.splice(0, excess % 2 === 0 ? excess : excess + 1);
}

// ─── URL parsing ─────────────────────────────────────────────────────────────
function parseGDocsLocation(): { docId: string; tabId: string } {
  const pathMatch = window.location.pathname.match(/\/document\/d\/([^/]+)\//);
  const docId = pathMatch?.[1] ?? 'unknown';
  const tabId = new URLSearchParams(window.location.search).get('tab') ?? 'default';
  return { docId, tabId };
}

// ─── Storage helpers ──────────────────────────────────────────────────────────
function sessionKey(docId: string) {
  return `oddity_gdocs_session_${docId}`;
}

async function loadSession(docId: string): Promise<OddityGDocsSession | null> {
  const key = sessionKey(docId);
  const result = await chrome.storage.local.get(key);
  return (result[key] as OddityGDocsSession) ?? null;
}

async function saveSession(session: OddityGDocsSession): Promise<void> {
  const key = sessionKey(session.docId);
  await chrome.storage.local.set({ [key]: session });
  syncSessionToCloud(session);
}

// ─── Cloud sync helpers ───────────────────────────────────────────────────────
function syncSessionToCloud(session: OddityGDocsSession): void {
  chrome.runtime.sendMessage({
    action: 'gdocsSessionSave',
    payload: {
      docId: session.docId,
      chatHistory: session.chatHistory,
      essayVersions: session.essayVersions ?? [],
      editSuggestions: session.editSuggestions ?? [],
    },
  }).catch((err) => { console.warn('[gdocs] session save failed:', err); });
}

type CloudSession = {
  chatHistory: GDocsMessage[];
  essayVersions: string[];
  editSuggestions: Array<{ find: string; replace: string }[]>;
  createdAt: string;
};

async function loadSessionFromCloud(docId: string): Promise<OddityGDocsSession | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'gdocsSessionLoad', payload: { docId } },
      (result: { session: CloudSession | null } | undefined) => {
        if (!result?.session) { resolve(null); return; }
        const s = result.session;
        const lastEssay = s.essayVersions[s.essayVersions.length - 1];
        resolve({
          docId,
          tabId: 'default',
          chatHistory: s.chatHistory,
          createdAt: new Date(s.createdAt).getTime(),
          essayVersions: s.essayVersions,
          essayContent: lastEssay,
          editSuggestions: s.editSuggestions,
        });
      }
    );
  });
}

// ─── Stream relay via background messages ────────────────────────────────────

// Monotonic request ID — incremented on every new request.
// Any chunk/done/error whose requestId doesn't match the current one is silently
// dropped, preventing text from two concurrent requests from mixing.
// (Ported from Claude Code's turn-tracking pattern.)
let currentRequestId = 0;

// Two-stage timeouts:
//   FIRST_CHUNK_TIMEOUT_MS — how long to wait for the very first token (reasoning
//     models like gemini-2.5-pro can think for 30-45s before streaming starts).
//   HEARTBEAT_TIMEOUT_MS   — max silence between tokens once streaming has begun
//     (stream is considered frozen if no new token for this long).
const FIRST_CHUNK_TIMEOUT_MS = 90_000;
const HEARTBEAT_TIMEOUT_MS   = 20_000;
let chunkTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
let receivedFirstChunk = false;

function clearChunkTimeout(): void {
  if (chunkTimeoutHandle !== null) {
    clearTimeout(chunkTimeoutHandle);
    chunkTimeoutHandle = null;
  }
}

function resetChunkTimeout(requestId: number, isFirstChunk = false): void {
  clearChunkTimeout();
  const ms = isFirstChunk ? FIRST_CHUNK_TIMEOUT_MS : HEARTBEAT_TIMEOUT_MS;
  chunkTimeoutHandle = setTimeout(() => {
    if (requestId !== currentRequestId) return; // stale
    console.warn('[Oddity GDocs] Stream timeout — no chunk received in', ms, 'ms');
    currentStreamText = '';
    streaming = false;
    pendingEditMode = false;
    pendingOutlineMode = false;
    pendingSkeletonMode = false;
    stopLoadingAnimation();
    setInputEnabled(true);
    showInlineError('Response timed out — the AI stopped responding. Please try again.');
  }, ms);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'gdocsChatChunk') {
    const { text, requestId } = message.payload as { text: string; requestId?: number };
    // Discard chunks from stale/concurrent requests
    if (requestId !== undefined && requestId !== currentRequestId) return;
    currentStreamText += text;
    receivedFirstChunk = true;
    resetChunkTimeout(currentRequestId, false); // switch to short heartbeat after first chunk
  } else if (message.action === 'gdocsChatDone') {
    const { requestId } = (message.payload ?? {}) as { requestId?: number };
    if (requestId !== undefined && requestId !== currentRequestId) return;
    clearChunkTimeout();
    const response = currentStreamText;
    pruneChatHistoryIfNeeded();
    chatHistory.push({ role: 'assistant', content: response });
    currentStreamText = '';
    handleResponseActions(response)
      .then(() => {
        streaming = false;
        stopLoadingAnimation();
        setInputEnabled(true);
        if (activeSession) {
          activeSession.chatHistory = [...chatHistory];
          void saveSession(activeSession);
        }
      })
      .catch((err) => {
        console.error('[Oddity GDocs] Response handling error:', err);
        streaming = false;
        stopLoadingAnimation();
        setInputEnabled(true);
      });
  } else if (message.action === 'gdocsChatError') {
    const { error: errMsg, requestId } = (message.payload ?? {}) as { error?: string; requestId?: number };
    if (requestId !== undefined && requestId !== currentRequestId) return;
    clearChunkTimeout();
    const msg = errMsg ?? 'Unknown error';
    console.error('[Oddity GDocs] Chat error:', msg);
    currentStreamText = '';
    streaming = false;
    pendingEditMode = false;
    pendingOutlineMode = false;
    pendingSkeletonMode = false;
    stopLoadingAnimation();
    setInputEnabled(true);
    if (topicTextarea) {
      topicTextarea.placeholder = `Error: ${msg.slice(0, 60)}`;
      setTimeout(() => { if (topicTextarea) topicTextarea.placeholder = getPlaceholder(); }, 4000);
    }
  }
});

// Sends a gdocsChat message with a stamped requestId and starts the heartbeat.
// All gdocsChat sends must go through this so the concurrent-request guard works.
function sendGDocsChat(messages: GDocsMessage[], mode: string): void {
  currentRequestId += 1;
  const requestId = currentRequestId;
  receivedFirstChunk = false;
  resetChunkTimeout(requestId, true); // start with long first-chunk timeout
  chrome.runtime.sendMessage({ action: 'gdocsChat', payload: { messages, mode, requestId } });
}

function getPlaceholder(): string {
  if (activeSession?.essayContent?.trim() || docHasContent) return 'Ask for edits…';
  return 'What do you want to write about?';
}

// ─── Doc text via Docs API / export fallback ──────────────────────────────────
async function getApiDocTextResult(): Promise<{ text?: string; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'gdocsGetDocText', payload: { docId: activeDocId } },
      (result: { text?: string; error?: string }) => {
        if (chrome.runtime.lastError || result?.error) {
          resolve({
            text: '',
            error: chrome.runtime.lastError?.message ?? result?.error,
          });
          return;
        }
        resolve({ text: result?.text?.trim() ?? '' });
      }
    );
  });
}

async function getCurrentDocText(): Promise<string> {
  const resolved = await resolveGDocsDocumentText({
    docId: activeDocId,
    readApiText: getApiDocTextResult,
    readExportText: fetchGoogleDocsText,
    fallbackTexts: [docContext, activeSession?.essayContent],
  });

  if (resolved.text) {
    docContext = resolved.text;
    docHasContent = true;
    if (activeSession) {
      activeSession.essayContent = resolved.text;
    }
    return resolved.text;
  }

  const preserved = docContext.trim() || activeSession?.essayContent?.trim() || '';
  docHasContent = preserved.length > 0;
  return preserved;
}

// ─── Doc insertion ────────────────────────────────────────────────────────────
async function pasteIntoDoc(text: string) {
  const iframe = document.querySelector('.docs-texteventtarget-iframe') as HTMLIFrameElement | null;
  if (!iframe?.contentDocument?.body || !iframe.contentWindow) {
    console.warn('[Oddity GDocs] iframe not accessible');
    return;
  }
  const iframeBody = iframe.contentDocument.body as HTMLElement;
  iframeBody.focus();
  await sleep(100);
  for (const char of text) {
    if (char === '\n') {
      iframeBody.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      iframeBody.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    } else {
      const cc = char.charCodeAt(0);
      iframeBody.dispatchEvent(new KeyboardEvent('keypress', { key: char, charCode: cc, keyCode: cc, which: cc, bubbles: true, cancelable: true }));
    }
  }
}

// ─── GDocs tab management ─────────────────────────────────────────────────────
async function renameGDocsTab(name: string): Promise<boolean> {
  const tabEl = document.querySelector('[role="treeitem"][aria-selected="true"]');
  if (!tabEl) return false;
  const labelEl = tabEl.querySelector('.chapter-label-content');
  if (!labelEl) return false;
  labelEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  await sleep(400);
  const inputEl = tabEl.querySelector<HTMLInputElement>('input.goog-control');
  if (!inputEl || inputEl.style.display === 'none') return false;
  inputEl.value = name;
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(50);
  inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  await sleep(200);
  return true;
}

async function renameGDocsTabWithRetry(name: string, tabId: string, maxAttempts = 5, delayMs = 500): Promise<void> {
  if (tabId === 'default') return;
  for (let i = 0; i < maxAttempts; i++) {
    const ok = await renameGDocsTab(name);
    if (ok) return;
    await sleep(delayMs);
  }
}

async function createNewGDocsTab(): Promise<boolean> {
  const addBtn = document.querySelector<HTMLElement>('[aria-label="Add tab"]');
  if (!addBtn) return false;
  addBtn.click();
  await sleep(600);
  return true;
}

async function waitForTabChange(previousTabId: string, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const current = new URLSearchParams(window.location.search).get('tab') ?? 'default';
    if (current !== previousTabId) return;
    await sleep(100);
  }
}

async function navigateToGDocsTabByLabel(label: string): Promise<void> {
  const tabEl = document.querySelector<HTMLElement>(`[role="treeitem"][aria-label="${label}"]`);
  if (tabEl) { tabEl.click(); await sleep(400); }
}

async function buildEssayTab(essayContent: string): Promise<void> {
  const prevTabId = activeTabId;
  const created = await createNewGDocsTab();
  if (!created) {
    await pasteIntoDoc(`\n\n--- Essay Draft ---\n${essayContent}\n\n`);
    return;
  }
  await waitForTabChange(prevTabId);
  const newTabId = new URLSearchParams(window.location.search).get('tab') ?? 'default';
  essayTabId = newTabId;
  await renameGDocsTabWithRetry('Essay Draft', newTabId, 8, 300);
  await pasteIntoDoc(essayContent + '\n\n');
  docHasContent = true;
  docContext = essayContent;
  if (activeSession) {
    activeSession.essayContent = essayContent;
    activeSession.essayTabId = newTabId;
    activeSession.essayVersions = [...(activeSession.essayVersions ?? []), essayContent];
    await saveSession(activeSession);
  }
  await navigateToGDocsTabByLabel('Essay Draft');
  // Update placeholder to edit mode
  if (topicTextarea) topicTextarea.placeholder = getPlaceholder();
}

// ─── Suggestion / Edit mode ───────────────────────────────────────────────────
function clickElement(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}

async function enableSuggestionMode(): Promise<void> {
  const modeSwitcher = document.querySelector<HTMLElement>('#docs-toolbar-mode-switcher');
  if (!modeSwitcher || modeSwitcher.classList.contains('suggest-mode')) return;
  clickElement(modeSwitcher);
  await sleep(300);
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const items = Array.from(document.querySelectorAll<HTMLElement>('.goog-menuitem, .goog-option, [role^="menuitem"], [role="option"]')).filter(el => el.offsetParent !== null);
    const item = items.find(el => /suggest/i.test(el.textContent ?? '') || /suggest/i.test(el.getAttribute('aria-label') ?? ''));
    if (item) { clickElement(item); await sleep(300); return; }
    await sleep(50);
  }
}

async function enableEditMode(): Promise<void> {
  const modeSwitcher = document.querySelector<HTMLElement>('#docs-toolbar-mode-switcher');
  if (!modeSwitcher || modeSwitcher.classList.contains('edit-mode')) return;
  clickElement(modeSwitcher);
  await sleep(300);
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const items = Array.from(document.querySelectorAll<HTMLElement>('.goog-menuitem, .goog-option, [role^="menuitem"], [role="option"]')).filter(el => el.offsetParent !== null);
    const item = items.find(el => /editing/i.test(el.textContent ?? '') || /editing/i.test(el.getAttribute('aria-label') ?? ''));
    if (item) { clickElement(item); await sleep(300); return; }
    await sleep(50);
  }
}

// ─── Edit op types ────────────────────────────────────────────────────────────
type EditOp =
  | { type: 'replace'; find: string; replace: string }
  | { type: 'delete'; find: string }
  | { type: 'insert'; after: string; text: string };

// ─── Find & replace helpers ───────────────────────────────────────────────────
function parseEditOps(text: string): EditOp[] {
  const ops: EditOp[] = [];
  const blocks = text.split(/^---\s*$/m);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('REPLACE:')) {
      const findMatch = trimmed.match(/^FIND:\s*([\s\S]*?)(?=\nWITH:)/m);
      const withMatch = trimmed.match(/^WITH:\s*([\s\S]*)$/m);
      if (findMatch?.[1]) {
        ops.push({ type: 'replace', find: findMatch[1].trim(), replace: withMatch?.[1]?.trim() ?? '' });
      }
    } else if (trimmed.startsWith('DELETE:')) {
      const findMatch = trimmed.match(/^FIND:\s*([\s\S]*)$/m);
      if (findMatch?.[1]) {
        ops.push({ type: 'delete', find: findMatch[1].trim() });
      }
    } else if (trimmed.startsWith('INSERT:')) {
      const afterMatch = trimmed.match(/^AFTER:\s*([\s\S]*?)(?=\nTEXT:)/m);
      const textMatch = trimmed.match(/^TEXT:\s*([\s\S]*)$/m);
      if (afterMatch?.[1] && textMatch?.[1]) {
        ops.push({ type: 'insert', after: afterMatch[1].trim(), text: textMatch[1].trim() });
      }
    } else {
      // Legacy FIND/REPLACE fallback
      const findMatch = trimmed.match(/^FIND:\s*([\s\S]*?)(?=\nREPLACE:)/m);
      const replaceMatch = trimmed.match(/^REPLACE:\s*([\s\S]*)$/m);
      if (findMatch?.[1] !== undefined) {
        ops.push({ type: 'replace', find: findMatch[1].trim(), replace: replaceMatch?.[1]?.trim() ?? '' });
      }
    }
  }
  return ops;
}

function iframeDocuments(): Document[] {
  return Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'))
    .flatMap(f => { try { return f.contentDocument ? [f.contentDocument] : []; } catch { return []; } });
}

function findFRInputs(): { findInput: HTMLInputElement | null; dialogDoc: Document } {
  const excluded = ['docs-title-input', 'docs-omnibox-input', 'assisted-actions-toolbar-omnibox', 'goog-toolbar-combo-button-input'];
  for (const doc of [document, ...iframeDocuments()]) {
    const allInputs = Array.from(doc.querySelectorAll<HTMLInputElement>('input'));
    const findByLabel = allInputs.find(el => /\b(find|search)\b/i.test(el.getAttribute('aria-label') ?? ''));
    if (findByLabel) return { findInput: findByLabel, dialogDoc: doc };
    const dialog = doc.querySelector<HTMLElement>('[role="dialog"]');
    if (dialog) {
      const dialogInputs = Array.from(dialog.querySelectorAll<HTMLInputElement>('input')).filter(el => !excluded.some(c => el.classList.contains(c)));
      if (dialogInputs.length >= 1) return { findInput: dialogInputs[0] ?? null, dialogDoc: doc };
    }
    const nonToolbarInputs = allInputs.filter(el => !excluded.some(c => el.classList.contains(c)));
    if (nonToolbarInputs.length >= 1) return { findInput: nonToolbarInputs[0] ?? null, dialogDoc: doc };
  }
  return { findInput: null, dialogDoc: document };
}

async function waitForFRDialog(timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (findFRInputs().findInput) return true;
    await sleep(100);
  }
  return false;
}

async function typeIntoFRInput(input: HTMLInputElement, value: string): Promise<void> {
  input.focus();
  await sleep(50);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, ctrlKey: true, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', keyCode: 46, bubbles: true }));
  input.value = '';
  await sleep(50);
  for (const char of value) {
    const cc = char.charCodeAt(0);
    input.dispatchEvent(new KeyboardEvent('keypress', { key: char, charCode: cc, keyCode: cc, bubbles: true, cancelable: true }));
    input.value += char;
    input.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
  }
  await sleep(400);
}

function findNextFRBtn(): HTMLElement | null {
  for (const doc of [document, ...iframeDocuments()]) {
    const btn = Array.from(doc.querySelectorAll<HTMLElement>('*')).find(el => el.offsetParent !== null && el.children.length === 0 && /^(find|next)$/i.test(el.textContent?.trim() ?? ''));
    if (btn) return btn;
  }
  return null;
}

// ─── Depth annotation comments ───────────────────────────────────────────────
interface DepthAnnotation {
  mode: string;
  type: string;
  anchor: { exact: string };
  content: { note: string; question?: string };
}

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return 'sha256:' + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchAnnotationsForDoc(): Promise<DepthAnnotation[]> {
  const text = activeSession?.essayContent ?? '';
  if (!text.trim()) return [];
  const contentHash = await sha256hex(text);
  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'gdocsAnnotateText', payload: { text, url: window.location.href, contentHash, wordCount } },
      (result) => resolve((result as { annotations?: DepthAnnotation[] })?.annotations ?? [])
    );
  });
}

function snapshotEditables(): Set<HTMLElement> {
  const docs = [document, ...iframeDocuments()];
  return new Set(docs.flatMap(doc => Array.from(doc.querySelectorAll<HTMLElement>('[contenteditable], textarea, input, [role="textbox"]'))));
}

const COMMENT_INPUT_SELECTORS = [
  '.docos-input-textarea', '.docos-replybox-textarea',
  "[aria-label='Add a comment']", "[aria-label='Comment']",
  "[placeholder='Add a comment…']", "[placeholder='Add a comment']",
  ".docos-streamdocument-container [contenteditable='true']",
  ".docos-docosbody-container [contenteditable='true']",
];

async function waitForNewEditable(before: Set<HTMLElement>, timeoutMs = 3000): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of COMMENT_INPUT_SELECTORS) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.offsetParent !== null) return el;
    }
    for (const doc of [document, ...iframeDocuments()]) {
      const newEl = Array.from(doc.querySelectorAll<HTMLElement>('[contenteditable], textarea, input, [role="textbox"]')).find(el => !before.has(el) && el.offsetParent !== null);
      if (newEl) return newEl;
    }
    await sleep(100);
  }
  return null;
}

async function typeIntoCommentBox(el: HTMLElement, text: string): Promise<void> {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const ta = el as HTMLTextAreaElement;
    ta.focus(); ta.value = text;
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.focus();
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
  }
  await sleep(150);
}

async function submitGDocsComment(el: HTMLElement): Promise<void> {
  const container = el.closest('[role="dialog"], .docos-anchoreddialog, .docos-input-wrapper') ?? el.parentElement?.parentElement;
  if (container) {
    const btn = Array.from(container.querySelectorAll<HTMLElement>('button, [role="button"]')).find(b => /^comment$/i.test(b.textContent?.trim() ?? '') || /^comment$/i.test(b.getAttribute('aria-label') ?? ''));
    if (btn) { btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await sleep(300); return; }
  }
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true, bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true, bubbles: true }));
  await sleep(300);
}

async function selectAnchorInDoc(anchorText: string): Promise<boolean> {
  const canvasIframe = document.querySelector<HTMLIFrameElement>('.docs-texteventtarget-iframe');
  if (!canvasIframe?.contentDocument?.body) return false;
  const iframeBody = canvasIframe.contentDocument.body as HTMLElement;
  iframeBody.focus();
  await sleep(100);
  iframeBody.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', code: 'KeyH', keyCode: 72, metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  const ready = await waitForFRDialog();
  if (!ready) return false;
  const { findInput } = findFRInputs();
  if (!findInput) return false;
  await typeIntoFRInput(findInput, anchorText.slice(0, 80));
  findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
  const closeStart = Date.now();
  while (Date.now() - closeStart < 2000) { if (!findFRInputs().findInput) break; await sleep(100); }
  await sleep(200);
  return true;
}

async function addSingleGDocsComment(anchorText: string, commentText: string): Promise<void> {
  const found = await selectAnchorInDoc(anchorText);
  if (!found) { console.warn('[Oddity GDocs] Anchor not found:', anchorText.slice(0, 60)); return; }
  const before = snapshotEditables();
  const canvasIframe = document.querySelector<HTMLIFrameElement>('.docs-texteventtarget-iframe');
  if (!canvasIframe?.contentDocument?.body) return;
  const iframeBody = canvasIframe.contentDocument.body as HTMLElement;
  iframeBody.focus();
  await sleep(100);
  iframeBody.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', keyCode: 77, metaKey: true, altKey: true, bubbles: true, cancelable: true }));
  await sleep(800);
  const textarea = await waitForNewEditable(before);
  if (!textarea) { console.warn('[Oddity GDocs] Comment input did not appear'); return; }
  await typeIntoCommentBox(textarea, commentText);
  await submitGDocsComment(textarea);
  await sleep(300);
}

async function addDepthAnnotationsAsComments(): Promise<void> {
  if (topicTextarea) topicTextarea.placeholder = 'Generating annotations…';
  const annotations = await fetchAnnotationsForDoc();
  if (annotations.length === 0) {
    if (topicTextarea) { topicTextarea.placeholder = 'No depth annotations found'; setTimeout(() => { if (topicTextarea) topicTextarea.placeholder = getPlaceholder(); }, 3000); }
    return;
  }
  if (commentBtn) commentBtn.disabled = true;
  setInputEnabled(false);
  startLoadingAnimation();
  for (const ann of annotations) {
    const label = ann.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const commentText = `[${label}] ${ann.content.note}${ann.content.question ? '\n\n' + ann.content.question : ''}`;
    await addSingleGDocsComment(ann.anchor.exact, commentText);
  }
  const text = activeSession?.essayContent ?? '';
  if (text.trim()) {
    const contentHash = await sha256hex(text);
    registerGDocsCommentAnnotations(annotations, contentHash);
  }
  stopLoadingAnimation();
  if (commentBtn) commentBtn.disabled = false;
  setInputEnabled(true);
}

// ─── Edit review panel (Cursor-style) ────────────────────────────────────────

function callDocApi(action: string, payload: Record<string, unknown>): Promise<{ error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, payload }, (r) => resolve((r as { error?: string }) ?? {}));
  });
}

async function applyPendingEditsViaApi(ops: EditOp[]): Promise<EditOp[]> {
  document.dispatchEvent(new CustomEvent('oddity:gdocs:edit-start'));
  const applied: EditOp[] = [];
  const failed: EditOp[] = [];
  let authError: string | null = null;

  // Track replace-text from previous ops to detect cascading conflicts.
  // Ported from Claude Code's FileEditTool getPatchForEdits: if op N's find
  // string is a substring of op N-1's replacement, applying N would match
  // inside newly-inserted text rather than the original document.
  const appliedReplaceTexts: string[] = [];

  for (const op of ops) {
    // Cascading edit guard: skip if this op's find text is a substring of
    // any previously applied replacement (Claude Code utils.ts:262-350).
    if (op.type !== 'insert') {
      const findKey = op.find.replace(/\n+$/, '');
      const cascadeConflict = appliedReplaceTexts.some(
        prev => findKey !== '' && prev.includes(findKey)
      );
      if (cascadeConflict) {
        console.warn('[Oddity GDocs] Skipping op — find text is a substring of a previous replacement:', op.find.slice(0, 60));
        failed.push(op);
        continue;
      }
    }

    let result: { error?: string };
    if (op.type === 'insert') {
      result = await callDocApi('gdocsApplyInsert', { docId: activeDocId, afterText: op.after, insertText: op.text });
    } else {
      // For delete ops with no trailing newline in the find text, also attempt
      // stripping a trailing newline — mirrors Claude Code's applyEditToFile deletion logic.
      const findText = op.find;
      const replaceText = op.type === 'replace' ? op.replace : '';
      result = await callDocApi('gdocsApplyPendingEdit', {
        docId: activeDocId,
        findText,
        replaceText,
      });
    }

    if (result.error) {
      console.warn('[Oddity GDocs] Apply edit error:', result.error);
      failed.push(op);
      if (isGDocsEditAuthError(result.error)) {
        authError = result.error;
        break;
      }
    } else {
      applied.push(op);
      if (op.type === 'replace') appliedReplaceTexts.push(op.replace);
    }
  }

  if (authError) {
    showInlineError(getGDocsEditInlineErrorMessage(authError));
  } else if (failed.length > 0 && applied.length === 0) {
    showInlineError(getGDocsEditInlineErrorMessage());
  } else if (failed.length > 0) {
    showInlineError(`${failed.length} of ${ops.length} edits couldn't be located in the document.`);
  }
  return applied;
}

function dismissReviewPanel(): void {
  reviewPanelEl?.remove();
  reviewPanelEl = null;
}

function opLabel(op: EditOp): string {
  if (op.type === 'insert') return `Add after "${op.after.slice(0, 40)}…"`;
  if (op.type === 'delete') return `Remove "${op.find.slice(0, 40)}…"`;
  return `Replace "${op.find.slice(0, 30)}…"`;
}

function showEditReviewPanel(ops: EditOp[]): void {
  if (!shadowWrapper) return;
  dismissReviewPanel();

  const pending = new Set(ops.map((_, i) => i));
  let dismissed = false;
  const tryDismiss = () => {
    if (dismissed || pending.size > 0) return;
    dismissed = true;
    dismissReviewPanel(); setInputEnabled(true);
  };

  const panel = document.createElement('div');
  panel.className = 'review-panel';

  const header = document.createElement('div');
  header.className = 'review-header';

  const title = document.createElement('div');
  title.className = 'review-title';
  title.textContent = `${ops.length} change${ops.length !== 1 ? 's' : ''} · highlighted in doc`;
  header.appendChild(title);

  const bulkBtns = document.createElement('div');
  bulkBtns.className = 'review-bulk';

  const revertAllBtn = document.createElement('button');
  revertAllBtn.className = 'review-revert-all';
  revertAllBtn.textContent = 'Revert all';

  const keepAllBtn = document.createElement('button');
  keepAllBtn.className = 'review-keep-all';
  keepAllBtn.textContent = 'Keep all';

  bulkBtns.appendChild(revertAllBtn);
  bulkBtns.appendChild(keepAllBtn);
  header.appendChild(bulkBtns);
  panel.appendChild(header);

  const changeList = document.createElement('div');
  changeList.className = 'review-changes';

  function acceptOp(op: EditOp): Promise<{ error?: string }> {
    if (op.type === 'insert') {
      return callDocApi('gdocsAcceptInsert', { docId: activeDocId, afterText: op.after, insertText: op.text });
    }
    return callDocApi('gdocsAcceptEdit', { docId: activeDocId, findText: op.find, replaceText: op.type === 'replace' ? op.replace : '' });
  }

  function revertOp(op: EditOp): Promise<{ error?: string }> {
    if (op.type === 'insert') {
      return callDocApi('gdocsRevertInsert', { docId: activeDocId, afterText: op.after, insertText: op.text });
    }
    return callDocApi('gdocsRevertEdit', { docId: activeDocId, findText: op.find, replaceText: op.type === 'replace' ? op.replace : '' });
  }

  const rows: Array<{
    row: HTMLDivElement;
    keepBtn: HTMLButtonElement;
    revertBtn: HTMLButtonElement;
  }> = [];

  async function decideOp(idx: number, direction: 'keep' | 'revert'): Promise<boolean> {
    if (!pending.has(idx)) return true;
    const rowEntry = rows[idx];
    const op = ops[idx];
    if (!rowEntry || !op) return false;

    rowEntry.keepBtn.disabled = true;
    rowEntry.revertBtn.disabled = true;

    const result = direction === 'keep' ? await acceptOp(op) : await revertOp(op);
    if (result.error) {
      rowEntry.keepBtn.disabled = false;
      rowEntry.revertBtn.disabled = false;
      showInlineError(getGDocsEditInlineErrorMessage(result.error));
      return false;
    }

    rowEntry.row.classList.add(direction === 'keep' ? 'decided-keep' : 'decided-revert');
    pending.delete(idx);
    tryDismiss();
    return true;
  }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const idx = i;
    const row = document.createElement('div');
    row.className = 'change-row';

    const label = document.createElement('span');
    label.className = 'change-label';
    label.textContent = opLabel(op);
    row.appendChild(label);

    const btns = document.createElement('div');
    btns.className = 'change-btns';

    const revertBtn = document.createElement('button');
    revertBtn.className = 'change-revert';
    revertBtn.textContent = 'Revert';

    const keepBtn = document.createElement('button');
    keepBtn.className = 'change-keep';
    keepBtn.textContent = 'Keep';

    keepBtn.addEventListener('click', () => {
      void decideOp(idx, 'keep');
    });

    revertBtn.addEventListener('click', () => {
      void decideOp(idx, 'revert');
    });

    btns.appendChild(revertBtn);
    btns.appendChild(keepBtn);
    row.appendChild(btns);
    changeList.appendChild(row);
    rows.push({ row, keepBtn, revertBtn });
  }

  panel.appendChild(changeList);
  shadowWrapper.insertBefore(panel, shadowWrapper.firstChild);
  reviewPanelEl = panel;

  keepAllBtn.addEventListener('click', () => {
    keepAllBtn.disabled = true;
    revertAllBtn.disabled = true;
    setInputEnabled(false);
    startLoadingAnimation();
    void (async () => {
      for (const idx of Array.from(pending)) {
        const ok = await decideOp(idx, 'keep');
        if (!ok) break;
      }
      stopLoadingAnimation();
      keepAllBtn.disabled = false;
      revertAllBtn.disabled = false;
      setInputEnabled(true);
    })();
  });

  revertAllBtn.addEventListener('click', () => {
    keepAllBtn.disabled = true;
    revertAllBtn.disabled = true;
    setInputEnabled(false);
    startLoadingAnimation();
    void (async () => {
      for (const idx of Array.from(pending)) {
        const ok = await decideOp(idx, 'revert');
        if (!ok) break;
      }
      stopLoadingAnimation();
      keepAllBtn.disabled = false;
      revertAllBtn.disabled = false;
      setInputEnabled(true);
    })();
  });
}

// ─── Response router ──────────────────────────────────────────────────────────
async function handleResponseActions(response: string): Promise<void> {
  if (pendingSkeletonMode) {
    pendingSkeletonMode = false;
    const raw = response.trim();

    // Parse FOLLOW_UP lines out of the skeleton response
    const followUpRegex = /^FOLLOW_UP_\d+:\s*(.+)$/gm;
    const followUpLines: string[] = [];
    let match;
    while ((match = followUpRegex.exec(raw)) !== null) {
      if (match[1]) followUpLines.push(match[1].trim());
    }
    currentSkeletonText = raw.replace(/^FOLLOW_UP_\d+:.*$/gm, '').trim();

    // Build the display text — include follow-up questions as a prompt to the user
    const followUpSection = followUpLines.length > 0
      ? `\n\n---\nTo refine this plan, consider:\n${followUpLines.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      : '';
    const displayText = `${currentSkeletonText}${followUpSection}`;

    pendingSkeletonApproval = true;
    currentOutlineText = currentSkeletonText;
    document.dispatchEvent(new CustomEvent('oddity:gdocs:outline:ready', { detail: { outline: displayText } }));
    streaming = false;
    stopLoadingAnimation();
    setInputEnabled(true);
    return;
  }

  if (pendingOutlineMode) {
    pendingOutlineMode = false;
    currentOutlineText = response.trim();
    document.dispatchEvent(new CustomEvent('oddity:gdocs:outline:ready', { detail: { outline: currentOutlineText } }));
    streaming = false;
    stopLoadingAnimation();
    setInputEnabled(true);
    return;
  }

  if (pendingEditMode) {
    pendingEditMode = false;
    const editMatch = response.match(/<<<EDIT>>>([\s\S]+?)(?:<<<END_EDIT>>>|$)/);
    if (editMatch?.[1]) {
      const ops = parseEditOps(editMatch[1].trim());
      if (ops.length > 0) {
        startLoadingAnimation();
        const applied = await applyPendingEditsViaApi(ops);
        stopLoadingAnimation();
        if (applied.length > 0) showEditReviewPanel(applied);
      }
    } else {
      // Missing-marker fallback: the model produced text but omitted the tags.
      // Surface a clear error rather than silently dropping the response.
      // (Claude Code pattern: never silently discard LLM output — always tell the user.)
      console.warn('[Oddity GDocs] Edit response missing <<<EDIT>>> markers:', response.slice(0, 120));
      showInlineError("The AI response was missing the expected format. Please try again.");
    }
    return;
  }

  const essayMatch = response.match(/<<<ESSAY>>>([\s\S]+?)<<<END_ESSAY>>>/);
  if (essayMatch?.[1]) {
    const essayContent = essayMatch[1].trim();
    const followup = response.replace(/<<<ESSAY>>>[\s\S]+?<<<END_ESSAY>>>/, '').trim();
    if (docHasContent) {
      await buildEssayTab(essayContent);
      if (followup) await pasteIntoDoc(`Oddity: ${followup}\n\n`);
    } else {
      await pasteIntoDoc(essayContent + '\n\n');
      essayTabId = new URLSearchParams(window.location.search).get('tab') ?? 'default';
      docHasContent = true; // doc now has content — update for router hard rule
      docContext = essayContent;
      if (activeSession) {
        activeSession.essayContent = essayContent;
        activeSession.essayTabId = essayTabId;
        activeSession.essayVersions = [...(activeSession.essayVersions ?? []), essayContent];
        await saveSession(activeSession);
      }
      if (topicTextarea) topicTextarea.placeholder = getPlaceholder();
      if (followup) await pasteIntoDoc(`Oddity: ${followup}\n\n`);
    }
  } else if (response.trim()) {
    // Response arrived but has no recognized markers — surface it rather than silently dropping.
    console.warn('[Oddity GDocs] Response had no recognized markers:', response.slice(0, 120));
    showInlineError("The AI response was missing the expected format. Please try again.");
  }
}

// ─── Loading animation (inline placeholder cycling) ───────────────────────────
const LOADING_QUESTIONS = [
  'What shapes your core beliefs?',
  'How does language affect thought?',
  'Why do patterns repeat in history?',
  'What defines a just society?',
  'When does change become necessary?',
  'How do ideas spread and evolve?',
  'What makes an argument compelling?',
  'Why does art outlast empires?',
  'How does power shape narrative?',
  'What is the cost of certainty?',
  'Why do humans need stories?',
  'How does context change meaning?',
  'What drives people to dissent?',
  'When is silence more powerful?',
  'How do incentives shape behavior?',
];

let loadingAnimInterval: ReturnType<typeof setInterval> | null = null;

function startLoadingAnimation(): void {
  document.dispatchEvent(new CustomEvent('oddity:gdocs:loading'));
  if (!topicTextarea) return;
  topicTextarea.value = '';
  let idx = Math.floor(Math.random() * LOADING_QUESTIONS.length);
  topicTextarea.placeholder = LOADING_QUESTIONS[idx]!;
  loadingAnimInterval = setInterval(() => {
    idx = (idx + 1) % LOADING_QUESTIONS.length;
    if (topicTextarea) topicTextarea.placeholder = LOADING_QUESTIONS[idx]!;
  }, 2000);
}

function stopLoadingAnimation(): void {
  document.dispatchEvent(new CustomEvent('oddity:gdocs:loading:done'));
  if (loadingAnimInterval) { clearInterval(loadingAnimInterval); loadingAnimInterval = null; }
  if (topicTextarea) topicTextarea.placeholder = getPlaceholder();
}

function setInputEnabled(enabled: boolean) {
  if (topicTextarea) {
    topicTextarea.disabled = !enabled;
    if (enabled) {
      topicTextarea.placeholder = getPlaceholder();
      topicTextarea.focus();
    }
  }
  if (submitBtn) submitBtn.disabled = !enabled;
  if (commentBtn) commentBtn.disabled = !enabled;
}

function showInlineError(message: string): void {
  if (!shadowWrapper) return;
  const existing = shadowWrapper.querySelector('.oddity-inline-error');
  existing?.remove();
  const err = document.createElement('div');
  err.className = 'oddity-inline-error';
  err.style.cssText = 'background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:8px;';
  err.textContent = message;
  shadowWrapper.insertBefore(err, shadowWrapper.firstChild);
  setTimeout(() => err.remove(), 6000);
}

// ─── MCQ flow ─────────────────────────────────────────────────────────────────
async function fetchAllMcqQuestions(topic: string): Promise<McqQuestion[] | null> {
  await getCurrentDocText();
  return new Promise((resolve) => {
    const hasExistingContent = docContext.trim().length > 0;
    const sections: string[] = [];

    if (hasExistingContent) {
      sections.push(`EXISTING DOCUMENT CONTENT:\n${docContext}`);
    }
    if (importedContext) {
      sections.push(`IMPORTED CONTENT:\n${importedContext}`);
    }
    if (mcqResources.length > 0) {
      const resourcesText = mcqResources
        .map(r => `[${r.name}]: ${r.content}`)
        .join('\n\n');
      sections.push(`RESOURCES:\n${resourcesText}`);
    }
    if (mcqMemos.length > 0) {
      const memosText = mcqMemos
        .map(m => `Annotation: "${m.note}"\nMemo: "${m.reply}"`)
        .join('\n\n');
      sections.push(`MARGIN NOTE MEMOS:\n${memosText}`);
    }
    sections.push(`TASK MODE: ${hasExistingContent ? 'Editing existing essay' : 'Writing new essay'}`);

    const enrichedContext = sections.join('\n\n---\n\n');

    chrome.runtime.sendMessage(
      { action: 'gdocsMcqQuestions', payload: { prompt: topic, docContext: enrichedContext } },
      (result: McqQuestion[] | { error?: string } | undefined) => {
        if (chrome.runtime.lastError) { console.error('[Oddity GDocs] MCQ fetch error:', chrome.runtime.lastError); resolve(null); return; }
        if (!result || !Array.isArray(result)) { console.error('[Oddity GDocs] MCQ error:', result); resolve(null); return; }
        resolve(result as McqQuestion[]);
      }
    );
  });
}

function dismissMcqCard(): void {
  mcqCardEl?.remove();
  mcqCardEl = null;
  if (mcqOverlayEl) { mcqOverlayEl.remove(); mcqOverlayEl = null; }
}

const MCQ_LABELS = ['A', 'B', 'C', 'D'];

const MCQ_OVERLAY_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600&display=swap');
  .mcq-backdrop { position: fixed; inset: 0; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 32px; z-index: 1; pointer-events: auto; }
  .mcq-card { background: #fff; border-radius: 16px; padding: 22px 22px 16px; box-shadow: 0 8px 40px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.07); border: 0.5px solid #e8e8e2; display: flex; flex-direction: column; gap: 14px; width: 480px; max-width: 90vw; font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; }
  .mcq-header { display: flex; align-items: center; justify-content: space-between; }
  .mcq-dots { display: flex; align-items: center; gap: 4px; }
  .mcq-dot { width: 6px; height: 6px; border-radius: 50%; background: #e5e7eb; transition: background 0.2s; }
  .mcq-dot-filled { background: #1a1a1a; }
  .mcq-progress { font-size: 11px; font-weight: 500; color: #9aa0a6; font-variant-numeric: tabular-nums; }
  .mcq-chip { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 99px; background: #f0f2f5; color: #6b7280; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
  .mcq-question { font-size: 14px; font-weight: 600; color: #1a1a1a; line-height: 1.5; margin-top: 2px; }
  .mcq-options { display: flex; flex-direction: column; gap: 7px; }
  .mcq-option { display: flex; align-items: flex-start; gap: 10px; text-align: left; padding: 10px 14px; border-radius: 10px; border: 1px solid #e8e8e2; background: #fff; color: #374151; font-size: 13px; font-family: inherit; cursor: pointer; transition: background 0.12s, border-color 0.12s; line-height: 1.4; width: 100%; }
  .mcq-option:hover { background: #f7f7f6; border-color: #d1d5db; }
  .mcq-option:disabled { opacity: 0.4; cursor: default; }
  .mcq-option-label { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; background: #f0f2f5; color: #6b7280; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-top: 1px; }
  .mcq-option-body { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .mcq-option-text { font-weight: 600; color: #1a1a1a; }
  .mcq-option-desc { font-size: 11.5px; font-weight: 400; color: #6b7280; line-height: 1.4; }
  .mcq-other-input { flex: 1; border: none; outline: none; background: transparent; font-size: 13px; font-family: inherit; color: #1a1a1a; font-weight: 500; padding: 0; min-width: 0; }
  .mcq-other-submit { flex-shrink: 0; border: none; background: #1a1a1a; color: #fff; border-radius: 50%; width: 20px; height: 20px; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; font-family: inherit; }
  .mcq-footer { display: flex; align-items: center; justify-content: space-between; }
  .mcq-footer-action { border: none; background: none; font-size: 12px; color: #9aa0a6; cursor: pointer; font-family: inherit; padding: 0; transition: color 0.15s; }
  .mcq-footer-action:hover { color: #374151; }
`;

function renderMcqCard(question: McqQuestion): void {
  dismissMcqCard();

  const displayNum = mcqQuestionIndex + 1;
  const totalNum = Math.min(mcqAllQuestions.length, MAX_MCQ_QUESTIONS);

  const overlayHost = document.createElement('div');
  overlayHost.id = 'oddity-gdocs-mcq-overlay';
  overlayHost.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;';
  document.body.appendChild(overlayHost);
  mcqOverlayEl = overlayHost;

  const shadow = overlayHost.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = MCQ_OVERLAY_CSS;
  shadow.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'mcq-backdrop';
  const card = document.createElement('div');
  card.className = 'mcq-card';

  // ── Top bar: progress dots + "X / Y" ────────────────────────────────────────
  const topBar = document.createElement('div');
  topBar.className = 'mcq-header';
  const dots = document.createElement('div');
  dots.className = 'mcq-dots';
  for (let i = 0; i < totalNum; i++) {
    const dot = document.createElement('span');
    dot.className = i < displayNum ? 'mcq-dot mcq-dot-filled' : 'mcq-dot';
    dots.appendChild(dot);
  }
  const progress = document.createElement('span');
  progress.className = 'mcq-progress';
  progress.textContent = `${displayNum} / ${totalNum}`;
  topBar.appendChild(dots);
  topBar.appendChild(progress);
  card.appendChild(topBar);

  // ── Header chip (Claude Code: short topic tag above the question) ────────────
  if (question.header) {
    const chip = document.createElement('span');
    chip.className = 'mcq-chip';
    chip.textContent = question.header;
    card.appendChild(chip);
  }

  // ── Question text ────────────────────────────────────────────────────────────
  const questionEl = document.createElement('div');
  questionEl.className = 'mcq-question';
  questionEl.textContent = question.question;
  card.appendChild(questionEl);

  // ── Options (Claude Code: label + description per option) ────────────────────
  const optionsEl = document.createElement('div');
  optionsEl.className = 'mcq-options';

  const aiOptions = question.options.slice(0, 4);
  aiOptions.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.className = 'mcq-option';

    const letterEl = document.createElement('span');
    letterEl.className = 'mcq-option-label';
    letterEl.textContent = MCQ_LABELS[idx] ?? String(idx + 1);

    const body = document.createElement('span');
    body.className = 'mcq-option-body';

    const textEl = document.createElement('span');
    textEl.className = 'mcq-option-text';
    textEl.textContent = opt.label;
    body.appendChild(textEl);

    // Description: one line explaining the trade-off (Claude Code AskUserQuestionTool pattern)
    if (opt.description) {
      const descEl = document.createElement('span');
      descEl.className = 'mcq-option-desc';
      descEl.textContent = opt.description;
      body.appendChild(descEl);
    }

    btn.appendChild(letterEl);
    btn.appendChild(body);
    btn.addEventListener('click', () => handleMcqAnswer(opt.label, question.question));
    optionsEl.appendChild(btn);
  });

  // ── "Other" option — always added by UI, never by LLM (Claude Code pattern) ─
  const otherIdx = aiOptions.length;
  const otherBtn = document.createElement('button');
  otherBtn.className = 'mcq-option';

  const otherLetterEl = document.createElement('span');
  otherLetterEl.className = 'mcq-option-label';
  otherLetterEl.textContent = MCQ_LABELS[otherIdx] ?? String(otherIdx + 1);

  const otherBody = document.createElement('span');
  otherBody.className = 'mcq-option-body';

  const otherTextEl = document.createElement('span');
  otherTextEl.className = 'mcq-option-text';
  otherTextEl.textContent = 'Other';
  otherBody.appendChild(otherTextEl);

  const otherInput = document.createElement('input');
  otherInput.type = 'text';
  otherInput.className = 'mcq-other-input';
  otherInput.placeholder = 'Specify…';
  otherInput.style.display = 'none';

  const otherSubmit = document.createElement('button');
  otherSubmit.className = 'mcq-other-submit';
  otherSubmit.textContent = '→';
  otherSubmit.style.display = 'none';

  otherBody.appendChild(otherInput);
  otherBody.appendChild(otherSubmit);
  otherBtn.appendChild(otherLetterEl);
  otherBtn.appendChild(otherBody);

  const submitOther = () => {
    const val = otherInput.value.trim();
    if (!val) return;
    handleMcqAnswer(val, question.question);
  };
  otherBtn.addEventListener('click', (e) => {
    if (otherInput.style.display !== 'none') return;
    e.stopPropagation();
    otherTextEl.style.display = 'none';
    otherInput.style.display = 'block';
    otherSubmit.style.display = 'flex';
    otherBtn.style.borderColor = '#1a1a1a';
    otherInput.focus();
  });
  otherInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitOther(); }
    e.stopPropagation();
  });
  otherInput.addEventListener('click', (e) => e.stopPropagation());
  otherSubmit.addEventListener('click', (e) => { e.stopPropagation(); submitOther(); });
  optionsEl.appendChild(otherBtn);
  card.appendChild(optionsEl);

  // ── Footer: Previous button from Q2 onwards ──────────────────────────────────
  if (mcqQuestionIndex > 0) {
    const footer = document.createElement('div');
    footer.className = 'mcq-footer';
    const prevBtn = document.createElement('button');
    prevBtn.className = 'mcq-footer-action';
    prevBtn.textContent = '← Previous';
    prevBtn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('oddity:gdocs:mcq:prev'));
    });
    footer.appendChild(prevBtn);
    card.appendChild(footer);
  }

  backdrop.appendChild(card);
  shadow.appendChild(backdrop);
  mcqCardEl = card;
}

function handleMcqAnswer(answer: string, question: string): void {
  if (!mcqActive) return;
  mcqPreviousQA.push({ question, answer });
  mcqQuestionIndex++;

  if (mcqQuestionIndex >= mcqAllQuestions.length || mcqQuestionIndex >= MAX_MCQ_QUESTIONS) {
    mcqActive = false;
    dismissMcqCard();
    document.dispatchEvent(new CustomEvent('oddity:gdocs:mcq:done'));
    const cb = mcqCompletionCallback;
    mcqCompletionCallback = null;
    cb?.();
    return;
  }

  dispatchMcqQuestion();
  renderMcqCard(mcqAllQuestions[mcqQuestionIndex]!);
}

async function readFileAsText(file: File): Promise<string> {
  // PDF: send to background for conversion
  if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const pdfData = Array.from(new Uint8Array(reader.result as ArrayBuffer));
        chrome.runtime.sendMessage(
          { action: 'convertPdfToHtml', payload: { pdfData } },
          (result: { html?: string; error?: string } | undefined) => {
            if (result?.html) {
              // Strip HTML tags to get plain text
              const div = document.createElement('div');
              div.innerHTML = result.html;
              resolve((div.textContent ?? '').slice(0, 8000));
            } else {
              resolve('');
            }
          }
        );
      };
      reader.onerror = () => resolve('');
      reader.readAsArrayBuffer(file);
    });
  }
  // Text files
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(((reader.result as string) ?? '').slice(0, 8000));
    reader.onerror = () => resolve('');
    reader.readAsText(file);
  });
}

function dispatchMcqQuestion(): void {
  const question = mcqAllQuestions[mcqQuestionIndex];
  if (!question) return;
  document.dispatchEvent(new CustomEvent('oddity:gdocs:mcq:question', {
    detail: {
      question: question.question,
      options: question.options,
      index: mcqQuestionIndex,
      total: Math.min(mcqAllQuestions.length, MAX_MCQ_QUESTIONS),
    }
  }));
}

async function startMcqFlow(topic: string): Promise<void> {
  mcqTopic = topic;
  mcqActive = true;
  mcqPreviousQA = [];
  mcqQuestionIndex = 0;
  mcqAllQuestions = [];

  // Signal loading to argument box (textarea already shows cycling placeholder)
  document.dispatchEvent(new CustomEvent('oddity:gdocs:mcq:loading'));

  const questions = await fetchAllMcqQuestions(topic);

  if (!questions || questions.length === 0) {
    mcqActive = false;
    document.dispatchEvent(new CustomEvent('oddity:gdocs:mcq:done'));
    const cb = mcqCompletionCallback;
    mcqCompletionCallback = null;
    cb?.();
    return;
  }

  mcqAllQuestions = questions;
  dispatchMcqQuestion();
  renderMcqCard(mcqAllQuestions[0]!);
}

function generateEssay(): void {
  streaming = true;
  setInputEnabled(false);
  startLoadingAnimation();

  const messages: GDocsMessage[] = [];
  if (docContext) {
    messages.push({ role: 'user', content: `Document context:\n\n${docContext}\n\nNow let's begin.` });
    messages.push({ role: 'assistant', content: 'Got it. Ready to write.' });
  }

  // Build the essay prompt from topic + MCQ answers
  let userMsg = `Topic: ${mcqTopic}`;
  if (mcqPreviousQA.length > 0) {
    const qaText = mcqPreviousQA.map((qa, i) => `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.answer}`).join('\n\n');
    userMsg += `\n\nPreferences:\n${qaText}`;
  }
  userMsg += '\n\nPlease write a full essay draft now.';

  chatHistory.push({ role: 'user', content: userMsg });
  messages.push(...chatHistory);

  if (activeSession) {
    activeSession.chatHistory = [...chatHistory];
    void saveSession(activeSession);
  }

  sendGDocsChat(messages, 'essay');
}

// ─── Mode Router ─────────────────────────────────────────────────────────────
async function routeRequest(text: string): Promise<'fast' | 'plan'> {
  const docText = await getCurrentDocText();
  const essayContent = activeSession?.essayContent?.trim() ?? '';

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'gdocsRoute', payload: { prompt: text, docContext: docText, essayContent } },
      (result: { mode?: string } | undefined) => {
        if (chrome.runtime.lastError) { resolve('fast'); return; }
        resolve(result?.mode === 'PLAN' ? 'plan' : 'fast');
      }
    );
  });
}

// ─── Fast Mode ────────────────────────────────────────────────────────────────
async function executeFastMode(text: string): Promise<void> {
  streaming = true;
  pendingEditMode = true;
  setInputEnabled(false);
  startLoadingAnimation();

  chatHistory.push({ role: 'user', content: text });
  if (activeSession) { activeSession.chatHistory = [...chatHistory]; void saveSession(activeSession); }

  const essayContent = await getCurrentDocText();

  // Fast mode: each request is stateless — always send current doc + current
  // request only. Previous assistant turns contain old FIND: anchors that no
  // longer exist after edits are applied, which causes "anchor not found" errors.
  const messages: GDocsMessage[] = [];
  if (essayContent) {
    messages.push({ role: 'user', content: `Here is the document:\n\n${essayContent}\n\nNow let's begin.` });
    messages.push({ role: 'assistant', content: 'Got it. What edits would you like?' });
  }
  messages.push({ role: 'user', content: text });
  sendGDocsChat(messages, 'fast');
}

// ─── Plan Mode ────────────────────────────────────────────────────────────────
function startPlanModeFlow(text: string): void {
  pendingPlanTopic = text;
  mcqCompletionCallback = () => { generateOutline(); };
  void startMcqFlow(text);
}


function isNewEssayRequest(prompt: string, existingContent: string): boolean {
  if (existingContent.trim()) return false; // doc has content → always an edit
  const writeKeywords = /\b(write|draft|create|compose|generate|make|produce|author)\b/i;
  return writeKeywords.test(prompt); // blank doc + write intent → new essay
}


type OutlineContext =
  | { previousOutline: string; feedback: string }
  | { skeletonContext: string; followUpAnswers?: string };

async function generateOutline(context?: OutlineContext): Promise<void> {
  streaming = true;
  pendingOutlineMode = true;
  setInputEnabled(false);
  startLoadingAnimation();

  const essayContent = await getCurrentDocText();

  const qaText = mcqPreviousQA.length > 0
    ? '\n\nWriter preferences:\n' + mcqPreviousQA.map((qa, i) => `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.answer}`).join('\n\n')
    : '';

  const messages: GDocsMessage[] = [];
  if (essayContent) {
    messages.push({ role: 'user', content: `Document:\n\n${essayContent}` });
    messages.push({ role: 'assistant', content: 'Got it.' });
  }
  const isNewEssay = isNewEssayRequest(pendingPlanTopic, essayContent);
  const outlineRequest = isNewEssay
    ? `Request: ${pendingPlanTopic}${qaText}\n\nGenerate a structured writing plan for this essay. Do not write the essay yet — only the outline.`
    : `Request: ${pendingPlanTopic}${qaText}\n\nGenerate a concise outline of the proposed changes to the document.`;

  messages.push({ role: 'user', content: outlineRequest });

  if (context && 'previousOutline' in context) {
    messages.push({ role: 'assistant', content: context.previousOutline });
    messages.push({ role: 'user', content: `That's not quite right. Here's my feedback: ${context.feedback}\n\nPlease revise the outline.` });
  } else if (context && 'skeletonContext' in context) {
    messages.push({ role: 'assistant', content: `Here is my initial skeleton:\n\n${context.skeletonContext}` });
    const followUp = context.followUpAnswers
      ? `\n\nAdditional context from the writer: ${context.followUpAnswers}`
      : '';
    messages.push({ role: 'user', content: `Good start. Now generate the final detailed outline based on this skeleton.${followUp}` });
  }

  sendGDocsChat(messages, 'outline');
}

async function executePlanEdits(outline: string): Promise<void> {
  streaming = true;
  setInputEnabled(false);
  startLoadingAnimation();

  const essayContent = await getCurrentDocText();
  if (activeSession) { activeSession.essayContent = essayContent; }

  const isNewEssay = isNewEssayRequest(pendingPlanTopic, essayContent);

  const qaText = mcqPreviousQA.length > 0
    ? '\n\nWriter preferences:\n' + mcqPreviousQA.map((qa, i) => `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.answer}`).join('\n\n')
    : '';

  chatHistory.push({ role: 'user', content: pendingPlanTopic });
  if (activeSession) { activeSession.chatHistory = [...chatHistory]; void saveSession(activeSession); }

  const messages: GDocsMessage[] = [];

  if (isNewEssay) {
    // New essay: send in essay mode so <<<ESSAY>>> markers are handled
    pendingEditMode = false;
    messages.push({ role: 'user', content: `Topic: ${pendingPlanTopic}${qaText}` });
    messages.push({ role: 'assistant', content: `Here is my writing plan:\n\n${outline}\n\nI will now write the full essay following this plan.` });
    messages.push({ role: 'user', content: 'Great, please write the full essay now.' });
    sendGDocsChat(messages, 'essay');
  } else {
    // Editing existing doc: send in edit mode so <<<EDIT>>> markers are handled
    pendingEditMode = true;
    messages.push({ role: 'user', content: `Here is the document:\n\n${essayContent}\n\nNow let's begin.` });
    messages.push({ role: 'assistant', content: 'Got it. What edits would you like?' });
    messages.push({ role: 'user', content: `Request: ${pendingPlanTopic}${qaText}` });
    messages.push({ role: 'assistant', content: `Here is my plan:\n\n${outline}\n\nI'll now execute these changes.` });
    messages.push({ role: 'user', content: 'Great, please execute all these changes now.' });
    sendGDocsChat(messages, 'edit');
  }
}

// ─── Topic submit / Edit mode send ───────────────────────────────────────────
async function handleSubmit(text: string): Promise<void> {
  if (!text || streaming || mcqActive) return;

  let resolvedMode: 'fast' | 'plan';
  if (userMode === 'auto') {
    // Always call router — it handles both blank docs and existing content
    setInputEnabled(false);
    startLoadingAnimation();
    resolvedMode = await routeRequest(text);
    stopLoadingAnimation();
    setInputEnabled(true);
  } else {
    resolvedMode = userMode;
  }

  if (resolvedMode === 'fast') {
    void executeFastMode(text);
  } else {
    startPlanModeFlow(text);
  }
}

// ─── Input bar ────────────────────────────────────────────────────────────────
function createInputBar(): void {
  const host = document.createElement('div');
  host.id = 'oddity-gdocs-input-host';
  host.style.cssText = 'all: initial; position: fixed; bottom: 24px; left: 24px; z-index: 2147483646; width: 520px;';
  document.body.appendChild(host);
  inputBar = host;

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600&display=swap');
    *, *::before, *::after { box-sizing: border-box; }
    .wrapper { display: flex; flex-direction: column; gap: 8px; font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif; align-items: flex-start; }
    .actions { display: flex; align-items: center; gap: 6px; padding: 0; }
    .action-btn { height: 30px; padding: 0 12px; border-radius: 9999px; border: none; background: #f0f2f5; color: #374151; font-size: 11px; font-weight: 600; font-family: inherit; letter-spacing: 0.02em; cursor: pointer; display: flex; align-items: center; gap: 4px; flex-shrink: 0; transition: background 0.15s; white-space: nowrap; }
    .action-btn:hover { background: #e5e7eb; }
    .action-btn:disabled { opacity: 0.4; cursor: default; }
    .action-btn--provoke { background: #1E2229; color: #fff; border-radius: 10px; height: auto; padding: 12px 24px; font-size: 15px; font-weight: 500; letter-spacing: 0; }
    .action-btn--provoke:hover { background: #2a3040; }
    /* MCQ card */
    .mcq-card { background: #fff; border-radius: 16px; padding: 18px 18px 14px; box-shadow: 0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06); border: 0.5px solid #e8e8e2; display: flex; flex-direction: column; gap: 14px; }
    .mcq-header { display: flex; align-items: center; justify-content: space-between; }
    .mcq-dots { display: flex; align-items: center; gap: 4px; }
    .mcq-dot { width: 6px; height: 6px; border-radius: 50%; background: #e5e7eb; transition: background 0.2s; }
    .mcq-dot-filled { background: #1a1a1a; }
    .mcq-progress { font-size: 11px; font-weight: 500; color: #9aa0a6; font-variant-numeric: tabular-nums; }
    .mcq-question { font-size: 13px; font-weight: 600; color: #1a1a1a; line-height: 1.5; }
    .mcq-options { display: flex; flex-direction: column; gap: 6px; }
    .mcq-option { display: flex; align-items: center; gap: 10px; text-align: left; padding: 9px 12px; border-radius: 10px; border: 1px solid #e8e8e2; background: #fff; color: #374151; font-size: 12px; font-family: inherit; cursor: pointer; transition: background 0.12s, border-color 0.12s; line-height: 1.4; width: 100%; }
    .mcq-option:hover { background: #f7f7f6; border-color: #d1d5db; }
    .mcq-option:disabled { opacity: 0.4; cursor: default; }
    .mcq-option-label { flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%; background: #f0f2f5; color: #6b7280; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; letter-spacing: 0; }
    .mcq-option-text { flex: 1; font-weight: 500; }
    .mcq-other-input { flex: 1; border: none; outline: none; background: transparent; font-size: 12px; font-family: inherit; color: #1a1a1a; font-weight: 500; padding: 0; min-width: 0; }
    .mcq-other-submit { flex-shrink: 0; border: none; background: #1a1a1a; color: #fff; border-radius: 50%; width: 18px; height: 18px; font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; font-family: inherit; }
    .mcq-footer { display: flex; justify-content: flex-end; }
    .mcq-skip { border: none; background: none; font-size: 11px; color: #9aa0a6; cursor: pointer; font-family: inherit; padding: 0; }
    .mcq-skip:hover { color: #374151; }
    /* Edit review panel */
    .review-panel { background: #fff; border-radius: 16px; padding: 12px 14px 10px; box-shadow: 0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06); border: 0.5px solid #e8e8e2; display: flex; flex-direction: column; gap: 8px; }
    .review-header { display: flex; align-items: center; justify-content: space-between; }
    .review-title { font-size: 10px; font-weight: 600; color: #9aa0a6; letter-spacing: 0.04em; }
    .review-bulk { display: flex; gap: 5px; }
    .review-revert-all { height: 24px; padding: 0 10px; border-radius: 9999px; border: 1px solid #e8e8e2; background: none; color: #6b7280; font-size: 10px; font-weight: 600; font-family: inherit; cursor: pointer; transition: background 0.12s; }
    .review-revert-all:hover { background: #f0f2f5; }
    .review-keep-all { height: 24px; padding: 0 10px; border-radius: 9999px; border: none; background: #111; color: #fff; font-size: 10px; font-weight: 600; font-family: inherit; cursor: pointer; transition: background 0.12s; }
    .review-keep-all:hover { background: #333; }
    .review-changes { display: flex; flex-direction: column; gap: 4px; }
    .change-row { display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; border-radius: 8px; background: #f9f9f8; transition: opacity 0.15s; }
    .change-row.decided-keep { opacity: 0.38; }
    .change-row.decided-revert { opacity: 0.38; }
    .change-label { font-size: 11px; color: #374151; font-weight: 500; }
    .change-btns { display: flex; gap: 4px; }
    .change-revert { height: 22px; padding: 0 10px; border-radius: 9999px; border: 1px solid #e8e8e2; background: none; color: #6b7280; font-size: 10px; font-weight: 600; font-family: inherit; cursor: pointer; transition: background 0.12s; }
    .change-revert:hover:not(:disabled) { background: #f0f2f5; }
    .change-revert:disabled { opacity: 0.4; cursor: default; }
    .change-keep { height: 22px; padding: 0 10px; border-radius: 9999px; border: none; background: #111; color: #fff; font-size: 10px; font-weight: 600; font-family: inherit; cursor: pointer; transition: background 0.12s; }
    .change-keep:hover:not(:disabled) { background: #333; }
    .change-keep:disabled { background: #e8e8e2; color: #9aa0a6; cursor: default; }
  `;
  shadow.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.className = 'wrapper';
  shadowWrapper = wrapper;

  // ── Provoke me button ──
  commentBtn = document.createElement('button');
  commentBtn.className = 'action-btn action-btn--provoke';
  commentBtn.textContent = 'Provoke me';
  commentBtn.addEventListener('click', () => document.dispatchEvent(new CustomEvent('oddity:gdocs:re-annotate')));

  wrapper.appendChild(commentBtn);
  shadow.appendChild(wrapper);
}

// ─── Activate / deactivate ────────────────────────────────────────────────────
async function activate(essayContext?: { prompt: string; answers: Record<string, string> }) {
  if (inputBar) return;

  document.dispatchEvent(new CustomEvent('oddity:gdocs:activated'));

  const { docId, tabId } = parseGDocsLocation();
  activeDocId = docId;
  activeTabId = tabId;

  let existingSession = await loadSession(docId);
  if (!existingSession) {
    existingSession = await loadSessionFromCloud(docId);
    if (existingSession) await chrome.storage.local.set({ [sessionKey(docId)]: existingSession });
  }

  if (existingSession) {
    activeSession = existingSession;
  }
  await getCurrentDocText();
  createInputBar();

  if (existingSession) {
    chatHistory.push(...existingSession.chatHistory);
    essayTabId = existingSession.essayTabId ?? '';
    // Re-register annotations for reply observer
    void fetchAnnotationsForDoc().then(async (annotations) => {
      if (!annotations.length) return;
      const text = activeSession?.essayContent ?? '';
      if (!text.trim()) return;
      const contentHash = await sha256hex(text);
      registerGDocsCommentAnnotations(annotations, contentHash);
    }).catch((err) => { console.warn('[gdocs] failed to fetch annotations:', err); });
  } else if (essayContext?.prompt) {
    activeSession = { docId, tabId, chatHistory: [], createdAt: Date.now() };
    await saveSession(activeSession);
    // Pre-fill answers from sidebar context, skip MCQ
    mcqTopic = essayContext.prompt;
    mcqPreviousQA = Object.entries(essayContext.answers).map(([q, a]) => ({ question: q, answer: a }));
    void generateEssay();
  } else {
    activeSession = { docId, tabId, chatHistory: [], createdAt: Date.now() };
    await saveSession(activeSession);
  }
}

function deactivate() {
  stopLoadingAnimation();
  dismissMcqCard();
  dismissReviewPanel();
  if (inputBar) { inputBar.remove(); inputBar = null; }
  topicTextarea = null; submitBtn = null; commentBtn = null; shadowWrapper = null;
  chatHistory.splice(0);
  docContext = '';
  docHasContent = false;
  activeDocId = '';
  activeTabId = '';
  essayTabId = '';
  pendingEditMode = false;
  pendingOutlineMode = false;
  pendingSkeletonMode = false;
  pendingSkeletonApproval = false;
  pendingPlanTopic = '';
  currentOutlineText = '';
  currentSkeletonText = '';
  activeSession = null;
  mcqActive = false;
  mcqPreviousQA = [];
  mcqQuestionIndex = 0;
  mcqAllQuestions = [];
  mcqTopic = '';
  importedContext = '';
  streaming = false;
  userMode = 'auto';
}

// ─── Entry point ──────────────────────────────────────────────────────────────
document.addEventListener('oddity:gdocs:activate', (e: Event) => {
  const context = (e as CustomEvent<{ prompt: string; answers: Record<string, string> } | undefined>).detail;
  void activate(context ?? undefined);
});

// Plan mode trigger from the argument box panel
document.addEventListener('oddity:gdocs:planmode', (e: Event) => {
  const { topic, resources, memos, fastMode } = (e as CustomEvent<{
    topic: string;
    resources: Array<{ name: string; content: string }>;
    memos: Array<{ note: string; reply: string }>;
    fastMode: boolean;
  }>).detail;
  const effectiveTopic = topic || mcqTopic || 'My essay';
  mcqOriginalPrompt = effectiveTopic;
  mcqResources = resources ?? [];
  mcqMemos = memos ?? [];

  if (fastMode) {
    void executeFastMode(effectiveTopic);
  } else {
    startPlanModeFlow(effectiveTopic);
  }
});

// MCQ answer from argument box
document.addEventListener('oddity:gdocs:mcq:answer', (e: Event) => {
  const { answer, question } = (e as CustomEvent<{ answer: string; question: string }>).detail;
  handleMcqAnswer(answer, question);
});

// Previous question from argument box
document.addEventListener('oddity:gdocs:mcq:prev', () => {
  if (mcqQuestionIndex <= 0 || mcqPreviousQA.length === 0) return;
  mcqPreviousQA.pop();
  mcqQuestionIndex--;
  dispatchMcqQuestion();
  renderMcqCard(mcqAllQuestions[mcqQuestionIndex]!);
});

// Skip to writing from argument box

// Chat trigger from the argument box panel (Auto mode)
document.addEventListener('oddity:gdocs:chat', (e: Event) => {
  const { text, resources, memos, fastMode } = (e as CustomEvent<{
    text: string;
    memoMode: string;
    resources: Array<{ name: string; content: string }>;
    memos: Array<{ note: string; reply: string }>;
    fastMode: boolean;
  }>).detail;
  if (!text) return;
  mcqResources = resources ?? [];
  mcqMemos = memos ?? [];

  if (fastMode) {
    void executeFastMode(text);
  } else {
    startPlanModeFlow(text);
  }
});

// ─── Outline approval events (from argument box) ──────────────────────────────
document.addEventListener('oddity:gdocs:outline:continue', () => {
  if (!currentOutlineText) return;
  void executePlanEdits(currentOutlineText);
});

document.addEventListener('oddity:gdocs:outline:reject', () => {
  streaming = false;
  pendingSkeletonApproval = false;
  currentOutlineText = '';
  currentSkeletonText = '';
  pendingPlanTopic = '';
  stopLoadingAnimation();
  setInputEnabled(true);
});

document.addEventListener('oddity:gdocs:outline:other', (e: Event) => {
  const { feedback } = (e as CustomEvent<{ feedback: string }>).detail;
  if (pendingSkeletonApproval) {
    // User provided follow-up answers — use them to refine the final outline
    pendingSkeletonApproval = false;
    generateOutline({ skeletonContext: currentSkeletonText, followUpAnswers: feedback });
    return;
  }
  const previousOutline = currentOutlineText;
  currentOutlineText = '';
  generateOutline({ previousOutline, feedback });
});

document.addEventListener('oddity:annotation:fix-now', (e: Event) => {
  const { anchorText, note, replyText } = (e as CustomEvent<{ annotationId: string; anchorText: string; note: string; replyText: string }>).detail;
  const prompt = `Fix the following passage based on this annotation feedback.\n\nPassage: "${anchorText}"\nAnnotation: ${note}${replyText ? `\nUser note: ${replyText}` : ''}`;
  void handleSubmit(prompt);
});
