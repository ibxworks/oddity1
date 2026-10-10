-- 008: per-provider PDF summary variants.
--
-- model_version participates in the cache identity so switching AI providers
-- or models never serves (or overwrites) another configuration's summary.
-- '' is the tier default and matches all pre-existing rows; override
-- configurations store their cache tag (provider:model:effort:base-hash).

ALTER TABLE pdf_page_summaries
  ADD COLUMN IF NOT EXISTS model_version text NOT NULL DEFAULT '';

ALTER TABLE pdf_page_summaries
  DROP CONSTRAINT IF EXISTS pdf_page_summaries_user_id_url_document_hash_page_no_key;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pdf_page_summaries_model_identity_key'
  ) THEN
    ALTER TABLE pdf_page_summaries
      ADD CONSTRAINT pdf_page_summaries_model_identity_key
      UNIQUE (user_id, url, document_hash, page_no, model_version);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pdf_page_summaries_model_lookup
  ON pdf_page_summaries (user_id, url, document_hash, page_no, model_version);
