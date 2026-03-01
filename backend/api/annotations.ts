import { Router } from 'express';
import { serviceClient, createUserClient } from '../lib/supabase.js';

const router = Router();

// GET /api/annotations?url=X&content_hash=Y — cached + user annotations merged
router.get('/', async (req, res) => {
  try {
    const { url, content_hash } = req.query;
    if (!url || !content_hash) {
      res.status(400).json({ error: 'url and content_hash query params required' });
      return;
    }

    // Fetch cached AI annotations (no RLS needed)
    const { data: cached } = await serviceClient
      .from('annotation_cache')
      .select('annotations')
      .eq('content_hash', content_hash as string)
      .gt('expires_at', new Date().toISOString());

    const cachedAnnotations = cached?.flatMap((row) => row.annotations) ?? [];

    // Fetch user annotations (RLS-protected) — includes edits, manual, and tombstones
    const token = req.headers.authorization?.slice(7) ?? '';
    const userClient = createUserClient(token);
    const { data: userAnns } = await userClient
      .from('user_annotations')
      .select('annotation')
      .eq('url', url as string)
      .eq('content_hash', content_hash as string);

    const userAnnotations = userAnns?.map((row) => row.annotation) ?? [];

    // Dedup: user version wins over cached version (by annotation ID)
    // Filter out tombstones (deleted: true)
    const userAnnotationIds = new Set(userAnnotations.map((a: any) => a.id));
    const tombstoneIds = new Set(
      userAnnotations.filter((a: any) => a.deleted === true).map((a: any) => a.id)
    );

    const dedupedCached = cachedAnnotations.filter(
      (a: any) => !userAnnotationIds.has(a.id)
    );
    const liveUserAnnotations = userAnnotations.filter(
      (a: any) => a.deleted !== true
    );

    res.json({
      success: true,
      cached: cachedAnnotations.length > 0,
      annotations: [...dedupedCached, ...liveUserAnnotations],
    });
  } catch (err) {
    console.error('[annotations GET] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/annotations — save manual annotation
router.post('/', async (req, res) => {
  try {
    const { url, content_hash, annotation } = req.body;
    if (!url || !content_hash || !annotation) {
      res.status(400).json({ error: 'url, content_hash, and annotation required' });
      return;
    }

    const token = req.headers.authorization?.slice(7) ?? '';
    const userClient = createUserClient(token);

    const { data, error } = await userClient
      .from('user_annotations')
      .insert({
        user_id: req.user!.id,
        url,
        content_hash,
        annotation,
      })
      .select()
      .single();

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    res.status(201).json(data.annotation);
  } catch (err) {
    console.error('[annotations POST] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/annotations/:id — upsert annotation (update if exists, insert if not)
router.put('/:id', async (req, res) => {
  try {
    const { annotation, url, content_hash } = req.body;
    if (!annotation) {
      res.status(400).json({ error: 'annotation required' });
      return;
    }

    const token = req.headers.authorization?.slice(7) ?? '';
    const userClient = createUserClient(token);

    // Try UPDATE first
    const { data, error } = await userClient
      .from('user_annotations')
      .update({ annotation })
      .eq('annotation->>id', req.params.id)
      .select()
      .single();

    if (data) {
      res.json(data.annotation);
      return;
    }

    // No existing row — INSERT (for AI annotation edits)
    if (!url || !content_hash) {
      res.status(400).json({ error: 'url and content_hash required for new annotation edit' });
      return;
    }

    const { data: inserted, error: insertError } = await userClient
      .from('user_annotations')
      .insert({
        user_id: req.user!.id,
        url,
        content_hash,
        annotation,
      })
      .select()
      .single();

    if (insertError) {
      res.status(400).json({ error: insertError.message });
      return;
    }

    res.json(inserted.annotation);
  } catch (err) {
    console.error('[annotations PUT] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/annotations/:id — delete annotation (or tombstone AI annotation)
router.delete('/:id', async (req, res) => {
  try {
    const token = req.headers.authorization?.slice(7) ?? '';
    const userClient = createUserClient(token);

    // Try deleting from user_annotations first (manual annotations)
    const { data: deleted } = await userClient
      .from('user_annotations')
      .delete()
      .eq('annotation->>id', req.params.id)
      .select();

    if (deleted && deleted.length > 0) {
      res.json({ success: true });
      return;
    }

    // No user_annotation found — this is an AI annotation.
    // Insert a tombstone so it doesn't reappear from cache.
    const { url, content_hash } = req.body ?? {};
    if (!url || !content_hash) {
      // Best-effort: without url/content_hash we can't insert a tombstone
      res.json({ success: true });
      return;
    }

    const { error: insertError } = await userClient
      .from('user_annotations')
      .insert({
        user_id: req.user!.id,
        url,
        content_hash,
        annotation: { id: req.params.id, deleted: true },
      });

    if (insertError) {
      console.error('[annotations DELETE] Tombstone insert error:', insertError);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[annotations DELETE] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
