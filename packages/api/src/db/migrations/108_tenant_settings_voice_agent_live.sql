-- 106_tenant_settings_voice_agent_live.sql
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS voice_agent_live_at TIMESTAMPTZ;
