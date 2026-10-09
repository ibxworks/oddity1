// ─── PostHog Analytics (fire-and-forget, background-only) ───
//
// All events are sent via HTTP POST to PostHog's /capture endpoint.
// Failures are silently swallowed — analytics must never affect functionality.

// Set via extension/.env (see extension/.env.example). Analytics is disabled
// when no key is configured — it must never affect functionality.
const POSTHOG_API_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const POSTHOG_HOST =
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ??
  "https://us.i.posthog.com";

let distinctId: string | null = null;
let userProperties: Record<string, unknown> = {};

function captureEvent(
  event: string,
  properties: Record<string, unknown> = {},
): void {
  try {
    if (!distinctId || !POSTHOG_API_KEY) return;

    const payload = {
      api_key: POSTHOG_API_KEY,
      event,
      properties: {
        distinct_id: distinctId,
        ...userProperties,
        ...properties,
      },
      timestamp: new Date().toISOString(),
    };

    fetch(`${POSTHOG_HOST}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    /* silent */
  }
}

/** Set the user identity and person properties. Fires a $identify event. */
export function identify(
  userId: string,
  properties: Record<string, unknown>,
  /** Skip the $identify network call (e.g. on SW boot — just re-arm local state). */
  silent = false,
): void {
  try {
    distinctId = userId;
    userProperties = { ...properties };
    if (!silent) {
      captureEvent("$identify", { $set: properties });
    }
  } catch {
    /* silent */
  }
}

/** Fire a named event. No-ops if no user is identified. */
export function track(
  event: string,
  properties?: Record<string, unknown>,
): void {
  try {
    captureEvent(event, properties ?? {});
  } catch {
    /* silent */
  }
}

/** Merge new person properties (local state only — no network call). */
export function updateProperties(
  properties: Record<string, unknown>,
): void {
  try {
    if (!distinctId) return;
    Object.assign(userProperties, properties);
  } catch {
    /* silent */
  }
}

/** Clear identity on sign-out. */
export function reset(): void {
  distinctId = null;
  userProperties = {};
}
