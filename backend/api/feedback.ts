import { Router } from 'express';
import { createUserClient } from '../lib/supabase.js';

const router = Router();

// GET /api/annotations/feedback?url=X&content_hash=Y
router.get('/', async (req, res) => {
  try {
    const { url, content_hash } = req.query;
    if (!url || !content_hash) {
      res.status(400).json({ error: 'url and content_hash query params required' });
      return;
    }

    const token = req.headers.authorization?.slice(7) ?? '';
    const userClient = createUserClient(token);

    const { data, error } = await userClient
      .from('annotation_feedback')
      .select('id, annotation_id, feedback_type, reply_text, created_at')
      .eq('url', url as string)
      .eq('content_hash', content_hash as string);

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    res.json(data ?? []);
  } catch (err) {
    console.error('[feedback GET] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/annotations/feedback
router.post('/', async (req, res) => {
  try {
    const { annotation_id, content_hash, url, feedback_type, reply_text } = req.body;
    if (!annotation_id || !content_hash || !url || !feedback_type) {
      res.status(400).json({ error: 'annotation_id, content_hash, url, and feedback_type required' });
      return;
    }

    const token = req.headers.authorization?.slice(7) ?? '';
    const userClient = createUserClient(token);

    // Dedup: remove any existing thumb reaction for this user+annotation before inserting
    if (feedback_type === 'thumbs_up' || feedback_type === 'thumbs_down') {
      await userClient
        .from('annotation_feedback')
        .delete()
        .eq('user_id', req.user!.id)
        .eq('annotation_id', annotation_id)
        .in('feedback_type', ['thumbs_up', 'thumbs_down']);
    }

    const { data, error } = await userClient
      .from('annotation_feedback')
      .insert({
        user_id: req.user!.id,
        annotation_id,
        content_hash,
        url,
        feedback_type,
        reply_text: reply_text ?? null,
      })
      .select()
      .single();

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    res.status(201).json(data);
  } catch (err) {
    console.error('[feedback POST] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/annotations/feedback/:id
router.delete('/:id', async (req, res) => {
  try {
    const token = req.headers.authorization?.slice(7) ?? '';
    const userClient = createUserClient(token);

    const { error } = await userClient
      .from('annotation_feedback')
      .delete()
      .eq('id', req.params.id);

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[feedback DELETE] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
