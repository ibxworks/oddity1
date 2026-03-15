import type { AnnotationType } from '@oddity/shared';
import { ANNOTATION_LABELS, getAnnotationColor } from '@oddity/shared';

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

const fallbackVisual: AnnotationVisual = {
  type: "user_written",
  backgroundColor: "#88888826",
  underlineStyle: "1.5px solid #888",
  gutterIcon: null,
  label: "ANNOTATION",
  color: "#888",
};

export function getVisual(type: AnnotationType, theme: ThemeMode = 'dark'): AnnotationVisual {
  return makeVisual(type, theme) ?? fallbackVisual;
}
