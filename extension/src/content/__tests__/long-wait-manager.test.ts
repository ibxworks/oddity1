import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LongWaitManager } from '../long-wait-manager.js';

describe('LongWaitManager', () => {
  let show: ReturnType<typeof vi.fn>;
  let hide: ReturnType<typeof vi.fn>;
  let manager: LongWaitManager;

  beforeEach(() => {
    vi.useFakeTimers();
    show = vi.fn();
    hide = vi.fn();
    manager = new LongWaitManager({ show, hide }, 500);
  });

  it('shows after delay for long pending requests', () => {
    manager.start('h1');

    vi.advanceTimersByTime(499);
    expect(show).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledTimes(1);
    expect(manager.isVisible()).toBe(true);
  });

  it('keeps a single global toast for multiple pending long requests', () => {
    manager.start('h1');
    manager.start('h2');

    vi.advanceTimersByTime(500);

    expect(show).toHaveBeenCalledTimes(1);
    expect(manager.pendingCount()).toBe(2);
  });

  it('hides immediately when first annotation chunk arrives', () => {
    manager.start('h1');
    vi.advanceTimersByTime(500);

    manager.handleFirstAnnotation('h1');

    expect(hide).toHaveBeenCalledTimes(1);
    expect(manager.pendingCount()).toBe(0);
    expect(manager.isVisible()).toBe(false);
  });

  it('hides when all pending long requests finish without annotations', () => {
    manager.start('h1');
    manager.start('h2');
    vi.advanceTimersByTime(500);

    manager.completeWithoutAnnotations('h1');
    expect(hide).not.toHaveBeenCalled();

    manager.completeWithoutAnnotations('h2');
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('hides when final result includes annotations', () => {
    manager.start('h1');
    manager.start('h2');
    vi.advanceTimersByTime(500);

    manager.handleFinalResult('h1', 3);

    expect(hide).toHaveBeenCalledTimes(1);
    expect(manager.pendingCount()).toBe(0);
  });

  it('cancels delayed show when request ends early', () => {
    manager.start('h1');
    manager.completeWithoutAnnotations('h1');

    vi.advanceTimersByTime(500);

    expect(show).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
  });
});
