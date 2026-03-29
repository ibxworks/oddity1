import { Router } from 'express';
import { createUserClient } from '../../lib/supabase.js';

const router = Router();

// GET /api/user/preferences
router.get('/', async (req, res) => {
  try {
    const token = req.headers.authorization?.slice(7) ?? '';
    const userClient = createUserClient(token);

    const { data: profile, error } = await userClient
      .from('profiles')
      .select('preferences')
      .eq('id', req.user!.id)
      .single();

    if (error?.code === 'PGRST116') {
      // Profile doesn't exist — auto-create
      const { data: created, error: createErr } = await userClient
        .from('profiles')
        .insert({ id: req.user!.id, preferences: {} })
        .select('preferences')
        .single();

      if (createErr) {
        res.status(500).json({ error: createErr.message });
        return;
      }

      res.json(created?.preferences ?? {});
      return;
    }

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(profile?.preferences ?? {});
  } catch (err) {
    console.error('[preferences GET] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/user/preferences — JSONB merge (not replace)
router.put('/', async (req, res) => {
  try {
    const token = req.headers.authorization?.slice(7) ?? '';
    const userClient = createUserClient(token);

    // Ensure profile exists
    await userClient
      .from('profiles')
      .upsert({ id: req.user!.id, preferences: {} }, { onConflict: 'id', ignoreDuplicates: true });

    // Merge preferences using Postgres JSONB concatenation
    const { data, error } = await userClient.rpc('merge_preferences', {
      user_id_param: req.user!.id,
      new_prefs: req.body,
    });

    if (error) {
      // Fallback: read current, merge in-app, write back
      const { data: current } = await userClient
        .from('profiles')
        .select('preferences')
        .eq('id', req.user!.id)
        .single();

      const merged = { ...(current?.preferences as object ?? {}), ...req.body };

      const { data: updated, error: updateErr } = await userClient
        .from('profiles')
        .update({ preferences: merged })
        .eq('id', req.user!.id)
        .select('preferences')
        .single();

      if (updateErr) {
        res.status(500).json({ error: updateErr.message });
        return;
      }

      res.json(updated?.preferences ?? merged);
      return;
    }

    res.json(data);
  } catch (err) {
    console.error('[preferences PUT] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
