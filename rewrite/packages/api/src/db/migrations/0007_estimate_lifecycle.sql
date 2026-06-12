-- Estimate lifecycle timestamps (sent / approved-or-declined).

ALTER TABLE estimates
  ADD COLUMN sent_at TIMESTAMPTZ,
  ADD COLUMN decided_at TIMESTAMPTZ;
