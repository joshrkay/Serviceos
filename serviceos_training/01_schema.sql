-- ServiceOS training corpus — Supabase / Postgres
-- Run in SQL Editor (Dashboard) once per project.
-- Uses service role from batch scripts; do not expose this table to anon without RLS.

-- pgvector (semantic search after embeddings are backfilled)
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Main table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS training_corpus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('submission', 'comment')),
  source_subreddit TEXT,
  reddit_permalink TEXT,
  created_utc TIMESTAMPTZ,
  raw_text TEXT NOT NULL,
  cleaned_text TEXT NOT NULL,
  language TEXT,
  triage_label TEXT NOT NULL CHECK (triage_label IN ('emergency', 'urgent', 'routine', 'unknown')),
  trade TEXT NOT NULL CHECK (trade IN ('plumbing', 'hvac', 'both')),
  fixture_tags TEXT[] NOT NULL DEFAULT '{}',
  trigger_phrases TEXT[] NOT NULL DEFAULT '{}',
  accent_signals TEXT[] NOT NULL DEFAULT '{}',
  is_layman BOOLEAN NOT NULL DEFAULT TRUE,
  confidence_score NUMERIC NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
  reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  -- text-embedding-3-small
  embedding VECTOR(1536),
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT training_corpus_source_id_key UNIQUE (source_id)
);

CREATE INDEX IF NOT EXISTS idx_training_corpus_triage ON training_corpus (triage_label);
CREATE INDEX IF NOT EXISTS idx_training_corpus_trade ON training_corpus (trade);
CREATE INDEX IF NOT EXISTS idx_training_corpus_subreddit ON training_corpus (source_subreddit);
CREATE INDEX IF NOT EXISTS idx_training_corpus_reviewed ON training_corpus (reviewed);

-- HNSW index for similarity search (only rows with embeddings)
CREATE INDEX IF NOT EXISTS idx_training_corpus_embedding_hnsw
  ON training_corpus
  USING hnsw (embedding vector_cosine_ops)
  WHERE (embedding IS NOT NULL);

COMMENT ON TABLE training_corpus IS 'Inbound AI training corpus; batch-ingested from Reddit archives. Upsert on source_id for idempotency.';

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW corpus_stats AS
SELECT
  triage_label,
  trade,
  source_subreddit,
  COUNT(*) AS row_count
FROM training_corpus
GROUP BY triage_label, trade, source_subreddit
ORDER BY row_count DESC;

CREATE OR REPLACE VIEW review_queue AS
SELECT *
FROM training_corpus
WHERE confidence_score >= 0.7
  AND reviewed = FALSE
ORDER BY confidence_score DESC, inserted_at ASC;

-- ---------------------------------------------------------------------------
-- Optional: keep updated_at fresh on UPDATE (batch upserts can set explicitly)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION training_corpus_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS training_corpus_set_updated_at ON training_corpus;
CREATE TRIGGER training_corpus_set_updated_at
  BEFORE UPDATE ON training_corpus
  FOR EACH ROW
  EXECUTE PROCEDURE training_corpus_touch_updated_at();
