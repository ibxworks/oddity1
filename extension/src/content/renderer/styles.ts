import type { AnnotationType } from '@oddity/shared';
import { ANNOTATION_COLORS, ANNOTATION_LABELS } from '@oddity/shared';

export type AnnotationVisual = {
  type: AnnotationType;
  backgroundColor: string | null;
  underlineStyle: string | null;
  gutterIcon: string | null;
  label: string;
  color: string;
};

/**
 * Helper to build a consistent visual entry for any annotation type.
 * Uses the unified ANNOTATION_COLORS/LABELS constants.
 */
function makeVisual(
  type: AnnotationType,
  opts?: { bgOpacity?: string; underlineColor?: string },
): AnnotationVisual {
  const color = ANNOTATION_COLORS[type] ?? "#888";
  const bgOpacity = opts?.bgOpacity ?? "26"; // 15% default
  const underlineColor = opts?.underlineColor ?? color;

  return {
    type,
    backgroundColor: color + bgOpacity,
    underlineStyle: `1.5px solid ${underlineColor}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS[type] ?? type.toUpperCase(),
    color,
  };
}

const visualMap: Partial<Record<AnnotationType, AnnotationVisual>> = {
  // ── Overview labels ──
  core_claim: makeVisual("core_claim"),
  evidence: makeVisual("evidence"),
  outcome: makeVisual("outcome"),
  background: makeVisual("background"),
  transition: makeVisual("transition"),

  // ── Depth types (critical) ──
  caveat: makeVisual("caveat"),
  counterargument: makeVisual("counterargument"),
  alternative: makeVisual("alternative"),
  fallacy: makeVisual("fallacy"),
  criteria: makeVisual("criteria"),
  perspective: makeVisual("perspective"),

  // ── Depth types (enrichment) ──
  insight: makeVisual("insight", { bgOpacity: "4d" }),
  recall: makeVisual("recall", { bgOpacity: "99", underlineColor: "#5B8AC5" }),
  study: makeVisual("study"),
  translation: makeVisual("translation"),
  vocabulary: makeVisual("vocabulary", { bgOpacity: "99", underlineColor: "#5B8AC5" }),

  // ── User-written ──
  user_written: makeVisual("user_written"),
};

const fallbackVisual: AnnotationVisual = {
  type: "user_written",
  backgroundColor: "#88888826",
  underlineStyle: "1.5px solid #888",
  gutterIcon: null,
  label: "ANNOTATION",
  color: "#888",
};

export function getVisual(type: AnnotationType): AnnotationVisual {
  return visualMap[type] ?? fallbackVisual;
}
