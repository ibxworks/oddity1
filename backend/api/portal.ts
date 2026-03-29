import { Router } from 'express';
import { serviceClient } from '../lib/supabase.js';
import { stripe } from '../lib/stripe.js';

const router = Router();

// POST /api/portal
router.post('/', async (req, res) => {
  try {
    const userId = req.user!.id;

    const { data: profile, error } = await serviceClient
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('[portal] Profile fetch error:', error.message);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    if (!profile?.stripe_customer_id) {
      res.status(400).json({ error: 'No active subscription' });
      return;
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${process.env.DASHBOARD_URL || 'http://localhost:5173'}/settings?portal_return=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[portal] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
