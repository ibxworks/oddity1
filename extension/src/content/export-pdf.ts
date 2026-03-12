import { Readability } from '@mozilla/readability';
import type { Annotation, AnnotationFont, AnnotationFontSize, AnnotationType } from '@oddity/shared';
import { ANNOTATION_LABELS } from '@oddity/shared';
import { getVisual } from './renderer/styles';

// ─── Inline highlight styles per annotation type (derived from frontend visual map) ───

function buildMarkStyle(type: AnnotationType): string {
  const v = getVisual(type);
  const parts: string[] = [];
  if (v.backgroundColor) parts.push(`background:${v.backgroundColor};border-radius:2px`);
  if (v.underlineStyle) parts.push(`border-bottom:${v.underlineStyle};padding-bottom:1px`);
  return parts.join(';');
}

const ALL_TYPES: AnnotationType[] = [
  'highlight', 'recall', 'provoking_question', 'insight', 'caveat', 'vocabulary', 'user_written',
];

const MARK_STYLES = Object.fromEntries(
  ALL_TYPES.map((t) => [t, buildMarkStyle(t)]),
) as Record<AnnotationType, string>;

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
  small: '12px',
  default: '14px',
  large: '16px',
};

// Google Fonts query strings for fonts that need loading
const GFONT_MAP: Partial<Record<AnnotationFont, string>> = {
  fraunces: 'family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,500',
  kalam: 'family=Kalam:wght@400',
};

// Label colors — matches frontend light mode overrides (PDF is always light)
const LABEL_COLORS: Record<AnnotationType, string> = {
  highlight: '#EAB308',
  recall: '#243C61',
  provoking_question: '#F5574C',
  insight: '#70AC87',
  caveat: '#F5574C',
  vocabulary: '#243C61',
  user_written: '#A1927B',
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

  const fontFamily = FONT_MAP[prefs.annotation_font ?? 'default'];
  const noteSize = SIZE_MAP[prefs.annotation_font_size ?? 'default'];
  const gfontQuery = GFONT_MAP[prefs.annotation_font ?? 'default'];

  const rawHtml = regionHtml || extractArticleHtmlFallback();
  if (!rawHtml) throw new Error('Could not extract page content for export');

  const cleanHtml = sanitizeHtml(rawHtml);
  const { bodyHtml, unmatchedAnnotations } = highlightAndAnnotate(cleanHtml, annotations);
  const fullHtml = buildDocument(
    title, subtitle, bodyHtml, annotations.length, unmatchedAnnotations,
    fontFamily, noteSize, gfontQuery,
  );

  await openPrintDialog(fullHtml);
}

// ─── Readability Fallback ───

function extractArticleHtmlFallback(): string | null {
  const clone = document.cloneNode(true) as Document;
  return new Readability(clone).parse()?.content ?? null;
}

// ─── HTML Sanitization ───
// Strips host-page artifacts so the exported content renders cleanly:
// removes non-content elements, inline styles, CSS classes, and data attributes.

function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;

  // Remove non-content elements
  const junk = [
    'script', 'style', 'svg', 'button', 'input', 'select', 'textarea',
    'nav', 'form', 'iframe', 'video', 'audio', 'canvas', 'dialog', 'noscript',
    '[role="button"]', '[role="navigation"]', '[role="toolbar"]',
    '[role="menu"]', '[role="menubar"]', '[role="complementary"]',
    '[aria-hidden="true"]', '[hidden]',
  ];
  for (const sel of junk) {
    for (const el of body.querySelectorAll(sel)) el.remove();
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

  // Ensure images have absolute URLs
  for (const img of body.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (src && !src.startsWith('http') && !src.startsWith('data:')) {
      try { img.setAttribute('src', new URL(src, window.location.href).href); } catch { /* skip */ }
    }
  }

  return body.innerHTML;
}

// ─── Highlight Text + Inject Sidenotes ───

function highlightAndAnnotate(
  html: string,
  annotations: Annotation[],
): { bodyHtml: string; unmatchedAnnotations: Annotation[] } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;

  const byId = new Map(annotations.map((a) => [a.id, a]));
  const matchedIds = new Set<string>();

  // Phase 1: Mark anchor text (longest first to avoid sub-match conflicts)
  const sorted = [...annotations].sort(
    (a, b) => b.anchor.exact.length - a.anchor.exact.length,
  );
  for (const ann of sorted) {
    if (ann.anchor.exact) {
      const found = markTextInNode(body, ann.anchor.exact, ann.type, ann.id);
      if (found) matchedIds.add(ann.id);
    }
  }

  // Phase 2: Walk marks in DOM order, inject Tufte-style float sidenotes
  const marks = body.querySelectorAll<HTMLElement>('mark[data-ann-id]');
  let counter = 0;
  for (const mark of marks) {
    const ann = byId.get(mark.dataset.annId ?? '');
    if (!ann) continue;

    const side = counter % 2 === 0 ? 'right' : 'left';
    const span = doc.createElement('span');
    span.className = `sn sn-${side} note-${ann.type}`;
    span.innerHTML = buildSidenoteInner(ann);
    // Insert sidenote right after its <mark> anchor — the float pushes it
    // into the margin while keeping it in normal document flow.
    mark.after(span);
    counter++;
  }

  const unmatched = annotations.filter((a) => !matchedIds.has(a.id));
  return { bodyHtml: body.innerHTML, unmatchedAnnotations: unmatched };
}

// ─── Recursive Text Marker ───

function markTextInNode(
  root: Node, searchText: string, type: AnnotationType, annId: string,
): boolean {
  if (root.nodeType === Node.TEXT_NODE) {
    const text = root.textContent ?? '';
    const idx = text.indexOf(searchText);
    if (idx === -1) return false;

    const parent = root.parentNode;
    if (!parent) return false;

    const ownerDoc = root.ownerDocument!;
    const frag = ownerDoc.createDocumentFragment();
    if (idx > 0) frag.appendChild(ownerDoc.createTextNode(text.slice(0, idx)));

    const mark = ownerDoc.createElement('mark');
    mark.setAttribute('style', MARK_STYLES[type]);
    mark.setAttribute('data-ann-type', type);
    mark.setAttribute('data-ann-id', annId);
    mark.textContent = text.slice(idx, idx + searchText.length);
    frag.appendChild(mark);

    const tail = text.slice(idx + searchText.length);
    if (tail) frag.appendChild(ownerDoc.createTextNode(tail));

    parent.replaceChild(frag, root);
    return true;
  }

  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName === 'MARK') continue;
    if (markTextInNode(child, searchText, type, annId)) return true;
  }

  return false;
}

// ─── Sidenote Inner HTML ───

function buildSidenoteInner(ann: Annotation): string {
  const label = ANNOTATION_LABELS[ann.type] ?? ann.type.toUpperCase();
  const note = ann.content.note ? esc(ann.content.note) : '';

  let sections = '';
  if (ann.content.why_it_matters) {
    sections += `<div class="sn-section"><span class="sn-section-label">Why it matters</span><p>${esc(ann.content.why_it_matters)}</p></div>`;
  }
  if (ann.content.question) {
    sections += `<div class="sn-section"><span class="sn-section-label">Question</span><p>${esc(ann.content.question)}</p></div>`;
  }
  const suggestions = ann.content.suggestions ?? [];
  if (suggestions.length > 0) {
    sections += `<div class="sn-section"><p>${suggestions.map((s) => esc(s)).join('; ')}</p></div>`;
  }

  return `<span class="sn-label">${esc(label)}</span><span class="sn-body">${note}</span>${sections}`;
}

// ─── Per-Type Label Color CSS ───

function typeCSS(): string {
  return ALL_TYPES.map((t) => `.note-${t} .sn-label{color:${LABEL_COLORS[t]}}`).join('\n');
}

// ─── Build Full HTML Document ───

function buildDocument(
  title: string,
  subtitle: string,
  bodyHtml: string,
  totalAnnotations: number,
  unmatchedAnnotations: Annotation[],
  fontFamily: string,
  noteSize: string,
  gfontQuery: string | undefined,
): string {
  const dateStr = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  // Build Google Fonts URL — always load Lora for body; add user's note font if needed
  const gfontUrl = gfontQuery
    ? `https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;0,700;1,400&${gfontQuery}&display=swap`
    : `https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;0,700;1,400&display=swap`;

  // Annotations that couldn't be matched to text — show at the bottom
  let unmatchedSection = '';
  if (unmatchedAnnotations.length > 0) {
    const items = unmatchedAnnotations.map((ann) => {
      const label = ANNOTATION_LABELS[ann.type] ?? ann.type.toUpperCase();
      const note = ann.content.note ? esc(ann.content.note) : '';
      return `<li class="extra-note note-${ann.type}">
  <span class="sn-label">${esc(label)}</span>
  <span class="extra-anchor">&ldquo;${esc(ann.anchor.exact)}&rdquo;</span>
  ${note ? `<span class="sn-body">${note}</span>` : ''}
</li>`;
    }).join('');
    unmatchedSection = `<div class="extra-section">
  <h3>Additional Annotations</h3>
  <ul>${items}</ul>
</div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(title)} — Oddity Export</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${gfontUrl}">
<style>
/* ── Reset ── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

/* ── Page ── */
@page{size:A4 portrait;margin:14mm 10mm 16mm 10mm}
@page{@top-center{content:none}@bottom-center{content:none}}
body{
  background:#faf8f5;
  font-family:'Lora',Georgia,'Times New Roman',serif;
  color:#1a1a1a;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
  padding:32px 16px;
}
@media print{body{background:#fff;padding:0}}
.wrapper{max-width:750px;margin:0 auto}
@media print{.wrapper{max-width:none}}

/* ── Header ── */
.hdr{text-align:center;padding-bottom:16px;margin-bottom:20px;border-bottom:1px solid #e0d8cc}
.hdr h1{font-size:22px;font-weight:700;letter-spacing:-.3px;margin-bottom:4px}
.hdr .sub{font-size:12px;text-transform:uppercase;letter-spacing:2px;color:#8a7d6b}
.hdr .meta{font-size:11px;color:#b0a090;margin-top:6px}

/* ── Content area with sidenote gutters ── */
.content{position:relative;padding:0 150px}
@media print{.content{padding:0 142px}}

/* Subtle vertical column dividers (screen only) */
.content::before,.content::after{
  content:'';position:absolute;top:0;bottom:0;width:1px;
  background:#d8d0c4;opacity:.3;pointer-events:none;
}
.content::before{left:150px}
.content::after{right:150px}
@media print{
  .content::before{left:142px}
  .content::after{right:142px}
}

/* ── Sidenote cards — matches frontend light mode card design ── */
.sn{
  display:block;
  width:130px;
  margin-bottom:10px;
  padding:10px 12px;
  border-radius:12px;
  background:#FFFFFF;
  box-shadow:-4px 2px 10px rgba(0,0,0,0.10),-1px 1px 3px rgba(0,0,0,0.06);
  break-inside:avoid;
  font-family:${fontFamily};
  font-size:${noteSize};
  line-height:1.45;
  color:#293038;
}
.sn-right{float:right;clear:right;margin-right:-144px}
.sn-left{float:left;clear:left;margin-left:-144px}
@media print{
  .sn-right{margin-right:-136px}
  .sn-left{margin-left:-136px}
}

/* Label — matches .note-label */
.sn-label{
  display:block;
  font-size:${noteSize};
  font-weight:900;
  letter-spacing:normal;
  text-transform:lowercase;
  margin-bottom:4px;
  color:#FFFFFF;
}
.sn-label::first-letter{text-transform:uppercase}

/* Body text — matches .note-text */
.sn-body{
  display:block;
  font-weight:300;
  color:#293038;
}

/* Section extras — matches .note-section */
.sn-section{
  margin-top:6px;
  padding-top:6px;
  border-top:1px solid rgba(41,48,56,0.1);
}
.sn-section-label{
  display:block;
  font-size:9px;
  font-weight:500;
  letter-spacing:0.1em;
  text-transform:uppercase;
  color:rgba(41,48,56,0.45);
  margin-bottom:2px;
}
.sn-section p{
  margin:0;
  font-size:${noteSize};
  color:#293038;
}

/* Per-type label colors */
${typeCSS()}

/* ── Main text typography ── */
.content p{font-size:14px;line-height:1.8;margin-bottom:13px;text-align:justify;hyphens:auto}
.content h1,.content h2,.content h3,.content h4{
  font-family:'Lora',Georgia,serif;margin:18px 0 10px;clear:both;
}
.content h1{font-size:19px;font-weight:700}
.content h2{font-size:16.5px;font-weight:600}
.content h3{font-size:14.5px;font-weight:600}
.content h4{font-size:13.5px;font-weight:600}
.content blockquote{
  border-left:3px solid #d0c8b8;padding-left:14px;margin:13px 0;
  font-style:italic;color:#5a5040;clear:both;
}
.content ul,.content ol{margin:10px 0;padding-left:22px}
.content li{font-size:14px;line-height:1.8;margin-bottom:3px}
.content pre{
  background:#f0ece4;padding:10px 12px;border-radius:4px;
  font-size:11.5px;line-height:1.5;margin:10px 0;
  white-space:pre-wrap;word-break:break-word;overflow-x:hidden;clear:both;
}
.content code{background:#f0ece4;padding:1px 4px;border-radius:2px;font-size:12px}
.content pre code{background:none;padding:0}
.content a{color:#6b5a3a;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
.content img{max-width:100%;height:auto;border-radius:2px;margin:6px 0}
.content figure{margin:12px 0;clear:both}
.content figcaption{font-size:11.5px;color:#8a7d6b;text-align:center;margin-top:3px}
.content table{width:100%;border-collapse:collapse;margin:10px 0;font-size:12.5px;clear:both}
.content th,.content td{border:1px solid #ddd8cc;padding:4px 7px;text-align:left}
.content th{background:#f5f0e8;font-weight:600}
.content hr{border:none;border-top:1px solid #ddd8cc;margin:16px 0;clear:both}

/* Neutralize host-page div/span wrappers that survived sanitization */
.content div:not(.extra-section){max-width:100%;overflow-wrap:break-word}
.content *{max-width:100%}

/* ── Unmatched annotations section ── */
.extra-section{
  clear:both;margin-top:24px;padding-top:14px;border-top:1px solid #e0d8cc;
}
.extra-section h3{font-size:14px;font-weight:600;margin-bottom:10px}
.extra-section ul{list-style:none;padding:0}
.extra-note{
  padding:10px 12px;border-radius:12px;margin-bottom:8px;break-inside:avoid;
  background:#FFFFFF;color:#293038;
  box-shadow:-4px 2px 10px rgba(0,0,0,0.10),-1px 1px 3px rgba(0,0,0,0.06);
  font-family:${fontFamily};font-size:${noteSize};
}
.extra-anchor{display:block;font-style:italic;font-size:12px;color:rgba(255,255,255,0.45);margin:2px 0}

/* ── Footer ── */
.ftr{
  clear:both;text-align:center;margin-top:24px;padding-top:14px;
  border-top:1px solid #e0d8cc;
  font-size:10px;color:#b0a090;letter-spacing:.5px;
}

/* ── Print overrides ── */
@media print{
  .hdr{break-after:avoid}
  .content p,.content li,.content blockquote{break-inside:avoid}
  .sn{break-inside:avoid}
  .extra-note{break-inside:avoid}
  .ftr{break-before:avoid}
}
</style>
</head>
<body>
<div class="wrapper">
  <div class="hdr">
    <h1>${esc(title)}</h1>
    ${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}
    <div class="meta">${totalAnnotations} annotation${totalAnnotations !== 1 ? 's' : ''} &middot; ${esc(dateStr)}</div>
  </div>
  <div class="content">
    ${bodyHtml}
  </div>
  ${unmatchedSection}
  <div class="ftr">Exported with Oddity</div>
</div>
</body>
</html>`;
}

// ─── Print Dialog ───

async function openPrintDialog(htmlContent: string): Promise<void> {
  const iframe = document.createElement('iframe');
  iframe.style.cssText =
    'position:fixed;left:-9999px;top:0;width:210mm;height:297mm;border:none;visibility:hidden';
  document.body.appendChild(iframe);

  return new Promise<void>((resolve, reject) => {
    iframe.addEventListener('load', async () => {
      const iDoc = iframe.contentDocument;
      const iWin = iframe.contentWindow;
      if (!iDoc || !iWin) {
        iframe.remove();
        reject(new Error('Cannot access print frame'));
        return;
      }

      try {
        if (iDoc.fonts?.ready) await iDoc.fonts.ready;
        await new Promise((r) => setTimeout(r, 500));

        // Resolve before the blocking print() so the popup message channel
        // doesn't time out while the user interacts with the print dialog.
        resolve();

        requestAnimationFrame(() => {
          iframe.style.visibility = 'visible';
          iWin.print();
          setTimeout(() => iframe.remove(), 3000);
        });
      } catch (err) {
        iframe.remove();
        reject(err as Error);
      }
    });

    iframe.srcdoc = htmlContent;
  });
}

// ─── Helpers ───

function esc(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
