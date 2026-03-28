-- Migration: Bridge stripe.subscriptions → profiles
-- The Stripe Sync Engine populates stripe.* mirror tables but never touches profiles.
-- This trigger fires on every change to stripe.subscriptions and keeps profiles in sync.

CREATE OR REPLACE FUNCTION public.sync_stripe_subscription_to_profile()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id uuid;
  v_tier text;
  v_billing_interval text;
  v_interval text;
  v_interval_count int;
BEGIN
  -- ── DELETE path ────────────────────────────────────────────────────────────
  IF TG_OP = 'DELETE' THEN
    -- Resolve user from subscription metadata → customer metadata fallback
    v_user_id := (OLD.metadata->>'user_id')::uuid;
    IF v_user_id IS NULL THEN
      SELECT (metadata->>'user_id')::uuid INTO v_user_id
      FROM stripe.customers WHERE id = OLD.customer;
    END IF;
    IF v_user_id IS NOT NULL THEN
      UPDATE public.profiles SET
        tier                  = 'free',
        stripe_subscription_id = NULL,
        subscription_status   = NULL,
        billing_interval      = NULL,
        current_period_end    = NULL,
        cancel_at_period_end  = false
      WHERE id = v_user_id;
    END IF;
    RETURN OLD;
  END IF;

  -- ── INSERT / UPDATE path ───────────────────────────────────────────────────
  v_user_id := (NEW.metadata->>'user_id')::uuid;
  IF v_user_id IS NULL THEN
    SELECT (metadata->>'user_id')::uuid INTO v_user_id
    FROM stripe.customers WHERE id = NEW.customer;
  END IF;
  -- No user mapping — skip silently (Stripe test events, etc.)
  IF v_user_id IS NULL THEN RETURN NEW; END IF;

  -- Determine tier: active/trialing/past_due → standard; anything else → free
  IF NEW.status IN ('active', 'trialing', 'past_due') THEN
    v_tier := 'standard';
  ELSE
    v_tier := 'free';
  END IF;

  -- If status is not active, clear subscription fields (matches subscription.deleted behavior)
  IF v_tier = 'free' THEN
    UPDATE public.profiles SET
      tier                  = 'free',
      stripe_subscription_id = NULL,
      subscription_status   = NULL,
      billing_interval      = NULL,
      current_period_end    = NULL,
      cancel_at_period_end  = false
    WHERE id = v_user_id;
    RETURN NEW;
  END IF;

  -- Map billing interval from subscription items (null-safe)
  v_interval       := NEW.items->'data'->0->'price'->'recurring'->>'interval';
  v_interval_count := COALESCE((NEW.items->'data'->0->'price'->'recurring'->>'interval_count')::int, 1);

  IF v_interval = 'year' THEN
    v_billing_interval := 'year';
  ELSIF v_interval = 'month' AND v_interval_count = 3 THEN
    v_billing_interval := 'quarter';
  ELSE
    v_billing_interval := 'month'; -- default / null-safe fallback
  END IF;

  -- Update profiles with live subscription state
  UPDATE public.profiles SET
    stripe_subscription_id = NEW.id,
    tier                   = 'standard',
    subscription_status    = NEW.status,
    cancel_at_period_end   = COALESCE(NEW.cancel_at_period_end, false),
    current_period_end     = CASE
                               WHEN NEW.current_period_end IS NOT NULL
                               THEN to_timestamp(NEW.current_period_end::double precision)
                               ELSE NULL
                             END,
    billing_interval       = v_billing_interval
  WHERE id = v_user_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for INSERT and UPDATE (webhook events + hourly worker reconciliation)
DROP TRIGGER IF EXISTS on_stripe_subscription_upsert ON stripe.subscriptions;
CREATE TRIGGER on_stripe_subscription_upsert
  AFTER INSERT OR UPDATE ON stripe.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.sync_stripe_subscription_to_profile();

-- Trigger for DELETE (sync engine removes hard-deleted/expired subscriptions)
DROP TRIGGER IF EXISTS on_stripe_subscription_delete ON stripe.subscriptions;
CREATE TRIGGER on_stripe_subscription_delete
  AFTER DELETE ON stripe.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.sync_stripe_subscription_to_profile();
