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
    backgroundColor: ANNOTATION_COLORS.highlight + '33', // 20% opacity
    underlineStyle: null,
    gutterIcon: null,
    label: ANNOTATION_LABELS.highlight,
    color: ANNOTATION_COLORS.highlight,
  },
  recall: {
    type: 'recall',
    backgroundColor: null,
    underlineStyle: `2px solid ${ANNOTATION_COLORS.recall}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.recall,
    color: ANNOTATION_COLORS.recall,
  },
  provoking_question: {
    type: 'provoking_question',
    backgroundColor: null,
    underlineStyle: `2px dotted ${ANNOTATION_COLORS.provoking_question}`,
    gutterIcon: '?',
    label: ANNOTATION_LABELS.provoking_question,
    color: ANNOTATION_COLORS.provoking_question,
  },
  insight: {
    type: 'insight',
    backgroundColor: ANNOTATION_COLORS.insight + '33', // 20% opacity
    underlineStyle: null,
    gutterIcon: null,
    label: ANNOTATION_LABELS.insight,
    color: ANNOTATION_COLORS.insight,
  },
  caveat: {
    type: 'caveat',
    backgroundColor: null,
    underlineStyle: `2px dashed ${ANNOTATION_COLORS.caveat}`,
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
