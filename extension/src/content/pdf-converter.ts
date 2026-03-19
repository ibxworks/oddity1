import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import PdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// The ?url import gives a relative asset path, but content scripts run in
// the page's origin, so we must resolve it through the extension's URL.
GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(PdfWorkerUrl);

interface TextBlock {
  text: string;
  y: number;
  fontSize: number;
}

/**
 * Convert a PDF URL to a readable HTML document string.
 * Fetches the PDF as binary data, extracts text via pdf.js,
 * and structures it into paragraphs based on vertical position gaps.
 */
export async function convertPdfToHtml(url: string): Promise<string> {
  // Fetch the PDF binary data via the background script.
  // Content scripts can't fetch file:// URLs, but the background can.
  const response = await chrome.runtime.sendMessage({ action: "fetchPdfData", payload: { url } });
  if (response?.error) throw new Error(response.error);
  const data = new Uint8Array(response.data);

  const pdf = await getDocument({ data }).promise;
  const numPages = pdf.numPages;

  // Extract filename for title
  let filename = "Document";
  try {
    const pathname = new URL(url).pathname;
    filename = decodeURIComponent(pathname.split("/").pop() ?? "Document").replace(/\.pdf$/i, "");
  } catch { /* keep default */ }

  const pages: string[] = [];
  let hasAnyText = false;

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    // Collect text items with position info
    const blocks: TextBlock[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const transform = (item as { transform: number[] }).transform;
      const y = transform[5];
      const fontSize = transform[0];
      blocks.push({ text: item.str, y, fontSize });
    }

    if (blocks.length === 0) continue;
    hasAnyText = true;

    // Group into paragraphs based on y-position gaps
    const paragraphs: string[] = [];
    let currentParagraph = blocks[0].text;
    let lastY = blocks[0].y;
    let lastFontSize = blocks[0].fontSize;

    for (let j = 1; j < blocks.length; j++) {
      const block = blocks[j];
      const yGap = Math.abs(block.y - lastY);
      const lineHeight = lastFontSize * 1.5;

      if (yGap > lineHeight) {
        // Significant vertical gap — new paragraph
        paragraphs.push(currentParagraph.trim());
        currentParagraph = block.text;
      } else {
        // Same line or small gap — append
        currentParagraph += " " + block.text;
      }

      lastY = block.y;
      lastFontSize = block.fontSize;
    }
    if (currentParagraph.trim()) {
      paragraphs.push(currentParagraph.trim());
    }

    const pageHtml = paragraphs
      .map((p) => `    <p>${escapeHtml(p)}</p>`)
      .join("\n");

    pages.push(`  <section class="page" data-page="${i}">
    <div class="page-number">Page ${i}</div>
${pageHtml}
  </section>`);
  }

  if (!hasAnyText) {
    pages.push(`  <section class="page">
    <p class="no-text">This PDF contains no extractable text (it may be a scanned document or image-based PDF).</p>
  </section>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="oddity-source-pdf" content="${escapeAttr(url)}">
  <title>${escapeHtml(filename)}</title>
  <style>
    body {
      max-width: 720px;
      margin: 2rem auto;
      padding: 0 1.5rem;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 18px;
      line-height: 1.7;
      color: #1a1a1a;
      background: #fff;
    }
    h1 {
      font-size: 1.8rem;
      margin-bottom: 0.5rem;
      border-bottom: 1px solid #ddd;
      padding-bottom: 0.5rem;
    }
    .source-link {
      font-size: 0.85rem;
      color: #666;
      margin-bottom: 2rem;
      display: block;
    }
    .source-link a { color: #4a6fa5; }
    .page {
      margin-bottom: 2rem;
    }
    .page-number {
      font-size: 0.75rem;
      color: #999;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
      border-top: 1px solid #eee;
      padding-top: 1rem;
    }
    .page:first-child .page-number {
      border-top: none;
      padding-top: 0;
    }
    p {
      margin: 0 0 1em 0;
    }
    .no-text {
      color: #888;
      font-style: italic;
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(filename)}</h1>
  <span class="source-link">Converted from <a href="${escapeAttr(url)}">${escapeHtml(url)}</a></span>
${pages.join("\n")}
</body>
</html>`;
}


function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
