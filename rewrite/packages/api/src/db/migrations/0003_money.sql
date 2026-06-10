-- Money loop: jobs, appointments, estimates, invoices, payments.
-- All money is integer cents; quantities are integer hundredths; tax rates
-- are basis points. CHECK constraints mirror @rivet/contracts enums (drift
-- tested in the integration suite).

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'unscheduled'
    CHECK (status IN ('unscheduled', 'scheduled', 'in_progress', 'done', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_tenant_idx ON jobs(tenant_id, created_at DESC);

CREATE TABLE appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX appointments_tenant_starts_idx ON appointments(tenant_id, starts_at);

CREATE TABLE estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'approved', 'declined', 'expired')),
  subtotal_cents BIGINT NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents BIGINT NOT NULL CHECK (tax_cents >= 0),
  total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
  tax_rate_bps INTEGER NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX estimates_tenant_idx ON estimates(tenant_id, created_at DESC);

CREATE TABLE estimate_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  estimate_id UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity_hundredths INTEGER NOT NULL CHECK (quantity_hundredths > 0),
  unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents >= 0),
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX estimate_line_items_estimate_idx ON estimate_line_items(estimate_id);

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'void')),
  subtotal_cents BIGINT NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents BIGINT NOT NULL CHECK (tax_cents >= 0),
  total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
  tax_rate_bps INTEGER NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  due_date DATE,
  sent_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invoices_tenant_idx ON invoices(tenant_id, created_at DESC);
CREATE INDEX invoices_tenant_status_idx ON invoices(tenant_id, status);

CREATE TABLE invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity_hundredths INTEGER NOT NULL CHECK (quantity_hundredths > 0),
  unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents >= 0),
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX invoice_line_items_invoice_idx ON invoice_line_items(invoice_id);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('card', 'cash', 'check', 'other')),
  external_ref TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_tenant_idx ON payments(tenant_id, received_at DESC);
-- Idempotency: a given external payment reference can only be recorded once.
CREATE UNIQUE INDEX payments_external_ref_idx ON payments(tenant_id, external_ref)
  WHERE external_ref IS NOT NULL;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'jobs', 'appointments', 'estimates', 'estimate_line_items',
    'invoices', 'invoice_line_items', 'payments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO rivet_app', t);
  END LOOP;
END $$;
