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
    backgroundColor: ANNOTATION_COLORS.highlight + '26', // 15% opacity
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.highlight}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.highlight,
    color: ANNOTATION_COLORS.highlight,
  },
  recall: {
    type: 'recall',
    backgroundColor: ANNOTATION_COLORS.recall + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.recall}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.recall,
    color: ANNOTATION_COLORS.recall,
  },
  provoking_question: {
    type: 'provoking_question',
    backgroundColor: ANNOTATION_COLORS.provoking_question + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.provoking_question}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.provoking_question,
    color: ANNOTATION_COLORS.provoking_question,
  },
  insight: {
    type: 'insight',
    backgroundColor: ANNOTATION_COLORS.insight + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.insight}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.insight,
    color: ANNOTATION_COLORS.insight,
  },
  caveat: {
    type: 'caveat',
    backgroundColor: ANNOTATION_COLORS.caveat + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.caveat}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.caveat,
    color: ANNOTATION_COLORS.caveat,
  },
  vocabulary: {
    type: 'vocabulary',
    backgroundColor: ANNOTATION_COLORS.vocabulary + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.vocabulary}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.vocabulary,
    color: ANNOTATION_COLORS.vocabulary,
  },
};

export function getVisual(type: AnnotationType): AnnotationVisual {
  return visualMap[type];
}
