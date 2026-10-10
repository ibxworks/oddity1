import { Readability } from '@mozilla/readability';
import type { Annotation, AnnotationFont, AnnotationFontSize } from '@oddity/shared';
import { ANNOTATION_LABELS } from '@oddity/shared';
import { invalidateTextNodeIndex, resolveSelector } from './selector.js';

// ─── Font maps (mirrors margin-notes.ts) ───

const FONT_MAP: Record<AnnotationFont, string> = {
  default: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  fraunces: "'Fraunces', Georgia, serif",
  kalam: "'Kalam', cursive, system-ui, sans-serif",
  helvetica: "Helvetica, 'Helvetica Neue', Arial, sans-serif",
  arial: "Arial, 'Helvetica Neue', sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
};

const SIZE_MAP: Record<AnnotationFontSize, string> = {
  small: '13px',
  default: '14px',
  large: '15px',
};

// Google Fonts query strings for fonts that need loading (400 body + 700 labels)
const GFONT_MAP: Partial<Record<AnnotationFont, { css: string; family: string }>> = {
  fraunces: { css: 'family=Fraunces:opsz,wght@9..144,400;9..144,600', family: 'Fraunces' },
  kalam: { css: 'family=Kalam:wght@400;700', family: 'Kalam' },
};

// ─── Main Export ───

export async function handleExportPdf(
  title: string,
  subtitle: string,
  annotations: Annotation[],
  regionHtml: string,
): Promise<void> {
  // Read user font preferences from storage
  const prefs = await new Promise<{ annotation_font?: AnnotationFont; annotation_font_size?: AnnotationFontSize }>(
    (resolve) => chrome.storage.local.get('preferences', (r) => resolve((r['preferences'] as any) ?? {})),
  );

  const noteFont = prefs.annotation_font ?? 'fraunces';
  const fontFamily = FONT_MAP[noteFont];
  const noteSize = SIZE_MAP[prefs.annotation_font_size ?? 'default'];
  const gfont = GFONT_MAP[noteFont];

  const rawHtml = regionHtml || extractArticleHtmlFallback();
  if (!rawHtml) throw new Error('Could not extract page content for export');

  const cleanHtml = sanitizeExportHtml(rawHtml);
  const host = document.createElement('div');
  host.innerHTML = cleanHtml;
  dedupeTitleHeading(host, title);
  const notes = annotateDocument(host, annotations);
  const fullHtml = buildExportDocument({
    title,
    subtitle,
    sourceUrl: window.location.href,
    bodyHtml: host.innerHTML,
    notes,
    fontFamily,
    noteSize,
    gfontCss: gfont?.css,
  });

  await openPrintDialog(fullHtml, gfont?.family);
}

// ─── Readability Fallback ───

function extractArticleHtmlFallback(): string | null {
  const clone = document.cloneNode(true) as Document;
  return new Readability(clone).parse()?.content ?? null;
}

// ─── HTML Sanitization ───
// Strips host-page artifacts so the exported content renders cleanly:
// removes non-content elements, nav/header/footer landmarks, back-links,
// inline styles, CSS classes, and data attributes.

const JUNK_SELECTORS = [
  'script', 'style', 'svg', 'button', 'input', 'select', 'textarea',
  'nav', 'aside', 'form', 'iframe', 'video', 'audio',
  'canvas', 'dialog', 'noscript', 'figure > figcaption > a',
  '[role="button"]', '[role="navigation"]', '[role="toolbar"]',
  '[role="menu"]', '[role="menubar"]', '[role="complementary"]',
  '[role="banner"]', '[role="contentinfo"]', '[role="search"]',
  '[aria-hidden="true"]', '[hidden]',
];

// header/footer often hold article content (bylines, dates), so they are
// only removed when provably outside the article — see sanitizeExportHtml.
const ARTICLE_WRAPPER = 'article, main, [role="main"], [role="article"]';

// Short "back to listing" links (e.g. "← Posts", "Back to blog") that live
// inside the article container on many blogs and survive tag-based filtering.
const BACK_LINK_RE = /^(?:[←→‹›«»↩]\s*)?(?:back(?:\s+to)?|posts?|all\s+posts?|blog|home|index)\s*[←→‹›«»↩]?$/i;

export function sanitizeExportHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;

  // Remove non-content elements
  for (const sel of JUNK_SELECTORS) {
    for (const el of body.querySelectorAll(sel)) el.remove();
  }

  // Remove header/footer only when provably outside article content. When
  // the fragment has no article wrapper (typical for region HTML, which is
  // already article content), keep them: they usually hold the byline/date.
  if (body.querySelector(ARTICLE_WRAPPER)) {
    for (const el of body.querySelectorAll('header, footer')) {
      if (!el.closest(ARTICLE_WRAPPER)) el.remove();
    }
  }

  // Remove back-links and empty anchors left behind (but keep image links,
  // whose textContent is empty even though they carry content)
  for (const a of body.querySelectorAll('a')) {
    if (a.querySelector('img')) continue;
    const text = (a.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (!text || (text.length <= 40 && BACK_LINK_RE.test(text))) {
      a.remove();
    }
  }

  // Strip attributes — keep only content-essential ones
  const keep = new Set(['src', 'href', 'alt', 'title', 'colspan', 'rowspan', 'datetime', 'lang']);
  const walkAttrs = (el: Element) => {
    for (const attr of Array.from(el.attributes)) {
      if (!keep.has(attr.name)) el.removeAttribute(attr.name);
    }
    for (const child of el.children) walkAttrs(child);
  };
  walkAttrs(body);

  // Drop emptied wrappers (single pass, deepest first via reverse order)
  const divs = Array.from(body.querySelectorAll('div,section,span'));
  for (let i = divs.length - 1; i >= 0; i--) {
    const el = divs[i]!;
    if (!el.isConnected) continue;
    const text = (el.textContent ?? '').trim();
    if (text === '' && el.querySelectorAll('img').length === 0) el.remove();
  }

  // Ensure images have absolute URLs
  for (const img of body.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (src && !src.startsWith('http') && !src.startsWith('data:')) {
      try { img.setAttribute('src', new URL(src, window.location.href).href); } catch { /* skip */ }
    }
  }

  return body.innerHTML;
}

// ─── Title Dedupe ───
// The page's own H1 usually repeats the export title shown in the header.
// Remove the first heading when it matches the title (modulo site suffixes
// like "Title | Site" from document.title).

function normalizeTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripSiteSuffix(title: string): string {
  const parts = title.split(/\s*[|—–·]\s*/);
  return parts[0] ?? title;
}

export function dedupeTitleHeading(host: Element, title: string): void {
  const heading = host.querySelector('h1, h2');
  if (!heading) return;
  const headingText = normalizeTitle(heading.textContent ?? '');
  if (!headingText) return;
  // Exact match only (after site-suffix stripping on either side) — prefix
  // matching deletes distinct headings that merely start with the title.
  const titleCandidates = new Set(
    [title, stripSiteSuffix(title)].map(normalizeTitle).filter(Boolean),
  );
  const headingCandidates = [headingText, normalizeTitle(stripSiteSuffix(headingText))];
  if (headingCandidates.some((h) => titleCandidates.has(h))) {
    heading.remove();
  }
}

// ─── Annotate: Highlight Anchors + Numbered Notes ───
// Uses the shared resolveSelector (normalized whitespace, multi-node spans,
// prefix/suffix disambiguation, fuzzy fallbacks) against a detached host so
// matching behaves exactly like the live overlay. Numbers are assigned in
// DOM order after all anchors are wrapped.

export type ExportNote = {
  number: number | null; // null = anchor not found; shown with its quote, unnumbered
  annotation: Annotation;
  /** Actual page text that was highlighted (falls back to anchor exact). */
  quote: string;
};

function rangeOverlapsMark(range: Range, host: Element): boolean {
  // Anchors are wrapped longest-first, so any overlap means this range
  // starts or ends inside an existing mark. (Deliberately avoids
  // compareBoundaryPoints, whose operand order varies across engines.)
  const startEl =
    range.startContainer.nodeType === Node.TEXT_NODE
      ? (range.startContainer as Text).parentElement
      : (range.startContainer as Element);
  const endEl =
    range.endContainer.nodeType === Node.TEXT_NODE
      ? (range.endContainer as Text).parentElement
      : (range.endContainer as Element);
  if (startEl?.closest('mark[data-note-id]')) return true;
  if (endEl?.closest('mark[data-note-id]')) return true;
  // Rare spanning case: the range fully contains an existing mark.
  const ancestor = range.commonAncestorContainer;
  if (ancestor.nodeType === Node.ELEMENT_NODE && host.contains(ancestor)) {
    const pos = (node: Node, offset: number) => {
      const r = document.createRange();
      r.setStart(node, offset);
      r.collapse(true);
      return r;
    };
    try {
      const startPt = pos(range.startContainer, range.startOffset);
      const endPt = pos(range.endContainer, range.endOffset);
      for (const mark of (ancestor as Element).querySelectorAll('mark[data-note-id]')) {
        const first = mark.firstChild;
        if (!first) continue;
        if (
          startPt.comparePoint(first, 0) <= 0 &&
          endPt.comparePoint(first, first.textContent?.length ?? 0) >= 0
        ) {
          return true;
        }
      }
    } catch {
      /* fall through */
    }
  }
  return false;
}

export function annotateDocument(host: Element, annotations: Annotation[]): ExportNote[] {
  // Longest first so nested anchors resolve to the longest span.
  const sorted = [...annotations].sort(
    (a, b) => b.anchor.exact.length - a.anchor.exact.length,
  );
  const matchedIds = new Set<string>();
  const quotes = new Map<string, string>();

  for (const ann of sorted) {
    if (!ann.anchor.exact) continue;
    try {
      invalidateTextNodeIndex(host);
      const range = resolveSelector(host, ann.anchor);
      if (!range) continue;
      if (rangeOverlapsMark(range, host)) continue; // overlapped by a longer anchor
      quotes.set(ann.id, range.toString());
      const mark = document.createElement('mark');
      mark.setAttribute('data-note-id', ann.id);
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
      matchedIds.add(ann.id);
    } catch {
      continue;
    }
  }
  invalidateTextNodeIndex(host);

  // Assign numbers in DOM order and attach superscript references.
  const byId = new Map(annotations.map((a) => [a.id, a]));
  const notes: ExportNote[] = [];
  const marks = host.querySelectorAll('mark[data-note-id]');
  marks.forEach((mark, i) => {
    const ann = byId.get(mark.getAttribute('data-note-id') ?? '');
    if (!ann) return;
    const number = i + 1;
    const sup = document.createElement('a');
    sup.className = 'fnref';
    sup.href = `#note-${number}`;
    sup.id = `ref-${number}`;
    sup.textContent = String(number);
    mark.after(sup);
    notes.push({ number, annotation: ann, quote: quotes.get(ann.id) ?? ann.anchor.exact });
  });

  // Anchors that could not be placed still appear, with their quote, after
  // the numbered notes so no annotation is silently dropped.
  for (const ann of annotations) {
    if (!matchedIds.has(ann.id)) {
      notes.push({ number: null, annotation: ann, quote: ann.anchor.exact });
    }
  }

  return notes;
}

// ─── Note Rendering ───

export function titleCaseLabel(annotation: Annotation): string {
  if (annotation.label) return annotation.label;
  const raw = (ANNOTATION_LABELS[annotation.type] ?? annotation.type).replace(/_/g, ' ').toLowerCase();
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escape-safe mini markdown: **bold**, "-"/"*" bullets, paragraph breaks.
// Runs on escaped text so LLM output can never inject markup.
export function renderNoteHtml(md: string): string {
  const lines = escapeHtml(md).split('\n');
  const parts: string[] = [];
  let inList = false;
  const inline = (t: string) => t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  for (const line of lines) {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[\*\-]\s+(.+)/);
    if (bullet) {
      if (!inList) { parts.push('<ul>'); inList = true; }
      parts.push(`<li>${inline(bullet[1]!)}</li>`);
      continue;
    }
    if (inList) { parts.push('</ul>'); inList = false; }
    if (trimmed === '') continue;
    parts.push(`<p>${inline(trimmed)}</p>`);
  }
  if (inList) parts.push('</ul>');
  return parts.join('');
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function buildNoteItem(note: ExportNote): string {
  const { annotation: ann } = note;
  const label = titleCaseLabel(ann);
  const quote = note.quote ? truncate(note.quote, 160) : '';

  let extra = '';
  if (ann.content.why_it_matters) {
    extra += `<div class="note-extra"><span class="note-extra-label">Why it matters — </span>${renderNoteHtml(ann.content.why_it_matters).replace(/^<p>|<\/p>$/g, '')}</div>`;
  }
  if (ann.content.question) {
    extra += `<div class="note-extra"><span class="note-extra-label">Question — </span>${renderNoteHtml(ann.content.question).replace(/^<p>|<\/p>$/g, '')}</div>`;
  }
  const suggestions = ann.content.suggestions ?? [];
  if (suggestions.length > 0) {
    extra += `<div class="note-extra"><span class="note-extra-label">Suggestions — </span>${suggestions.map((s) => escapeHtml(s)).join('; ')}</div>`;
  }

  const num = note.number;
  const idAttr = num !== null ? ` id="note-${num}"` : '';
  const numHtml = num !== null
    ? `<a class="note-num" href="#ref-${num}">${num}</a>`
    : `<span class="note-num note-num-unlinked" title="Anchor not found on page">·</span>`;

  return `<li class="note"${idAttr}>${numHtml}<div class="note-main">`
    + `<div class="note-label">${escapeHtml(label)}</div>`
    + (quote ? `<div class="note-quote">&ldquo;${escapeHtml(quote)}&rdquo;</div>` : '')
    + (ann.content.note ? `<div class="note-body">${renderNoteHtml(ann.content.note)}</div>` : '')
    + extra
    + `</div></li>`;
}

// ─── Build Full HTML Document ───

export type ExportDocumentOptions = {
  title: string;
  subtitle: string;
  sourceUrl: string;
  bodyHtml: string;
  notes: ExportNote[];
  fontFamily: string;
  noteSize: string;
  gfontCss: string | undefined;
};

export function buildExportDocument(opts: ExportDocumentOptions): string {
  const { title, subtitle, sourceUrl, bodyHtml, notes, fontFamily, noteSize, gfontCss } = opts;
  const dateStr = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  let domain = '';
  try { domain = new URL(sourceUrl).hostname.replace(/^www\./, ''); } catch { /* skip */ }

  const gfontUrl = gfontCss
    ? `https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400&${gfontCss}&display=swap`
    : `https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400&display=swap`;

  const numbered = notes.filter((n) => n.number !== null).length;
  const notesHtml = notes.length > 0
    ? `<section class="notes"><h2>Notes</h2><ol>${notes.map(buildNoteItem).join('')}</ol></section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — Oddity Export</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${gfontUrl}">
<style>
/* ── Reset ── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

/* ── Page: portrait-friendly, margins only (never force size/orientation) ── */
@page{
  margin:20mm 17mm 22mm 17mm;
}
@page{
  @bottom-center{
    content:counter(page);
    font-family:'Lora',Georgia,serif;
    font-size:9pt;
    color:#a8a094;
  }
}
:root{
  --ink:#1c1917;
  --ink-soft:#4a4440;
  --muted:#6f675e;
  --faint:#a8a094;
  --hairline:#e3ddd3;
  --accent:#9a3412;
  --mark-bg:#f6efdc;
  --mark-line:#c9a227;
}
body{
  background:#fff;
  font-family:'Lora',Georgia,'Times New Roman',serif;
  color:var(--ink);
  padding:48px 20px 64px;
  -webkit-font-smoothing:antialiased;
}
.wrapper{max-width:680px;margin:0 auto}

/* ── Header ── */
.hdr{margin-bottom:28px}
.hdr h1{
  font-size:30px;font-weight:600;line-height:1.2;letter-spacing:-.2px;
  text-wrap:balance;
}
.hdr .sub{font-size:15px;font-style:italic;color:var(--muted);margin-top:8px}
.hdr .meta{font-size:12.5px;color:var(--muted);margin-top:10px}
.hdr .rule{border:none;border-top:1px solid var(--hairline);margin-top:20px}

/* ── Article ── */
.content{font-size:16px;line-height:1.7}
.content p{margin-bottom:1em;widows:3;orphans:3}
.content h1,.content h2,.content h3,.content h4{
  line-height:1.3;margin:1.6em 0 .6em;letter-spacing:-.1px;
  break-after:avoid;
}
.content h1{font-size:24px;font-weight:600}
.content h2{font-size:20px;font-weight:600}
.content h3{font-size:17px;font-weight:600}
.content h4{font-size:16px;font-weight:600}
.content blockquote{
  margin:1.2em 0;padding-left:18px;
  border-left:2px solid var(--hairline);
  font-style:italic;color:var(--ink-soft);
}
.content ul,.content ol{margin:1em 0;padding-left:26px}
.content li{margin-bottom:.3em;widows:3;orphans:3}
.content pre{
  background:#f6f4f0;padding:14px 16px;border-radius:6px;
  font-size:13px;line-height:1.55;margin:1.2em 0;
  white-space:pre-wrap;word-break:break-word;
  font-family:ui-monospace,'SF Mono',Menlo,monospace;
}
.content code{
  background:#f6f4f0;padding:1px 5px;border-radius:3px;font-size:.85em;
  font-family:ui-monospace,'SF Mono',Menlo,monospace;
}
.content pre code{background:none;padding:0}
.content a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--faint);text-underline-offset:3px}
.content img{max-width:100%;height:auto;border-radius:4px;margin:8px 0}
.content figure{margin:1.4em 0}
.content figcaption{font-size:13px;color:var(--muted);text-align:center;margin-top:6px}
.content table{width:100%;border-collapse:collapse;margin:1.2em 0;font-size:14px}
.content th,.content td{border:1px solid var(--hairline);padding:6px 10px;text-align:left}
.content th{background:#faf9f6;font-weight:600}
.content hr{border:none;border-top:1px solid var(--hairline);margin:1.8em 0}

/* ── Annotation references: warm highlight + superscript numeral ── */
.content mark{
  background:var(--mark-bg);
  border-bottom:1px solid var(--mark-line);
  padding-bottom:1px;border-radius:2px;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}
.fnref{
  font-family:${fontFamily};
  font-size:10.5px;font-weight:700;color:var(--accent);
  text-decoration:none;vertical-align:super;line-height:0;
  margin-left:2px;letter-spacing:.2px;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}

/* ── Notes ── */
.notes{margin-top:40px;padding-top:6px;border-top:1px solid var(--hairline)}
.notes h2{font-size:20px;font-weight:600;margin:18px 0 4px;break-after:avoid}
.notes ol{list-style:none;padding:0}
.note{
  display:flex;gap:14px;
  padding:14px 0;
  border-top:1px solid var(--hairline);
  font-family:${fontFamily};
  font-size:${noteSize};
  line-height:1.55;
  color:var(--ink-soft);
  break-inside:avoid;
}
.notes ol > li:first-child{border-top:none}
.note-num{
  flex:0 0 22px;text-align:right;
  font-family:'Lora',Georgia,serif;
  font-size:14px;font-weight:600;color:var(--accent);
  text-decoration:none;line-height:1.5;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}
.note-num-unlinked{color:var(--faint)}
.note-main{min-width:0;flex:1}
.note-label{font-size:12.5px;font-weight:700;color:var(--ink);margin-bottom:2px}
.note-quote{font-style:italic;color:var(--muted);margin-bottom:4px}
.note-body p{margin:0 0 .5em}
.note-body p:last-child{margin-bottom:0}
.note-body ul{margin:.4em 0;padding-left:20px}
.note-body li{margin-bottom:.2em}
.note-extra{margin:.5em 0 0;font-size:.93em}
.note-extra p{margin:.3em 0}
.note-extra ul{margin:.3em 0;padding-left:20px}
.note-extra-label{color:var(--muted)}

/* ── Footer ── */
.ftr{
  text-align:center;margin-top:36px;padding-top:16px;
  border-top:1px solid var(--hairline);
  font-size:11.5px;color:var(--faint);
}

@media print{
  body{padding:0}
  .hdr h1{font-size:26px}
  a{color:inherit}
}
</style>
</head>
<body>
<div class="wrapper">
  <header class="hdr">
    <h1>${escapeHtml(title)}</h1>
    ${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ''}
    <div class="meta">${numbered} note${numbered !== 1 ? 's' : ''} &middot; ${escapeHtml(dateStr)}${domain ? ` &middot; ${escapeHtml(domain)}` : ''}</div>
    <hr class="rule">
  </header>
  <article class="content">
    ${bodyHtml}
  </article>
  ${notesHtml}
  <footer class="ftr">Exported with Oddity</footer>
</div>
</body>
</html>`;
}

// ─── Print Dialog ───
// Hidden iframe sized near portrait printable width. The frame stays hidden:
// Chrome lays out and prints the full document regardless of visibility.

async function openPrintDialog(htmlContent: string, noteFontFamily?: string): Promise<void> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    'position:fixed;left:-9999px;top:0;width:800px;height:600px;border:none;visibility:hidden';
  document.body.appendChild(iframe);

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      const w = iframe.contentWindow;
      w?.removeEventListener('afterprint', cleanup);
      setTimeout(() => iframe.remove(), 1000);
    };

    iframe.addEventListener('load', async () => {
      const iDoc = iframe.contentDocument;
      const iWin = iframe.contentWindow;
      if (!iDoc || !iWin) {
        iframe.remove();
        reject(new Error('Cannot access print frame'));
        return;
      }

      try {
        await waitForExportFonts(iDoc, noteFontFamily);

        // Resolve before the blocking print() so the popup message channel
        // doesn't time out while the user interacts with the print dialog.
        resolve();

        iWin.addEventListener('afterprint', cleanup);
        setTimeout(cleanup, 30000); // fallback if afterprint never fires
        iWin.print();
      } catch (err) {
        iframe.remove();
        reject(err as Error);
      }
    });

    iframe.srcdoc = htmlContent;
  });
}

// Wait for the export stylesheet + each used face, with a timeout fallback
// so offline or slow fonts never block the dialog.
async function waitForExportFonts(iDoc: Document, noteFontFamily?: string): Promise<void> {
  const timeout = new Promise<void>((r) => setTimeout(r, 2500));
  const load = (async () => {
    try {
      const link = iDoc.querySelector<HTMLLinkElement>('link[rel="stylesheet"]');
      if (link) {
        await new Promise<void>((resolve) => {
          if (link.sheet) { resolve(); return; }
          link.addEventListener('load', () => resolve(), { once: true });
          link.addEventListener('error', () => resolve(), { once: true });
        });
      }
      const faces: [string, string][] = [['Lora', '400'], ['Lora', '600']];
      if (noteFontFamily) faces.push([noteFontFamily, '400'], [noteFontFamily, '700']);
      if (iDoc.fonts?.load) {
        await Promise.all(
          faces.map(([fam, weight]) =>
            iDoc.fonts.load(`${weight} 16px "${fam}"`).catch(() => []),
          ),
        );
      }
    } catch {
      /* fall back to system fonts */
    }
  })();
  await Promise.race([load, timeout]);
}
