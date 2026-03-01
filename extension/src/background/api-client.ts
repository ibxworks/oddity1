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
import { getAccessToken, getSession } from './auth.js';

// ─── Error Types ───

export class AuthError extends Error {
  constructor(message = 'Authentication failed') {
    super(message);
    this.name = 'AuthError';
  }
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

  // On 401, attempt token refresh and retry once
  if (response.status === 401) {
    const session = await getSession();
    if (!session) {
      throw new AuthError();
    }

    // Retry with the (possibly refreshed) token
    const retryToken = await getAccessToken();
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

export async function requestAnnotations(
  req: AnnotateRequest,
): Promise<AnnotationResponse> {
  const res = await authFetch('/api/annotate', {
    method: 'POST',
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`requestAnnotations failed: ${res.status}`);
  return res.json() as Promise<AnnotationResponse>;
}

export async function getAnnotations(
  url: string,
  contentHash: string,
): Promise<AnnotationResponse> {
  const params = new URLSearchParams({ url, content_hash: contentHash });
  const res = await authFetch(`/api/annotations?${params.toString()}`);
  if (!res.ok) throw new Error(`getAnnotations failed: ${res.status}`);
  return res.json() as Promise<AnnotationResponse>;
}

export async function saveAnnotation(
  url: string,
  contentHash: string,
  annotation: Annotation,
): Promise<Annotation> {
  const res = await authFetch('/api/annotations', {
    method: 'POST',
    body: JSON.stringify({ url, content_hash: contentHash, annotation }),
  });
  if (!res.ok) throw new Error(`saveAnnotation failed: ${res.status}`);
  return res.json() as Promise<Annotation>;
}

export async function deleteAnnotation(id: string): Promise<void> {
  const res = await authFetch(`/api/annotations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`deleteAnnotation failed: ${res.status}`);
}

export async function updateAnnotation(
  id: string,
  annotation: Annotation,
): Promise<Annotation> {
  const res = await authFetch(`/api/annotations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ annotation }),
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
}): Promise<AnnotationFeedback> {
  const res = await authFetch('/api/annotations/feedback', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`saveFeedback failed: ${res.status}`);
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
