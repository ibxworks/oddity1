import { useState, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { BACKEND_URL } from '../utils/annotationConstants';

export function useAnnotation() {
  const [annotations, setAnnotations] = useState([]);
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const annotate = useCallback(async (plainText, wordCount) => {
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
          url: 'dashboard://document',
          content_hash: '',
        }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Annotation failed: ${res.status}`);
      if (!res.body) throw new Error('No response body for SSE stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const collected = [];
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
