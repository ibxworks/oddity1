/**
 * In-memory hot cache with TTL eviction and bounded size.
 *
 * Sits in front of the Supabase `annotation_cache` table to eliminate
 * DB round-trips for burst duplicate requests (e.g. page refresh,
 * multiple tabs on the same article).
 *
 * Design constraints:
 *   - Process-local (serverless-friendly: each instance gets its own cache)
 *   - LRU eviction when maxSize is reached
 *   - Entries auto-expire after ttlMs
 *   - Negative cache: stores `null` sentinel for known-bad inputs
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface HotCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  has(key: string): boolean;
  clear(): void;
  readonly size: number;
}

export function createHotCache<T>(opts: {
  ttlMs: number;
  maxSize?: number;
}): HotCache<T> {
  const { ttlMs, maxSize = 500 } = opts;
  const store = new Map<string, CacheEntry<T>>();

  function evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) {
        store.delete(key);
      }
    }
  }

  function evictLRU(): void {
    // Map preserves insertion order — the first key is the oldest
    if (store.size > maxSize) {
      const firstKey = store.keys().next().value as string;
      store.delete(firstKey);
    }
  }

  return {
    get(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;

      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }

      // Move to end (LRU refresh): delete + re-insert
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },

    set(key: string, value: T): void {
      // Delete first so re-insert goes to end of Map
      store.delete(key);
      store.set(key, { value, expiresAt: Date.now() + ttlMs });

      // Bound the cache size
      if (store.size > maxSize) {
        evictLRU();
      }

      // Periodic expired cleanup (amortized: only every 50 writes)
      if (store.size % 50 === 0) {
        evictExpired();
      }
    },

    has(key: string): boolean {
      const entry = store.get(key);
      if (!entry) return false;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return false;
      }
      return true;
    },

    clear(): void {
      store.clear();
    },

    get size(): number {
      return store.size;
    },
  };
}
