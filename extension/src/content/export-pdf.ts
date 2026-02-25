import { Readability } from '@mozilla/readability';
import type { Annotation, AnnotationType } from '@oddity/shared';
import { ANNOTATION_COLORS, ANNOTATION_LABELS } from '@oddity/shared';
import html2pdf from 'html2pdf.js';

// ─── Types ───

interface PositionedNote {
  annotation: Annotation;
  side: 'left' | 'right';
  topPercent: number;
}

// ─── Inline highlight styles per type ───

const INLINE_STYLES: Record<AnnotationType, string> = {
  highlight: `background: ${ANNOTATION_COLORS.highlight}33; border-radius: 2px; padding: 1px 2px;`,
  underline: `border-bottom: 2px solid ${ANNOTATION_COLORS.underline}; padding-bottom: 1px;`,
  question: `border-bottom: 2px dotted ${ANNOTATION_COLORS.question}; padding-bottom: 1px;`,
  insight: `background: ${ANNOTATION_COLORS.insight}33; border-radius: 2px; padding: 1px 2px;`,
  caveat: `border-bottom: 2px wavy ${ANNOTATION_COLORS.caveat}; padding-bottom: 1px;`,
  vocabulary: `border-bottom: 2px dotted ${ANNOTATION_COLORS.vocabulary}; padding-bottom: 1px;`,
};

// ─── Main Export Function ───

export async function handleExportPdf(
  title: string,
  subtitle: string,
  annotations: Annotation[],
): Promise<void> {
  // 1. Extract article HTML via Readability
  const articleHtml = extractArticleHtml();
  if (!articleHtml) {
    throw new Error('Could not extract article content');
  }

  // 2. Build the annotated HTML
  const { html: mainHtml, textContent } = highlightAnnotations(articleHtml, annotations);

  // 3. Position margin notes
  const notes = positionNotes(annotations, textContent);

  // 4. Build the full document
  const fullHtml = buildDocument(title, subtitle, mainHtml, notes);

  // 5. Render to PDF
  await renderPdf(fullHtml, title);
}

// ─── Extract Article HTML ───

function extractArticleHtml(): string | null {
  const clone = document.cloneNode(true) as Document;
  const reader = new Readability(clone);
  const result = reader.parse();
  return result?.content ?? null;
}

// ─── Highlight Annotations in HTML ───

function highlightAnnotations(
  html: string,
  annotations: Annotation[],
): { html: string; textContent: string } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;

  // Sort annotations by length descending to avoid nested match issues
  const sorted = [...annotations].sort(
    (a, b) => b.anchor.exact.length - a.anchor.exact.length,
  );

  for (const ann of sorted) {
    const exact = ann.anchor.exact;
    if (!exact) continue;
    markTextInNode(body, exact, ann.type);
  }

  return {
    html: body.innerHTML,
    textContent: body.textContent ?? '',
  };
}

function markTextInNode(root: Node, searchText: string, type: AnnotationType): boolean {
  if (root.nodeType === Node.TEXT_NODE) {
    const text = root.textContent ?? '';
    const index = text.indexOf(searchText);
    if (index === -1) return false;

    const before = text.substring(0, index);
    const match = text.substring(index, index + searchText.length);
    const after = text.substring(index + searchText.length);

    const parent = root.parentNode;
    if (!parent) return false;

    const frag = root.ownerDocument!.createDocumentFragment();
    if (before) frag.appendChild(root.ownerDocument!.createTextNode(before));

    const mark = root.ownerDocument!.createElement('mark');
    mark.setAttribute('style', INLINE_STYLES[type]);
    mark.setAttribute('data-ann-type', type);
    mark.textContent = match;
    frag.appendChild(mark);

    if (after) frag.appendChild(root.ownerDocument!.createTextNode(after));

    parent.replaceChild(frag, root);
    return true;
  }

  // Recurse into child nodes (skip already-marked nodes)
  const children = Array.from(root.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName === 'MARK') continue;
    if (markTextInNode(child, searchText, type)) return true;
  }

  return false;
}

// ─── Position Margin Notes ───

function positionNotes(annotations: Annotation[], fullText: string): PositionedNote[] {
  const totalLen = fullText.length || 1;
  const notes: PositionedNote[] = [];

  for (let i = 0; i < annotations.length; i++) {
    const ann = annotations[i]!;
    const exactPos = fullText.indexOf(ann.anchor.exact);
    const topPercent = exactPos >= 0 ? (exactPos / totalLen) * 100 : (i / annotations.length) * 100;

    notes.push({
      annotation: ann,
      side: i % 2 === 0 ? 'left' : 'right',
      topPercent,
    });
  }

  // Ensure minimum gap between notes on same side
  const leftNotes = notes.filter((n) => n.side === 'left');
  const rightNotes = notes.filter((n) => n.side === 'right');
  resolveOverlaps(leftNotes);
  resolveOverlaps(rightNotes);

  return notes;
}

function resolveOverlaps(notes: PositionedNote[]): void {
  notes.sort((a, b) => a.topPercent - b.topPercent);
  const minGap = 1.5; // percent
  for (let i = 1; i < notes.length; i++) {
    const prev = notes[i - 1]!;
    const curr = notes[i]!;
    if (curr.topPercent - prev.topPercent < minGap) {
      curr.topPercent = prev.topPercent + minGap;
    }
  }
}

// ─── Build Full HTML Document ───

function buildDocument(
  title: string,
  subtitle: string,
  mainHtml: string,
  notes: PositionedNote[],
): string {
  const leftNotes = notes.filter((n) => n.side === 'left');
  const rightNotes = notes.filter((n) => n.side === 'right');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@400;600;700&family=Lora:ital,wght@0,400;0,600;1,400&family=Lora:wght@700&display=swap');

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: #f5f0e8;
  font-family: 'Lora', Georgia, serif;
  padding: 40px 20px;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.page-wrapper {
  max-width: 1100px;
  margin: 0 auto;
}

.doc-header {
  text-align: center;
  margin-bottom: 36px;
  padding-bottom: 20px;
  border-bottom: 1px solid #d4c4a8;
}

.doc-title {
  font-family: 'Lora', serif;
  font-weight: 700;
  font-size: 22px;
  color: #2a2018;
  margin-bottom: 6px;
  letter-spacing: -0.3px;
}

.doc-subtitle {
  font-family: 'Lora', serif;
  font-size: 12px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: #8b7355;
}

.layout {
  display: grid;
  grid-template-columns: 220px 1fr 220px;
  gap: 0;
  position: relative;
}

.layout::before,
.layout::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: linear-gradient(to bottom, transparent, #c8b89a 10%, #c8b89a 90%, transparent);
  opacity: 0.4;
}
.layout::before { left: 220px; }
.layout::after { right: 220px; }

.margin-left, .margin-right {
  position: relative;
  padding-top: 4px;
}

.margin-left { padding-right: 24px; padding-left: 8px; }
.margin-right { padding-left: 24px; padding-right: 8px; }

.main-text {
  padding: 0 36px;
}

.main-text p {
  font-size: 14.5px;
  line-height: 1.85;
  color: #2a2018;
  margin-bottom: 16px;
  text-align: justify;
  hyphens: auto;
}

.main-text h1, .main-text h2, .main-text h3, .main-text h4 {
  font-family: 'Lora', serif;
  color: #2a2018;
  margin-top: 24px;
  margin-bottom: 12px;
}
.main-text h1 { font-size: 20px; }
.main-text h2 { font-size: 17px; }
.main-text h3 { font-size: 15px; }

.main-text img { max-width: 100%; height: auto; }
.main-text figure { margin: 16px 0; }
.main-text figcaption { font-size: 12px; color: #8b7355; text-align: center; margin-top: 4px; }

.main-text blockquote {
  border-left: 3px solid #c8b89a;
  padding-left: 16px;
  margin: 16px 0;
  font-style: italic;
  color: #5a4a38;
}

.main-text ul, .main-text ol {
  margin: 12px 0;
  padding-left: 24px;
}

.main-text li {
  font-size: 14.5px;
  line-height: 1.85;
  color: #2a2018;
  margin-bottom: 4px;
}

.main-text pre {
  background: #ece6da;
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 12px;
  margin: 12px 0;
}

.main-text code {
  background: #ece6da;
  padding: 1px 4px;
  border-radius: 2px;
  font-size: 13px;
}

.main-text a { color: #6b5a3a; }

/* Annotation margin notes */
.ann-note {
  position: relative;
  margin-bottom: 8px;
}

.ann-bubble {
  font-family: 'Caveat', cursive;
  font-size: 14.5px;
  line-height: 1.4;
  color: #2a1a08;
  padding: 8px 10px;
  border-radius: 4px;
}

.ann-tag {
  font-family: 'Caveat', cursive;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin-bottom: 3px;
  display: block;
  opacity: 0.7;
}

.ann-suggestions {
  margin-top: 4px;
  padding-left: 14px;
  font-family: 'Caveat', cursive;
  font-size: 13px;
  color: #3a2a18;
}

.ann-suggestions li {
  margin-bottom: 2px;
  line-height: 1.3;
}

${generateAnnotationColorCSS()}

.footer-note {
  text-align: center;
  margin-top: 36px;
  padding-top: 20px;
  border-top: 1px solid #d4c4a8;
  font-family: 'Lora', serif;
  font-size: 11px;
  color: #b09070;
  letter-spacing: 1px;
}
</style>
</head>
<body>
<div class="page-wrapper">
  <div class="doc-header">
    <div class="doc-title">${escapeHtml(title)}</div>
    <div class="doc-subtitle">${escapeHtml(subtitle)}</div>
  </div>

  <div class="layout">
    <div class="margin-left">
      ${renderMarginNotes(leftNotes)}
    </div>
    <div class="main-text">
      ${mainHtml}
    </div>
    <div class="margin-right">
      ${renderMarginNotes(rightNotes)}
    </div>
  </div>

  <div class="footer-note">
    Exported with Oddity 1
  </div>
</div>
</body>
</html>`;
}

function generateAnnotationColorCSS(): string {
  const types: AnnotationType[] = ['highlight', 'underline', 'question', 'insight', 'caveat', 'vocabulary'];
  return types
    .map((type) => {
      const color = ANNOTATION_COLORS[type];
      return `
.ann-${type} .ann-bubble {
  background: ${color}18;
  border-left: 3px solid ${color};
}
.ann-${type} .ann-tag { color: ${color}; }`;
    })
    .join('\n');
}

function renderMarginNotes(notes: PositionedNote[]): string {
  return notes
    .map((note) => {
      const ann = note.annotation;
      const label = ANNOTATION_LABELS[ann.type] ?? ann.type.toUpperCase();
      const noteText = ann.content.note ? escapeHtml(ann.content.note) : '';
      const suggestions = ann.content.suggestions ?? [];

      let suggestionsHtml = '';
      if (suggestions.length > 0) {
        suggestionsHtml = `<ul class="ann-suggestions">${suggestions.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`;
      }

      return `<div class="ann-note ann-${ann.type}" style="margin-top: ${Math.max(0, note.topPercent)}%;">
  <span class="ann-tag">${escapeHtml(label)}</span>
  <div class="ann-bubble">
    ${noteText}${suggestionsHtml}
  </div>
</div>`;
    })
    .join('\n');
}

// ─── PDF Rendering ───

async function renderPdf(htmlContent: string, title: string): Promise<void> {
  const container = document.createElement('div');
  container.style.cssText = 'position: fixed; left: -9999px; top: 0; width: 1100px; z-index: -1;';
  document.body.appendChild(container);

  // Create iframe to isolate styles
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width: 1100px; height: 100%; border: none;';
  container.appendChild(iframe);

  // Wait for iframe to load
  await new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
    iframe.srcdoc = htmlContent;
  });

  // Wait a bit for fonts to load
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const iframeBody = iframe.contentDocument?.body;
  if (!iframeBody) {
    container.remove();
    throw new Error('Failed to render PDF content');
  }

  const safeName = title.replace(/[^a-zA-Z0-9 -]/g, '').substring(0, 50).trim() || 'document';

  try {
    await html2pdf()
      .set({
        margin: [10, 10, 10, 10],
        filename: `${safeName}-oddity.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: {
          scale: 2,
          width: 1100,
          useCORS: true,
          logging: false,
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      })
      .from(iframeBody)
      .save();
  } finally {
    container.remove();
  }
}

// ─── Helpers ───

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
