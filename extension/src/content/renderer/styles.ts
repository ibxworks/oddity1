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

const visualMap: Record<AnnotationType, AnnotationVisual> = {
  highlight: {
    type: 'highlight',
    backgroundColor: ANNOTATION_COLORS.highlight + '66', // 40% opacity
    underlineStyle: null,
    gutterIcon: null,
    label: ANNOTATION_LABELS.highlight,
    color: ANNOTATION_COLORS.highlight,
  },
  underline: {
    type: 'underline',
    backgroundColor: null,
    underlineStyle: `2px solid ${ANNOTATION_COLORS.underline}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.underline,
    color: ANNOTATION_COLORS.underline,
  },
  question: {
    type: 'question',
    backgroundColor: null,
    underlineStyle: `2px dotted ${ANNOTATION_COLORS.question}`,
    gutterIcon: '?',
    label: ANNOTATION_LABELS.question,
    color: ANNOTATION_COLORS.question,
  },
  insight: {
    type: 'insight',
    backgroundColor: ANNOTATION_COLORS.insight + '66',
    underlineStyle: null,
    gutterIcon: null,
    label: ANNOTATION_LABELS.insight,
    color: ANNOTATION_COLORS.insight,
  },
  caveat: {
    type: 'caveat',
    backgroundColor: null,
    underlineStyle: `2px wavy ${ANNOTATION_COLORS.caveat}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.caveat,
    color: ANNOTATION_COLORS.caveat,
  },
  vocabulary: {
    type: 'vocabulary',
    backgroundColor: null,
    underlineStyle: `2px dotted ${ANNOTATION_COLORS.vocabulary}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.vocabulary,
    color: ANNOTATION_COLORS.vocabulary,
  },
};

export function getVisual(type: AnnotationType): AnnotationVisual {
  return visualMap[type];
}
