-- BYOK: per-user LLM provider keys. Only ciphertext is stored here; the
-- plaintext key is encrypted with the server-side BYOK_ENCRYPTION_KEY and
-- never leaves the backend except over the user's own TLS link at save time.
-- Apply in Supabase Dashboard → SQL editor (no automated runner in this repo).

CREATE TABLE IF NOT EXISTS user_llm_keys (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  key_encrypted text NOT NULL,
  key_hint text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  base_url text NOT NULL DEFAULT '',
  reasoning_effort text NOT NULL DEFAULT 'default',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

ALTER TABLE user_llm_keys ENABLE ROW LEVEL SECURITY;

-- Service-role only: no user-facing policies. All access goes through the
-- backend, which decrypts with a secret the client never sees.
