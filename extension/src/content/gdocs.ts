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
let loadingOverlayEl: HTMLElement | null = null;
let loadingStatusEl: HTMLElement | null = null;

// ─── MCQ state ────────────────────────────────────────────────────────────────
let mcqActive = false;
let mcqPreviousQA: Array<{ question: string; answer: string }> = [];
let mcqQuestionNumber = 1;
let mcqTopic = '';
let mcqCardEl: HTMLElement | null = null;
const MAX_MCQ_QUESTIONS = 3;

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
        hideLoadingOverlay();
        setInputEnabled(true);
        if (activeSession) {
          activeSession.chatHistory = [...chatHistory];
          void saveSession(activeSession);
        }
      })
      .catch((err) => {
        console.error('[Oddity GDocs] Response handling error:', err);
        streaming = false;
        hideLoadingOverlay();
        setInputEnabled(true);
      });
  } else if (message.action === 'gdocsChatError') {
    const errMsg = (message.payload as { error?: string }).error ?? 'Unknown error';
    console.error('[Oddity GDocs] Chat error:', errMsg);
    currentStreamText = '';
    streaming = false;
    pendingEditMode = false;
    hideLoadingOverlay();
    setInputEnabled(true);
    if (topicTextarea) {
      topicTextarea.placeholder = `Error: ${errMsg.slice(0, 60)}`;
      setTimeout(() => { if (topicTextarea) topicTextarea.placeholder = getPlaceholder(); }, 4000);
    }
  }
});

function getPlaceholder(): string {
  const currentTabId = new URLSearchParams(window.location.search).get('tab') ?? 'default';
  if (essayTabId && currentTabId === essayTabId) return 'Ask for edits…';
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
  showLoadingOverlay(`Adding ${annotations.length} depth comments…`);
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
  hideLoadingOverlay();
  if (commentBtn) commentBtn.disabled = false;
  setInputEnabled(true);
}

// ─── Response router ──────────────────────────────────────────────────────────
async function handleResponseActions(response: string): Promise<void> {
  if (pendingEditMode) {
    pendingEditMode = false;
    const editMatch = response.match(/<<<EDIT>>>([\s\S]+?)<<<END_EDIT>>>/);
    if (editMatch?.[1]) {
      await enableSuggestionMode();
      const ops = parseEditOps(editMatch[1].trim());
      if (activeSession && ops.length > 0) {
        activeSession.editSuggestions = [...(activeSession.editSuggestions ?? []), ops];
        await saveSession(activeSession);
      }
      for (const op of ops) await replaceTextViaCanvas(op.find, op.replace);
      await enableEditMode();
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
      if (activeSession) {
        activeSession.essayContent = essayContent;
        activeSession.essayVersions = [...(activeSession.essayVersions ?? []), essayContent];
        await saveSession(activeSession);
      }
      if (followup) await pasteIntoDoc(`Oddity: ${followup}\n\n`);
    }
  }
}

// ─── Loading overlay ──────────────────────────────────────────────────────────
function showLoadingOverlay(status: string): void {
  if (loadingOverlayEl) { if (loadingStatusEl) loadingStatusEl.textContent = status; return; }
  const host = document.createElement('div');
  host.id = 'oddity-gdocs-loading-host';
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483645; pointer-events: all;';
  document.body.appendChild(host);
  loadingOverlayEl = host;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; }
    .overlay { position: fixed; inset: 0; backdrop-filter: blur(6px) saturate(0.8); -webkit-backdrop-filter: blur(6px) saturate(0.8); background: rgba(255,255,255,0.18); display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 16px; padding: 28px 32px; box-shadow: 0 8px 40px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06); border: 0.5px solid #e8e8e2; display: flex; flex-direction: column; align-items: center; gap: 16px; min-width: 220px; font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; }
    .logo { width: 36px; height: 36px; border-radius: 8px; object-fit: contain; }
    .spinner { width: 28px; height: 28px; border: 2.5px solid #e8e8e2; border-top-color: #111; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status { font-size: 13px; font-weight: 500; color: #1a1a1a; text-align: center; line-height: 1.4; letter-spacing: 0.01em; }
  `;
  shadow.appendChild(style);
  const overlay = document.createElement('div'); overlay.className = 'overlay';
  const card = document.createElement('div'); card.className = 'card';
  const logo = document.createElement('img'); logo.className = 'logo'; logo.src = chrome.runtime.getURL('Oddity1-Logo.png'); logo.alt = 'Oddity';
  const spinner = document.createElement('div'); spinner.className = 'spinner';
  const statusEl = document.createElement('div'); statusEl.className = 'status'; statusEl.textContent = status; loadingStatusEl = statusEl;
  card.appendChild(logo); card.appendChild(spinner); card.appendChild(statusEl);
  overlay.appendChild(card); shadow.appendChild(overlay);
}

function hideLoadingOverlay(): void {
  loadingOverlayEl?.remove();
  loadingOverlayEl = null;
  loadingStatusEl = null;
}

function setInputEnabled(enabled: boolean) {
  if (topicTextarea) {
    topicTextarea.disabled = !enabled;
    if (enabled) {
      topicTextarea.placeholder = getPlaceholder();
      topicTextarea.focus();
    } else {
      topicTextarea.placeholder = 'Thinking…';
    }
  }
  if (submitBtn) submitBtn.disabled = !enabled;
  if (commentBtn) commentBtn.disabled = !enabled;
}

// ─── MCQ flow ─────────────────────────────────────────────────────────────────
async function fetchMcqQuestion(
  topic: string,
  previousQA: Array<{ question: string; answer: string }>,
  questionNumber: number,
): Promise<McqQuestion | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'gdocsMcqQuestion', payload: { prompt: topic, docContext, previousQA, questionNumber } },
      (result: McqQuestion | { error?: string } | undefined) => {
        if (!result || 'error' in result) { resolve(null); return; }
        resolve(result as McqQuestion);
      }
    );
  });
}

function dismissMcqCard(): void {
  mcqCardEl?.remove();
  mcqCardEl = null;
}

function renderMcqCard(question: McqQuestion): void {
  if (!shadowWrapper) return;
  dismissMcqCard();

  const card = document.createElement('div');
  card.className = 'mcq-card';

  const qNumEl = document.createElement('div');
  qNumEl.className = 'mcq-num';
  qNumEl.textContent = `Question ${mcqQuestionNumber} of ${MAX_MCQ_QUESTIONS}`;
  card.appendChild(qNumEl);

  const questionEl = document.createElement('div');
  questionEl.className = 'mcq-question';
  questionEl.textContent = question.question;
  card.appendChild(questionEl);

  const optionsEl = document.createElement('div');
  optionsEl.className = 'mcq-options';
  for (const opt of question.options) {
    const btn = document.createElement('button');
    btn.className = 'mcq-option';
    btn.textContent = opt;
    btn.addEventListener('click', () => void handleMcqAnswer(opt, question.question));
    optionsEl.appendChild(btn);
  }
  card.appendChild(optionsEl);

  const skipBtn = document.createElement('button');
  skipBtn.className = 'mcq-skip';
  skipBtn.textContent = 'Skip — write essay now';
  skipBtn.addEventListener('click', () => {
    dismissMcqCard();
    mcqActive = false;
    void generateEssay();
  });
  card.appendChild(skipBtn);

  // Insert at top of wrapper (above the input bar)
  shadowWrapper.insertBefore(card, shadowWrapper.firstChild);
  mcqCardEl = card;
}

async function handleMcqAnswer(answer: string, question: string): Promise<void> {
  if (!mcqActive) return;
  mcqPreviousQA.push({ question, answer });
  mcqQuestionNumber++;

  if (mcqQuestionNumber > MAX_MCQ_QUESTIONS) {
    dismissMcqCard();
    mcqActive = false;
    void generateEssay();
    return;
  }

  // Disable option buttons while fetching next
  mcqCardEl?.querySelectorAll<HTMLButtonElement>('.mcq-option').forEach(b => { b.disabled = true; });

  const next = await fetchMcqQuestion(mcqTopic, mcqPreviousQA, mcqQuestionNumber);
  if (!next) {
    dismissMcqCard();
    mcqActive = false;
    void generateEssay();
    return;
  }
  renderMcqCard(next);
}

async function startMcqFlow(topic: string): Promise<void> {
  mcqTopic = topic;
  mcqActive = true;
  mcqPreviousQA = [];
  mcqQuestionNumber = 1;

  setInputEnabled(false);
  if (topicTextarea) topicTextarea.placeholder = 'Thinking…';

  const first = await fetchMcqQuestion(topic, [], 1);
  if (!first) {
    mcqActive = false;
    setInputEnabled(true);
    void generateEssay();
    return;
  }
  setInputEnabled(true); // re-enable Notes button while MCQ is active
  if (topicTextarea) { topicTextarea.disabled = true; topicTextarea.value = ''; topicTextarea.placeholder = 'Answer to continue…'; }
  if (submitBtn) submitBtn.disabled = true;
  renderMcqCard(first);
}

function generateEssay(): void {
  streaming = true;
  setInputEnabled(false);
  showLoadingOverlay('Writing your essay…');

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

  const currentTabId = new URLSearchParams(window.location.search).get('tab') ?? 'default';
  const isEditTab = !!essayTabId && currentTabId === essayTabId;

  if (isEditTab) {
    // Edit mode on essay tab
    streaming = true;
    pendingEditMode = true;
    setInputEnabled(false);
    showLoadingOverlay('Editing your essay…');

    chatHistory.push({ role: 'user', content: text });
    if (activeSession) { activeSession.chatHistory = [...chatHistory]; void saveSession(activeSession); }

    const essayContent = activeSession?.essayContent ?? '';
    const editMessages: GDocsMessage[] = [];
    if (essayContent) {
      editMessages.push({ role: 'user', content: `Here is the essay to edit:\n\n${essayContent}\n\nNow let's begin.` });
      editMessages.push({ role: 'assistant', content: "Got it. What edits would you like?" });
    }
    editMessages.push(...chatHistory);
    chrome.runtime.sendMessage({ action: 'gdocsChat', payload: { messages: editMessages, mode: 'edit' } });
    return;
  }

  // Topic entry — start MCQ flow
  void startMcqFlow(text);
}

// ─── Input bar ────────────────────────────────────────────────────────────────
function createInputBar(): void {
  const host = document.createElement('div');
  host.id = 'oddity-gdocs-input-host';
  host.style.cssText = 'all: initial; position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 2147483646; width: 520px;';
  document.body.appendChild(host);
  inputBar = host;

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600&display=swap');
    *, *::before, *::after { box-sizing: border-box; }
    .wrapper { display: flex; flex-direction: column; gap: 8px; font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif; }
    .bar { display: flex; align-items: center; gap: 8px; background: #fff; border-radius: 9999px; padding: 8px 8px 8px 18px; box-shadow: 0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06); border: 0.5px solid #e8e8e2; }
    textarea { flex: 1; resize: none; border: none; outline: none; font-family: inherit; font-size: 13px; line-height: 1.4; color: #1a1a1a; background: transparent; max-height: 120px; overflow-y: auto; padding: 0; margin: 0; display: block; }
    textarea::placeholder { color: #9aa0a6; }
    textarea:disabled { opacity: 0.45; }
    .send { width: 34px; height: 34px; border-radius: 9999px; border: none; background: #111; color: #fff; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; transition: background 0.15s; }
    .send:hover { background: #333; }
    .send:disabled { background: #e8e8e2; color: #9aa0a6; cursor: default; }
    .close { width: 0; height: 28px; border-radius: 9999px; border: none; background: none; color: #9aa0a6; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; padding: 0; overflow: hidden; opacity: 0; pointer-events: none; transition: width 0.22s cubic-bezier(0.34,1.56,0.64,1), opacity 0.15s; }
    .close:hover { color: #374151; }
    .show-close .close { width: 28px; opacity: 1; pointer-events: all; }
    .actions { display: flex; align-items: center; gap: 6px; padding: 0 4px; }
    .action-btn { height: 30px; padding: 0 12px; border-radius: 9999px; border: none; background: #f0f2f5; color: #374151; font-size: 11px; font-weight: 600; font-family: inherit; letter-spacing: 0.02em; cursor: pointer; display: flex; align-items: center; gap: 4px; flex-shrink: 0; transition: background 0.15s; white-space: nowrap; }
    .action-btn:hover { background: #e5e7eb; }
    .action-btn:disabled { opacity: 0.4; cursor: default; }
    .action-btn svg { width: 12px; height: 12px; flex-shrink: 0; }
    /* MCQ card */
    .mcq-card { background: #fff; border-radius: 16px; padding: 20px 20px 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06); border: 0.5px solid #e8e8e2; display: flex; flex-direction: column; gap: 12px; }
    .mcq-num { font-size: 10px; font-weight: 600; color: #9aa0a6; letter-spacing: 0.08em; text-transform: uppercase; }
    .mcq-question { font-size: 13px; font-weight: 600; color: #1a1a1a; line-height: 1.45; }
    .mcq-options { display: flex; flex-direction: column; gap: 6px; }
    .mcq-option { text-align: left; padding: 8px 14px; border-radius: 9999px; border: none; background: #f0f2f5; color: #374151; font-size: 12px; font-weight: 500; font-family: inherit; cursor: pointer; transition: background 0.12s; line-height: 1.35; }
    .mcq-option:hover { background: #e5e7eb; }
    .mcq-option:disabled { opacity: 0.4; cursor: default; }
    .mcq-skip { align-self: flex-end; border: none; background: none; font-size: 11px; color: #9aa0a6; cursor: pointer; font-family: inherit; padding: 0; text-decoration: underline; }
    .mcq-skip:hover { color: #374151; }
  `;
  shadow.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.className = 'wrapper';
  shadowWrapper = wrapper;

  // ── Input pill ──
  const bar = document.createElement('div');
  bar.className = 'bar';

  topicTextarea = document.createElement('textarea');
  topicTextarea.placeholder = getPlaceholder();
  topicTextarea.rows = 1;
  topicTextarea.addEventListener('input', () => {
    topicTextarea!.style.height = 'auto';
    topicTextarea!.style.height = `${Math.min(topicTextarea!.scrollHeight, 120)}px`;
  });
  topicTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const val = topicTextarea!.value.trim();
      if (val) { topicTextarea!.value = ''; topicTextarea!.style.height = 'auto'; void handleSubmit(val); }
    }
  });

  submitBtn = document.createElement('button');
  submitBtn.className = 'send';
  submitBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 12V4M8 4L4.5 7.5M8 4L11.5 7.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  submitBtn.title = 'Submit';
  submitBtn.addEventListener('click', () => {
    const val = topicTextarea!.value.trim();
    if (val) { topicTextarea!.value = ''; topicTextarea!.style.height = 'auto'; void handleSubmit(val); }
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close Oddity';
  closeBtn.addEventListener('click', deactivate);

  bar.appendChild(topicTextarea);
  bar.appendChild(submitBtn);
  bar.appendChild(closeBtn);

  bar.addEventListener('mousemove', (e) => {
    const rect = bar.getBoundingClientRect();
    wrapper.classList.toggle('show-close', e.clientX - rect.left > rect.width * 0.75);
  });
  bar.addEventListener('mouseleave', () => wrapper.classList.remove('show-close'));

  // ── Actions row ──
  const actionsRow = document.createElement('div');
  actionsRow.className = 'actions';

  commentBtn = document.createElement('button');
  commentBtn.className = 'action-btn';
  commentBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 2H2a1 1 0 00-1 1v5a1 1 0 001 1h2l2 2 2-2h2a1 1 0 001-1V3a1 1 0 00-1-1z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>Notes`;
  commentBtn.title = 'Add depth annotations as GDocs comments';
  commentBtn.addEventListener('click', () => void addDepthAnnotationsAsComments());

  actionsRow.appendChild(commentBtn);

  wrapper.appendChild(actionsRow);
  wrapper.appendChild(bar);
  shadow.appendChild(wrapper);

  setTimeout(() => topicTextarea?.focus(), 100);
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
    if (topicTextarea) topicTextarea.placeholder = getPlaceholder();
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
  dismissMcqCard();
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
  mcqQuestionNumber = 1;
  mcqTopic = '';
  streaming = false;
}

// ─── Entry point ──────────────────────────────────────────────────────────────
document.addEventListener('oddity:gdocs:activate', (e: Event) => {
  const context = (e as CustomEvent<{ prompt: string; answers: Record<string, string> } | undefined>).detail;
  void activate(context ?? undefined);
});
