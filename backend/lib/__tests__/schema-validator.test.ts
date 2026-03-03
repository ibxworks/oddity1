import { describe, it, expect } from 'vitest';
import { validateAnnotations } from '../schema-validator.js';

describe('validateAnnotations', () => {
  const validAnnotation = {
    id: 'ann_1',
    type: 'highlight',
    anchor: { type: 'TextQuoteSelector', exact: 'test text' },
    content: { note: 'This is a note' },
  };

  const validWithOptionals = {
    id: 'ann_2',
    type: 'provoking_question',
    anchor: {
      type: 'TextQuoteSelector',
      exact: 'neural networks',
      prefix: 'understanding ',
      suffix: ' is key',
    },
    content: {
      note: 'What does this mean?',
      why_it_matters: 'Critical concept',
      question: 'Can you elaborate?',
    },
  };

  it('accepts a valid annotation array', () => {
    const result = validateAnnotations([validAnnotation, validWithOptionals]);
    expect(result.valid).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects invalid annotation type', () => {
    const invalid = { ...validAnnotation, type: 'unknown_type' };
    const result = validateAnnotations([invalid]);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Annotation[0]');
  });

  it('returns valid subset on mixed input', () => {
    const invalid = { ...validAnnotation, type: 'bad' };
    const result = validateAnnotations([validAnnotation, invalid, validWithOptionals]);
    expect(result.valid).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
  });

  it('accepts empty array', () => {
    const result = validateAnnotations([]);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects annotation without anchor', () => {
    const noAnchor = { id: 'x', type: 'highlight', content: { note: 'hi' } };
    const result = validateAnnotations([noAnchor]);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it('rejects annotation without content', () => {
    const noContent = {
      id: 'x',
      type: 'highlight',
      anchor: { type: 'TextQuoteSelector', exact: 'text' },
    };
    const result = validateAnnotations([noContent]);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it('rejects non-array input', () => {
    const result = validateAnnotations('not an array');
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain('Expected an array');
  });

  it('accepts annotation with only required fields', () => {
    const result = validateAnnotations([validAnnotation]);
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts all valid annotation types', () => {
    const types = ['highlight', 'recall', 'provoking_question', 'insight', 'caveat', 'vocabulary'];
    const annotations = types.map((type, i) => ({
      id: `ann_${i}`,
      type,
      anchor: { type: 'TextQuoteSelector', exact: `text ${i}` },
      content: { note: `Note ${i}` },
    }));
    const result = validateAnnotations(annotations);
    expect(result.valid).toHaveLength(6);
    expect(result.errors).toHaveLength(0);
  });

  it('normalizes "provoking question" (with space) to "provoking_question"', () => {
    const annotation = {
      id: 'ann_space',
      type: 'provoking question',
      anchor: { type: 'TextQuoteSelector', exact: 'some claim' },
      content: { note: 'Why?' },
    };
    const result = validateAnnotations([annotation]);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]!.type).toBe('provoking_question');
    expect(result.errors).toHaveLength(0);
  });
});
