import type { Annotation } from '@oddity/shared';
import { ANNOTATION_LABELS } from '@oddity/shared';

/**
 * Generate a Markdown string from annotations grouped by position.
 */
export function exportAsMarkdown(
  annotations: Annotation[],
  pageTitle: string,
  pageUrl: string,
): string {
  const lines: string[] = [
    `# ${pageTitle}`,
    '',
    `> Source: ${pageUrl}`,
    `> Exported: ${new Date().toLocaleString()}`,
    '',
    '---',
    '',
  ];

  if (annotations.length === 0) {
    lines.push('_No annotations on this page._');
    return lines.join('\n');
  }

  for (const ann of annotations) {
    const label = ANNOTATION_LABELS[ann.type] ?? ann.type.toUpperCase();
    lines.push(`### [${label}]`);
    lines.push('');
    lines.push(`> ${ann.anchor.exact}`);
    lines.push('');
    if (ann.content.note) {
      lines.push(ann.content.note);
      lines.push('');
    }
    if (ann.content.why_it_matters) {
      lines.push(`**Why it matters:** ${ann.content.why_it_matters}`);
      lines.push('');
    }
    if (ann.content.question) {
      lines.push(`**Question:** ${ann.content.question}`);
      lines.push('');
    }
    if (ann.content.suggestions && ann.content.suggestions.length > 0) {
      lines.push('**Suggestions:**');
      for (const s of ann.content.suggestions) {
        lines.push(`- ${s}`);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Trigger a file download with the given content as a .md file.
 */
export function downloadMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
