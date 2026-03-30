import type { AnnotationType, Verdict } from '@oddity/shared';
import { ALL_OVERVIEW_TYPES, ANNOTATION_LABELS, VERDICT_LABELS, getAnnotationColor, getVerdictColor } from '@oddity/shared';

export type ThemeMode = 'light' | 'dark';

export type AnnotationVisual = {
  type: AnnotationType;
  backgroundColor: string | null;
  underlineStyle: string | null;
  gutterIcon: string | null;
  label: string;
  color: string;
};

/**
 * Build a visual entry for an annotation type, using the correct
 * color set for the given theme.
 */
function makeVisual(
  type: AnnotationType,
  theme: ThemeMode,
  opts?: { bgOpacity?: string; underlineColor?: string },
): AnnotationVisual {
  const color = getAnnotationColor(type, theme);
  // Blue (user_written) gets 0.2 opacity (33), all others get 0.1 (1A)
  const bgOpacity = opts?.bgOpacity ?? (type === "user_written" ? "33" : "1A");
  const underlineColor = opts?.underlineColor ?? (color + "E6"); // 0.9 opacity

  const isOverview = (ALL_OVERVIEW_TYPES as readonly string[]).includes(type);

  return {
    type,
    backgroundColor: color + bgOpacity,
    underlineStyle: `1.5px solid ${underlineColor}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS[type] ?? type.toUpperCase(),
    color,
  };
}

const fallbackVisual: AnnotationVisual = {
  type: "user_written",
  backgroundColor: "#88888826",
  underlineStyle: "1.5px solid #888",
  gutterIcon: null,
  label: "ANNOTATION",
  color: "#888",
};

export function getVisual(type: AnnotationType, theme: ThemeMode = 'dark', labelOverride?: string, verdict?: Verdict): AnnotationVisual {
  if (verdict) {
    const color = getVerdictColor(verdict, theme);
    const bgOpacity = "1A";
    return {
      type,
      backgroundColor: color + bgOpacity,
      underlineStyle: `1.5px solid ${color}E6`,
      gutterIcon: null,
      label: labelOverride ?? VERDICT_LABELS[verdict],
      color,
    };
  }
  const visual = makeVisual(type, theme) ?? fallbackVisual;
  if (labelOverride) visual.label = labelOverride;
  return visual;
}
