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

    // Fetch user manual annotations (RLS-protected)
    const token = req.headers.authorization?.slice(7) ?? '';
    const userClient = createUserClient(token);
    const { data: userAnns } = await userClient
      .from('user_annotations')
      .select('annotation')
      .eq('url', url as string)
      .eq('content_hash', content_hash as string);

    const userAnnotations = userAnns?.map((row) => row.annotation) ?? [];

    res.json({
      success: true,
      cached: cachedAnnotations.length > 0,
      annotations: [...cachedAnnotations, ...userAnnotations],
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

// PUT /api/annotations/:id — update user-owned annotation
router.put('/:id', async (req, res) => {
  try {
    const { annotation } = req.body;
    if (!annotation) {
      res.status(400).json({ error: 'annotation required' });
      return;
    }

    const token = req.headers.authorization?.slice(7) ?? '';
    const userClient = createUserClient(token);

    const { data, error } = await userClient
      .from('user_annotations')
      .update({ annotation })
      .eq('annotation->>id', req.params.id)
      .select()
      .single();

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    res.json(data.annotation);
  } catch (err) {
    console.error('[annotations PUT] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/annotations/:id — delete user-owned annotation
router.delete('/:id', async (req, res) => {
  try {
    const token = req.headers.authorization?.slice(7) ?? '';
    const userClient = createUserClient(token);

    const { error } = await userClient
      .from('user_annotations')
      .delete()
      .eq('annotation->>id', req.params.id);

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[annotations DELETE] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
