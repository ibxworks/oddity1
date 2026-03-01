import { Router } from 'express';
import { createUserClient } from '../lib/supabase.js';

const router = Router();

// POST /api/user-feedback
router.post('/', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const token = req.headers.authorization?.slice(7) ?? '';
    const userClient = createUserClient(token);

    const { error } = await userClient
      .from('user_feedback')
      .insert({
        user_id: req.user!.id,
        email: req.user!.email,
        message: message.trim(),
      });

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    res.status(201).json({ success: true });
  } catch (err) {
    console.error('[user-feedback POST] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
