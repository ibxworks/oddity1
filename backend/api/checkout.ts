import { Router } from 'express';
import { z } from 'zod';
import { serviceClient } from '../lib/supabase.js';
import { getStripe } from '../lib/stripe.js';

const router = Router();

const CheckoutRequestSchema = z.object({
  interval: z.enum(['month', 'quarter', 'year']),
});

const PRICE_ID_MAP: Record<string, string | undefined> = {
  month: process.env.STRIPE_STANDARD_PRICEID_MONTHLY,
  quarter: process.env.STRIPE_STANDARD_PRICEID_QUARTERLY,
  year: process.env.STRIPE_STANDARD_PRICEID_YEARLY,
};

// POST /api/checkout
router.post('/', async (req, res) => {
  try {
    const parsed = CheckoutRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const { interval } = parsed.data;
    const priceId = PRICE_ID_MAP[interval];
    if (!priceId) {
      res.status(500).json({ error: `Missing price ID env var for interval: ${interval}` });
      return;
    }

    const userId = req.user!.id;
    const userEmail = req.user!.email;

    // Fetch or create Stripe customer
    const { data: profile, error: profileErr } = await serviceClient
      .from('profiles')
      .select('stripe_customer_id, tier, stripe_subscription_id')
      .eq('id', userId)
      .single();

    if (profileErr && profileErr.code !== 'PGRST116') {
      console.error('[checkout] Profile fetch error:', profileErr.message);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    // Guard: prevent duplicate subscriptions
    if (profile?.tier === 'standard' && profile?.stripe_subscription_id) {
      res.status(409).json({ error: 'You already have an active subscription. Manage it from Settings.' });
      return;
    }

    let customerId: string = profile?.stripe_customer_id ?? '';

    if (!customerId) {
      const customer = await getStripe().customers.create({
        email: userEmail,
        metadata: { user_id: userId },
      });
      customerId = customer.id;

      const { error: updateErr } = await serviceClient
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId);

      if (updateErr) {
        console.error('[checkout] Failed to store customer ID:', updateErr.message);
        res.status(500).json({ error: 'Internal server error' });
        return;
      }
    }

    const dashboardUrl = process.env.DASHBOARD_URL;
    if (!dashboardUrl) {
      res.status(500).json({ error: 'DASHBOARD_URL not configured' });
      return;
    }

    const session = await getStripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: userId,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${dashboardUrl}/settings?checkout=success`,
      cancel_url: `${dashboardUrl}/plans?checkout=canceled`,
      subscription_data: {
        metadata: { user_id: userId },
      },
      metadata: { user_id: userId },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
