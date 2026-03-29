import { Router } from 'express';
import { serviceClient } from '../lib/supabase.js';

const router = Router();

// GET /api/subscription
router.get('/', async (req, res) => {
  try {
    const userId = req.user!.id;

    const { data: profile, error } = await serviceClient
      .from('profiles')
      .select(
        'tier, subscription_status, billing_interval, current_period_end, cancel_at_period_end, monthly_annotation_count, usage_period_start',
      )
      .eq('id', userId)
      .single();

    if (error) {
      console.error('[subscription] Profile fetch error:', error.message);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    // Use fresh DB tier for limit, not the middleware-cached tier
    const limit =
      profile.tier !== 'free'
        ? Number(process.env.STANDARD_PLAN_LIMIT_PER_MONTH ?? 2000)
        : Number(process.env.FREE_PLAN_LIMIT_PER_MONTH ?? 100);

    res.json({
      tier: profile.tier,
      subscription_status: profile.subscription_status ?? null,
      billing_interval: profile.billing_interval ?? null,
      current_period_end: profile.current_period_end ?? null,
      cancel_at_period_end: profile.cancel_at_period_end ?? false,
      usage: {
        count: profile.monthly_annotation_count ?? 0,
        limit,
        period_start: profile.usage_period_start ?? null,
      },
    });
  } catch (err) {
    console.error('[subscription] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
