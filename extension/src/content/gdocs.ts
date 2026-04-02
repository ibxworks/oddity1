// Oddity GDocs — First Principles Thinking assistant for Google Docs

interface GDocsMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface OddityGDocsSession {
  docId: string;
  tabId: string;
  chatHistory: GDocsMessage[];
  createdAt: number;
  treeContent?: string;
  essayContent?: string;
  essayTabId?: string;
  treeTabId?: string;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

const chatHistory: GDocsMessage[] = [];
let docContext = '';
let streaming = false;
let currentStreamText = '';
let pendingUserPaste: Promise<void> = Promise.resolve();
let inputBar: HTMLDivElement | null = null;
let gdocsTextarea: HTMLTextAreaElement | null = null;
let sendBtn: HTMLButtonElement | null = null;
let treeBtn: HTMLButtonElement | null = null;
let essayBtn: HTMLButtonElement | null = null;
let commentBtn: HTMLButtonElement | null = null;
let activeDocId = '';
let activeTabId = '';
let essayTabId = '';
let treeTabId = '';
let pendingEditMode = false;
let activeSession: OddityGDocsSession | null = null;
let loadingOverlayEl: HTMLElement | null = null;
let loadingStatusEl: HTMLElement | null = null;

// ─── URL parsing ─────────────────────────────────────────────────────────────
function parseGDocsLocation(): { docId: string; tabId: string } {
  const pathMatch = window.location.pathname.match(/\/document\/d\/([^/]+)\//);
  const docId = pathMatch?.[1] ?? 'unknown';
  const tabId = new URLSearchParams(window.location.search).get('tab') ?? 'default';
  return { docId, tabId };
}

// ─── Storage helpers ──────────────────────────────────────────────────────────
function sessionKey(docId: string, tabId: string) {
  return `oddity_gdocs_session_${docId}_${tabId}`;
}

async function loadSession(docId: string, tabId: string): Promise<OddityGDocsSession | null> {
  const key = sessionKey(docId, tabId);
  const result = await chrome.storage.local.get(key);
  return (result[key] as OddityGDocsSession) ?? null;
}

async function saveSession(session: OddityGDocsSession): Promise<void> {
  const key = sessionKey(session.docId, session.tabId);
  await chrome.storage.local.set({ [key]: session });
}

async function saveSessionAfterMessage(): Promise<void> {
  if (!activeSession) return;
  activeSession.chatHistory = [...chatHistory];
  await saveSession(activeSession);
}

// ─── Stream relay via background messages ────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'gdocsChatChunk') {
    currentStreamText += (message.payload as { text: string }).text;
  } else if (message.action === 'gdocsChatDone') {
    const response = currentStreamText;
    chatHistory.push({ role: 'assistant', content: response });
    currentStreamText = '';
    pendingUserPaste
      .then(() => saveSessionAfterMessage())
      .then(() => handleResponseActions(response))
      .then(() => {
        streaming = false;
        hideLoadingOverlay();
        setInputEnabled(true);
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
    if (gdocsTextarea) {
      gdocsTextarea.placeholder = `Error: ${errMsg.slice(0, 60)}`;
      setTimeout(() => { if (gdocsTextarea) gdocsTextarea.placeholder = 'Ask Oddity...'; }, 4000);
    }
  }
});

// ─── Doc context scraping ─────────────────────────────────────────────────────
function scrapeDocContext(): string {
  const docs = [document, ...iframeDocuments()];
  const paragraphs = docs.flatMap((doc) =>
    Array.from(doc.querySelectorAll<HTMLElement>('.kix-paragraphrenderer'))
  );
  return paragraphs
    .map((p) => p.textContent ?? '')
    .filter((t) => t.trim().length > 0)
    .join('\n')
    .slice(0, 8000);
}

// ─── Doc insertion via character-by-character events ─────────────────────────
async function pasteIntoDoc(text: string) {
  const iframe = document.querySelector(
    '.docs-texteventtarget-iframe'
  ) as HTMLIFrameElement | null;

  if (!iframe?.contentDocument?.body || !iframe.contentWindow) {
    console.warn('[Oddity GDocs] iframe not accessible');
    return;
  }

  const iframeBody = iframe.contentDocument.body as HTMLElement;
  iframeBody.focus();
  await sleep(100);

  for (const char of text) {
    if (char === '\n') {
      iframeBody.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
      );
      iframeBody.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
      );
    } else {
      const cc = char.charCodeAt(0);
      iframeBody.dispatchEvent(
        new KeyboardEvent('keypress', { key: char, charCode: cc, keyCode: cc, which: cc, bubbles: true, cancelable: true })
      );
    }
  }
}

// ─── GDocs tab rename ─────────────────────────────────────────────────────────
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

// ─── GDocs tab creation & navigation ─────────────────────────────────────────
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
  const brainstormingTabId = activeTabId;
  const created = await createNewGDocsTab();
  if (!created) {
    await pasteIntoDoc(`\n\n--- Essay Draft ---\n${essayContent}\n\n`);
    return;
  }
  await waitForTabChange(brainstormingTabId);
  const newTabId = new URLSearchParams(window.location.search).get('tab') ?? 'default';
  essayTabId = newTabId;
  await renameGDocsTabWithRetry('Essay Draft', newTabId, 8, 300);
  await pasteIntoDoc(essayContent + '\n\n');
  if (activeSession) {
    activeSession.essayContent = essayContent;
    activeSession.essayTabId = newTabId;
    await saveSession(activeSession);
  }
  await navigateToGDocsTabByLabel('Brainstorming');
}

async function buildArgumentTreeTab(treeContent: string): Promise<void> {
  const brainstormingTabId = activeTabId;
  const created = await createNewGDocsTab();
  if (!created) {
    await pasteIntoDoc(`\n\n--- Argument Tree ---\n${treeContent}\n\n`);
    return;
  }
  await waitForTabChange(brainstormingTabId);
  const newTabId = new URLSearchParams(window.location.search).get('tab') ?? 'default';
  treeTabId = newTabId;
  await renameGDocsTabWithRetry('Argument Tree', newTabId, 8, 300);
  await pasteIntoDoc(treeContent + '\n\n');
  if (activeSession) {
    activeSession.treeContent = treeContent;
    activeSession.treeTabId = newTabId;
    await saveSession(activeSession);
  }
  await navigateToGDocsTabByLabel('Brainstorming');
}

// ─── Suggestion mode helpers ──────────────────────────────────────────────────
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
    const items = Array.from(document.querySelectorAll<HTMLElement>(
      '.goog-menuitem, .goog-option, [role^="menuitem"], [role="option"]'
    )).filter(el => el.offsetParent !== null);

    const item = items.find(el =>
      /suggest/i.test(el.textContent ?? '') ||
      /suggest/i.test(el.getAttribute('aria-label') ?? '')
    );
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
    const items = Array.from(document.querySelectorAll<HTMLElement>(
      '.goog-menuitem, .goog-option, [role^="menuitem"], [role="option"]'
    )).filter(el => el.offsetParent !== null);

    const item = items.find(el =>
      /editing/i.test(el.textContent ?? '') ||
      /editing/i.test(el.getAttribute('aria-label') ?? '')
    );
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
      ops.push({
        find: findMatch[1].trim(),
        replace: replaceMatch?.[1]?.trim() ?? '',
      });
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
      const dialogInputs = Array.from(dialog.querySelectorAll<HTMLInputElement>('input'))
        .filter(el => !excluded.some(c => el.classList.contains(c)));
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
  canvasIframe.contentDocument.body.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'H', code: 'KeyH', keyCode: 72,
    metaKey: true, shiftKey: true,
    bubbles: true, cancelable: true,
  }));

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
    const btn = Array.from(doc.querySelectorAll<HTMLElement>('*')).find(
      (el) =>
        el.offsetParent !== null &&
        el.children.length === 0 &&
        /^(find|next)$/i.test(el.textContent?.trim() ?? '')
    );
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
  // Use stored essay content — no DOM scraping needed
  const text = activeSession?.essayContent ?? '';
  if (!text.trim()) {
    console.warn('[Oddity GDocs] No essay content in session');
    return [];
  }
  const contentHash = await sha256hex(text);
  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'gdocsAnnotateText', payload: { text, url: window.location.href, contentHash, wordCount } },
      (result) => {
        console.log('[Oddity GDocs] gdocsAnnotateText response:', result);
        resolve((result as { annotations?: DepthAnnotation[] })?.annotations ?? []);
      }
    );
  });
}

function snapshotEditables(): Set<HTMLElement> {
  const docs = [document, ...iframeDocuments()];
  const els = docs.flatMap((doc) =>
    Array.from(doc.querySelectorAll<HTMLElement>('[contenteditable], textarea, input, [role="textbox"]'))
  );
  return new Set(els);
}

const COMMENT_INPUT_SELECTORS = [
  '.docos-input-textarea',
  '.docos-replybox-textarea',
  "[aria-label='Add a comment']",
  "[aria-label='Comment']",
  "[placeholder='Add a comment…']",
  "[placeholder='Add a comment']",
  ".docos-streamdocument-container [contenteditable='true']",
  ".docos-docosbody-container [contenteditable='true']",
];

async function waitForNewEditable(before: Set<HTMLElement>, timeoutMs = 3000): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Check proven GDocs comment selectors first
    for (const sel of COMMENT_INPUT_SELECTORS) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.offsetParent !== null) return el;
    }
    // Fallback: snapshot diff across all accessible documents
    const docs = [document, ...iframeDocuments()];
    for (const doc of docs) {
      const current = Array.from(
        doc.querySelectorAll<HTMLElement>('[contenteditable], textarea, input, [role="textbox"]')
      );
      const newEl = current.find((el) => !before.has(el) && el.offsetParent !== null);
      if (newEl) return newEl;
    }
    await sleep(100);
  }
  return null;
}

async function typeIntoCommentBox(el: HTMLElement, text: string): Promise<void> {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const ta = el as HTMLTextAreaElement;
    ta.focus();
    ta.value = text;
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.focus();
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
  }
  await sleep(150);
}

async function submitComment(el: HTMLElement): Promise<void> {
  // Try clicking the "Comment" button directly — most reliable
  const container = el.closest('[role="dialog"], .docos-anchoreddialog, .docos-input-wrapper')
    ?? el.parentElement?.parentElement;
  if (container) {
    const btn = Array.from(container.querySelectorAll<HTMLElement>('button, [role="button"]'))
      .find((b) => /^comment$/i.test(b.textContent?.trim() ?? '') || /^comment$/i.test(b.getAttribute('aria-label') ?? ''));
    if (btn) {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(300);
      return;
    }
  }
  // Fallback: Ctrl+Enter on the input
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

  // Open Find & Replace to position cursor at the anchor text
  iframeBody.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'H', code: 'KeyH', keyCode: 72, metaKey: true, shiftKey: true, bubbles: true, cancelable: true })
  );

  const ready = await waitForFRDialog();
  if (!ready) return false;

  const { findInput } = findFRInputs();
  if (!findInput) return false;

  await typeIntoFRInput(findInput, anchorText.slice(0, 80));

  // Close dialog — GDocs keeps the found text highlighted/selected after Escape
  findInput.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true })
  );
  const closeStart = Date.now();
  while (Date.now() - closeStart < 2000) {
    if (!findFRInputs().findInput) break;
    await sleep(100);
  }
  await sleep(200);

  return true;
}

async function addSingleGDocsComment(anchorText: string, commentText: string): Promise<void> {
  const found = await selectAnchorInDoc(anchorText);
  if (!found) {
    console.warn('[Oddity GDocs] Anchor text not found:', anchorText.slice(0, 60));
    return;
  }

  const before = snapshotEditables();

  const canvasIframe = document.querySelector<HTMLIFrameElement>('.docs-texteventtarget-iframe');
  if (!canvasIframe?.contentDocument?.body) return;

  const iframeBody = canvasIframe.contentDocument.body as HTMLElement;
  iframeBody.focus();
  await sleep(100);

  iframeBody.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', keyCode: 77, metaKey: true, altKey: true, bubbles: true, cancelable: true })
  );
  await sleep(800);

  const textarea = await waitForNewEditable(before);
  if (!textarea) {
    console.warn('[Oddity GDocs] Comment input did not appear');
    return;
  }

  await typeIntoCommentBox(textarea, commentText);
  await submitComment(textarea);
  await sleep(300);
}

async function addDepthAnnotationsAsComments(): Promise<void> {
  if (gdocsTextarea) gdocsTextarea.placeholder = 'Generating annotations…';
  const annotations = await fetchAnnotationsForDoc();

  if (annotations.length === 0) {
    if (gdocsTextarea) {
      gdocsTextarea.placeholder = 'No depth annotations found for this doc';
      setTimeout(() => { if (gdocsTextarea) gdocsTextarea.placeholder = 'Ask Oddity...'; }, 3000);
    }
    return;
  }

  if (commentBtn) commentBtn.disabled = true;
  setInputEnabled(false);
  if (gdocsTextarea) gdocsTextarea.placeholder = `Adding ${annotations.length} comments…`;
  showLoadingOverlay(`Adding ${annotations.length} depth comments…`);

  for (const ann of annotations) {
    const label = ann.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const commentText = `[${label}] ${ann.content.note}${ann.content.question ? '\n\n' + ann.content.question : ''}`;
    await addSingleGDocsComment(ann.anchor.exact, commentText);
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
      for (const op of ops) {
        await replaceTextViaCanvas(op.find, op.replace);
      }
      await enableEditMode();
    }
    return;
  }

  const treeMatch = response.match(/<<<TREE>>>([\s\S]+?)<<<END_TREE>>>/);
  const essayMatch = response.match(/<<<ESSAY>>>([\s\S]+?)<<<END_ESSAY>>>/);

  if (treeMatch?.[1]) {
    const treeContent = treeMatch[1].trim();
    const followup = response.replace(/<<<TREE>>>[\s\S]+?<<<END_TREE>>>/, '').trim();
    await buildArgumentTreeTab(treeContent);
    if (followup) await pasteIntoDoc(`Oddity 1: ${followup}\n\n`);
  } else if (essayMatch?.[1]) {
    const essayContent = essayMatch[1].trim();
    const followup = response.replace(/<<<ESSAY>>>[\s\S]+?<<<END_ESSAY>>>/, '').trim();
    await buildEssayTab(essayContent);
    if (followup) await pasteIntoDoc(`Oddity 1: ${followup}\n\n`);
  } else {
    await pasteIntoDoc(`Oddity 1: ${response}\n\n`);
  }
}

// ─── Loading overlay ──────────────────────────────────────────────────────────
function showLoadingOverlay(status: string): void {
  if (loadingOverlayEl) {
    if (loadingStatusEl) loadingStatusEl.textContent = status;
    return;
  }

  const host = document.createElement('div');
  host.id = 'oddity-gdocs-loading-host';
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483645; pointer-events: all;';
  document.body.appendChild(host);
  loadingOverlayEl = host;

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; }
    .overlay {
      position: fixed; inset: 0;
      backdrop-filter: blur(6px) saturate(0.8);
      -webkit-backdrop-filter: blur(6px) saturate(0.8);
      background: rgba(255, 255, 255, 0.18);
      display: flex; align-items: center; justify-content: center;
    }
    .card {
      background: #ffffff;
      border-radius: 16px;
      padding: 28px 32px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06);
      border: 0.5px solid #e8e8e2;
      display: flex; flex-direction: column; align-items: center; gap: 16px;
      min-width: 220px;
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .logo {
      width: 36px; height: 36px; border-radius: 8px; object-fit: contain;
    }
    .spinner {
      width: 28px; height: 28px;
      border: 2.5px solid #e8e8e2;
      border-top-color: #111;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status {
      font-size: 13px; font-weight: 500; color: #1a1a1a;
      text-align: center; line-height: 1.4;
      letter-spacing: 0.01em;
    }
  `;
  shadow.appendChild(style);

  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  const card = document.createElement('div');
  card.className = 'card';

  const logo = document.createElement('img');
  logo.className = 'logo';
  logo.src = chrome.runtime.getURL('Oddity1-Logo.png');
  logo.alt = 'Oddity';

  const spinner = document.createElement('div');
  spinner.className = 'spinner';

  const statusEl = document.createElement('div');
  statusEl.className = 'status';
  statusEl.textContent = status;
  loadingStatusEl = statusEl;

  card.appendChild(logo);
  card.appendChild(spinner);
  card.appendChild(statusEl);
  overlay.appendChild(card);
  shadow.appendChild(overlay);
}

function hideLoadingOverlay(): void {
  loadingOverlayEl?.remove();
  loadingOverlayEl = null;
  loadingStatusEl = null;
}

function setInputEnabled(enabled: boolean) {
  if (gdocsTextarea) {
    gdocsTextarea.disabled = !enabled;
    gdocsTextarea.placeholder = enabled ? 'Ask Oddity...' : 'Thinking…';
    if (enabled) gdocsTextarea.focus();
  }
  if (sendBtn) sendBtn.disabled = !enabled;
  if (treeBtn) treeBtn.disabled = !enabled;
  if (essayBtn) essayBtn.disabled = !enabled;
  if (commentBtn) commentBtn.disabled = !enabled;
}

// ─── Tree request ─────────────────────────────────────────────────────────────
function handleTreeRequest(btn: HTMLButtonElement) {
  if (streaming || chatHistory.length === 0) return;
  streaming = true;
  pendingUserPaste = Promise.resolve();
  btn.disabled = true;
  if (sendBtn) sendBtn.disabled = true;
  if (gdocsTextarea) { gdocsTextarea.disabled = true; gdocsTextarea.placeholder = 'Building tree…'; }
  showLoadingOverlay('Building your argument tree…');

  const messages: GDocsMessage[] = [];
  if (docContext) {
    messages.push({ role: 'user', content: `Here is the current document text for context:\n\n${docContext}\n\nNow let's begin.` });
    messages.push({ role: 'assistant', content: "Got it — I've read the document. What would you like to think through?" });
  }
  messages.push(...chatHistory);
  messages.push({ role: 'user', content: 'Please build the argument tree now.' });

  chrome.runtime.sendMessage({ action: 'gdocsChat', payload: { messages, mode: 'tree' } });
}

// ─── Essay request ────────────────────────────────────────────────────────────
function handleEssayRequest(btn: HTMLButtonElement) {
  if (streaming || chatHistory.length === 0) return;
  streaming = true;
  pendingUserPaste = Promise.resolve();
  btn.disabled = true;
  if (sendBtn) sendBtn.disabled = true;
  if (treeBtn) treeBtn.disabled = true;
  if (gdocsTextarea) { gdocsTextarea.disabled = true; gdocsTextarea.placeholder = 'Drafting essay…'; }
  showLoadingOverlay('Drafting your essay…');

  const messages: GDocsMessage[] = [];
  if (docContext) {
    messages.push({ role: 'user', content: `Here is the current document text for context:\n\n${docContext}\n\nNow let's begin.` });
    messages.push({ role: 'assistant', content: "Got it — I've read the document. What would you like to think through?" });
  }
  messages.push(...chatHistory);
  messages.push({ role: 'user', content: 'Please write a first draft essay based on our conversation and the argument tree.' });

  chrome.runtime.sendMessage({ action: 'gdocsChat', payload: { messages, mode: 'essay' } });
}

// ─── Send handler ─────────────────────────────────────────────────────────────
async function handleSend(text: string) {
  if (!text || streaming) return;

  const currentTabId = new URLSearchParams(window.location.search).get('tab') ?? 'default';
  const isEditTab = (!!essayTabId && currentTabId === essayTabId) || (!!treeTabId && currentTabId === treeTabId);

  if (isEditTab) {
    streaming = true;
    pendingEditMode = true;
    pendingUserPaste = Promise.resolve();
    setInputEnabled(false);
    if (gdocsTextarea) gdocsTextarea.placeholder = 'Editing…';
    showLoadingOverlay('Editing your essay…');

    chatHistory.push({ role: 'user', content: text });
    void saveSessionAfterMessage();

    const essayContent = activeSession?.essayContent ?? '';
    const editMessages: GDocsMessage[] = [];
    if (essayContent) {
      editMessages.push({ role: 'user', content: `Here is the essay to edit:\n\n${essayContent}\n\nNow let's begin.` });
      editMessages.push({ role: 'assistant', content: "Got it — I've read the essay. What edits would you like me to make?" });
    }
    editMessages.push(...chatHistory);

    chrome.runtime.sendMessage({ action: 'gdocsChat', payload: { messages: editMessages, mode: 'edit' } });
    return;
  }

  // Brainstorming tab: normal chat flow
  streaming = true;
  setInputEnabled(false);
  pendingUserPaste = pasteIntoDoc(`You: ${text}\n\n`);

  chatHistory.push({ role: 'user', content: text });
  void saveSessionAfterMessage();

  const messages: GDocsMessage[] = [];
  if (docContext) {
    messages.push({ role: 'user', content: `Here is the current document text for context:\n\n${docContext}\n\nNow let's begin.` });
    messages.push({ role: 'assistant', content: "Got it — I've read the document. What would you like to think through?" });
  }
  messages.push(...chatHistory);

  chrome.runtime.sendMessage({ action: 'gdocsChat', payload: { messages, mode: 'chat' } });
}

// ─── Input bar ────────────────────────────────────────────────────────────────
function createInputBar() {
  const host = document.createElement('div');
  host.id = 'oddity-gdocs-input-host';
  host.style.cssText =
    'all: initial; position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 2147483646; width: 520px;';
  document.body.appendChild(host);
  inputBar = host;

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600&display=swap');
    *, *::before, *::after { box-sizing: border-box; }
    .wrapper {
      display: flex; flex-direction: column; gap: 8px;
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .bar {
      display: flex; align-items: center; gap: 8px;
      background: #ffffff; border-radius: 9999px; padding: 8px 8px 8px 18px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06);
      border: 0.5px solid #e8e8e2;
    }
    textarea {
      flex: 1; resize: none; border: none; outline: none;
      font-family: inherit; font-size: 13px; line-height: 1.4; color: #1a1a1a;
      background: transparent; max-height: 120px; overflow-y: auto;
      padding: 0; margin: 0; display: block;
    }
    textarea::placeholder { color: #9aa0a6; }
    textarea:disabled { opacity: 0.45; }
    .send {
      width: 34px; height: 34px; border-radius: 9999px; border: none;
      background: #111; color: #fff; cursor: pointer; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s;
    }
    .send:hover { background: #333; }
    .send:disabled { background: #e8e8e2; color: #9aa0a6; cursor: default; }
    .close {
      width: 0; height: 28px; border-radius: 9999px; border: none;
      background: none; color: #9aa0a6; font-size: 18px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      line-height: 1; padding: 0; overflow: hidden;
      opacity: 0; pointer-events: none;
      transition: width 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.15s ease;
    }
    .close:hover { color: #374151; }
    .show-close .close { width: 28px; opacity: 1; pointer-events: all; }
    .actions {
      display: flex; align-items: center; gap: 6px; padding: 0 4px;
    }
    .action-btn {
      height: 30px; padding: 0 12px; border-radius: 9999px; border: none;
      background: #f0f2f5; color: #374151; font-size: 11px; font-weight: 600;
      font-family: inherit; letter-spacing: 0.02em; cursor: pointer;
      display: flex; align-items: center; gap: 4px; flex-shrink: 0;
      transition: background 0.15s; white-space: nowrap;
    }
    .action-btn:hover { background: #e5e7eb; }
    .action-btn:disabled { opacity: 0.4; cursor: default; }
    .action-btn svg { width: 12px; height: 12px; flex-shrink: 0; }
  `;
  shadow.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.className = 'wrapper';

  // ── Input pill row ──
  const bar = document.createElement('div');
  bar.className = 'bar';

  gdocsTextarea = document.createElement('textarea');
  gdocsTextarea.placeholder = 'Ask Oddity...';
  gdocsTextarea.rows = 1;
  gdocsTextarea.addEventListener('input', () => {
    gdocsTextarea!.style.height = 'auto';
    gdocsTextarea!.style.height = `${Math.min(gdocsTextarea!.scrollHeight, 120)}px`;
  });
  gdocsTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const val = gdocsTextarea!.value.trim();
      if (val) { gdocsTextarea!.value = ''; gdocsTextarea!.style.height = 'auto'; void handleSend(val); }
    }
  });

  sendBtn = document.createElement('button');
  sendBtn.className = 'send';
  sendBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 12V4M8 4L4.5 7.5M8 4L11.5 7.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  sendBtn.title = 'Send';
  sendBtn.addEventListener('click', () => {
    const val = gdocsTextarea!.value.trim();
    if (val) { gdocsTextarea!.value = ''; gdocsTextarea!.style.height = 'auto'; void handleSend(val); }
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close Oddity';
  closeBtn.addEventListener('click', deactivate);

  bar.appendChild(gdocsTextarea);
  bar.appendChild(sendBtn);
  bar.appendChild(closeBtn);

  bar.addEventListener('mousemove', (e) => {
    const rect = bar.getBoundingClientRect();
    wrapper.classList.toggle('show-close', e.clientX - rect.left > rect.width * 0.75);
  });
  bar.addEventListener('mouseleave', () => wrapper.classList.remove('show-close'));

  // ── Actions row (below the pill) ──
  const actionsRow = document.createElement('div');
  actionsRow.className = 'actions';

  treeBtn = document.createElement('button');
  treeBtn.className = 'action-btn';
  treeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="2" r="1.5" stroke="currentColor" stroke-width="1.25"/><circle cx="2" cy="9" r="1.5" stroke="currentColor" stroke-width="1.25"/><circle cx="10" cy="9" r="1.5" stroke="currentColor" stroke-width="1.25"/><path d="M6 3.5V6M6 6L2 7.5M6 6L10 7.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>Tree`;
  treeBtn.title = 'Build argument tree';
  treeBtn.addEventListener('click', () => handleTreeRequest(treeBtn!));

  essayBtn = document.createElement('button');
  essayBtn.className = 'action-btn';
  essayBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 10h8M2 7.5h5M2 5h8M2 2.5h5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>Essay`;
  essayBtn.title = 'Draft essay from conversation';
  essayBtn.addEventListener('click', () => handleEssayRequest(essayBtn!));

  commentBtn = document.createElement('button');
  commentBtn.className = 'action-btn';
  commentBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 2H2a1 1 0 00-1 1v5a1 1 0 001 1h2l2 2 2-2h2a1 1 0 001-1V3a1 1 0 00-1-1z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>Notes`;
  commentBtn.title = 'Add depth margin notes as GDocs comments';
  commentBtn.addEventListener('click', () => void addDepthAnnotationsAsComments());

  actionsRow.appendChild(treeBtn);
  actionsRow.appendChild(essayBtn);
  actionsRow.appendChild(commentBtn);

  wrapper.appendChild(actionsRow);
  wrapper.appendChild(bar);
  shadow.appendChild(wrapper);

  setTimeout(() => gdocsTextarea?.focus(), 100);
}

// ─── Activate / deactivate ────────────────────────────────────────────────────
async function activate() {
  if (inputBar) return;

  // Signal to index.ts that GDocs has been activated so the args box overlay dismisses
  document.dispatchEvent(new CustomEvent('oddity:gdocs:activated'));

  const { docId, tabId } = parseGDocsLocation();
  activeDocId = docId;
  activeTabId = tabId;

  const existingSession = await loadSession(docId, tabId);

  docContext = scrapeDocContext();
  createInputBar();

  if (existingSession) {
    chatHistory.push(...existingSession.chatHistory);
    activeSession = existingSession;
    essayTabId = existingSession.essayTabId ?? '';
    treeTabId = existingSession.treeTabId ?? '';
    await pasteIntoDoc('Oddity 1: [Resuming — Brainstorming]\n\n');
  } else {
    const welcomeMsg = "What's the topic, idea, or problem you want to think through?";
    chatHistory.push({ role: 'assistant', content: welcomeMsg });
    activeSession = { docId, tabId, chatHistory: [...chatHistory], createdAt: Date.now() };
    await saveSession(activeSession);
    const renamePromise = renameGDocsTabWithRetry('Brainstorming', tabId);
    await pasteIntoDoc(`Oddity 1: ${welcomeMsg}\n\n`);
    await renamePromise;
  }
}

function deactivate() {
  if (inputBar) { inputBar.remove(); inputBar = null; }
  gdocsTextarea = null; sendBtn = null; treeBtn = null; essayBtn = null; commentBtn = null;
  chatHistory.splice(0);
  docContext = '';
  activeDocId = '';
  activeTabId = '';
  essayTabId = '';
  treeTabId = '';
  pendingEditMode = false;
  activeSession = null;
}

// ─── Entry point ──────────────────────────────────────────────────────────────
document.addEventListener('oddity:gdocs:activate', () => void activate());
