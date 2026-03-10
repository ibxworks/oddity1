import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ANNOTATION_COLORS } from '../utils/annotationConstants';

export const annotationPluginKey = new PluginKey('annotations');

// CSS class + inline style for each annotation type
const TYPE_STYLES = {
  highlight: { bg: `${ANNOTATION_COLORS.highlight}30` },
  recall: { border: `2px solid ${ANNOTATION_COLORS.recall}` },
  provoking_question: { border: `2px dotted ${ANNOTATION_COLORS.provoking_question}` },
  insight: { bg: `${ANNOTATION_COLORS.insight}28` },
  caveat: { border: `2px dashed ${ANNOTATION_COLORS.caveat}` },
  vocabulary: { border: `2px dotted ${ANNOTATION_COLORS.vocabulary}` },
};

function buildDecorations(doc, annotations) {
  if (!annotations || annotations.length === 0) return DecorationSet.empty;

  // Extract all text from the ProseMirror doc with position mapping
  const textParts = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      textParts.push({ text: node.text, pos });
    }
  });

  const fullText = textParts.map((p) => p.text).join('');

  // Build position map: index in fullText → ProseMirror position
  const posMap = [];
  let offset = 0;
  for (const part of textParts) {
    for (let i = 0; i < part.text.length; i++) {
      posMap.push(part.pos + i);
    }
    offset += part.text.length;
  }

  const decorations = [];

  // Sort longest first to avoid sub-match issues
  const sorted = [...annotations].sort(
    (a, b) => b.anchor.exact.length - a.anchor.exact.length,
  );

  const usedRanges = [];

  for (const ann of sorted) {
    const searchText = ann.anchor.exact;
    if (!searchText) continue;

    const idx = fullText.indexOf(searchText);
    if (idx === -1) continue;

    const from = posMap[idx];
    const to = posMap[idx + searchText.length - 1] + 1;

    // Skip if overlapping with existing decoration
    const overlaps = usedRanges.some(
      (r) => from < r.to && to > r.from,
    );
    if (overlaps) continue;

    usedRanges.push({ from, to });

    const style = TYPE_STYLES[ann.type] || {};
    const cssProps = [];
    if (style.bg) cssProps.push(`background:${style.bg}`);
    if (style.border) cssProps.push(`border-bottom:${style.border}`, 'padding-bottom:1px');
    cssProps.push('border-radius:2px', 'padding:0 2px');

    decorations.push(
      Decoration.inline(from, to, {
        style: cssProps.join(';'),
        'data-annotation-id': ann.id,
        'data-annotation-type': ann.type,
        class: `annotation-highlight annotation-${ann.type}`,
      }),
    );
  }

  return DecorationSet.create(doc, decorations);
}

export function createAnnotationPlugin() {
  return new Plugin({
    key: annotationPluginKey,

    state: {
      init() {
        return { decorations: DecorationSet.empty, annotations: [] };
      },
      apply(tr, prev) {
        const meta = tr.getMeta(annotationPluginKey);
        if (meta?.annotations !== undefined) {
          return {
            annotations: meta.annotations,
            decorations: buildDecorations(tr.doc, meta.annotations),
          };
        }
        // Remap decorations through document changes
        if (tr.docChanged) {
          return {
            annotations: prev.annotations,
            decorations: prev.decorations.map(tr.mapping, tr.doc),
          };
        }
        return prev;
      },
    },

    props: {
      decorations(state) {
        return annotationPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
}
