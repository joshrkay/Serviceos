-- Platform: tenants, users, append-only events, transactional outbox,
-- webhook ingestion ledger.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  default_tax_rate_bps INTEGER NOT NULL DEFAULT 0
    CHECK (default_tax_rate_bps BETWEEN 0 AND 10000),
  ai_daily_quota INTEGER NOT NULL DEFAULT 500 CHECK (ai_daily_quota >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  clerk_user_id TEXT UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'tech')),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX users_tenant_idx ON users(tenant_id);
CREATE UNIQUE INDEX users_tenant_phone_idx ON users(tenant_id, phone) WHERE phone IS NOT NULL;

-- Append-only event log: the spine of audit, notifications and timelines.
CREATE TABLE events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'ai', 'system')),
  actor_id TEXT,
  correlation_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_tenant_created_idx ON events(tenant_id, created_at DESC);
CREATE INDEX events_entity_idx ON events(tenant_id, entity_type, entity_id);

CREATE OR REPLACE FUNCTION forbid_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events table is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_event_mutation();

-- Transactional outbox: side effects enqueued atomically with state changes,
-- drained into pg-boss by the platform worker.
CREATE TABLE outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT UNIQUE,
  not_before TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ
);
CREATE INDEX outbox_undispatched_idx ON outbox(created_at) WHERE dispatched_at IS NULL;

-- Webhook ingestion ledger (platform-level: tenant resolved during
-- processing, so no tenant_id / RLS here).
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'failed', 'skipped')),
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, external_id)
);

-- Tenant isolation: FORCE row level security on all tenant tables. The app
-- connects as a non-superuser role and sets app.tenant_id per transaction.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Application role grants. rivet_app has no BYPASSRLS; everything it does is
-- tenant-scoped. webhook_events is intentionally NOT granted: only the admin
-- pool (platform layer) touches it.
GRANT USAGE ON SCHEMA public TO rivet_app;
GRANT SELECT, INSERT, UPDATE ON tenants TO rivet_app;
GRANT SELECT, INSERT, UPDATE ON users TO rivet_app;
GRANT SELECT, INSERT ON events TO rivet_app;
GRANT SELECT, INSERT, UPDATE ON outbox TO rivet_app;
