import type { Annotation, AnnotationFeedback, Intensity } from '@oddity/shared';

/**
 * URL-hash prediction cache using chrome.storage.local.
 * Maps URL → {content_hash, intensity, annotations, feedback} so that on
 * revisits, we can render instantly before even extracting text.
 * Falls back to normal pipeline if content has changed (hash mismatch).
 */

interface UrlCacheEntry {
  contentHash: string;
  intensity: Intensity;
  annotations: Annotation[];
  feedback: AnnotationFeedback[];
  timestamp: number;
}

const CACHE_PREFIX = 'urlc:';
const MAX_ENTRIES = 200; // Cap storage usage

function cacheKey(url: string): string {
  // Normalize URL: strip fragment, trailing slash
  const normalized = url.split('#')[0]?.replace(/\/$/, '') ?? url;
  return `${CACHE_PREFIX}${normalized}`;
}

export async function getUrlCache(url: string): Promise<UrlCacheEntry | null> {
  const key = cacheKey(url);
  const result = await chrome.storage.local.get(key);
  return (result[key] as UrlCacheEntry) ?? null;
}

export async function setUrlCache(
  url: string,
  contentHash: string,
  intensity: Intensity,
  annotations: Annotation[],
  feedback: AnnotationFeedback[],
): Promise<void> {
  const key = cacheKey(url);
  const entry: UrlCacheEntry = {
    contentHash,
    intensity,
    annotations,
    feedback,
    timestamp: Date.now(),
  };
  await chrome.storage.local.set({ [key]: entry });

  // Evict oldest entries if over limit (async, non-blocking)
  evictOldEntries().catch(() => {});
}

async function evictOldEntries(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const urlKeys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));

  if (urlKeys.length <= MAX_ENTRIES) return;

  // Sort by timestamp, remove oldest
  const entries = urlKeys.map((k) => ({
    key: k,
    timestamp: (all[k] as UrlCacheEntry)?.timestamp ?? 0,
  }));
  entries.sort((a, b) => a.timestamp - b.timestamp);

  const toRemove = entries.slice(0, entries.length - MAX_ENTRIES).map((e) => e.key);
  await chrome.storage.local.remove(toRemove);
}
