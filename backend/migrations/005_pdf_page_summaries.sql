CREATE TABLE IF NOT EXISTS pdf_page_summaries (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  url text NOT NULL,
  document_hash text NOT NULL,
  page_no text NOT NULL,
  page_text_hash text NOT NULL,
  summary text NOT NULL,
  page_title text DEFAULT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, url, document_hash, page_no)
);

CREATE INDEX IF NOT EXISTS idx_pdf_page_summaries_lookup
  ON pdf_page_summaries (user_id, url, document_hash);

ALTER TABLE pdf_page_summaries ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pdf_page_summaries'
      AND policyname = 'pdf_page_summaries_select_own'
  ) THEN
    CREATE POLICY pdf_page_summaries_select_own
      ON pdf_page_summaries
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pdf_page_summaries'
      AND policyname = 'pdf_page_summaries_insert_own'
  ) THEN
    CREATE POLICY pdf_page_summaries_insert_own
      ON pdf_page_summaries
      FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pdf_page_summaries'
      AND policyname = 'pdf_page_summaries_update_own'
  ) THEN
    CREATE POLICY pdf_page_summaries_update_own
      ON pdf_page_summaries
      FOR UPDATE
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pdf_page_summaries'
      AND policyname = 'pdf_page_summaries_delete_own'
  ) THEN
    CREATE POLICY pdf_page_summaries_delete_own
      ON pdf_page_summaries
      FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END
$$;
