ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS execution_retry_count integer NOT NULL DEFAULT 0;
