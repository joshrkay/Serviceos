-- 147_tenant_settings_csr_seats.sql
-- Feature 5 (overflow handling): number of human CSR seats a tenant staffs.
-- When the live busy count reaches this, the AI handles overflow within hours.
-- Additive and nullable; NULL means "no human CSRs" so the AI always answers.
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS csr_seats INTEGER;
