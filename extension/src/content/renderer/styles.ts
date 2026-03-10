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
    backgroundColor: ANNOTATION_COLORS.recall + '99',
    underlineStyle: `1.5px solid #5B8AC5`,
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
    backgroundColor: '#2D7A4F' + '4d',
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
    backgroundColor: ANNOTATION_COLORS.vocabulary + '99',
    underlineStyle: `1.5px solid #5B8AC5`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.vocabulary,
    color: ANNOTATION_COLORS.vocabulary,
  },
  user_written: {
    type: 'user_written',
    backgroundColor: ANNOTATION_COLORS.user_written + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.user_written}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.user_written,
    color: ANNOTATION_COLORS.user_written,
  },
};

export function getVisual(type: AnnotationType): AnnotationVisual {
  return visualMap[type];
}
