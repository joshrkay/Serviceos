ALTER TYPE proposal_status ADD VALUE IF NOT EXISTS 'executing';
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS claimed_by uuid;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
