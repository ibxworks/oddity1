/**
 * In-flight request deduplication.
 *
 * When multiple concurrent requests arrive for the same content (e.g. two
 * tabs opening the same article, or a rapid retry), only the first request
 * actually calls the LLM. Subsequent callers await the same promise.
 *
 * Keyed by a composite string (typically `${content_hash}:${intensity}`).
 * The promise is removed from the map on settlement (success or failure)
 * so that future requests always get a fresh attempt.
 */

export interface InflightDedup {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  readonly pendingCount: number;
}

export function createInflightDedup(): InflightDedup {
  const inflight = new Map<string, Promise<unknown>>();

  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const existing = inflight.get(key);
      if (existing) {
        return existing as Promise<T>;
      }

      const promise = fn().finally(() => {
        inflight.delete(key);
      });

      inflight.set(key, promise);
      return promise;
    },

    get pendingCount(): number {
      return inflight.size;
    },
  };
}
