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
  // Red — critical/challenging
  provocation: {
    type: 'provocation',
    backgroundColor: ANNOTATION_COLORS.provocation + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.provocation}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.provocation,
    color: ANNOTATION_COLORS.provocation,
  },
  caveat: {
    type: 'caveat',
    backgroundColor: ANNOTATION_COLORS.caveat + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.caveat}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.caveat,
    color: ANNOTATION_COLORS.caveat,
  },
  'hedge-check': {
    type: 'hedge-check',
    backgroundColor: ANNOTATION_COLORS['hedge-check'] + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS['hedge-check']}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS['hedge-check'],
    color: ANNOTATION_COLORS['hedge-check'],
  },
  perspective: {
    type: 'perspective',
    backgroundColor: ANNOTATION_COLORS.perspective + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.perspective}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.perspective,
    color: ANNOTATION_COLORS.perspective,
  },
  alternative: {
    type: 'alternative',
    backgroundColor: ANNOTATION_COLORS.alternative + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.alternative}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.alternative,
    color: ANNOTATION_COLORS.alternative,
  },
  specificity: {
    type: 'specificity',
    backgroundColor: ANNOTATION_COLORS.specificity + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.specificity}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.specificity,
    color: ANNOTATION_COLORS.specificity,
  },
  // Green — enriching
  insight: {
    type: 'insight',
    backgroundColor: ANNOTATION_COLORS.insight + '4d',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.insight}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.insight,
    color: ANNOTATION_COLORS.insight,
  },
  free: {
    type: 'free',
    backgroundColor: ANNOTATION_COLORS.free + '4d',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.free}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.free,
    color: ANNOTATION_COLORS.free,
  },
  // Blue — navigating/orienting
  structural: {
    type: 'structural',
    backgroundColor: ANNOTATION_COLORS.structural + '99',
    underlineStyle: `1.5px solid #5B8AC5`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.structural,
    color: ANNOTATION_COLORS.structural,
  },
  recall: {
    type: 'recall',
    backgroundColor: ANNOTATION_COLORS.recall + '99',
    underlineStyle: `1.5px solid #5B8AC5`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.recall,
    color: ANNOTATION_COLORS.recall,
  },
  labeling: {
    type: 'labeling',
    backgroundColor: ANNOTATION_COLORS.labeling + '99',
    underlineStyle: `1.5px solid #5B8AC5`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.labeling,
    color: ANNOTATION_COLORS.labeling,
  },
  goal: {
    type: 'goal',
    backgroundColor: ANNOTATION_COLORS.goal + '99',
    underlineStyle: `1.5px solid #5B8AC5`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.goal,
    color: ANNOTATION_COLORS.goal,
  },
  givens: {
    type: 'givens',
    backgroundColor: ANNOTATION_COLORS.givens + '99',
    underlineStyle: `1.5px solid #5B8AC5`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.givens,
    color: ANNOTATION_COLORS.givens,
  },
  // Yellow — clarifying
  vocab: {
    type: 'vocab',
    backgroundColor: ANNOTATION_COLORS.vocab + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.vocab}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.vocab,
    color: ANNOTATION_COLORS.vocab,
  },
  translation: {
    type: 'translation',
    backgroundColor: ANNOTATION_COLORS.translation + '26',
    underlineStyle: `1.5px solid ${ANNOTATION_COLORS.translation}`,
    gutterIcon: null,
    label: ANNOTATION_LABELS.translation,
    color: ANNOTATION_COLORS.translation,
  },
};

export function getVisual(type: AnnotationType): AnnotationVisual {
  return visualMap[type];
}
