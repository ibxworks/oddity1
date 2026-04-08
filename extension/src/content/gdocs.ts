// Oddity GDocs — essay writing assistant for Google Docs
// Flow: user enters topic → MCQ questions → essay generation → edit mode on essay tab
import { registerGDocsCommentAnnotations } from "./gdocs-comments.js";

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

interface McqQuestion {
  question: string;
  options: string[];
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

// ─── Chat history (for edit mode) ─────────────────────────────────────────────
const chatHistory: GDocsMessage[] = [];

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
  }).catch(() => {});
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
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'gdocsChatChunk') {
    currentStreamText += (message.payload as { text: string }).text;
  } else if (message.action === 'gdocsChatDone') {
    const response = currentStreamText;
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
    const errMsg = (message.payload as { error?: string }).error ?? 'Unknown error';
    console.error('[Oddity GDocs] Chat error:', errMsg);
    currentStreamText = '';
    streaming = false;
    pendingEditMode = false;
    stopLoadingAnimation();
    setInputEnabled(true);
    if (topicTextarea) {
      topicTextarea.placeholder = `Error: ${errMsg.slice(0, 60)}`;
      setTimeout(() => { if (topicTextarea) topicTextarea.placeholder = getPlaceholder(); }, 4000);
    }
  }
});

function getPlaceholder(): string {
  if (activeSession?.essayContent?.trim() || docHasContent) return 'Ask for edits…';
  return 'What do you want to write about?';
}

// ─── Doc context scraping ─────────────────────────────────────────────────────
function scrapeDocContext(): string {
  const docs = [document, ...iframeDocuments()];

  const paragraphText = docs
    .flatMap(d => Array.from(d.querySelectorAll<HTMLElement>('.kix-paragraphrenderer')))
    .map(p => p.textContent ?? '')
    .filter(t => t.trim().length > 0)
    .join('\n');
  if (paragraphText.trim().length > 0) return paragraphText.slice(0, 8000);

  const wordNodeText = docs
    .flatMap(d => Array.from(d.querySelectorAll<HTMLElement>('.kix-wordhtmlgenerator-word-node')))
    .map(el => el.textContent ?? '')
    .filter(t => t.trim().length > 0)
    .join(' ');
  if (wordNodeText.trim().length > 0) return wordNodeText.slice(0, 8000);

  for (const d of docs) {
    const editor = d.querySelector<HTMLElement>('.docs-editor-container, .kix-appview-editor');
    if (editor) {
      const text = editor.innerText ?? '';
      if (text.trim().length > 0) return text.slice(0, 8000);
    }
  }
  return '';
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

// ─── Find & replace helpers ───────────────────────────────────────────────────
function parseEditOps(text: string): Array<{ find: string; replace: string }> {
  const ops: Array<{ find: string; replace: string }> = [];
  const blocks = text.split(/^---\s*$/m);
  for (const block of blocks) {
    const findMatch = block.match(/^FIND:\s*([\s\S]*?)(?=\nREPLACE:)/m);
    const replaceMatch = block.match(/^REPLACE:\s*([\s\S]*)$/m);
    if (findMatch?.[1] !== undefined) {
      ops.push({ find: findMatch[1].trim(), replace: replaceMatch?.[1]?.trim() ?? '' });
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

async function replaceTextViaCanvas(findText: string, replaceText: string): Promise<void> {
  const canvasIframe = document.querySelector<HTMLIFrameElement>('.docs-texteventtarget-iframe');
  if (!canvasIframe?.contentDocument?.body) return;
  canvasIframe.contentDocument.body.focus();
  await sleep(100);
  canvasIframe.contentDocument.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', code: 'KeyH', keyCode: 72, metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  const ready = await waitForFRDialog();
  if (!ready) return;
  const { findInput } = findFRInputs();
  if (!findInput) return;
  await typeIntoFRInput(findInput, findText);
  const nextBtn = findNextFRBtn();
  if (nextBtn) {
    nextBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    nextBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(300);
  }
  findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
  await sleep(100);
  const closeStart = Date.now();
  while (Date.now() - closeStart < 2000) {
    if (!findFRInputs().findInput) break;
    await sleep(100);
  }
  await sleep(200);
  await pasteIntoDoc(replaceText);
  await sleep(200);
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

async function applyPendingEditsViaApi(ops: Array<{ find: string; replace: string }>): Promise<void> {
  for (const op of ops) {
    const result = await callDocApi('gdocsApplyPendingEdit', {
      docId: activeDocId,
      findText: op.find,
      replaceText: op.replace,
    });
    if (result.error) console.warn('[Oddity GDocs] Apply edit error:', result.error);
  }
}

function dismissReviewPanel(): void {
  reviewPanelEl?.remove();
  reviewPanelEl = null;
}

function showEditReviewPanel(ops: Array<{ find: string; replace: string }>): void {
  if (!shadowWrapper) return;
  dismissReviewPanel();

  const pending = new Set(ops.map((_, i) => i)); // indices not yet decided

  const panel = document.createElement('div');
  panel.className = 'review-panel';

  // Header
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

  // One row per change — just label + Keep / Revert
  const changeList = document.createElement('div');
  changeList.className = 'review-changes';

  for (let i = 0; i < ops.length; i++) {
    const row = document.createElement('div');
    row.className = 'change-row';

    const label = document.createElement('span');
    label.className = 'change-label';
    label.textContent = `Change ${i + 1}`;
    row.appendChild(label);

    const btns = document.createElement('div');
    btns.className = 'change-btns';

    const revertBtn = document.createElement('button');
    revertBtn.className = 'change-revert';
    revertBtn.textContent = 'Revert';

    const keepBtn = document.createElement('button');
    keepBtn.className = 'change-keep';
    keepBtn.textContent = 'Keep';

    const idx = i;
    const op = ops[idx]!;

    keepBtn.addEventListener('click', () => {
      keepBtn.disabled = true;
      revertBtn.disabled = true;
      row.classList.add('decided-keep');
      pending.delete(idx);
      void callDocApi('gdocsAcceptEdit', { docId: activeDocId, findText: op.find, replaceText: op.replace })
        .then(() => { if (pending.size === 0) { dismissReviewPanel(); setInputEnabled(true); } });
    });

    revertBtn.addEventListener('click', () => {
      keepBtn.disabled = true;
      revertBtn.disabled = true;
      row.classList.add('decided-revert');
      pending.delete(idx);
      void callDocApi('gdocsRevertEdit', { docId: activeDocId, findText: op.find, replaceText: op.replace })
        .then(() => { if (pending.size === 0) { dismissReviewPanel(); setInputEnabled(true); } });
    });

    btns.appendChild(revertBtn);
    btns.appendChild(keepBtn);
    row.appendChild(btns);
    changeList.appendChild(row);
  }

  panel.appendChild(changeList);
  shadowWrapper.insertBefore(panel, shadowWrapper.firstChild);
  reviewPanelEl = panel;

  keepAllBtn.addEventListener('click', () => {
    dismissReviewPanel();
    setInputEnabled(false);
    startLoadingAnimation();
    void (async () => {
      for (const op of ops) {
        await callDocApi('gdocsAcceptEdit', { docId: activeDocId, findText: op.find, replaceText: op.replace });
      }
      stopLoadingAnimation();
      setInputEnabled(true);
    })();
  });

  revertAllBtn.addEventListener('click', () => {
    dismissReviewPanel();
    setInputEnabled(false);
    startLoadingAnimation();
    void (async () => {
      for (const op of ops) {
        await callDocApi('gdocsRevertEdit', { docId: activeDocId, findText: op.find, replaceText: op.replace });
      }
      stopLoadingAnimation();
      setInputEnabled(true);
    })();
  });
}

// ─── Response router ──────────────────────────────────────────────────────────
async function handleResponseActions(response: string): Promise<void> {
  if (pendingEditMode) {
    pendingEditMode = false;
    const editMatch = response.match(/<<<EDIT>>>([\s\S]+?)<<<END_EDIT>>>/);
    if (editMatch?.[1]) {
      const ops = parseEditOps(editMatch[1].trim());
      if (ops.length > 0) {
        if (activeSession) {
          activeSession.editSuggestions = [...(activeSession.editSuggestions ?? []), ops];
          await saveSession(activeSession);
        }
        startLoadingAnimation();
        await applyPendingEditsViaApi(ops);
        stopLoadingAnimation();
        showEditReviewPanel(ops);
      }
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
      if (activeSession) {
        activeSession.essayContent = essayContent;
        activeSession.essayTabId = essayTabId;
        activeSession.essayVersions = [...(activeSession.essayVersions ?? []), essayContent];
        await saveSession(activeSession);
      }
      if (topicTextarea) topicTextarea.placeholder = getPlaceholder();
      if (followup) await pasteIntoDoc(`Oddity: ${followup}\n\n`);
    }
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

// ─── MCQ flow ─────────────────────────────────────────────────────────────────
async function fetchAllMcqQuestions(topic: string): Promise<McqQuestion[] | null> {
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
  .mcq-card { background: #fff; border-radius: 16px; padding: 22px 22px 16px; box-shadow: 0 8px 40px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.07); border: 0.5px solid #e8e8e2; display: flex; flex-direction: column; gap: 16px; width: 480px; max-width: 90vw; font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; }
  .mcq-header { display: flex; align-items: center; justify-content: space-between; }
  .mcq-dots { display: flex; align-items: center; gap: 4px; }
  .mcq-dot { width: 6px; height: 6px; border-radius: 50%; background: #e5e7eb; transition: background 0.2s; }
  .mcq-dot-filled { background: #1a1a1a; }
  .mcq-progress { font-size: 11px; font-weight: 500; color: #9aa0a6; font-variant-numeric: tabular-nums; }
  .mcq-question { font-size: 14px; font-weight: 600; color: #1a1a1a; line-height: 1.5; }
  .mcq-options { display: flex; flex-direction: column; gap: 7px; }
  .mcq-option { display: flex; align-items: center; gap: 10px; text-align: left; padding: 10px 14px; border-radius: 10px; border: 1px solid #e8e8e2; background: #fff; color: #374151; font-size: 13px; font-family: inherit; cursor: pointer; transition: background 0.12s, border-color 0.12s; line-height: 1.4; width: 100%; }
  .mcq-option:hover { background: #f7f7f6; border-color: #d1d5db; }
  .mcq-option:disabled { opacity: 0.4; cursor: default; }
  .mcq-option-label { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; background: #f0f2f5; color: #6b7280; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .mcq-option-text { flex: 1; font-weight: 500; }
  .mcq-other-input { flex: 1; border: none; outline: none; background: transparent; font-size: 13px; font-family: inherit; color: #1a1a1a; font-weight: 500; padding: 0; min-width: 0; }
  .mcq-other-submit { flex-shrink: 0; border: none; background: #1a1a1a; color: #fff; border-radius: 50%; width: 20px; height: 20px; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; font-family: inherit; }
  .mcq-footer { display: flex; align-items: center; justify-content: space-between; }
  .mcq-footer-action { border: none; background: none; font-size: 12px; color: #9aa0a6; cursor: pointer; font-family: inherit; padding: 0; transition: color 0.15s; }
  .mcq-footer-action:hover { color: #374151; }
`;

function renderMcqCard(question: McqQuestion): void {
  // Remove previous card
  dismissMcqCard();

  const displayNum = mcqQuestionIndex + 1;
  const totalNum = Math.min(mcqAllQuestions.length, MAX_MCQ_QUESTIONS);

  // Create a new centered fixed overlay
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

  // Header: progress dots + "X / Y"
  const header = document.createElement('div');
  header.className = 'mcq-header';
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
  header.appendChild(dots);
  header.appendChild(progress);
  card.appendChild(header);

  const questionEl = document.createElement('div');
  questionEl.className = 'mcq-question';
  questionEl.textContent = question.question;
  card.appendChild(questionEl);

  const optionsEl = document.createElement('div');
  optionsEl.className = 'mcq-options';

  const aiOptions = question.options.slice(0, 3);
  aiOptions.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.className = 'mcq-option';
    const labelEl = document.createElement('span');
    labelEl.className = 'mcq-option-label';
    labelEl.textContent = MCQ_LABELS[idx] ?? String(idx + 1);
    const textEl = document.createElement('span');
    textEl.className = 'mcq-option-text';
    textEl.textContent = opt;
    btn.appendChild(labelEl);
    btn.appendChild(textEl);
    btn.addEventListener('click', () => handleMcqAnswer(opt, question.question));
    optionsEl.appendChild(btn);
  });

  // "Other" option
  const otherIdx = aiOptions.length;
  const otherBtn = document.createElement('button');
  otherBtn.className = 'mcq-option';
  const otherLabelEl = document.createElement('span');
  otherLabelEl.className = 'mcq-option-label';
  otherLabelEl.textContent = MCQ_LABELS[otherIdx] ?? 'D';
  const otherTextEl = document.createElement('span');
  otherTextEl.className = 'mcq-option-text';
  otherTextEl.textContent = 'Other';
  otherBtn.appendChild(otherLabelEl);
  otherBtn.appendChild(otherTextEl);
  const otherInput = document.createElement('input');
  otherInput.type = 'text';
  otherInput.className = 'mcq-other-input';
  otherInput.placeholder = 'Specify…';
  otherInput.style.display = 'none';
  const otherSubmit = document.createElement('button');
  otherSubmit.className = 'mcq-other-submit';
  otherSubmit.textContent = '→';
  otherSubmit.style.display = 'none';
  otherBtn.appendChild(otherInput);
  otherBtn.appendChild(otherSubmit);
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

  // Footer: Previous button from Q2 onwards
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

  chrome.runtime.sendMessage({ action: 'gdocsChat', payload: { messages, mode: 'essay' } });
}

// ─── Topic submit / Edit mode send ───────────────────────────────────────────
async function handleSubmit(text: string): Promise<void> {
  if (!text || streaming || mcqActive) return;

  const hasExistingEssay = !!(activeSession?.essayContent?.trim());

  if (hasExistingEssay || docHasContent) {
    // Edit mode — essay or doc content already exists
    streaming = true;
    pendingEditMode = true;
    setInputEnabled(false);
    startLoadingAnimation();

    // Re-scrape for freshest text; fall back to stored essay or activation-time scrape
    const freshScrape = scrapeDocContext();
    const essayContent = activeSession?.essayContent?.trim() || freshScrape.trim() || docContext.trim();

    // Persist scraped content so Docs API edit targeting stays consistent
    if (activeSession && !activeSession.essayContent && essayContent) {
      activeSession.essayContent = essayContent;
    }

    chatHistory.push({ role: 'user', content: text });
    if (activeSession) { activeSession.chatHistory = [...chatHistory]; void saveSession(activeSession); }

    const editMessages: GDocsMessage[] = [];
    if (essayContent) {
      editMessages.push({ role: 'user', content: `Here is the essay to edit:\n\n${essayContent}\n\nNow let's begin.` });
      editMessages.push({ role: 'assistant', content: "Got it. What edits would you like?" });
    }
    editMessages.push(...chatHistory);
    chrome.runtime.sendMessage({ action: 'gdocsChat', payload: { messages: editMessages, mode: 'edit' } });
    return;
  }

  // No existing content — write a new essay using the text as the topic
  mcqTopic = text;
  mcqPreviousQA = [];
  void generateEssay();
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
    .action-btn svg { width: 12px; height: 12px; flex-shrink: 0; }
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

  // ── Notes button ──
  commentBtn = document.createElement('button');
  commentBtn.className = 'action-btn';
  commentBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 2H2a1 1 0 00-1 1v5a1 1 0 001 1h2l2 2 2-2h2a1 1 0 001-1V3a1 1 0 00-1-1z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>Notes`;
  commentBtn.title = 'Re-run annotations';
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

  docContext = scrapeDocContext();
  docHasContent = docContext.trim().length > 0;
  createInputBar();

  if (existingSession) {
    chatHistory.push(...existingSession.chatHistory);
    activeSession = existingSession;
    essayTabId = existingSession.essayTabId ?? '';
    // Re-register annotations for reply observer
    void fetchAnnotationsForDoc().then(async (annotations) => {
      if (!annotations.length) return;
      const text = activeSession?.essayContent ?? '';
      if (!text.trim()) return;
      const contentHash = await sha256hex(text);
      registerGDocsCommentAnnotations(annotations, contentHash);
    });
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
  activeSession = null;
  mcqActive = false;
  mcqPreviousQA = [];
  mcqQuestionIndex = 0;
  mcqAllQuestions = [];
  mcqTopic = '';
  importedContext = '';
  streaming = false;
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
    // Fast mode: skip MCQ unless the doc is blank (new essay needed)
    const freshScrape = scrapeDocContext();
    const essayContent = activeSession?.essayContent?.trim() || freshScrape.trim() || docContext.trim();
    if (essayContent) {
      // Existing content — go straight to edit
      if (activeSession && !activeSession.essayContent) {
        activeSession.essayContent = essayContent;
        void saveSession(activeSession);
      }
      streaming = true;
      pendingEditMode = true;
      setInputEnabled(false);
      startLoadingAnimation();
      chatHistory.push({ role: 'user', content: effectiveTopic });
      if (activeSession) { activeSession.chatHistory = [...chatHistory]; void saveSession(activeSession); }
      const editMessages: GDocsMessage[] = [
        { role: 'user', content: `Here is the essay to edit:\n\n${essayContent}\n\nNow let's begin.` },
        { role: 'assistant', content: "Got it. What edits would you like?" },
        ...chatHistory,
      ];
      chrome.runtime.sendMessage({ action: 'gdocsChat', payload: { messages: editMessages, mode: 'edit' } });
      return;
    }
    // Blank doc — fall through to MCQ (need preferences for new essay)
  }

  mcqCompletionCallback = () => { void generateEssay(); };
  void startMcqFlow(effectiveTopic);
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

  // Re-scrape fresh — activation-time scrape may have been too early
  const freshScrape = scrapeDocContext();
  const essayContent = activeSession?.essayContent?.trim() || freshScrape.trim() || docContext.trim();

  if (essayContent) {
    // Existing content: go straight to edit — never show MCQ for edits
    if (activeSession && !activeSession.essayContent) {
      activeSession.essayContent = essayContent;
      void saveSession(activeSession);
    }
    streaming = true;
    pendingEditMode = true;
    setInputEnabled(false);
    startLoadingAnimation();
    chatHistory.push({ role: 'user', content: text });
    if (activeSession) { activeSession.chatHistory = [...chatHistory]; void saveSession(activeSession); }
    const editMessages: GDocsMessage[] = [
      { role: 'user', content: `Here is the essay to edit:\n\n${essayContent}\n\nNow let's begin.` },
      { role: 'assistant', content: "Got it. What edits would you like?" },
      ...chatHistory,
    ];
    chrome.runtime.sendMessage({ action: 'gdocsChat', payload: { messages: editMessages, mode: 'edit' } });
  } else if (fastMode) {
    // Fast mode + blank doc: write directly from the prompt, skip MCQ
    mcqTopic = text;
    void generateEssay();
  } else {
    // Blank doc: run MCQ to gather preferences, then write new essay
    mcqOriginalPrompt = text;
    mcqCompletionCallback = () => { void generateEssay(); };
    void startMcqFlow(text);
  }
});

document.addEventListener('oddity:annotation:fix-now', (e: Event) => {
  const { anchorText, note, replyText } = (e as CustomEvent<{ annotationId: string; anchorText: string; note: string; replyText: string }>).detail;
  const prompt = `Fix the following passage based on this annotation feedback.\n\nPassage: "${anchorText}"\nAnnotation: ${note}${replyText ? `\nUser note: ${replyText}` : ''}`;
  void handleSubmit(prompt);
});
