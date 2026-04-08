import {
  BACKEND_URL,
  type AnnotateRequest,
  type AnnotationResponse,
  type Annotation,
  type AnnotationFeedback,
  type AnnotationUsage,
  type FeedbackType,
  type PdfPageSummaryGenerateRequest,
  type PdfPageSummaryGenerateResponse,
  type PdfPageSummaryListResponse,
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

export class UsageLimitError extends Error {
  usage: AnnotationUsage;
  upgrade: boolean;
  upgradeMultiplier?: number;

  constructor(
    message: string,
    usage: AnnotationUsage,
    upgrade = false,
    upgradeMultiplier?: number,
  ) {
    super(message);
    this.name = 'UsageLimitError';
    this.usage = usage;
    this.upgrade = upgrade;
    this.upgradeMultiplier = upgradeMultiplier;
  }
}

/** Rate limit gate for annotation requests: timestamp (ms) until which requests should be blocked. */
let annotationRateLimitUntil = 0;
/** Rate limit gate for sketch requests (separate from annotations). */
let sketchRateLimitUntil = 0;
/** Max rate limit duration: 5 minutes. Servers may return absurdly long values. */
const MAX_RATE_LIMIT_SECS = 300;

type AnnotationErrorPayload = {
  error?: string;
  usage?: AnnotationUsage;
  upgrade?: boolean;
  upgrade_multiplier?: number;
  retry_after?: number;
};

async function readJsonPayload(
  response: Response,
): Promise<AnnotationErrorPayload | null> {
  const body = await response.text().catch(() => '');
  if (!body) return null;

  try {
    return JSON.parse(body) as AnnotationErrorPayload;
  } catch {
    return { error: body };
  }
}

function getErrorMessage(
  prefix: string,
  status: number,
  payload: AnnotationErrorPayload | null,
): string {
  const detail = payload?.error ?? 'Request failed';
  return `${prefix} (${status}): ${detail}`;
}

function throwAnnotationResponseError(
  prefix: string,
  status: number,
  payload: AnnotationErrorPayload | null,
): never {
  if (
    status === 403 &&
    payload?.error === 'Monthly annotation limit reached' &&
    payload.usage
  ) {
    throw new UsageLimitError(
      payload.error,
      payload.usage,
      payload.upgrade === true,
      payload.upgrade_multiplier,
    );
  }

  throw new Error(getErrorMessage(prefix, status, payload));
}

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

/** Delete the current user's account and all associated data. */
export async function deleteAccount(): Promise<void> {
  const response = await authFetch('/api/user/account', { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || 'Failed to delete account');
  }
}

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
    const payload = await readJsonPayload(res);
    throwAnnotationResponseError('requestAnnotations failed', res.status, payload);
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
    const payload = await readJsonPayload(res);
    let retryAfter = 60; // default 60s
    if (payload?.retry_after) retryAfter = Math.ceil(Number(payload.retry_after));
    // Cap to prevent absurdly long blocks (server may return hours)
    retryAfter = Math.min(retryAfter, MAX_RATE_LIMIT_SECS);
    annotationRateLimitUntil = Date.now() + retryAfter * 1000;
    throw new RateLimitError(retryAfter);
  }

  if (!res.ok) {
    const payload = await readJsonPayload(res);
    throwAnnotationResponseError(
      'requestAnnotationsStreaming failed',
      res.status,
      payload,
    );
  }
  if (!res.body) throw new Error('No response body for SSE stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const annotations: Annotation[] = [];
  let feedback: AnnotationFeedback[] = [];
  let cached = false;
  let usage: AnnotationUsage | undefined;
  let upgrade: boolean | undefined;
  let upgradeMultiplier: number | undefined;
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

        let event: Record<string, unknown>;

        try {
          event = JSON.parse(jsonStr) as Record<string, unknown>;
        } catch {
          // Skip malformed events
          continue;
        }

        if (typeof event.error === 'string') {
          throw new Error(event.error);
        }

        if (event.annotation) {
          const annotation = event.annotation as Annotation;
          annotations.push(annotation);
          onAnnotation(annotation);
        }

        if (event.done) {
          cached = event.cached === true;
          feedback = (event.feedback as AnnotationFeedback[] | undefined) ?? [];
          usage = event.usage as AnnotationUsage | undefined;
          upgrade = event.upgrade as boolean | undefined;
          upgradeMultiplier = event.upgrade_multiplier as number | undefined;
          if (event.annotations) {
            annotations.length = 0;
            annotations.push(...(event.annotations as Annotation[]));
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    success: true,
    cached,
    annotations,
    feedback,
    usage,
    upgrade,
    upgrade_multiplier: upgradeMultiplier,
  };
}

/**
 * Request a sketch via SSE streaming. Calls onChunk for each text delta,
 * then resolves with the full assembled text.
 */
export async function requestSketchStreaming(
  payload: { input_text: string; purpose: string; user_reactions: string; mode?: "sketch" | "prompt" },
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

export async function getPdfPageSummaries(
  url: string,
  documentHash: string,
): Promise<PdfPageSummaryListResponse> {
  const params = new URLSearchParams({
    url,
    document_hash: documentHash,
  });
  const res = await authFetch(`/api/pdf-page-summaries?${params.toString()}`);
  if (!res.ok) throw new Error(`getPdfPageSummaries failed: ${res.status}`);
  return res.json() as Promise<PdfPageSummaryListResponse>;
}

export async function generatePdfPageSummary(
  payload: PdfPageSummaryGenerateRequest,
): Promise<PdfPageSummaryGenerateResponse> {
  const res = await authFetch("/api/pdf-page-summaries/generate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errorPayload = await readJsonPayload(res);
    throwAnnotationResponseError(
      "generatePdfPageSummary failed",
      res.status,
      errorPayload,
    );
  }
  return res.json() as Promise<PdfPageSummaryGenerateResponse>;
}

export async function getPreferences(): Promise<UserPreferences> {
  const res = await authFetch('/api/user/preferences');
  if (!res.ok) throw new Error(`getPreferences failed: ${res.status}`);
  return res.json() as Promise<UserPreferences>;
}

export async function sendUserFeedback(message: string, role?: string): Promise<{ success: boolean }> {
  const body: Record<string, string> = { message };
  if (role) body.role = role;
  const res = await authFetch('/api/user-feedback', {
    method: 'POST',
    body: JSON.stringify(body),
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

/** Convert a PDF binary to HTML via the Datalab Marker API (server-side). */
export async function convertPdfViaMarker(pdfData: Uint8Array): Promise<string> {
  // Encode binary as base64 to send in JSON body
  const pdfBase64 = uint8ToBase64(pdfData);

  const res = await authFetch('/api/convert-pdf', {
    method: 'POST',
    body: JSON.stringify({ pdfBase64 }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((body as { error?: string }).error ?? `Convert PDF failed: ${res.status}`);
  }

  const data = (await res.json()) as { html: string };
  return data.html;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

// ─── GDocs Chat Streaming ─────────────────────────────────────────────────────

export async function requestGDocsChatStreaming(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  mode: "chat" | "tree" | "essay" | "edit" | "fast" | "outline",
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  async function doFetch(token: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetch(`${BACKEND_URL}/api/gdocs-chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messages, mode }),
      signal,
    });
  }

  let res = await doFetch(await getAccessToken());

  if (res.status === 401) {
    const retryToken = await refreshAccessToken();
    if (!retryToken) throw new AuthError();
    res = await doFetch(retryToken);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`requestGDocsChatStreaming failed (${res.status}): ${body}`);
  }
  if (!res.body) throw new Error("No response body for gdocs-chat SSE stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.error) throw new Error(event.error);
          if (event.text && !event.done) onChunk(event.text);
        } catch {
          // Skip malformed events
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── GDocs MCQ ────────────────────────────────────────────────────────────────

export type McqQuestion = { question: string; options: string[] };

export async function fetchAllGDocsMcqQuestions(
  prompt: string,
  docContext: string,
): Promise<McqQuestion[]> {
  async function doFetch(token: string | null): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetch(`${BACKEND_URL}/api/gdocs-mcq`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt, docContext }),
    });
  }

  let res = await doFetch(await getAccessToken());
  if (res.status === 401) {
    const retryToken = await refreshAccessToken();
    if (!retryToken) throw new AuthError();
    res = await doFetch(retryToken);
  }
  if (!res.ok) throw new Error(`fetchAllGDocsMcqQuestions failed: ${res.status}`);
  return res.json() as Promise<McqQuestion[]>;
}

// ─── GDocs Route (mode classifier) ───────────────────────────────────────────

export type GDocsRouteMode = "FAST" | "PLAN";

export async function requestGDocsRoute(
  prompt: string,
  docContext: string,
  essayContent: string,
): Promise<{ mode: GDocsRouteMode; reasoning: string }> {
  async function doFetch(token: string | null): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetch(`${BACKEND_URL}/api/gdocs-route`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt, docContext, essayContent }),
    });
  }

  let res = await doFetch(await getAccessToken());
  if (res.status === 401) {
    const retryToken = await refreshAccessToken();
    if (!retryToken) throw new AuthError();
    res = await doFetch(retryToken);
  }
  if (!res.ok) throw new Error(`requestGDocsRoute failed: ${res.status}`);
  return res.json() as Promise<{ mode: GDocsRouteMode; reasoning: string }>;
}

// ─── GDocs Session (cloud sync) ───────────────────────────────────────────────

export type GDocsSessionData = {
  chatHistory: Array<{ role: "user" | "assistant"; content: string }>;
  essayVersions: string[];
  editSuggestions: Array<Array<{ find: string; replace: string }>>;
  createdAt: string;
  updatedAt: string;
};

export async function fetchGDocsSession(docId: string): Promise<GDocsSessionData | null> {
  async function doFetch(token: string | null): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetch(`${BACKEND_URL}/api/gdocs-session?docId=${encodeURIComponent(docId)}`, {
      method: "GET",
      headers,
    });
  }

  let res = await doFetch(await getAccessToken());
  if (res.status === 401) {
    const retryToken = await refreshAccessToken();
    if (!retryToken) throw new AuthError();
    res = await doFetch(retryToken);
  }
  if (!res.ok) throw new Error(`fetchGDocsSession failed: ${res.status}`);
  const body = await res.json() as { session: GDocsSessionData | null };
  return body.session;
}

export async function saveGDocsSession(
  docId: string,
  chatHistory: Array<{ role: "user" | "assistant"; content: string }>,
  essayVersions: string[],
  editSuggestions: Array<Array<{ find: string; replace: string }>>,
): Promise<void> {
  async function doFetch(token: string | null): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetch(`${BACKEND_URL}/api/gdocs-session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ docId, chatHistory, essayVersions, editSuggestions }),
    });
  }

  let res = await doFetch(await getAccessToken());
  if (res.status === 401) {
    const retryToken = await refreshAccessToken();
    if (!retryToken) throw new AuthError();
    res = await doFetch(retryToken);
  }
  if (!res.ok) throw new Error(`saveGDocsSession failed: ${res.status}`);
}
