-- 001_stripe_subscriptions.sql
-- Adds Stripe subscription tracking and usage limits to profiles table

-- 1A. Add subscription columns to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id text UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text UNIQUE,
  ADD COLUMN IF NOT EXISTS subscription_status text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS billing_interval text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS current_period_end timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS monthly_annotation_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage_period_start date DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer
  ON profiles(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- 1B. Rename tier value 'pro' to 'standard'
UPDATE profiles SET tier = 'standard' WHERE tier = 'pro';

-- 1C. URL dedup table for monthly usage tracking
CREATE TABLE IF NOT EXISTS monthly_url_usage (
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  url_hash text NOT NULL,
  period_start date NOT NULL,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, url_hash, period_start)
);

CREATE INDEX IF NOT EXISTS idx_monthly_url_usage_user_period
  ON monthly_url_usage(user_id, period_start);

ALTER TABLE monthly_url_usage ENABLE ROW LEVEL SECURITY;

-- Service role policy (webhooks and backend use service client)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'monthly_url_usage' AND policyname = 'monthly_url_usage_service'
  ) THEN
    CREATE POLICY monthly_url_usage_service ON monthly_url_usage FOR ALL USING (true);
  END IF;
END
$$;

-- 1D. RPC function: check and record usage atomically
CREATE OR REPLACE FUNCTION check_and_record_usage(
  p_user_id uuid,
  p_url text,
  p_limit int
) RETURNS jsonb AS $$
DECLARE
  v_period date := date_trunc('month', now())::date;
  v_hash text := encode(sha256(p_url::bytea), 'hex');
  v_count int;
  v_exists boolean;
  v_rows_affected int;
BEGIN
  -- Lock the profile row to serialize concurrent usage checks for same user
  SELECT monthly_annotation_count INTO v_count
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  -- Reset counter if new month
  UPDATE profiles
  SET monthly_annotation_count = 0, usage_period_start = v_period
  WHERE id = p_user_id AND (usage_period_start IS NULL OR usage_period_start < v_period);

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected > 0 THEN
    v_count := 0;
  END IF;

  -- Check if this URL was already counted this month
  SELECT EXISTS(
    SELECT 1 FROM monthly_url_usage
    WHERE user_id = p_user_id AND url_hash = v_hash AND period_start = v_period
  ) INTO v_exists;

  IF v_exists THEN
    RETURN jsonb_build_object('allowed', true, 'already_counted', true, 'count', v_count);
  END IF;

  -- Check if limit reached
  IF v_count >= p_limit THEN
    RETURN jsonb_build_object('allowed', false, 'already_counted', false, 'count', v_count);
  END IF;

  -- Record the URL usage; ON CONFLICT DO NOTHING means ROW_COUNT=0 if duplicate
  INSERT INTO monthly_url_usage (user_id, url_hash, period_start)
  VALUES (p_user_id, v_hash, v_period)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

  -- Only increment if the insert actually added a new row
  IF v_rows_affected > 0 THEN
    UPDATE profiles SET monthly_annotation_count = monthly_annotation_count + 1
    WHERE id = p_user_id;
    v_count := v_count + 1;
  END IF;

  RETURN jsonb_build_object('allowed', true, 'already_counted', v_rows_affected = 0, 'count', v_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
