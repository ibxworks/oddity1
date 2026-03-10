import { useState, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { BACKEND_URL } from '../utils/annotationConstants';

async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function useAnnotation() {
  const [annotations, setAnnotations] = useState([]);
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const annotate = useCallback(async (plainText, wordCount, { docId } = {}) => {
    // Abort previous request if any
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsAnnotating(true);
    setError(null);
    setAnnotations([]);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const token = session.access_token;
      const contentHash = await sha256(plainText);

      const res = await fetch(`${BACKEND_URL}/api/annotate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          text: plainText,
          word_count: wordCount,
          url: `https://app.oddity1.com/documents/${docId || 'untitled'}`,
          content_hash: contentHash,
          intensity: 'default',
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Annotation failed (${res.status}): ${body || res.statusText}`);
      }
      if (!res.body) throw new Error('No response body for SSE stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const collected = [];
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Check if this request was superseded
          if (abortRef.current !== controller) return [];

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6);

            try {
              const event = JSON.parse(jsonStr);

              if (event.error) throw new Error(event.error);

              if (event.annotation) {
                collected.push(event.annotation);
                setAnnotations([...collected]);
              }

              if (event.done && event.annotations) {
                collected.length = 0;
                collected.push(...event.annotations);
                setAnnotations([...collected]);
              }
            } catch {
              // Skip malformed events
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Only update state if this is still the active request
      if (abortRef.current !== controller) return [];
      setIsAnnotating(false);
      return collected;
    } catch (err) {
      if (err.name === 'AbortError') return [];
      setError(err.message);
      setIsAnnotating(false);
      return [];
    }
  }, []);

  const clearAnnotations = useCallback(() => {
    setAnnotations([]);
    setError(null);
  }, []);

  // Cleanup on unmount
  const cleanup = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  return { annotations, isAnnotating, error, annotate, clearAnnotations, cleanup };
}
