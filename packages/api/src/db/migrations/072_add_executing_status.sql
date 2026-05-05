ALTER TABLE proposals ADD COLUMN IF NOT EXISTS claimed_by uuid;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_status_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
  CHECK (status IN ('draft', 'ready_for_review', 'approved', 'executing', 'rejected', 'expired', 'executed', 'execution_failed', 'undone'));
