import type { Annotation, AnnotationFeedback } from '@oddity/shared';
import { serviceClient, createUserClient } from './supabase.js';

/**
 * Merge AI-cached annotations with user annotations, and fetch feedback.
 * User annotations shadow (replace) cached AI annotation IDs.
 * Tombstones (deleted: true) are filtered out.
 */
export async function mergeAnnotationsAndFeedback(
  aiAnnotations: Annotation[],
  url: string,
  contentHash: string,
  authToken: string,
): Promise<{ annotations: Annotation[]; feedback: AnnotationFeedback[] }> {
  const userClient = createUserClient(authToken);

  // Fetch user annotations + feedback in parallel
  const [userAnnsResult, feedbackResult] = await Promise.all([
    userClient
      .from('user_annotations')
      .select('annotation')
      .eq('url', url)
      .eq('content_hash', contentHash),
    userClient
      .from('annotation_feedback')
      .select('id, annotation_id, feedback_type, reply_text, created_at')
      .eq('url', url)
      .eq('content_hash', contentHash),
  ]);

  const userAnnotations = userAnnsResult.data?.map((row) => row.annotation) ?? [];
  const feedback: AnnotationFeedback[] = feedbackResult.data ?? [];

  // Dedup: user version wins over cached version (by annotation ID)
  // Filter out tombstones (deleted: true)
  const userAnnotationIds = new Set(userAnnotations.map((a: any) => a.id));
  const tombstoneIds = new Set(
    userAnnotations.filter((a: any) => a.deleted === true).map((a: any) => a.id),
  );

  const dedupedCached = aiAnnotations.filter(
    (a) => !userAnnotationIds.has(a.id) && !tombstoneIds.has(a.id),
  );
  const liveUserAnnotations = userAnnotations.filter(
    (a: any) => a.deleted !== true,
  );

  return {
    annotations: [...dedupedCached, ...liveUserAnnotations],
    feedback,
  };
}
