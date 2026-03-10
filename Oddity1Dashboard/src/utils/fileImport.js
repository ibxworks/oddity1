/**
 * Import a .txt or .md file, returning HTML content and a title.
 */
export function importFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      const title = file.name.replace(/\.(txt|md)$/i, '');
      const ext = file.name.split('.').pop()?.toLowerCase();

      const content = ext === 'md' ? mdToHtml(text) : txtToHtml(text);
      resolve({ content, title });
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function txtToHtml(text) {
  return text
    .split(/\n\n+/)
    .filter(Boolean)
    .map((p) => `<p>${esc(p.trim())}</p>`)
    .join('');
}

function mdToHtml(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (line.trim() === '') { i++; continue; }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      out.push(`<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`);
      i++; continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const bqLines = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        bqLines.push(lines[i].slice(2));
        i++;
      }
      out.push(`<blockquote><p>${inlineFormat(bqLines.join(' '))}</p></blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map((item) => `<li>${inlineFormat(item)}</li>`).join('') + '</ul>');
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      out.push('<ol>' + items.map((item) => `<li>${inlineFormat(item)}</li>`).join('') + '</ol>');
      continue;
    }

    // Paragraph
    const pLines = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^#{1,3}\s/.test(lines[i]) && !/^[-*]\s/.test(lines[i]) && !/^\d+\.\s/.test(lines[i]) && !lines[i].startsWith('> ')) {
      pLines.push(lines[i]);
      i++;
    }
    if (pLines.length) {
      out.push(`<p>${inlineFormat(pLines.join(' '))}</p>`);
    }
  }

  return out.join('');
}

function inlineFormat(text) {
  let s = esc(text);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/`(.+?)`/g, '<code>$1</code>');
  return s;
}
