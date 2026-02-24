import {
  ADAPTER_REFRESH_INTERVAL_MINUTES,
  type SiteAdapter,
} from "@oddity/shared";
import { getAdapters as fetchAdaptersFromApi } from "./api-client.js";

const ALARM_NAME = "oddity-adapter-refresh";
const STORAGE_KEY = "adapters";

// ─── In-Memory Cache ───
// Service workers can be terminated at any time, so we always
// fall back to chrome.storage.local if the in-memory cache is empty.

let cachedAdapters: SiteAdapter[] | null = null;

// ─── Storage Helpers ───

async function loadFromStorage(): Promise<SiteAdapter[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const adapters = (result[STORAGE_KEY] as SiteAdapter[] | undefined) ?? [];
  cachedAdapters = adapters;
  return adapters;
}

async function saveToStorage(adapters: SiteAdapter[]): Promise<void> {
  cachedAdapters = adapters;
  await chrome.storage.local.set({ [STORAGE_KEY]: adapters });
}

// ─── Refresh Logic ───

async function refreshAdapters(): Promise<void> {
  try {
    const adapters = await fetchAdaptersFromApi();
    await saveToStorage(adapters);
    console.log(
      `[Oddity 1] Adapter registry refreshed: ${adapters.length} adapters`,
    );
  } catch (err) {
    console.error("[Oddity 1] Failed to refresh adapters:", err);
  }
}

// ─── Public API ───

/**
 * Get all site adapters. Returns cached data immediately and
 * triggers a background refresh if the alarm-based refresh hasn't
 * fired recently.
 */
export async function getAdapters(): Promise<SiteAdapter[]> {
  if (cachedAdapters !== null) {
    return cachedAdapters;
  }
  return loadFromStorage();
}

/**
 * Set up the chrome.alarms-based refresh cycle.
 * Call once on chrome.runtime.onInstalled.
 */
export function initAdapterRefresh(): void {
  // Do an initial fetch
  refreshAdapters();

  // Set up periodic alarm
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: ADAPTER_REFRESH_INTERVAL_MINUTES,
  });
}

/**
 * Handle alarm firing. Call from chrome.alarms.onAlarm listener.
 */
export function handleAdapterAlarm(alarm: chrome.alarms.Alarm): void {
  if (alarm.name === ALARM_NAME) {
    refreshAdapters();
  }
}

// ─── Hostname Glob Matching ───

/**
 * Match a hostname against a SiteAdapter's hostname_pattern.
 * Supports:
 *  - Exact match: "chat.openai.com"
 *  - Wildcard prefix: "*.substack.com"
 */
function hostnameMatchesPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".substack.com"
    return hostname.endsWith(suffix) || hostname === pattern.slice(2);
  }
  return hostname === pattern;
}

/**
 * Find the first enabled adapter whose hostname_pattern matches the given hostname.
 */
export function matchAdapter(hostname: string): SiteAdapter | null {
  if (!cachedAdapters) return null;
  return (
    cachedAdapters.find(
      (a) => a.enabled && hostnameMatchesPattern(hostname, a.hostname_pattern),
    ) ?? null
  );
}
