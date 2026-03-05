import { EAGER_WORD_LIMIT } from '@oddity/shared';
import { describe, expect, it } from 'vitest';
import { isLongRequest } from '../long-request.js';

describe('isLongRequest', () => {
  it('returns false at or below the threshold', () => {
    expect(isLongRequest(EAGER_WORD_LIMIT)).toBe(false);
    expect(isLongRequest(EAGER_WORD_LIMIT - 1)).toBe(false);
  });

  it('returns true above the threshold', () => {
    expect(isLongRequest(EAGER_WORD_LIMIT + 1)).toBe(true);
  });
});
