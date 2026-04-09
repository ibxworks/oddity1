-- Google Docs session persistence (chat history, essay versions, edit suggestions)

CREATE TABLE IF NOT EXISTS gdocs_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  doc_id text NOT NULL,
  chat_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  essay_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  edit_suggestions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_gdocs_sessions_user_doc ON gdocs_sessions (user_id, doc_id);

ALTER TABLE gdocs_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY gdocs_sessions_select_own ON gdocs_sessions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY gdocs_sessions_insert_own ON gdocs_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY gdocs_sessions_update_own ON gdocs_sessions
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY gdocs_sessions_delete_own ON gdocs_sessions
  FOR DELETE USING (auth.uid() = user_id);
