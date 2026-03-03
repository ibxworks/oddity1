import { describe, it, expect } from 'vitest';
import * as shared from '../index.js';

describe('@oddity/shared exports', () => {
  it('exports BACKEND_URL', () => {
    expect(shared.BACKEND_URL).toBeDefined();
  });

  it('exports timing constants', () => {
    expect(shared.STABILITY_DEBOUNCE_MS).toBe(500);
    expect(shared.POPOVER_SHOW_DELAY_MS).toBe(200);
    expect(shared.POPOVER_HIDE_DELAY_MS).toBe(300);
    expect(shared.ADAPTER_REFRESH_INTERVAL_MINUTES).toBe(360);
    expect(shared.SCROLL_LOADER_ROOT_MARGIN).toBe('500px');
    expect(shared.EAGER_WORD_LIMIT).toBe(5000);
  });

  it('exports rate limit constants', () => {
    expect(shared.RATE_LIMIT_FREE).toBe(50);
    expect(shared.RATE_LIMIT_PRO).toBe(500);
  });

  it('exports request limit constants', () => {
    expect(shared.MAX_TEXT_LENGTH).toBe(100_000);
  });

  it('exports cache constants', () => {
    expect(shared.CACHE_TTL_DAYS).toBe(30);
  });

  it('exports annotation colors for all 6 types', () => {
    expect(Object.keys(shared.ANNOTATION_COLORS)).toHaveLength(6);
    expect(shared.ANNOTATION_COLORS.highlight).toBe('#F59E0B');
    expect(shared.ANNOTATION_COLORS.recall).toBe('#0D9488');
    expect(shared.ANNOTATION_COLORS.provoking_question).toBe('#7C3AED');
    expect(shared.ANNOTATION_COLORS.caveat).toBe('#7C3AED');
    expect(shared.ANNOTATION_COLORS.vocabulary).toBe('#0D9488');
    expect(shared.ANNOTATION_COLORS.insight).toBe('#2563EB');
  });

  it('exports annotation labels for all 6 types', () => {
    expect(Object.keys(shared.ANNOTATION_LABELS)).toHaveLength(6);
    expect(shared.ANNOTATION_LABELS.highlight).toBe('KEY PHRASE');
    expect(shared.ANNOTATION_LABELS.recall).toBe('RECALL');
    expect(shared.ANNOTATION_LABELS.provoking_question).toBe('PROVOCATION');
  });

  it('exports ALL_ANNOTATION_TYPES with 6 entries', () => {
    expect(shared.ALL_ANNOTATION_TYPES).toHaveLength(6);
    expect(shared.ALL_ANNOTATION_TYPES).toContain('highlight');
    expect(shared.ALL_ANNOTATION_TYPES).toContain('recall');
    expect(shared.ALL_ANNOTATION_TYPES).toContain('provoking_question');
    expect(shared.ALL_ANNOTATION_TYPES).toContain('vocabulary');
  });
});
