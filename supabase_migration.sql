-- ServiceOS Sprint 1 — Supabase Migration
-- Run in Supabase SQL Editor → New Query → paste → Run

-- ============================================================
-- Extensions
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. tenants
-- ============================================================
CREATE TABLE IF NOT EXISTS tenants (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clerk_user_id TEXT UNIQUE NOT NULL,
  business_name TEXT NOT NULL,
  trade_type    TEXT NOT NULL CHECK (trade_type IN ('hvac', 'plumbing', 'painting')),
  owner_name    TEXT NOT NULL DEFAULT '',
  owner_email   TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_own ON tenants
  USING (clerk_user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- ============================================================
-- 2. customers
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  address       TEXT,
  total_jobs    INT NOT NULL DEFAULT 0,
  total_revenue INT NOT NULL DEFAULT 0, -- cents
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_customers_tenant ON customers(tenant_id);
CREATE INDEX idx_customers_name_trgm ON customers USING gin (name gin_trgm_ops);
CREATE UNIQUE INDEX idx_customers_tenant_phone ON customers(tenant_id, phone) WHERE phone IS NOT NULL;

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY customers_tenant ON customers
  USING (tenant_id IN (SELECT id FROM tenants WHERE clerk_user_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- ============================================================
-- 3. jobs
-- ============================================================
CREATE TABLE IF NOT EXISTS jobs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  amount_cents  INT NOT NULL DEFAULT 0,
  scheduled_at  TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_jobs_tenant ON jobs(tenant_id);
CREATE INDEX idx_jobs_customer ON jobs(customer_id);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY jobs_tenant ON jobs
  USING (tenant_id IN (SELECT id FROM tenants WHERE clerk_user_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- ============================================================
-- 4. invoices
-- ============================================================
CREATE TABLE IF NOT EXISTS invoices (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  job_id          UUID REFERENCES jobs(id) ON DELETE SET NULL,
  amount_cents    INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
  description     TEXT NOT NULL DEFAULT '',
  due_at          TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_tenant ON invoices(tenant_id);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_tenant ON invoices
  USING (tenant_id IN (SELECT id FROM tenants WHERE clerk_user_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- ============================================================
-- 5. conversations
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('contractor', 'assistant')),
  content         TEXT NOT NULL,
  input_method    TEXT NOT NULL DEFAULT 'text' CHECK (input_method IN ('text', 'voice')),
  proposal_json   JSONB,
  proposal_status TEXT CHECK (proposal_status IN ('pending', 'approved', 'edited', 'rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_tenant ON conversations(tenant_id);
CREATE INDEX idx_conversations_created ON conversations(tenant_id, created_at DESC);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_tenant ON conversations
  USING (tenant_id IN (SELECT id FROM tenants WHERE clerk_user_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- ============================================================
-- 6. corrections
-- ============================================================
CREATE TABLE IF NOT EXISTS corrections (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  original_intent     TEXT,
  corrected_intent    TEXT,
  original_customer   TEXT,
  corrected_customer  TEXT,
  original_amount     INT,  -- cents
  corrected_amount    INT,  -- cents
  original_service    TEXT,
  corrected_service   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_corrections_tenant ON corrections(tenant_id);

ALTER TABLE corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY corrections_tenant ON corrections
  USING (tenant_id IN (SELECT id FROM tenants WHERE clerk_user_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- ============================================================
-- Seed data (5 customers for testing — requires a tenant)
-- ============================================================
-- ============================================================
-- RPC: Fuzzy customer match (used by LangGraph agent)
-- ============================================================
CREATE OR REPLACE FUNCTION match_customer(
  p_tenant_id UUID,
  p_name TEXT,
  p_threshold FLOAT DEFAULT 0.3,
  p_limit INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  phone TEXT,
  address TEXT,
  sim_score FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id,
    c.name,
    c.phone,
    c.address,
    similarity(c.name, p_name)::FLOAT AS sim_score
  FROM customers c
  WHERE c.tenant_id = p_tenant_id
    AND similarity(c.name, p_name) > p_threshold
  ORDER BY sim_score DESC
  LIMIT p_limit;
$$;

-- ============================================================
-- Seed data (5 customers for testing — requires a tenant)
-- ============================================================
-- NOTE: After creating your first tenant via the app, run:
--
-- INSERT INTO customers (tenant_id, name, phone, address, total_jobs, total_revenue) VALUES
--   ('<your-tenant-id>', 'Mike Johnson',          '602-555-0101', '1234 Adams St, Phoenix AZ',    12, 1450000),
--   ('<your-tenant-id>', 'Johnson & Associates',   '602-555-0102', '5678 Oak Ave, Scottsdale AZ',  8,  2200000),
--   ('<your-tenant-id>', 'Sarah Chen',             '602-555-0103', '910 Elm Dr, Tempe AZ',          5,   875000),
--   ('<your-tenant-id>', 'Rodriguez Family',        '602-555-0104', '2468 Pine Ln, Mesa AZ',         3,   420000),
--   ('<your-tenant-id>', 'Williams Residence',      '602-555-0105', '1357 Oak Dr, Chandler AZ',      7,  1100000);
