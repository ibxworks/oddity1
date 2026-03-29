import { Router } from 'express';
import type Stripe from 'stripe';
import { serviceClient } from '../lib/supabase.js';
import { getStripe } from '../lib/stripe.js';

const router = Router();

type BillingInterval = 'month' | 'quarter' | 'year';

function mapBillingInterval(
  interval: Stripe.Price.Recurring.Interval,
  intervalCount: number,
): BillingInterval {
  if (interval === 'year') return 'year';
  if (interval === 'month' && intervalCount === 3) return 'quarter';
  return 'month';
}

// POST /api/webhook/stripe — raw body, no auth
router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) {
    res.status(400).json({ error: 'Missing stripe-signature header' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.body as Buffer,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET ?? '',
    );
  } catch (err) {
    console.error('[webhook-stripe] Signature verification failed:', err);
    res.status(400).json({ error: 'Invalid webhook signature' });
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = (session.metadata?.user_id ?? session.client_reference_id) as string;
        const customerId = session.customer as string;
        const subscriptionId = session.subscription as string;

        if (!userId || !subscriptionId) {
          console.error('[webhook-stripe] checkout.session.completed: missing user_id or subscription_id');
          break;
        }

        const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
        const firstItem = subscription.items.data[0];
        const priceRecurring = firstItem?.price?.recurring;
        const billingInterval = priceRecurring
          ? mapBillingInterval(priceRecurring.interval, priceRecurring.interval_count ?? 1)
          : 'month';
        const currentPeriodEnd = firstItem?.current_period_end
          ? new Date(firstItem.current_period_end * 1000).toISOString()
          : null;

        const { data: updatedRows, error } = await serviceClient
          .from('profiles')
          .update({
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            tier: 'standard',
            subscription_status: subscription.status,
            billing_interval: billingInterval,
            current_period_end: currentPeriodEnd,
            cancel_at_period_end: false,
          })
          .eq('id', userId)
          .select('id');

        if (error) {
          console.error('[webhook-stripe] checkout.session.completed update error:', error.message);
          res.status(500).json({ error: 'Failed to process webhook' });
          return;
        }

        if (!updatedRows || updatedRows.length === 0) {
          console.error('[webhook-stripe] checkout.session.completed: no profile found for user_id', userId);
          res.status(500).json({ error: 'User profile not found' });
          return;
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        const { data: profile, error: fetchErr } = await serviceClient
          .from('profiles')
          .select('id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (fetchErr || !profile) {
          console.error('[webhook-stripe] customer.subscription.updated: user not found for customer', customerId);
          break;
        }

        const updatedFirstItem = subscription.items.data[0];
        const priceRecurring = updatedFirstItem?.price?.recurring;
        const billingInterval = priceRecurring
          ? mapBillingInterval(priceRecurring.interval, priceRecurring.interval_count ?? 1)
          : 'month';
        const currentPeriodEnd = updatedFirstItem?.current_period_end
          ? new Date(updatedFirstItem.current_period_end * 1000).toISOString()
          : null;

        const activeStatuses = ['active', 'trialing', 'past_due'];
        const tier = activeStatuses.includes(subscription.status) ? 'standard' : 'free';

        const { error } = await serviceClient
          .from('profiles')
          .update({
            subscription_status: subscription.status,
            current_period_end: currentPeriodEnd,
            cancel_at_period_end: subscription.cancel_at_period_end,
            billing_interval: billingInterval,
            tier,
          })
          .eq('id', profile.id);

        if (error) {
          console.error('[webhook-stripe] customer.subscription.updated update error:', error.message);
          res.status(500).json({ error: 'Failed to process webhook' });
          return;
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        const { data: profile, error: fetchErr } = await serviceClient
          .from('profiles')
          .select('id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (fetchErr || !profile) {
          console.error('[webhook-stripe] customer.subscription.deleted: user not found for customer', customerId);
          break;
        }

        const { error } = await serviceClient
          .from('profiles')
          .update({
            tier: 'free',
            stripe_subscription_id: null,
            subscription_status: null,
            billing_interval: null,
            current_period_end: null,
            cancel_at_period_end: false,
          })
          .eq('id', profile.id);

        if (error) {
          console.error('[webhook-stripe] customer.subscription.deleted update error:', error.message);
          res.status(500).json({ error: 'Failed to process webhook' });
          return;
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        const { data: profile, error: fetchErr } = await serviceClient
          .from('profiles')
          .select('id, stripe_subscription_id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (fetchErr || !profile) {
          console.error('[webhook-stripe] invoice.payment_failed: user not found for customer', customerId);
          break;
        }

        // Only mark past_due if user still has an active subscription.
        // Prevents a delayed payment_failed from re-elevating a cancelled user.
        if (!profile.stripe_subscription_id) {
          console.log('[webhook-stripe] invoice.payment_failed: user has no active subscription, skipping');
          break;
        }

        const { error } = await serviceClient
          .from('profiles')
          .update({ subscription_status: 'past_due' })
          .eq('id', profile.id);

        if (error) {
          console.error('[webhook-stripe] invoice.payment_failed update error:', error.message);
          res.status(500).json({ error: 'Failed to process webhook' });
          return;
        }
        break;
      }

      default:
        // Unhandled event — acknowledge receipt without action
        break;
    }
  } catch (err) {
    console.error('[webhook-stripe] Handler error:', err);
    // Return 500 so Stripe retries the webhook
    res.status(500).json({ error: 'Internal webhook handler error' });
    return;
  }

  res.status(200).json({ received: true });
});

export default router;
