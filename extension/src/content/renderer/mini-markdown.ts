/**
 * Lightweight markdown-to-HTML converter for LLM-generated annotation text.
 * Supports: **bold**, bullet lists (* or -), and line breaks.
 * Input is trusted (from our own LLM), so no sanitization is applied.
 */

/** Handle inline markdown: **bold** */
function inlineMd(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

export function renderMiniMarkdown(md: string): string {
  const lines = md.split("\n");
  const htmlParts: string[] = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Bullet point: "* text" or "- text"
    const bulletMatch = trimmed.match(/^[\*\-]\s+(.+)/);
    if (bulletMatch) {
      if (!inList) {
        htmlParts.push("<ul>");
        inList = true;
      }
      htmlParts.push(`<li>${inlineMd(bulletMatch[1]!)}</li>`);
      continue;
    }

    // Close list if we were in one
    if (inList) {
      htmlParts.push("</ul>");
      inList = false;
    }

    if (trimmed === "") {
      htmlParts.push("<br>");
    } else {
      htmlParts.push(`<p>${inlineMd(trimmed)}</p>`);
    }
  }

  if (inList) htmlParts.push("</ul>");
  return htmlParts.join("");
}
