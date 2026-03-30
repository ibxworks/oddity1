import { useEffect, useState } from 'react';
import { ANNOTATION_COLORS, ANNOTATION_LABELS, VERDICT_COLORS, VERDICT_LABELS } from '../utils/annotationConstants';
import './MarginNotes.css';

export default function MarginNotes({ annotations, editorRef }) {
  const [positions, setPositions] = useState([]);
  const [hoveredId, setHoveredId] = useState(null);

  useEffect(() => {
    if (!annotations?.length || !editorRef?.current) return;

    function computePositions() {
      const wrapper = editorRef.current;
      if (!wrapper) return;
      const wrapperRect = wrapper.getBoundingClientRect();

      const notes = [];
      for (const ann of annotations) {
        const el = document.querySelector(`[data-annotation-id="${ann.id}"]`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        notes.push({
          id: ann.id,
          top: rect.top - wrapperRect.top,
          annotation: ann,
        });
      }

      // Prevent overlap: push notes down if too close
      notes.sort((a, b) => a.top - b.top);
      const MIN_GAP = 60;
      for (let i = 1; i < notes.length; i++) {
        if (notes[i].top < notes[i - 1].top + MIN_GAP) {
          notes[i].top = notes[i - 1].top + MIN_GAP;
        }
      }

      setPositions(notes);
    }

    const rafId = requestAnimationFrame(computePositions);

    // Throttled recompute on scroll/resize
    let ticking = false;
    function onUpdate() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        computePositions();
        ticking = false;
      });
    }

    window.addEventListener('scroll', onUpdate, true);
    window.addEventListener('resize', onUpdate);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', onUpdate, true);
      window.removeEventListener('resize', onUpdate);
    };
  }, [annotations, editorRef]);

  return (
    <div className="margin-notes">
      {positions.map((pos, i) => {
        const ann = pos.annotation;
        const side = i % 2 === 0 ? 'right' : 'left';
        const color = ann.verdict ? (VERDICT_COLORS[ann.verdict] || '#666') : (ANNOTATION_COLORS[ann.type] || '#666');
        const label = ann.verdict ? (VERDICT_LABELS[ann.verdict] || ann.type) : (ANNOTATION_LABELS[ann.type] || ann.type);
        const isHovered = hoveredId === ann.id;

        return (
          <div
            key={ann.id}
            className={`margin-note margin-note--${side}`}
            style={{
              top: pos.top,
              borderLeftColor: color,
              background: `${color}10`,
            }}
            onMouseEnter={() => setHoveredId(ann.id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            <span className="margin-note__label" style={{ color }}>{label}</span>
            <span className="margin-note__body">{ann.content.note}</span>
            {isHovered && ann.content.why_it_matters && (
              <span className="margin-note__extra">
                <strong>Why it matters</strong> {ann.content.why_it_matters}
              </span>
            )}
            {isHovered && ann.content.question && (
              <span className="margin-note__extra">
                <strong>Question</strong> {ann.content.question}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
