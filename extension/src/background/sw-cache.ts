import type { Annotation, AnnotationFeedback } from '@oddity/shared';

/**
 * Service Worker session cache using chrome.storage.session.
 * Persists across SW restarts within the same browser session (10MB limit).
 * Keyed by "content_hash:intensity".
 */

interface CacheEntry {
  annotations: Annotation[];
  feedback: AnnotationFeedback[];
  timestamp: number;
}

const CACHE_PREFIX = 'swc:';

function cacheKey(contentHash: string, intensity: string): string {
  return `${CACHE_PREFIX}${contentHash}:${intensity}`;
}

export async function getFromSessionCache(
  contentHash: string,
  intensity: string,
): Promise<CacheEntry | null> {
  const key = cacheKey(contentHash, intensity);
  const result = await chrome.storage.session.get(key);
  return (result[key] as CacheEntry) ?? null;
}

export async function setInSessionCache(
  contentHash: string,
  intensity: string,
  annotations: Annotation[],
  feedback: AnnotationFeedback[],
): Promise<void> {
  const key = cacheKey(contentHash, intensity);
  const entry: CacheEntry = { annotations, feedback, timestamp: Date.now() };
  await chrome.storage.session.set({ [key]: entry });
}

export async function clearSessionCache(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keysToRemove = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keysToRemove.length > 0) {
    await chrome.storage.session.remove(keysToRemove);
  }
}
