import { Router } from 'express';
import { getStripe } from '../lib/stripe.js';

const router = Router();

interface PriceOption {
  id: string;
  label: string;
  price: string;
  interval: string;
}

function toAppInterval(stripeInterval: string, intervalCount: number): string | null {
  if (stripeInterval === 'month' && intervalCount === 1) return 'month';
  if (stripeInterval === 'month' && intervalCount === 3) return 'quarter';
  if (stripeInterval === 'year' && intervalCount === 1) return 'year';
  return null;
}

function toLabel(appInterval: string): string {
  if (appInterval === 'month') return 'Monthly';
  if (appInterval === 'quarter') return 'Quarterly';
  if (appInterval === 'year') return 'Yearly';
  return appInterval;
}

function toPerMonthCents(unitAmount: number, appInterval: string): number {
  if (appInterval === 'year') return Math.round(unitAmount / 12);
  if (appInterval === 'quarter') return Math.round(unitAmount / 3);
  return unitAmount;
}

const ORDER: Record<string, number> = { year: 0, quarter: 1, month: 2 };

// GET /api/prices — public, no auth required
router.get('/', async (_req, res) => {
  try {
    const productId = process.env.STRIPE_STANDARD_PRODUCT_ID;
    if (!productId) {
      res.status(500).json({ error: 'Missing STRIPE_STANDARD_PRODUCT_ID' });
      return;
    }

    const { data: stripePrices } = await getStripe().prices.list({
      product: productId,
      active: true,
      limit: 10,
    });

    const prices: PriceOption[] = [];

    for (const p of stripePrices) {
      if (!p.recurring) continue;
      const appInterval = toAppInterval(p.recurring.interval, p.recurring.interval_count);
      if (!appInterval) continue;

      const perMonthCents = toPerMonthCents(p.unit_amount ?? 0, appInterval);
      prices.push({
        id: appInterval === 'month' ? 'monthly' : appInterval === 'quarter' ? 'quarterly' : 'yearly',
        label: toLabel(appInterval),
        price: (perMonthCents / 100).toFixed(2),
        interval: appInterval,
      });
    }

    prices.sort((a, b) => (ORDER[a.interval] ?? 99) - (ORDER[b.interval] ?? 99));

    res.json({ prices });
  } catch (err) {
    console.error('[prices] Error fetching Stripe prices:', err);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

export default router;
