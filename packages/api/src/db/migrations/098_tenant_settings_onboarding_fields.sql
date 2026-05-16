ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS business_hours      JSONB       NOT NULL DEFAULT '{}';
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS service_area_text   TEXT;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS service_area_radius INT;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS job_buffer_minutes  INT         NOT NULL DEFAULT 30;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS hourly_rate_cents   INT;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS onboarding_test_call_skipped_at      TIMESTAMPTZ;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS onboarding_upgrade_prompt_shown_at   TIMESTAMPTZ;
