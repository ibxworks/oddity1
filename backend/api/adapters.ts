import { Router } from 'express';
import { serviceClient } from '../lib/supabase.js';

const router = Router();

// GET /api/adapters — public, no auth required
router.get('/', async (_req, res) => {
  try {
    const { data, error } = await serviceClient
      .from('site_adapters')
      .select('*')
      .eq('enabled', true);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data ?? []);
  } catch (err) {
    console.error('[adapters] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
