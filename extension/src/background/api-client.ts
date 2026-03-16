import {
  BACKEND_URL,
  type AnnotateRequest,
  type AnnotationResponse,
  type Annotation,
  type AnnotationFeedback,
  type FeedbackType,
  type SiteAdapter,
  type UserPreferences,
} from '@oddity/shared';
import { getAccessToken, refreshAccessToken } from './auth.js';

// ─── Error Types ───

export class AuthError extends Error {
  constructor(message = 'Authentication failed') {
    super(message);
    this.name = 'AuthError';
  }
}

export class RateLimitError extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super(`Rate limit exceeded. Retry after ${retryAfter}s`);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/** Rate limit gate for annotation requests: timestamp (ms) until which requests should be blocked. */
let annotationRateLimitUntil = 0;
/** Rate limit gate for sketch requests (separate from annotations). */
let sketchRateLimitUntil = 0;
/** Max rate limit duration: 5 minutes. Servers may return absurdly long values. */
const MAX_RATE_LIMIT_SECS = 300;

// ─── Internal Fetch with Auth ───

async function authFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken();

  const headers = new Headers(init.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  headers.set('Content-Type', 'application/json');

  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers,
  });

  // On 401, force-refresh the token and retry once
  if (response.status === 401) {
    const retryToken = await refreshAccessToken();
    if (!retryToken) {
      throw new AuthError();
    }

    const retryHeaders = new Headers(init.headers);
    retryHeaders.set('Authorization', `Bearer ${retryToken}`);
    retryHeaders.set('Content-Type', 'application/json');

    const retryResponse = await fetch(`${BACKEND_URL}${path}`, {
      ...init,
      headers: retryHeaders,
    });

    if (retryResponse.status === 401) {
      throw new AuthError();
    }

    return retryResponse;
  }

  return response;
}

// ─── Exported API Functions ───

/**
 * Request annotations for a content region.
 * Accepts an optional AbortSignal for cancellation of stale requests.
 */
export async function requestAnnotations(
  req: AnnotateRequest,
  signal?: AbortSignal,
): Promise<AnnotationResponse> {
  const res = await authFetch('/api/annotate', {
    method: 'POST',
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`requestAnnotations failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<AnnotationResponse>;
}

/**
 * Request annotations via SSE streaming. Calls onAnnotation for each
 * annotation as it arrives, then resolves with the complete result.
 */
export async function requestAnnotationsStreaming(
  req: AnnotateRequest,
  onAnnotation: (annotation: Annotation) => void,
  signal?: AbortSignal,
): Promise<AnnotationResponse> {
  // Block if rate-limited (annotation-specific gate)
  if (Date.now() < annotationRateLimitUntil) {
    const waitSec = Math.ceil((annotationRateLimitUntil - Date.now()) / 1000);
    throw new RateLimitError(waitSec);
  }

  async function doStreamingFetch(token: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return fetch(`${BACKEND_URL}/api/annotate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
      signal,
    });
  }

  let res = await doStreamingFetch(await getAccessToken());

  // On 401, force-refresh the token and retry once
  if (res.status === 401) {
    const retryToken = await refreshAccessToken();
    if (!retryToken) {
      throw new AuthError();
    }
    res = await doStreamingFetch(retryToken);
  }

  if (res.status === 429) {
    const body = await res.text().catch(() => '');
    let retryAfter = 60; // default 60s
    try {
      const parsed = JSON.parse(body);
      if (parsed.retry_after) retryAfter = Math.ceil(Number(parsed.retry_after));
    } catch {}
    // Cap to prevent absurdly long blocks (server may return hours)
    retryAfter = Math.min(retryAfter, MAX_RATE_LIMIT_SECS);
    annotationRateLimitUntil = Date.now() + retryAfter * 1000;
    throw new RateLimitError(retryAfter);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`requestAnnotationsStreaming failed (${res.status}): ${body}`);
  }
  if (!res.body) throw new Error('No response body for SSE stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const annotations: Annotation[] = [];
  let feedback: AnnotationFeedback[] = [];
  let cached = false;
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);

        try {
          const event = JSON.parse(jsonStr);

          if (event.error) {
            throw new Error(event.error);
          }

          if (event.annotation) {
            annotations.push(event.annotation);
            onAnnotation(event.annotation);
          }

          if (event.done) {
            cached = event.cached ?? false;
            feedback = event.feedback ?? [];
            if (event.annotations) {
              annotations.length = 0;
              annotations.push(...event.annotations);
            }
          }
        } catch {
          // Skip malformed events
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { success: true, cached, annotations, feedback };
}

/**
 * Request a sketch via SSE streaming. Calls onChunk for each text delta,
 * then resolves with the full assembled text.
 */
export async function requestSketchStreaming(
  payload: { input_text: string; purpose: string; user_reactions: string },
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  // Block if sketch-specific rate limit is active
  if (Date.now() < sketchRateLimitUntil) {
    const waitSec = Math.ceil((sketchRateLimitUntil - Date.now()) / 1000);
    throw new RateLimitError(waitSec);
  }

  async function doFetch(token: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetch(`${BACKEND_URL}/api/sketch`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  }

  let res = await doFetch(await getAccessToken());

  if (res.status === 401) {
    const retryToken = await refreshAccessToken();
    if (!retryToken) throw new AuthError();
    res = await doFetch(retryToken);
  }

  if (res.status === 429) {
    const body = await res.text().catch(() => '');
    let retryAfter = 60;
    try {
      const parsed = JSON.parse(body);
      if (parsed.retry_after) retryAfter = Math.ceil(Number(parsed.retry_after));
    } catch {}
    retryAfter = Math.min(retryAfter, MAX_RATE_LIMIT_SECS);
    sketchRateLimitUntil = Date.now() + retryAfter * 1000;
    throw new RateLimitError(retryAfter);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`requestSketchStreaming failed (${res.status}): ${body}`);
  }
  if (!res.body) throw new Error('No response body for sketch SSE stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.error) throw new Error(event.error);
          if (event.text) {
            fullText += event.text;
            onChunk(event.text);
          }
        } catch {
          // Skip malformed events
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}

export async function getAnnotations(
  url: string,
  contentHash: string,
  signal?: AbortSignal,
): Promise<AnnotationResponse> {
  const params = new URLSearchParams({ url, content_hash: contentHash });
  const res = await authFetch(`/api/annotations?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`getAnnotations failed: ${res.status}`);
  return res.json() as Promise<AnnotationResponse>;
}

export async function saveAnnotation(
  url: string,
  contentHash: string,
  annotation: Annotation,
  pageTitle?: string,
): Promise<Annotation> {
  const res = await authFetch('/api/annotations', {
    method: 'POST',
    body: JSON.stringify({ url, content_hash: contentHash, annotation, page_title: pageTitle }),
  });
  if (!res.ok) throw new Error(`saveAnnotation failed: ${res.status}`);
  return res.json() as Promise<Annotation>;
}

export async function deleteAnnotation(id: string, url?: string, contentHash?: string): Promise<void> {
  const res = await authFetch(`/api/annotations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ url, content_hash: contentHash }),
  });
  if (!res.ok) throw new Error(`deleteAnnotation failed: ${res.status}`);
}

export async function updateAnnotation(
  id: string,
  annotation: Annotation,
  url?: string,
  contentHash?: string,
  pageTitle?: string,
): Promise<Annotation> {
  const res = await authFetch(`/api/annotations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ annotation, url, content_hash: contentHash, page_title: pageTitle }),
  });
  if (!res.ok) throw new Error(`updateAnnotation failed: ${res.status}`);
  return res.json() as Promise<Annotation>;
}

export async function getFeedback(
  url: string,
  contentHash: string,
): Promise<AnnotationFeedback[]> {
  const params = new URLSearchParams({ url, content_hash: contentHash });
  const res = await authFetch(`/api/annotations/feedback?${params.toString()}`);
  if (!res.ok) throw new Error(`getFeedback failed: ${res.status}`);
  return res.json() as Promise<AnnotationFeedback[]>;
}

export async function saveFeedback(data: {
  annotation_id: string;
  content_hash: string;
  url: string;
  feedback_type: FeedbackType;
  reply_text?: string;
  page_title?: string;
}): Promise<AnnotationFeedback> {
  const res = await authFetch('/api/annotations/feedback', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`saveFeedback failed: ${res.status}`);
  return res.json() as Promise<AnnotationFeedback>;
}

export async function updateFeedback(id: string, replyText: string): Promise<AnnotationFeedback> {
  const res = await authFetch(`/api/annotations/feedback/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ reply_text: replyText }),
  });
  if (!res.ok) throw new Error(`updateFeedback failed: ${res.status}`);
  return res.json() as Promise<AnnotationFeedback>;
}

export async function deleteFeedback(id: string): Promise<void> {
  const res = await authFetch(`/api/annotations/feedback/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`deleteFeedback failed: ${res.status}`);
}

export async function getAdapters(): Promise<SiteAdapter[]> {
  const res = await authFetch('/api/adapters');
  if (!res.ok) throw new Error(`getAdapters failed: ${res.status}`);
  return res.json() as Promise<SiteAdapter[]>;
}

export async function getPreferences(): Promise<UserPreferences> {
  const res = await authFetch('/api/user/preferences');
  if (!res.ok) throw new Error(`getPreferences failed: ${res.status}`);
  return res.json() as Promise<UserPreferences>;
}

export async function sendUserFeedback(message: string): Promise<{ success: boolean }> {
  const res = await authFetch('/api/user-feedback', {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`sendUserFeedback failed: ${res.status}`);
  return res.json() as Promise<{ success: boolean }>;
}

export async function updatePreferences(
  prefs: Partial<UserPreferences>,
): Promise<UserPreferences> {
  const res = await authFetch('/api/user/preferences', {
    method: 'PUT',
    body: JSON.stringify(prefs),
  });
  if (!res.ok) throw new Error(`updatePreferences failed: ${res.status}`);
  return res.json() as Promise<UserPreferences>;
}
