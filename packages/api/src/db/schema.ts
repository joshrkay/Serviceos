export interface BaseEntity {
  id: string;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantRow {
  id: string;
  owner_id: string;
  owner_email: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export interface UserRow extends BaseEntity {
  clerkUserId: string;
  email: string;
  role: string;
  firstName?: string;
  lastName?: string;
}

export const MIGRATIONS = {
  // Platform & Auth

  '001_create_tenants': `
    CREATE TABLE IF NOT EXISTS tenants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id TEXT NOT NULL UNIQUE,
      owner_email TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tenants_owner ON tenants(owner_id);
  `,

  '002_create_users': `
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      clerk_user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'dispatcher', 'technician')),
      first_name TEXT,
      last_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_users_clerk ON users(clerk_user_id);
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_users ON users;
    CREATE POLICY tenant_isolation_users ON users
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '003_create_audit_events': `
    CREATE TABLE IF NOT EXISTS audit_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      actor_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      correlation_id TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_events(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_events(correlation_id);
    ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_audit ON audit_events;
    CREATE POLICY tenant_isolation_audit ON audit_events
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // Storage & Messaging

  '004_create_files': `
    CREATE TABLE IF NOT EXISTS files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      s3_bucket TEXT NOT NULL,
      s3_key TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      uploaded_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_files_tenant ON files(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_files_entity ON files(entity_type, entity_id);
    ALTER TABLE files ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_files ON files;
    CREATE POLICY tenant_isolation_files ON files
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '005_create_conversations': `
    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      title TEXT,
      entity_type TEXT,
      entity_id TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_entity ON conversations(entity_type, entity_id);
    ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_conversations ON conversations;
    CREATE POLICY tenant_isolation_conversations ON conversations
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '006_create_messages': `
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      conversation_id UUID NOT NULL REFERENCES conversations(id),
      message_type TEXT NOT NULL CHECK (message_type IN ('text', 'transcript', 'system_event', 'note')),
      content TEXT,
      sender_id TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      file_id UUID REFERENCES files(id),
      source TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);
    ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_messages ON messages;
    CREATE POLICY tenant_isolation_messages ON messages
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '007_create_voice_recordings': `
    CREATE TABLE IF NOT EXISTS voice_recordings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      file_id UUID NOT NULL REFERENCES files(id),
      conversation_id UUID REFERENCES conversations(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      transcript TEXT,
      transcript_metadata JSONB DEFAULT '{}',
      duration_seconds NUMERIC,
      error_message TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_voice_tenant ON voice_recordings(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_voice_status ON voice_recordings(status);
    ALTER TABLE voice_recordings ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_voice ON voice_recordings;
    CREATE POLICY tenant_isolation_voice ON voice_recordings
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // AI Foundations

  '008_create_ai_runs': `
    CREATE TABLE IF NOT EXISTS ai_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      task_type TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version_id UUID,
      input_snapshot JSONB NOT NULL DEFAULT '{}',
      output_snapshot JSONB,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      error_message TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      duration_ms INTEGER,
      token_usage JSONB DEFAULT '{}',
      correlation_id TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_runs_tenant ON ai_runs(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_ai_runs_task ON ai_runs(task_type);
    CREATE INDEX IF NOT EXISTS idx_ai_runs_prompt ON ai_runs(prompt_version_id);
    ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_ai_runs ON ai_runs;
    CREATE POLICY tenant_isolation_ai_runs ON ai_runs
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '009_create_prompt_versions': `
    CREATE TABLE IF NOT EXISTS prompt_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_type TEXT NOT NULL,
      version INTEGER NOT NULL,
      template TEXT NOT NULL,
      model TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT false,
      metadata JSONB DEFAULT '{}',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_task_version ON prompt_versions(task_type, version);
    CREATE INDEX IF NOT EXISTS idx_prompt_active ON prompt_versions(task_type, is_active) WHERE is_active = true;
  `,

  '010_create_document_revisions': `
    CREATE TABLE IF NOT EXISTS document_revisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      document_type TEXT NOT NULL CHECK (document_type IN ('estimate', 'invoice', 'proposal')),
      document_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot JSONB NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('manual', 'ai_generated', 'ai_revised')),
      actor_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      ai_run_id UUID REFERENCES ai_runs(id),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_doc_rev_tenant ON document_revisions(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_doc_rev_document ON document_revisions(document_type, document_id);
    ALTER TABLE document_revisions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_doc_rev ON document_revisions;
    CREATE POLICY tenant_isolation_doc_rev ON document_revisions
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '011_create_diff_analyses': `
    CREATE TABLE IF NOT EXISTS diff_analyses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      document_type TEXT NOT NULL,
      document_id TEXT NOT NULL,
      from_revision_id UUID NOT NULL REFERENCES document_revisions(id),
      to_revision_id UUID NOT NULL REFERENCES document_revisions(id),
      diff JSONB NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_diff_tenant ON diff_analyses(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_diff_document ON diff_analyses(document_type, document_id);
    ALTER TABLE diff_analyses ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_diffs ON diff_analyses;
    CREATE POLICY tenant_isolation_diffs ON diff_analyses
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '012_create_webhook_events': `
    CREATE TABLE IF NOT EXISTS webhook_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'failed')),
      error_message TEXT,
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_idempotency ON webhook_events(source, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_events(status);
  `,

  // Business Core

  '013_create_tenant_settings': `
    CREATE TABLE IF NOT EXISTS tenant_settings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id),
      business_name TEXT NOT NULL,
      business_phone TEXT,
      business_email TEXT,
      timezone TEXT NOT NULL DEFAULT 'America/New_York',
      estimate_prefix TEXT NOT NULL DEFAULT 'EST-',
      invoice_prefix TEXT NOT NULL DEFAULT 'INV-',
      next_estimate_number INTEGER NOT NULL DEFAULT 1,
      next_invoice_number INTEGER NOT NULL DEFAULT 1,
      default_payment_term_days INTEGER NOT NULL DEFAULT 30,
      terminology_preferences JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_settings ON tenant_settings;
    CREATE POLICY tenant_isolation_settings ON tenant_settings
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '014_create_customers': `
    CREATE TABLE IF NOT EXISTS customers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL,
      company_name TEXT,
      primary_phone TEXT,
      secondary_phone TEXT,
      email TEXT,
      preferred_channel TEXT NOT NULL DEFAULT 'none' CHECK (preferred_channel IN ('phone', 'email', 'sms', 'none')),
      sms_consent BOOLEAN NOT NULL DEFAULT false,
      communication_notes TEXT,
      is_archived BOOLEAN NOT NULL DEFAULT false,
      archived_at TIMESTAMPTZ,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(tenant_id, display_name);
    CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(tenant_id, email);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(tenant_id, primary_phone);
    ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
    ALTER TABLE customers FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_customers ON customers;
    CREATE POLICY tenant_isolation_customers ON customers
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '015_create_service_locations': `
    CREATE TABLE IF NOT EXISTS service_locations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      customer_id UUID NOT NULL REFERENCES customers(id),
      label TEXT,
      street1 TEXT NOT NULL,
      street2 TEXT,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'US',
      latitude NUMERIC,
      longitude NUMERIC,
      access_notes TEXT,
      is_primary BOOLEAN NOT NULL DEFAULT false,
      is_archived BOOLEAN NOT NULL DEFAULT false,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_locations_tenant ON service_locations(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_locations_customer ON service_locations(customer_id);
    ALTER TABLE service_locations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE service_locations FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_locations ON service_locations;
    CREATE POLICY tenant_isolation_locations ON service_locations
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '016_create_jobs': `
    CREATE TABLE IF NOT EXISTS jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      customer_id UUID NOT NULL REFERENCES customers(id),
      location_id UUID NOT NULL REFERENCES service_locations(id),
      job_number TEXT NOT NULL,
      summary TEXT NOT NULL,
      problem_description TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'scheduled', 'in_progress', 'completed', 'canceled')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      assigned_technician_id UUID REFERENCES users(id),
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(tenant_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_number ON jobs(tenant_id, job_number);
    ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_jobs ON jobs;
    CREATE POLICY tenant_isolation_jobs ON jobs
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '017_create_job_timeline_events': `
    CREATE TABLE IF NOT EXISTS job_timeline_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      job_id UUID NOT NULL REFERENCES jobs(id),
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      description TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_job ON job_timeline_events(job_id);
    CREATE INDEX IF NOT EXISTS idx_timeline_tenant ON job_timeline_events(tenant_id);
    ALTER TABLE job_timeline_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE job_timeline_events FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_timeline ON job_timeline_events;
    CREATE POLICY tenant_isolation_timeline ON job_timeline_events
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '018_create_appointments': `
    CREATE TABLE IF NOT EXISTS appointments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      job_id UUID NOT NULL REFERENCES jobs(id),
      scheduled_start TIMESTAMPTZ NOT NULL,
      scheduled_end TIMESTAMPTZ NOT NULL,
      arrival_window_start TIMESTAMPTZ,
      arrival_window_end TIMESTAMPTZ,
      timezone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'confirmed', 'in_progress', 'completed', 'canceled', 'no_show')),
      notes TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_appointments_tenant ON appointments(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_job ON appointments(job_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_schedule ON appointments(tenant_id, scheduled_start);
    ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_appointments ON appointments;
    CREATE POLICY tenant_isolation_appointments ON appointments
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '070_tenant_location_and_integrations': `
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS country CHAR(2) NOT NULL DEFAULT 'US',
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS locale TEXT;
    ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_us_region_check;
    -- QA-2026-06-04: NOT VALID — the runner re-executes every migration on
    -- every boot (no ledger), so a validating ADD CONSTRAINT here re-checks
    -- all rows each deploy; any tenant_settings row with a NULL region
    -- (which the relaxed 088 constraint explicitly allows) bricked the next
    -- deploy with 23514. NOT VALID keeps the strict intent for new writes in
    -- the 070→088 window without re-validating existing data; 088 drops it.
    ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_us_region_check
      CHECK (country <> 'US' OR (region IS NOT NULL AND btrim(region) ~ '^[A-Z]{2}$')) NOT VALID;

    CREATE TABLE IF NOT EXISTS tenant_integrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('twilio', 'sendgrid')),
      subaccount_sid TEXT,
      subuser_id TEXT,
      auth_token_primary_secret_ref TEXT,
      auth_token_secondary_secret_ref TEXT,
      credential_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'provisioning'
        CHECK (status IN ('provisioning', 'active', 'suspended', 'terminated', 'releasing', 'failed')),
      provider_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      provisioned_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_integrations_tenant ON tenant_integrations(tenant_id);
    ALTER TABLE tenant_integrations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_integrations FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_tenant_integrations ON tenant_integrations;
    CREATE POLICY tenant_isolation_tenant_integrations ON tenant_integrations
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

    CREATE TABLE IF NOT EXISTS tenant_provisioning_costs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('twilio', 'sendgrid')),
      currency CHAR(3) NOT NULL DEFAULT 'USD',
      amount_cents BIGINT NOT NULL DEFAULT 0,
      category TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      external_ref TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_provisioning_costs_tenant
      ON tenant_provisioning_costs(tenant_id, occurred_at DESC);
    ALTER TABLE tenant_provisioning_costs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_provisioning_costs FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_tenant_provisioning_costs ON tenant_provisioning_costs;
    CREATE POLICY tenant_isolation_tenant_provisioning_costs ON tenant_provisioning_costs
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '019_create_appointment_assignments': `
    CREATE TABLE IF NOT EXISTS appointment_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      appointment_id UUID NOT NULL REFERENCES appointments(id),
      technician_id UUID NOT NULL REFERENCES users(id),
      is_primary BOOLEAN NOT NULL DEFAULT true,
      assigned_by TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_assignments_appointment ON appointment_assignments(appointment_id);
    CREATE INDEX IF NOT EXISTS idx_assignments_technician ON appointment_assignments(technician_id);
    ALTER TABLE appointment_assignments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE appointment_assignments FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_assignments ON appointment_assignments;
    CREATE POLICY tenant_isolation_assignments ON appointment_assignments
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '020_create_estimates': `
    CREATE TABLE IF NOT EXISTS estimates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      job_id UUID NOT NULL REFERENCES jobs(id),
      estimate_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready_for_review', 'sent', 'accepted', 'rejected', 'expired')),
      discount_cents INTEGER NOT NULL DEFAULT 0,
      tax_rate_bps INTEGER NOT NULL DEFAULT 0,
      subtotal_cents INTEGER NOT NULL DEFAULT 0,
      taxable_subtotal_cents INTEGER NOT NULL DEFAULT 0,
      tax_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      valid_until TIMESTAMPTZ,
      customer_message TEXT,
      internal_notes TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_estimates_tenant ON estimates(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_estimates_job ON estimates(job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_estimates_number ON estimates(tenant_id, estimate_number);
    ALTER TABLE estimates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE estimates FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_estimates ON estimates;
    CREATE POLICY tenant_isolation_estimates ON estimates
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '021_create_estimate_line_items': `
    CREATE TABLE IF NOT EXISTS estimate_line_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      estimate_id UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      category TEXT CHECK (category IN ('labor', 'material', 'equipment', 'other')),
      quantity NUMERIC NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      taxable BOOLEAN NOT NULL DEFAULT true
    );
    CREATE INDEX IF NOT EXISTS idx_est_items_estimate ON estimate_line_items(estimate_id);
    ALTER TABLE estimate_line_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE estimate_line_items FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_est_items ON estimate_line_items;
    CREATE POLICY tenant_isolation_est_items ON estimate_line_items
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '022_create_estimate_provenance': `
    CREATE TABLE IF NOT EXISTS estimate_provenance (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      estimate_id UUID NOT NULL REFERENCES estimates(id),
      source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'ai_generated', 'ai_revised', 'template', 'cloned')),
      source_reference TEXT,
      creator_id TEXT NOT NULL,
      creator_role TEXT NOT NULL,
      ai_run_id UUID REFERENCES ai_runs(id),
      conversation_id UUID REFERENCES conversations(id),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_provenance_estimate ON estimate_provenance(estimate_id);
    ALTER TABLE estimate_provenance ENABLE ROW LEVEL SECURITY;
    ALTER TABLE estimate_provenance FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_provenance ON estimate_provenance;
    CREATE POLICY tenant_isolation_provenance ON estimate_provenance
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '023_create_estimate_approvals': `
    CREATE TABLE IF NOT EXISTS estimate_approvals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      estimate_id UUID NOT NULL REFERENCES estimates(id),
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'approved_with_edits', 'rejected')),
      approved_by TEXT,
      approved_at TIMESTAMPTZ,
      rejected_by TEXT,
      rejected_at TIMESTAMPTZ,
      rejection_reason TEXT,
      approved_with_edits BOOLEAN NOT NULL DEFAULT false,
      final_revision_id UUID REFERENCES document_revisions(id),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_estimate ON estimate_approvals(estimate_id);
    ALTER TABLE estimate_approvals ENABLE ROW LEVEL SECURITY;
    ALTER TABLE estimate_approvals FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_approvals ON estimate_approvals;
    CREATE POLICY tenant_isolation_approvals ON estimate_approvals
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '024_create_invoices': `
    CREATE TABLE IF NOT EXISTS invoices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      job_id UUID NOT NULL REFERENCES jobs(id),
      estimate_id UUID REFERENCES estimates(id),
      invoice_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'partially_paid', 'paid', 'void', 'canceled')),
      discount_cents INTEGER NOT NULL DEFAULT 0,
      tax_rate_bps INTEGER NOT NULL DEFAULT 0,
      subtotal_cents INTEGER NOT NULL DEFAULT 0,
      taxable_subtotal_cents INTEGER NOT NULL DEFAULT 0,
      tax_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      amount_paid_cents INTEGER NOT NULL DEFAULT 0,
      amount_due_cents INTEGER NOT NULL DEFAULT 0,
      issued_at TIMESTAMPTZ,
      due_date TIMESTAMPTZ,
      customer_message TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices(job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number ON invoices(tenant_id, invoice_number);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(tenant_id, status);
    ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
    ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_invoices ON invoices;
    CREATE POLICY tenant_isolation_invoices ON invoices
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '025_create_invoice_line_items': `
    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      category TEXT CHECK (category IN ('labor', 'material', 'equipment', 'other')),
      quantity NUMERIC NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      taxable BOOLEAN NOT NULL DEFAULT true
    );
    CREATE INDEX IF NOT EXISTS idx_inv_items_invoice ON invoice_line_items(invoice_id);
    ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE invoice_line_items FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_inv_items ON invoice_line_items;
    CREATE POLICY tenant_isolation_inv_items ON invoice_line_items
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '026_create_payments': `
    CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      invoice_id UUID NOT NULL REFERENCES invoices(id),
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'refunded')),
      payment_method TEXT NOT NULL DEFAULT 'stripe'
        CHECK (payment_method IN ('stripe', 'cash', 'check', 'other')),
      stripe_payment_intent_id TEXT,
      stripe_payment_link_id TEXT,
      reference_number TEXT,
      notes TEXT,
      paid_at TIMESTAMPTZ,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_payments_stripe_intent ON payments(stripe_payment_intent_id)
      WHERE stripe_payment_intent_id IS NOT NULL;
    ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE payments FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_payments ON payments;
    CREATE POLICY tenant_isolation_payments ON payments
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // Proposal Engine

  '027_create_proposals': `
    CREATE TABLE IF NOT EXISTS proposals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      proposal_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'approved_with_edits', 'rejected', 'expired', 'execution_failed')),
      payload JSONB NOT NULL DEFAULT '{}',
      confidence_score NUMERIC,
      target_entity_type TEXT,
      target_entity_id TEXT,
      ai_run_id UUID REFERENCES ai_runs(id),
      conversation_id UUID REFERENCES conversations(id),
      idempotency_key TEXT NOT NULL,
      expires_at TIMESTAMPTZ,
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      rejection_reason TEXT,
      execution_error TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_tenant ON proposals(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_proposals_type ON proposals(tenant_id, proposal_type);
    CREATE INDEX IF NOT EXISTS idx_proposals_ai_run ON proposals(ai_run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_idempotency ON proposals(tenant_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_proposals_target ON proposals(target_entity_type, target_entity_id);
    ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_proposals ON proposals;
    CREATE POLICY tenant_isolation_proposals ON proposals
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '028_create_proposal_analytics': `
    CREATE TABLE IF NOT EXISTS proposal_analytics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      proposal_id UUID NOT NULL REFERENCES proposals(id),
      proposal_type TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'approved_with_edits', 'rejected', 'expired', 'execution_failed')),
      edited_fields JSONB DEFAULT '[]',
      rejection_reason TEXT,
      confidence_score NUMERIC,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_tenant ON proposal_analytics(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_analytics_type ON proposal_analytics(proposal_type);
    CREATE INDEX IF NOT EXISTS idx_analytics_outcome ON proposal_analytics(outcome);
    ALTER TABLE proposal_analytics ENABLE ROW LEVEL SECURITY;
    ALTER TABLE proposal_analytics FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_analytics ON proposal_analytics;
    CREATE POLICY tenant_isolation_analytics ON proposal_analytics
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '029_create_evaluation_snapshots': `
    CREATE TABLE IF NOT EXISTS evaluation_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      proposal_id UUID NOT NULL REFERENCES proposals(id),
      ai_run_id UUID REFERENCES ai_runs(id),
      task_type TEXT NOT NULL,
      input JSONB NOT NULL DEFAULT '{}',
      output JSONB NOT NULL DEFAULT '{}',
      outcome JSONB NOT NULL DEFAULT '{}',
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_eval_tenant ON evaluation_snapshots(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_eval_task ON evaluation_snapshots(task_type);
    ALTER TABLE evaluation_snapshots ENABLE ROW LEVEL SECURITY;
    ALTER TABLE evaluation_snapshots FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_eval ON evaluation_snapshots;
    CREATE POLICY tenant_isolation_eval ON evaluation_snapshots
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // LLM Gateway

  '030_create_llm_cache': `
    CREATE TABLE IF NOT EXISTS llm_cache (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cache_key TEXT NOT NULL UNIQUE,
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      task_type TEXT NOT NULL,
      response JSONB NOT NULL,
      ttl_ms INTEGER NOT NULL,
      cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cache_key ON llm_cache(cache_key);
    CREATE INDEX IF NOT EXISTS idx_cache_tenant ON llm_cache(tenant_id);
    ALTER TABLE llm_cache ENABLE ROW LEVEL SECURITY;
    ALTER TABLE llm_cache FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_cache ON llm_cache;
    CREATE POLICY tenant_isolation_cache ON llm_cache
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '031_create_provider_health': `
    CREATE TABLE IF NOT EXISTS provider_health (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_name TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      success BOOLEAN NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_health_provider ON provider_health(provider_name);
    CREATE INDEX IF NOT EXISTS idx_health_recorded ON provider_health(recorded_at);
  `,

  // Vertical Packs & Intelligence

  '032_create_vertical_packs': `
    CREATE TABLE IF NOT EXISTS vertical_packs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type TEXT NOT NULL UNIQUE CHECK (type IN ('hvac', 'plumbing')),
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      description TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      categories JSONB NOT NULL DEFAULT '[]',
      terminology JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_vp_type ON vertical_packs(type);
    CREATE INDEX IF NOT EXISTS idx_vp_active ON vertical_packs(is_active);
  `,

  '033_create_estimate_templates': `
    CREATE TABLE IF NOT EXISTS estimate_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      vertical_type TEXT NOT NULL,
      category_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      line_item_templates JSONB NOT NULL DEFAULT '[]',
      default_discount_cents INTEGER NOT NULL DEFAULT 0,
      default_tax_rate_bps INTEGER NOT NULL DEFAULT 0,
      default_customer_message TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_et_tenant ON estimate_templates(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_et_category ON estimate_templates(tenant_id, category_id);
    CREATE INDEX IF NOT EXISTS idx_et_vertical ON estimate_templates(tenant_id, vertical_type);
    ALTER TABLE estimate_templates ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_templates ON estimate_templates;
    CREATE POLICY tenant_isolation_templates ON estimate_templates
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '034_create_service_bundles': `
    CREATE TABLE IF NOT EXISTS service_bundles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      vertical_type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      category_ids JSONB NOT NULL DEFAULT '[]',
      line_item_templates JSONB NOT NULL DEFAULT '[]',
      trigger_keywords JSONB NOT NULL DEFAULT '[]',
      is_active BOOLEAN NOT NULL DEFAULT true,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sb_tenant ON service_bundles(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_sb_vertical ON service_bundles(tenant_id, vertical_type);
    ALTER TABLE service_bundles ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_bundles ON service_bundles;
    CREATE POLICY tenant_isolation_bundles ON service_bundles
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '035_create_wording_preferences': `
    CREATE TABLE IF NOT EXISTS wording_preferences (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      vertical_type TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('line_item_description', 'customer_message', 'internal_note', 'estimate_header', 'estimate_footer')),
      key TEXT NOT NULL,
      preferred_wording TEXT NOT NULL,
      avoid_wordings JSONB NOT NULL DEFAULT '[]',
      context TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wp_tenant ON wording_preferences(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_wp_scope ON wording_preferences(tenant_id, scope);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wp_tenant_scope_key ON wording_preferences(tenant_id, scope, key);
    ALTER TABLE wording_preferences ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_wording ON wording_preferences;
    CREATE POLICY tenant_isolation_wording ON wording_preferences
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '036_create_quality_metrics': `
    CREATE TABLE IF NOT EXISTS quality_metrics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      metric_name TEXT NOT NULL,
      value NUMERIC NOT NULL,
      metadata JSONB DEFAULT '{}',
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_qm_tenant ON quality_metrics(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_qm_metric ON quality_metrics(tenant_id, metric_name);
    CREATE INDEX IF NOT EXISTS idx_qm_recorded ON quality_metrics(recorded_at);
    ALTER TABLE quality_metrics ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_qm ON quality_metrics;
    CREATE POLICY tenant_isolation_qm ON quality_metrics
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '037_create_notes': `
    CREATE TABLE IF NOT EXISTS notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      entity_type TEXT NOT NULL CHECK (entity_type IN ('customer', 'location', 'job', 'estimate', 'invoice')),
      entity_id TEXT NOT NULL,
      content TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_role TEXT NOT NULL,
      is_pinned BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notes_tenant ON notes(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_notes_entity ON notes(entity_type, entity_id);
    ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE notes FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_notes ON notes;
    CREATE POLICY tenant_isolation_notes ON notes
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '038_create_pack_activations': `
    CREATE TABLE IF NOT EXISTS pack_activations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      pack_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
      activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deactivated_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_pack_act_tenant ON pack_activations(tenant_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pack_act_unique ON pack_activations(tenant_id, pack_id);
    ALTER TABLE pack_activations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pack_activations FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_pack_act ON pack_activations;
    CREATE POLICY tenant_isolation_pack_act ON pack_activations
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '039_proposals_v2': `
    ALTER TABLE proposals
      ADD COLUMN IF NOT EXISTS summary TEXT,
      ADD COLUMN IF NOT EXISTS explanation TEXT,
      ADD COLUMN IF NOT EXISTS confidence_factors JSONB,
      ADD COLUMN IF NOT EXISTS source_context JSONB,
      ADD COLUMN IF NOT EXISTS prompt_version_id UUID,
      ADD COLUMN IF NOT EXISTS result_entity_id TEXT,
      ADD COLUMN IF NOT EXISTS rejection_details TEXT,
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS executed_by TEXT,
      ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS undone_by TEXT;
    ALTER TABLE proposals ALTER COLUMN idempotency_key DROP NOT NULL;
    ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_status_check;
    ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
      CHECK (status IN ('draft', 'ready_for_review', 'approved', 'rejected', 'expired', 'executed', 'execution_failed', 'undone'));
  `,

  '040_create_technician_location_pings': `
    CREATE TABLE IF NOT EXISTS technician_location_pings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      technician_id TEXT NOT NULL,
      appointment_id UUID REFERENCES appointments(id),
      lat DOUBLE PRECISION NOT NULL CHECK (lat >= -90 AND lat <= 90),
      lng DOUBLE PRECISION NOT NULL CHECK (lng >= -180 AND lng <= 180),
      accuracy_meters DOUBLE PRECISION CHECK (accuracy_meters IS NULL OR accuracy_meters >= 0),
      speed_mps DOUBLE PRECISION CHECK (speed_mps IS NULL OR speed_mps >= 0),
      heading DOUBLE PRECISION CHECK (heading IS NULL OR (heading >= 0 AND heading < 360)),
      recorded_at TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tlp_tenant_technician_recorded_desc
      ON technician_location_pings(tenant_id, technician_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tlp_tenant_appointment_recorded_desc
      ON technician_location_pings(tenant_id, appointment_id, recorded_at DESC);
    ALTER TABLE technician_location_pings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE technician_location_pings FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_technician_location_pings ON technician_location_pings;
    CREATE POLICY tenant_isolation_technician_location_pings ON technician_location_pings
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '041_create_catalog_items': `
    CREATE TABLE IF NOT EXISTS catalog_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL CHECK (category IN ('Labor', 'Parts', 'Materials')),
      unit TEXT NOT NULL CHECK (unit IN ('each', 'hour', 'sq ft', 'per lb', 'per gal')),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      product_service_type TEXT NOT NULL CHECK (product_service_type IN ('product', 'service')),
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_items_tenant ON catalog_items(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_catalog_items_tenant_category ON catalog_items(tenant_id, category);
    CREATE INDEX IF NOT EXISTS idx_catalog_items_active ON catalog_items(tenant_id) WHERE archived_at IS NULL;
    ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE catalog_items FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_catalog_items ON catalog_items;
    CREATE POLICY tenant_isolation_catalog_items ON catalog_items
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,


  '042_create_feedback_requests': `
    CREATE TABLE IF NOT EXISTS feedback_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      job_id UUID NOT NULL REFERENCES jobs(id),
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_requests_tenant ON feedback_requests(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_requests_job ON feedback_requests(tenant_id, job_id);
    ALTER TABLE feedback_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE feedback_requests FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_feedback_requests ON feedback_requests;
    CREATE POLICY tenant_isolation_feedback_requests ON feedback_requests
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '043_create_feedback_responses': `
    CREATE TABLE IF NOT EXISTS feedback_responses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      request_id UUID NOT NULL REFERENCES feedback_requests(id) ON DELETE CASCADE,
      job_id UUID NOT NULL REFERENCES jobs(id),
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_responses_request ON feedback_responses(request_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_responses_tenant_submitted ON feedback_responses(tenant_id, submitted_at DESC);
    ALTER TABLE feedback_responses ENABLE ROW LEVEL SECURITY;
    ALTER TABLE feedback_responses FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_feedback_responses ON feedback_responses;
    CREATE POLICY tenant_isolation_feedback_responses ON feedback_responses
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // Renamed from 044_* to 049_* after merge: upstream main also added a
  // 044_create_ai_artifacts (P0-021). Keys are alphabetical at runtime so the
  // exact number is informational; uniqueness matters because duplicates would
  // silently lose a migration.
  '049_add_view_tokens_to_estimates_and_invoices': `
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS view_token TEXT;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS last_dispatch_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_estimates_view_token ON estimates(view_token) WHERE view_token IS NOT NULL;

    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS view_token TEXT;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_dispatch_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_view_token ON invoices(view_token) WHERE view_token IS NOT NULL;
  `,

  '045_create_message_dispatches': `
    CREATE TABLE IF NOT EXISTS message_dispatches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      entity_type TEXT NOT NULL CHECK (entity_type IN ('estimate', 'invoice')),
      entity_id UUID NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
      recipient TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'failed', 'bounced')),
      error_message TEXT,
      idempotency_key TEXT,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_dispatches_tenant_entity ON message_dispatches(tenant_id, entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_dispatches_provider_msg ON message_dispatches(provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_idempotency ON message_dispatches(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    ALTER TABLE message_dispatches ENABLE ROW LEVEL SECURITY;
    ALTER TABLE message_dispatches FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_message_dispatches ON message_dispatches;
    CREATE POLICY tenant_isolation_message_dispatches ON message_dispatches
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P0-019 — Postgres-backed AssignmentRepository.
  //
  // The `appointment_assignments` table itself was created by migration
  // `019_create_appointment_assignments` (with RLS, tenant_isolation policy,
  // and single-column indexes on appointment_id and technician_id).
  //
  // This migration is idempotent and:
  //   * Re-asserts RLS + tenant_isolation policy (defense-in-depth — safe no-op
  //     when the policy already matches).
  //   * Adds composite indexes `(tenant_id, appointment_id)` and
  //     `(tenant_id, technician_id)` to support the access patterns used by
  //     `PgAssignmentRepository.findByAppointment` / `findByTechnician`,
  //     which always filter by tenant_id first as defense-in-depth.
  '048_create_assignments': `
    CREATE TABLE IF NOT EXISTS appointment_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      appointment_id UUID NOT NULL REFERENCES appointments(id),
      technician_id UUID NOT NULL REFERENCES users(id),
      is_primary BOOLEAN NOT NULL DEFAULT true,
      assigned_by TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_assignments_tenant_appointment
      ON appointment_assignments(tenant_id, appointment_id);
    CREATE INDEX IF NOT EXISTS idx_assignments_tenant_technician
      ON appointment_assignments(tenant_id, technician_id);
    ALTER TABLE appointment_assignments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE appointment_assignments FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_assignments ON appointment_assignments;
    CREATE POLICY tenant_isolation_assignments ON appointment_assignments
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P0-021 — Postgres-backed AI artifacts: document_revisions + diff_analyses.
  //
  // Both tables are append-only (the audit trail invariant). The Pg
  // repositories implement create + read methods only; diff_analyses additionally
  // exposes updateStatus to advance the worker state machine
  // (pending -> processing -> completed/failed).
  //
  // Column-type rationale (driven by InMemory entity types):
  //   * document_revisions.id is generated via uuidv4() in createRevision()
  //     so we use UUID with gen_random_uuid() default.
  //   * document_revisions.actor_id is TEXT (not UUID) — Clerk user ids are
  //     TEXT throughout this codebase (see users.clerk_user_id, tenants.owner_id,
  //     audit_events.actor_id).
  //   * document_revisions.document_id is TEXT — the InMemory entity treats
  //     documentId as an opaque string and several callers may pass non-UUID
  //     ids (estimates / invoices / proposals across surfaces).
  //   * diff_analyses.id is TEXT (not UUID) because diffAnalysisIdFor() builds
  //     a deterministic key like `diff:<tenantId>:<docType>:<docId>:<from>:<to>`
  //     so re-enqueueing the same revision pair is end-to-end idempotent.
  //   * diff_analyses.diff is JSONB storing the DiffEntry[] array.
  '044_create_ai_artifacts': `
    CREATE TABLE IF NOT EXISTS document_revisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      document_type TEXT NOT NULL CHECK (document_type IN ('estimate', 'invoice', 'proposal')),
      document_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot JSONB NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('manual', 'ai_generated', 'ai_revised')),
      actor_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      ai_run_id UUID,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, document_type, document_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_document_revisions_tenant_doc
      ON document_revisions(tenant_id, document_type, document_id);
    ALTER TABLE document_revisions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE document_revisions FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_document_revisions ON document_revisions;
    CREATE POLICY tenant_isolation_document_revisions ON document_revisions
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

    CREATE TABLE IF NOT EXISTS diff_analyses (
      id TEXT PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      document_type TEXT NOT NULL,
      document_id TEXT NOT NULL,
      from_revision_id UUID NOT NULL REFERENCES document_revisions(id),
      to_revision_id UUID NOT NULL REFERENCES document_revisions(id),
      diff JSONB NOT NULL DEFAULT '[]'::jsonb,
      summary TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_diff_analyses_tenant_doc
      ON diff_analyses(tenant_id, document_type, document_id);
    CREATE INDEX IF NOT EXISTS idx_diff_analyses_revisions
      ON diff_analyses(tenant_id, from_revision_id, to_revision_id);
    ALTER TABLE diff_analyses ENABLE ROW LEVEL SECURITY;
    ALTER TABLE diff_analyses FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_diff_analyses ON diff_analyses;
    CREATE POLICY tenant_isolation_diff_analyses ON diff_analyses
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '046_estimate_view_expiry_and_acceptance': `
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS view_token_expires_at TIMESTAMPTZ;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS first_viewed_at TIMESTAMPTZ;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS accepted_by_name TEXT;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS accepted_by_ip TEXT;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS accepted_user_agent TEXT;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS accepted_signature_data TEXT;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS rejected_reason TEXT;
  `,

  '047_invoice_view_expiry': `
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS view_token_expires_at TIMESTAMPTZ;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS first_viewed_at TIMESTAMPTZ;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;
  `,

  '050_invoice_stripe_payment_link': `
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_payment_link_id TEXT;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_payment_link_url TEXT;
  `,

  // ── Phase 8: Customer Calling Agent ────────────────────────────────────────

  // P8-001: pg_trgm fuzzy-match indexes for entity resolution
  '051_p8_entity_resolution_indexes': `
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS idx_customers_name_trgm
      ON customers USING GIN (display_name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_jobs_title_trgm
      ON jobs USING GIN (summary gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_invoices_number_trgm
      ON invoices USING GIN (invoice_number gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_appointments_scheduled_for
      ON appointments (tenant_id, scheduled_start);
  `,

  // P8-002: tenant-local DNC list for compliance skill
  '052_p8_tenant_dnc_list': `
    CREATE TABLE IF NOT EXISTS tenant_dnc_list (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      phone TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dnc_tenant_phone
      ON tenant_dnc_list (tenant_id, phone);
    ALTER TABLE tenant_dnc_list ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_dnc ON tenant_dnc_list;
    CREATE POLICY tenant_isolation_dnc ON tenant_dnc_list
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P8-006: normalized phone index for identify_caller skill
  '053_p8_customers_phone_index': `
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_normalized TEXT
      GENERATED ALWAYS AS (regexp_replace(primary_phone, '[^0-9]', '', 'g')) STORED;
    CREATE INDEX IF NOT EXISTS idx_customers_phone_normalized
      ON customers (tenant_id, phone_normalized);
  `,

  // P8-008 + P8-014: on-call rotation, call summaries, voice_recordings extensions
  '054_p8_telephony_tables': `
    CREATE TABLE IF NOT EXISTS tenant_oncall_rotation (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      user_id UUID NOT NULL REFERENCES users(id),
      order_index INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_oncall_tenant_order
      ON tenant_oncall_rotation (tenant_id, order_index) WHERE active = true;
    ALTER TABLE tenant_oncall_rotation ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_oncall ON tenant_oncall_rotation;
    CREATE POLICY tenant_isolation_oncall ON tenant_oncall_rotation
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

    CREATE TABLE IF NOT EXISTS call_summaries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      call_id UUID REFERENCES voice_recordings(id),
      summary TEXT NOT NULL,
      detected_intent TEXT,
      proposal_ids UUID[] DEFAULT '{}',
      quality_score NUMERIC(3,2),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE call_summaries ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_call_summaries ON call_summaries;
    CREATE POLICY tenant_isolation_call_summaries ON call_summaries
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
    -- Partial unique index: idempotent retries of summarizeSession for the
    -- same recording collide cleanly. NULL call_id (no recording yet) is
    -- intentionally excluded so multiple in-app sessions can coexist.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_call_summaries_tenant_call
      ON call_summaries (tenant_id, call_id)
      WHERE call_id IS NOT NULL;

    ALTER TABLE voice_recordings
      ADD COLUMN IF NOT EXISTS call_sid TEXT,
      ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'inapp_voice'
        CHECK (source IN ('inbound_call', 'inapp_voice', 'batch_upload')),
      ADD COLUMN IF NOT EXISTS recording_url TEXT;
    CREATE INDEX IF NOT EXISTS idx_voice_call_sid
      ON voice_recordings (call_sid) WHERE call_sid IS NOT NULL;
  `,

  '056_create_service_agreements': `
    CREATE TABLE IF NOT EXISTS service_agreements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      customer_id UUID NOT NULL REFERENCES customers(id),
      location_id UUID REFERENCES service_locations(id),
      name TEXT NOT NULL,
      description TEXT,
      recurrence_rule TEXT NOT NULL,
      price_cents BIGINT NOT NULL DEFAULT 0,
      auto_generate_invoice BOOLEAN NOT NULL DEFAULT TRUE,
      auto_generate_job BOOLEAN NOT NULL DEFAULT TRUE,
      next_run_at TIMESTAMPTZ NOT NULL,
      last_run_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
      starts_on DATE NOT NULL,
      ends_on DATE,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agreements_tenant ON service_agreements(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_agreements_customer ON service_agreements(tenant_id, customer_id);
    CREATE INDEX IF NOT EXISTS idx_agreements_status_next ON service_agreements(tenant_id, status, next_run_at);
    ALTER TABLE service_agreements ENABLE ROW LEVEL SECURITY;
    ALTER TABLE service_agreements FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_service_agreements ON service_agreements;
    CREATE POLICY tenant_isolation_service_agreements ON service_agreements
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

    CREATE TABLE IF NOT EXISTS service_agreement_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      agreement_id UUID NOT NULL REFERENCES service_agreements(id) ON DELETE CASCADE,
      scheduled_for DATE NOT NULL,
      generated_job_id UUID,
      generated_invoice_id UUID,
      status TEXT NOT NULL CHECK (status IN ('pending','generated','skipped','failed')),
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agreement_id, scheduled_for)
    );
    CREATE INDEX IF NOT EXISTS idx_agreement_runs_tenant ON service_agreement_runs(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_agreement_runs_agreement ON service_agreement_runs(tenant_id, agreement_id);
    ALTER TABLE service_agreement_runs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE service_agreement_runs FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_service_agreement_runs ON service_agreement_runs;
    CREATE POLICY tenant_isolation_service_agreement_runs ON service_agreement_runs
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P9-001: Lead pipeline table. PgLeadRepository writes to this; previously
  // the table was created out-of-band (tests run against InMemory).
  //
  // The original P9-001 migration shipped without the `phone_normalized`
  // generated column; the column + matching indexes are added in
  // `058_leads_phone_normalized` so existing production databases (which
  // already ran a CREATE TABLE that didn't include the generated column)
  // still converge. Do NOT add `phone_normalized` back to this CREATE
  // TABLE — `CREATE TABLE IF NOT EXISTS` is a no-op on existing tables,
  // so any column added here would be silently skipped on the first DB
  // that ran `055_create_leads` / the original `057_create_leads`.
  '057_create_leads': `
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      company_name TEXT,
      primary_phone TEXT,
      email TEXT,
      source TEXT NOT NULL CHECK (source IN ('web_form','phone_call','referral','walk_in','marketplace','other')),
      source_detail TEXT,
      stage TEXT NOT NULL CHECK (stage IN ('new','contacted','qualified','quoted','won','lost')),
      estimated_value_cents BIGINT,
      notes TEXT,
      assigned_user_id UUID,
      converted_customer_id UUID,
      lost_reason TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_stage ON leads(tenant_id, stage);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_source ON leads(tenant_id, source);
    ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
    ALTER TABLE leads FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_leads ON leads;
    CREATE POLICY tenant_isolation_leads ON leads
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // Add `phone_normalized` to leads as a generated column so the
  // inbound-receptionist dedupe skill can index-lookup unknown callers
  // in O(1). Split out from `057_create_leads` because that migration
  // had already shipped to production without this column; the in-place
  // mutation that added the column to the CREATE TABLE was a no-op
  // there (`CREATE TABLE IF NOT EXISTS` skips when the table exists),
  // and the indexes that followed crashed startup with
  // `column "phone_normalized" does not exist`. ALTER TABLE … ADD
  // COLUMN IF NOT EXISTS converges fresh and existing DBs on the same
  // shape.
  //
  // The partial unique index keeps a (tenant_id, phone_normalized) pair
  // unique only while the lead is still open (converted_customer_id IS
  // NULL) so a contact can become a fresh lead again after they were
  // previously converted to a customer.
  '058_leads_phone_normalized': `
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS phone_normalized TEXT GENERATED ALWAYS AS (
        regexp_replace(
          regexp_replace(COALESCE(primary_phone, ''), '[^0-9]', '', 'g'),
          '^1([0-9]{10})$', '\\1'
        )
      ) STORED;
    CREATE INDEX IF NOT EXISTS idx_leads_phone_normalized
      ON leads (tenant_id, phone_normalized)
      WHERE phone_normalized <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_phone_unique_open
      ON leads (tenant_id, phone_normalized)
      WHERE phone_normalized <> '' AND converted_customer_id IS NULL;
  `,

  // Lead source attribution + originating-lead FK chain.
  //   - Adds richer marketing attribution to leads (UTM cols + JSONB blob).
  //   - Adds nullable originating_lead_id FK to customers/jobs/invoices so
  //     we can answer "which lead/source generated this revenue?" via a
  //     single join. Estimates and payments deliberately omit the column;
  //     they reach attribution via estimate.job_id / payment.invoice_id.
  '059_lead_attribution': `
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS utm_source   TEXT,
      ADD COLUMN IF NOT EXISTS utm_medium   TEXT,
      ADD COLUMN IF NOT EXISTS utm_campaign TEXT,
      ADD COLUMN IF NOT EXISTS attribution  JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE INDEX IF NOT EXISTS idx_leads_utm_campaign
      ON leads (tenant_id, utm_campaign) WHERE utm_campaign IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_leads_utm_source_medium
      ON leads (tenant_id, utm_source, utm_medium) WHERE utm_source IS NOT NULL;

    ALTER TABLE customers
      ADD COLUMN IF NOT EXISTS originating_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL;
    ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS originating_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL;
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS originating_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_customers_originating_lead
      ON customers (tenant_id, originating_lead_id) WHERE originating_lead_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_jobs_originating_lead
      ON jobs (tenant_id, originating_lead_id) WHERE originating_lead_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_invoices_originating_lead
      ON invoices (tenant_id, originating_lead_id) WHERE originating_lead_id IS NOT NULL;
  `,

  // Phase 2 of the inbound-CSR training-data architecture (RAG corpus). Adds
  // the four capture surfaces the downstream ingestion workers and quality
  // dashboards need:
  //
  //   1. call_transcript_turns      — per-turn rows so the in-memory FSM
  //                                   transcript survives a process restart
  //                                   and the transcript-ingestion-worker
  //                                   (Phase 4a) has stable input.
  //   2. proposal_executions        — captures the as-executed payload
  //                                   alongside the immutable proposals.payload
  //                                   so the proposal-correction-worker
  //                                   (Phase 4a) can diff the two and emit a
  //                                   training chunk. Multiple rows allowed
  //                                   per proposal (retry, undo + redo).
  //   3. voice_recordings.outcome   — terminal-state enum stamped by the FSM
  //                                   at hangup so analytics can correlate
  //                                   recording rows with what actually
  //                                   happened on the call.
  //   4. retrieval_eval_runs        — quality measurement table built in from
  //                                   day one so we can prove RAG retrieval
  //                                   helps before flipping the default. Each
  //                                   row links a query → retrieved chunks →
  //                                   downstream proposal → downstream outcome.
  //
  // Originally merged via PR #233 but silently dropped in the merge that
  // landed PR #229 onto main. Restored verbatim here; the immutability
  // snapshot's hash matches PR #233's original block.
  '060_capture_schema': `
    CREATE TABLE IF NOT EXISTS call_transcript_turns (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      voice_recording_id UUID NOT NULL REFERENCES voice_recordings(id) ON DELETE CASCADE,
      turn_index         INTEGER NOT NULL,
      speaker            TEXT NOT NULL CHECK (speaker IN ('agent', 'caller')),
      text               TEXT NOT NULL,
      started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at       TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (turn_index >= 0)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_call_transcript_turns_recording
      ON call_transcript_turns (voice_recording_id, turn_index);
    CREATE INDEX IF NOT EXISTS idx_call_transcript_turns_tenant
      ON call_transcript_turns (tenant_id, created_at DESC);
    ALTER TABLE call_transcript_turns ENABLE ROW LEVEL SECURITY;
    ALTER TABLE call_transcript_turns FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_call_transcript_turns ON call_transcript_turns;
    CREATE POLICY tenant_isolation_call_transcript_turns ON call_transcript_turns
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

    CREATE TABLE IF NOT EXISTS proposal_executions (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      proposal_id      UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      executed_payload JSONB NOT NULL,
      executed_by      TEXT NOT NULL,
      executed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status           TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'undone')),
      error_message    TEXT,
      idempotency_key  TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_proposal_executions_proposal
      ON proposal_executions (proposal_id, executed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proposal_executions_tenant
      ON proposal_executions (tenant_id, executed_at DESC);
    -- Idempotency: same (tenant, proposal, key) collides cleanly. Partial so
    -- rows without an idempotency_key (legacy or undo paths) coexist freely.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_executions_idempotency
      ON proposal_executions (tenant_id, proposal_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    ALTER TABLE proposal_executions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE proposal_executions FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_proposal_executions ON proposal_executions;
    CREATE POLICY tenant_isolation_proposal_executions ON proposal_executions
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

    -- Terminal-state enum on voice_recordings. NULL until the FSM stamps it
    -- at hangup; backfillable from call_summaries.quality_score + escalation
    -- audit signals (separate ops job).
    ALTER TABLE voice_recordings
      ADD COLUMN IF NOT EXISTS outcome TEXT
        CHECK (outcome IN ('completed', 'escalated_to_human', 'callback_required', 'dropped', 'no_intent', 'failed'));
    CREATE INDEX IF NOT EXISTS idx_voice_recordings_outcome
      ON voice_recordings (tenant_id, outcome) WHERE outcome IS NOT NULL;

    CREATE TABLE IF NOT EXISTS retrieval_eval_runs (
      id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      ai_run_id              UUID REFERENCES ai_runs(id) ON DELETE SET NULL,
      query_text             TEXT NOT NULL,
      retrieved_chunk_ids    UUID[] NOT NULL DEFAULT '{}',
      retrieved_scores       REAL[] NOT NULL DEFAULT '{}',
      downstream_proposal_id UUID REFERENCES proposals(id) ON DELETE SET NULL,
      downstream_outcome     TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_retrieval_eval_runs_tenant_time
      ON retrieval_eval_runs (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_retrieval_eval_runs_proposal
      ON retrieval_eval_runs (downstream_proposal_id)
      WHERE downstream_proposal_id IS NOT NULL;
    ALTER TABLE retrieval_eval_runs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE retrieval_eval_runs FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_retrieval_eval_runs ON retrieval_eval_runs;
    CREATE POLICY tenant_isolation_retrieval_eval_runs ON retrieval_eval_runs
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P11-001: voice lookup-skill audit log. Every invocation of a
  // `lookup_*` voice skill writes one row — high-volume but tiny
  // payload (no nested data). Tenant-scoped via RLS just like
  // audit_events; session_id is the voice session that hosted the
  // lookup, customer_id is nullable because the caller may be
  // unidentified at lookup time.
  '061_create_lookup_events': `
    CREATE TABLE IF NOT EXISTS lookup_events (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      session_id UUID NOT NULL,
      customer_id UUID,
      intent TEXT NOT NULL,
      result_status TEXT NOT NULL CHECK (result_status IN ('found','none','error')),
      result_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lookup_events_tenant ON lookup_events(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_lookup_events_tenant_session
      ON lookup_events(tenant_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_lookup_events_tenant_customer
      ON lookup_events(tenant_id, customer_id)
      WHERE customer_id IS NOT NULL;
    ALTER TABLE lookup_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE lookup_events FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_lookup_events ON lookup_events;
    CREATE POLICY tenant_isolation_lookup_events ON lookup_events
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // Phase 1 of the inbound-AI-CSR RAG corpus. One unified table holds
  // both per-tenant chunks (tenant_id NOT NULL, RLS-scoped) and the
  // global non-PII tier (tenant_id IS NULL — vertical-pack terminology
  // and category patterns shared across tenants). The CHECK constraint
  // forces (scope='tenant' ⇔ tenant_id IS NOT NULL) so the two tiers
  // can't accidentally cross.
  //
  // Embedding model is locked to text-embedding-3-small (1536 dims) for
  // v1: cosine distances aren't comparable across embedding models, so
  // mixed-model rows in the same ivfflat index would silently degrade
  // retrieval quality. Future model upgrades go through a separate
  // re-embedding job that rebuilds the index.
  //
  // Phase 1 is purely additive — no caller in main reads or writes this
  // table yet. Workers + retrieval wiring land in Phases 3b and 4a.
  //
  // Originally landed as 059_create_knowledge_chunks; bumped to 061 when
  // 059_lead_attribution + 060_capture_schema landed on main first, then
  // bumped again to 062 when 061_create_lookup_events claimed 061.
  '062_create_knowledge_chunks': `
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id            UUID NULL REFERENCES tenants(id) ON DELETE CASCADE,
      scope                TEXT NOT NULL CHECK (scope IN ('tenant', 'global')),
      source_type          TEXT NOT NULL,
      source_id            TEXT NOT NULL,
      source_version       INTEGER NOT NULL DEFAULT 1,
      content              TEXT NOT NULL,
      content_scrubbed     TEXT NOT NULL,
      embedding            vector(1536) NOT NULL,
      embedding_model      TEXT NOT NULL CHECK (embedding_model = 'text-embedding-3-small'),
      chunk_schema_version INTEGER NOT NULL DEFAULT 1,
      metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (
        (scope = 'tenant' AND tenant_id IS NOT NULL)
        OR (scope = 'global' AND tenant_id IS NULL)
      )
    );

    -- Approximate-nearest-neighbour index for cosine similarity. Defaults to
    -- 100 lists, suitable for tens of thousands to ~1M rows; revisit when a
    -- single tenant crosses ~10M chunks.
    CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_ivfflat
      ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);

    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tenant_source
      ON knowledge_chunks (tenant_id, source_type, source_id);

    -- Idempotent ingestion: same (scope, source_type, source_id, version)
    -- collides cleanly so re-ingestion with ON CONFLICT works.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_chunks_dedupe
      ON knowledge_chunks (scope, source_type, source_id, source_version);

    ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_knowledge_chunks ON knowledge_chunks;
    CREATE POLICY tenant_isolation_knowledge_chunks ON knowledge_chunks
      USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // Phase 4c: language detection telemetry for the inbound AI CSR.
  // Body is byte-identical to origin/main; the immutability test will
  // reject any in-place mutation here. P11-002's additions
  // (tenant_settings columns, leads.preferred_language, customers
  // CHECK constraint) live in a follow-up migration further down.
  '063_language_detection': `
    ALTER TABLE voice_recordings
      ADD COLUMN IF NOT EXISTS detected_language TEXT;
    CREATE INDEX IF NOT EXISTS idx_voice_recordings_lang
      ON voice_recordings (tenant_id, detected_language)
      WHERE detected_language IS NOT NULL;

    ALTER TABLE customers
      ADD COLUMN IF NOT EXISTS preferred_language TEXT;

    ALTER TABLE retrieval_eval_runs
      ADD COLUMN IF NOT EXISTS detected_language TEXT;
    CREATE INDEX IF NOT EXISTS idx_retrieval_eval_runs_lang
      ON retrieval_eval_runs (tenant_id, detected_language, created_at DESC)
      WHERE detected_language IS NOT NULL;
  `,

  // P12-001: per-job photo storage. job_photos rows reference rows in
  // the existing `files` table (the upload pipeline still creates a
  // file row + S3 object); the join row carries photo-specific
  // metadata (category/notes/taken_at/uploader). Deleting a job
  // cascades photo rows; deleting a photo row leaves the underlying
  // file/S3 object intact so existing download URLs still resolve.
  '064_create_job_photos': `
    CREATE TABLE IF NOT EXISTS job_photos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      uploaded_by_user_id TEXT NOT NULL,
      file_id UUID NOT NULL REFERENCES files(id),
      category TEXT NOT NULL CHECK (category IN ('before','after','problem','completion','other')),
      notes TEXT,
      taken_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_job_photos_tenant_job ON job_photos(tenant_id, job_id);
    ALTER TABLE job_photos ENABLE ROW LEVEL SECURITY;
    ALTER TABLE job_photos FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_job_photos ON job_photos;
    CREATE POLICY tenant_isolation_job_photos ON job_photos
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P10-001: Customer self-service portal sessions. A single signed token
  // grants a customer read access to all of their estimates, invoices,
  // jobs, agreements, and appointments. The plaintext token is returned
  // ONCE at create time and stored only as `token_hash = sha256(token)`.
  // Lookup is hash-only (system-level / no tenant context) — RLS still
  // applies for tenant-scoped reads/writes via `tenant_isolation_portal_sessions`.
  //
  // Originally landed as 060_create_portal_sessions; bumped to 065 because
  // 060_capture_schema, 061_create_lookup_events, 062_create_knowledge_chunks,
  // 063_language_detection, and 064_create_job_photos claimed 060–064 on main
  // before this branch merged.
  '065_create_portal_sessions': `
    CREATE TABLE IF NOT EXISTS portal_sessions (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      customer_id UUID NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      last_accessed_at TIMESTAMPTZ,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_token_hash
      ON portal_sessions (token_hash);
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_tenant
      ON portal_sessions (tenant_id);
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_customer
      ON portal_sessions (tenant_id, customer_id);
    ALTER TABLE portal_sessions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_portal_sessions ON portal_sessions;
    -- Tenant-scoped reads/writes (most paths) match the active GUC. The
    -- system-level token-hash lookup (resolvePortalToken) runs without
    -- a tenant context — that's literally what it returns — so the
    -- policy permits the read when the GUC is unset. The lookup is
    -- still safe because the candidate row is selected by sha256 hash.
    CREATE POLICY tenant_isolation_portal_sessions ON portal_sessions
      USING (
        current_setting('app.current_tenant_id', true) IS NULL
        OR current_setting('app.current_tenant_id', true) = ''
        OR tenant_id::text = current_setting('app.current_tenant_id', true)
      );
  `,

  // P12 — voice_sessions table + supervisor/tech mode columns.
  // Originally landed on main as 066_create_voice_sessions_and_modes;
  // ported here verbatim so the snapshot hash matches. Indices and
  // policies use IF NOT EXISTS / DROP-then-CREATE so the migration is
  // re-runnable.
  '066_create_voice_sessions_and_modes': `
    -- voice_sessions: persistent FSM state per AI operator instance
    CREATE TABLE IF NOT EXISTS voice_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      customer_id UUID REFERENCES customers(id),
      channel TEXT NOT NULL CHECK (channel IN ('voice_inbound','voice_outbound','sms','mms','inapp_voice','webchat')),
      external_id TEXT,
      state TEXT NOT NULL,
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      supervisor_user_id UUID REFERENCES users(id),
      supervisor_mode_at_start TEXT CHECK (supervisor_mode_at_start IN ('supervisor','tech','both','unsupervised')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ,
      ended_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS voice_sessions_tenant_started ON voice_sessions(tenant_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS voice_sessions_active ON voice_sessions(tenant_id) WHERE ended_at IS NULL;
    ALTER TABLE voice_sessions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON voice_sessions;
    CREATE POLICY tenant_isolation ON voice_sessions
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

    -- users: field-capable + current mode
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS can_field_serve BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS current_mode TEXT NOT NULL DEFAULT 'supervisor'
        CHECK (current_mode IN ('supervisor','tech','both')),
      ADD COLUMN IF NOT EXISTS mode_changed_at TIMESTAMPTZ;
    UPDATE users SET can_field_serve = true WHERE role = 'owner' AND can_field_serve = false;

    -- tenant_settings: backup supervisor + unsupervised routing
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS backup_supervisor_user_id UUID REFERENCES users(id),
      ADD COLUMN IF NOT EXISTS unsupervised_proposal_routing TEXT NOT NULL DEFAULT 'queue_and_sms'
        CHECK (unsupervised_proposal_routing IN ('queue_and_sms','queue_only','escalate_to_oncall'));
  `,

  // P12-002: Tech time tracking. Captures clock-in / clock-out events per
  // user, optionally linked to a job. Schema choices:
  //   - user_id is TEXT (Clerk subject) to mirror audit_events.actor_id —
  //     keeps the route handler from hitting a DB lookup for the FK.
  //   - job_id is nullable to support non-billable hours (drive/break/admin).
  //   - clocked_out_at is nullable while a shift is running; the partial
  //     UNIQUE index enforces "at most one open entry per user per tenant"
  //     at the database level, which is what makes the concurrent-clock-in
  //     race correctness story possible (the service catches 23505 and
  //     auto-closes the prior entry).
  //   - duration_minutes is computed in app code on close; we store it so
  //     the weekly rollup can sum without re-deriving.
  '067_create_time_entries': `
    CREATE TABLE IF NOT EXISTS time_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      user_id TEXT NOT NULL,
      job_id UUID,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('job', 'drive', 'break', 'admin')),
      clocked_in_at TIMESTAMPTZ NOT NULL,
      clocked_out_at TIMESTAMPTZ,
      duration_minutes INTEGER,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_time_entries_tenant_user
      ON time_entries(tenant_id, user_id, clocked_in_at DESC);
    CREATE INDEX IF NOT EXISTS idx_time_entries_tenant_job
      ON time_entries(tenant_id, job_id) WHERE job_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_one_active_per_user
      ON time_entries(tenant_id, user_id) WHERE clocked_out_at IS NULL;
    ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE time_entries FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_time_entries ON time_entries;
    CREATE POLICY tenant_isolation_time_entries ON time_entries
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P11-002: Spanish multilingual support — tenant-level language config
  // (default lang + per-language TTS voice + auto-detect toggle + Spanish
  // dispatcher routing) plus per-lead preferred_language column.
  //
  // Originally drafted as 063_create_language_settings on this branch,
  // but main shipped 063 (language_detection), 064 (job_photos), 065
  // (portal_sessions), 066 (voice_sessions_and_modes) and PR #253 added
  // 067 (time_entries) before this branch had a chance to merge —
  // bumped to 068 to keep the post-deploy ordering monotonic. Body uses
  // ALTER TABLE … ADD COLUMN IF NOT EXISTS so it converges fresh and
  // existing DBs on the same shape (lessons learned from PR #225).
  //
  // We deliberately do NOT add CHECK (preferred_language IN ('en','es'))
  // to customers.preferred_language — main's 063 created it as a free
  // BCP-47 string, and the immutability test forbids retro-tightening.
  // The runtime catalog narrows to 'en'|'es' at the call site instead.
  '068_create_language_settings': `
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS default_language TEXT NOT NULL DEFAULT 'en'
        CHECK (default_language IN ('en','es')),
      ADD COLUMN IF NOT EXISTS tts_voice_en TEXT,
      ADD COLUMN IF NOT EXISTS tts_voice_es TEXT,
      ADD COLUMN IF NOT EXISTS auto_detect_language BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS spanish_dispatcher_user_ids UUID[];

    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS preferred_language TEXT
        CHECK (preferred_language IN ('en','es'));
  `,

  // P12-005 follow-up: extend the inline CHECK constraint on
  // leads.source so 'customer_portal' is accepted at the DB layer.
  // The original CHECK was authored inline in 057_create_leads, which
  // makes Postgres generate the name `leads_source_check`. We drop it
  // (IF EXISTS, so fresh DBs that never had the old constraint don't
  // error) and re-add it with the extended value list. Originally
  // drafted at slot 068; bumped to 069 because PR #245 landed
  // 068_create_language_settings on main first.
  '069_extend_leads_source_check': `
    ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_source_check;
    ALTER TABLE leads ADD CONSTRAINT leads_source_check
      CHECK (source IN ('web_form','phone_call','referral','walk_in','marketplace','other','customer_portal'));
  `,

  // Twilio per-tenant subaccount model.
  // Adds country/region to tenant_settings (US-only at launch; column is
  // forward-compatible for future international expansion).
  // Creates tenant_integrations to track Twilio subaccount + SendGrid subuser
  // provisioning state per tenant. Auth tokens are stored AES-256-GCM
  // encrypted (app-level key) — never plaintext.
  '070_tenant_integrations': `
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS country CHAR(2) NOT NULL DEFAULT 'US',
      ADD COLUMN IF NOT EXISTS region TEXT;

    CREATE TABLE IF NOT EXISTS tenant_integrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      provider TEXT NOT NULL CHECK (provider IN ('twilio', 'sendgrid')),
      status TEXT NOT NULL DEFAULT 'provisioning'
        CHECK (status IN ('provisioning', 'active', 'suspended', 'terminated', 'releasing', 'failed')),
      subaccount_sid TEXT,
      subuser_username TEXT,
      auth_token_primary_enc TEXT,
      auth_token_secondary_enc TEXT,
      credential_version INTEGER NOT NULL DEFAULT 1,
      provider_data JSONB NOT NULL DEFAULT '{}',
      last_error TEXT,
      provisioned_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, provider)
    );

    ALTER TABLE tenant_integrations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_integrations FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_integrations ON tenant_integrations;
    CREATE POLICY tenant_isolation_integrations ON tenant_integrations
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '071_widen_tenant_integrations_status': `
    UPDATE tenant_integrations SET status = 't0_requested' WHERE status = 'provisioning';
    UPDATE tenant_integrations SET status = 'full_readiness' WHERE status = 'active';
    ALTER TABLE tenant_integrations ALTER COLUMN status SET DEFAULT 't0_requested';
    ALTER TABLE tenant_integrations DROP CONSTRAINT IF EXISTS tenant_integrations_status_check;
    ALTER TABLE tenant_integrations ADD CONSTRAINT tenant_integrations_status_check
      CHECK (status IN (
        't0_requested',
        'partial_readiness',
        'pending_compliance_dns',
        'full_readiness',
        'failed',
        'failed_compensated',
        'compensating',
        'suspended',
        'terminated',
        'releasing'
      ));
  `,

  '072_add_executing_status': `
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS claimed_by UUID;
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
    ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_status_check;
    ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
      CHECK (status IN ('draft', 'ready_for_review', 'approved', 'executing', 'rejected', 'expired', 'executed', 'execution_failed', 'undone'));
  `,

  '073_add_execution_retry_count': `
    ALTER TABLE proposals
      ADD COLUMN IF NOT EXISTS execution_retry_count INTEGER NOT NULL DEFAULT 0;
  `,

  // Inbound Twilio webhooks (voice/SMS/recording) need to look up
  // tenant_integrations BEFORE a tenant is known — to find:
  //   1. the tenant_id given an incoming `to` number
  //   2. the subaccount auth token given the AccountSid in the webhook body
  // Both lookups are inherently cross-tenant. The existing FORCE RLS
  // policy on tenant_integrations blocks them. Add a permissive read
  // policy that activates only when app.system_lookup = 'true' is set
  // on the connection — set inside short-lived transactions in
  // app.ts's resolveTwilioAuthTokenForSubaccount /
  // resolveTenantIdByPhoneNumber helpers. Writes still require
  // app.current_tenant_id (the original tenant_isolation_integrations
  // policy stays in force for INSERT/UPDATE/DELETE).
  '074_tenant_integrations_system_lookup': `
    DROP POLICY IF EXISTS tenant_isolation_integrations ON tenant_integrations;
    CREATE POLICY tenant_isolation_integrations ON tenant_integrations
      USING (
        tenant_id = current_setting('app.current_tenant_id', true)::UUID
        OR current_setting('app.system_lookup', true) = 'true'
      );
  `,

  '075_tenant_settings_quick_toggles': `
    -- Tier 4 (Settings stubs) — persist the SettingsPage Quick toggles.
    -- Defaults: auto_apply false (stricter, humans approve internal AI
    -- updates by default); reminders true (existing toggle ships on,
    -- mirrors today's UX expectation).
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS auto_apply_internal_updates BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS auto_send_appointment_reminders BOOLEAN NOT NULL DEFAULT true;
  `,

  '076_tenant_settings_auto_approve_threshold': `
    -- Tier 4 (AI approval rules) — per-tenant per-mode override map for
    -- the proposal auto-approve threshold. JSONB shape matches the
    -- Partial<Record<'supervisor'|'tech'|'both', number>> consumed by
    -- packages/api/src/proposals/auto-approve.ts:resolveAutoApproveThreshold.
    -- A missing key falls through to DEFAULT_AUTO_APPROVE_THRESHOLDS
    -- (locked product values: supervisor 0.9, both 0.92, tech 0.95).
    --
    -- Empty object default ('{}') means "no overrides" — preserves
    -- existing behavior for every tenant on the day this migration runs.
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS auto_approve_threshold JSONB NOT NULL DEFAULT '{}'::jsonb;
  `,

  '077_tenant_settings_deposit_rules': `
    -- Tier 4 (Deposit rules — PR 1: data plane only) — per-tenant rules
    -- for requiring a deposit before work begins on an estimate. PR 2
    -- will compute the deposit on estimate generation/send; PR 3 will
    -- split the customer payment flow. This migration establishes the
    -- settings columns; behavior is unchanged until PR 2 lands.
    --
    -- Strategy:
    --   - NULL (default): no deposit ever required.
    --   - 'percentage':   deposit_percentage_bps must be set (0-10000).
    --   - 'fixed':        deposit_fixed_cents must be set (>= 0).
    --
    -- deposit_required_above_cents: optional threshold. When NULL the
    -- rule applies to every estimate; otherwise only estimates whose
    -- total >= this value require a deposit. NULL is also the default
    -- so adding the column is a no-op for existing tenants.
    --
    -- The CHECK constraint enforces that when a strategy is picked,
    -- the matching amount column is set; the converse (extra fields
    -- when strategy is NULL) is left to the application layer to keep
    -- the constraint surface small.
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS deposit_strategy TEXT
        CHECK (deposit_strategy IN ('percentage', 'fixed') OR deposit_strategy IS NULL),
      ADD COLUMN IF NOT EXISTS deposit_percentage_bps INTEGER
        CHECK (deposit_percentage_bps IS NULL
               OR (deposit_percentage_bps >= 0 AND deposit_percentage_bps <= 10000)),
      ADD COLUMN IF NOT EXISTS deposit_fixed_cents INTEGER
        CHECK (deposit_fixed_cents IS NULL OR deposit_fixed_cents >= 0),
      ADD COLUMN IF NOT EXISTS deposit_required_above_cents INTEGER
        CHECK (deposit_required_above_cents IS NULL OR deposit_required_above_cents >= 0);

    ALTER TABLE tenant_settings
      DROP CONSTRAINT IF EXISTS tenant_settings_deposit_strategy_amount_check;
    ALTER TABLE tenant_settings
      ADD CONSTRAINT tenant_settings_deposit_strategy_amount_check
        CHECK (
          deposit_strategy IS NULL
          OR (deposit_strategy = 'percentage' AND deposit_percentage_bps IS NOT NULL)
          OR (deposit_strategy = 'fixed' AND deposit_fixed_cents IS NOT NULL)
        );
  `,

  '078_jobs_deposit_columns': `
    -- Tier 4 (Deposit rules — PR 2: estimate-flow computation). The
    -- deposit lives on the JOB rather than the estimate so it works
    -- in both the estimate-approval flow AND the direct-to-job flow
    -- (a tech can be dispatched to a scheduled job without an estimate
    -- ever existing). The estimate-approval hook in
    -- PublicEstimateService writes the rule's required amount onto
    -- the linked job; the upcoming PR 3 customer split-payment
    -- updates deposit_paid_cents and deposit_status.
    --
    --   deposit_required_cents : amount the rule says to collect.
    --                            0 = no deposit (default; legacy rows
    --                            and tenants without a configured rule
    --                            land here automatically).
    --   deposit_paid_cents     : amount actually collected. Capped at
    --                            deposit_required_cents by the
    --                            CHECK below.
    --   deposit_status         : 'not_required' (deposit_required_cents = 0)
    --                            'pending'      (required > 0, paid < required)
    --                            'paid'         (paid >= required > 0).
    --                            Computed on write by the application
    --                            layer; the CHECK is for shape only.
    ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS deposit_required_cents INTEGER NOT NULL DEFAULT 0
        CHECK (deposit_required_cents >= 0),
      ADD COLUMN IF NOT EXISTS deposit_paid_cents INTEGER NOT NULL DEFAULT 0
        CHECK (deposit_paid_cents >= 0),
      ADD COLUMN IF NOT EXISTS deposit_status TEXT NOT NULL DEFAULT 'not_required'
        CHECK (deposit_status IN ('not_required', 'pending', 'paid'));

    ALTER TABLE jobs
      DROP CONSTRAINT IF EXISTS jobs_deposit_paid_lte_required;
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_deposit_paid_lte_required
        CHECK (deposit_paid_cents <= deposit_required_cents);
  `,

  '079_tenant_settings_deposit_timing_policy': `
    -- Tier 4 (Deposit rules — PR 3a-extended). Tenant-configurable
    -- policy controlling when the customer is asked to pay the deposit:
    --
    --   'after_approval'  (default): customer accepts the estimate, THEN
    --                                 sees the deposit payment link.
    --                                 Mirrors the existing PR 3a flow.
    --   'before_approval': customer must pay the deposit BEFORE the
    --                      Approve button becomes active. Used by tenants
    --                      who don't want any commitment without skin in
    --                      the game first.
    --
    -- Default is 'after_approval' so existing tenants keep current
    -- behavior on the day this migration runs.
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS deposit_timing_policy TEXT NOT NULL DEFAULT 'after_approval'
        CHECK (deposit_timing_policy IN ('before_approval', 'after_approval'));
  `,

  '080_jobs_deposit_stripe_payment_link': `
    -- Tier 4 (Deposit rules — PR 3b). Stripe Payment Link minted for
    -- the deposit, persisted on the job so a re-tap from the customer
    -- portal returns the same URL (idempotency mirrors the invoice
    -- pay-now flow). The webhook handler credits deposit_paid_cents
    -- using metadata.deposit_for_job_id; the URL itself is
    -- informational and visible to the customer.
    --
    -- Both columns are nullable: a job has no deposit link until the
    -- customer (or the dispatcher) requests one.
    ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS deposit_stripe_payment_link_id TEXT,
      ADD COLUMN IF NOT EXISTS deposit_stripe_payment_link_url TEXT;
  `,

  '081_jobs_deposit_credited_to_invoice': `
    -- Tier 4 (Deposit rules — PR 3c). Marks which invoice consumed
    -- this job's paid deposit. NULL = deposit hasn't been applied to
    -- any invoice yet (or no deposit was paid). Set the FIRST time an
    -- invoice is created from this job; downstream invoices for the
    -- same job (rare but possible — e.g. additional change-order work)
    -- skip the credit because the deposit is already consumed.
    --
    -- FK without ON DELETE so a deleted invoice surfaces a clear
    -- foreign-key error rather than silently re-enabling a credit.
    -- Idempotent: nullable + default NULL, so existing rows are
    -- unaffected.
    ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS deposit_credited_to_invoice_id UUID
        REFERENCES invoices(id);
  `,

  '082_create_pending_invitations': `
    -- Tier 4 (Team members — PR 3). Tracks team invitations sent via
    -- Clerk before the invitee accepts. The Clerk user.created webhook
    -- looks up by email to attach an accepted invitee to the right
    -- tenant + role rather than bootstrapping a brand-new tenant.
    --
    --   tenant_id          : tenant the invitee will join.
    --   email              : matched against email_addresses[0] from
    --                        the Clerk webhook payload.
    --   role               : role they'll be assigned on accept.
    --   clerk_invitation_id: returned by POST /v1/invitations; used to
    --                        revoke. Nullable so the dev/test path
    --                        (no CLERK_SECRET_KEY) still works.
    --   invited_by         : Clerk subject of the inviting user (audit).
    --   accepted_at        : NULL until user.created fires for this email.
    --   created_at / expires_at : standard. Default 14d expiry.
    CREATE TABLE IF NOT EXISTS pending_invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','dispatcher','technician')),
      clerk_invitation_id TEXT,
      invited_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days',
      accepted_at TIMESTAMPTZ
    );
    -- Used by the webhook lookup (email) and by the list view (tenant +
    -- accepted_at IS NULL). Partial index keeps the lookup tight.
    CREATE INDEX IF NOT EXISTS idx_pending_invitations_email_pending
      ON pending_invitations(LOWER(email))
      WHERE accepted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_pending_invitations_tenant_pending
      ON pending_invitations(tenant_id)
      WHERE accepted_at IS NULL;
    -- Prevent two simultaneously-pending invitations for the same
    -- (tenant, email) — the operator should revoke the first.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_invitations_tenant_email_pending
      ON pending_invitations(tenant_id, LOWER(email))
      WHERE accepted_at IS NULL;
    ALTER TABLE pending_invitations ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_pending_invitations ON pending_invitations;
    CREATE POLICY tenant_isolation_pending_invitations ON pending_invitations
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '083_tenants_stripe_subscription': `
    -- Tier 4 (Subscription — Fieldly billing). Tracks the Stripe
    -- Customer + Subscription tied to this tenant for the SaaS
    -- subscription Fieldly bills them for. Distinct from
    -- tenant_settings.depositStrategy etc. which govern how the
    -- tenant bills THEIR customers (Stripe Connect path).
    --
    --   stripe_customer_id     : created on first portal-open;
    --                            populated by the billing-portal
    --                            route. Nullable so existing tenants
    --                            don't need a backfill.
    --   stripe_subscription_id : populated by the Stripe webhook on
    --                            customer.subscription.created.
    --   subscription_status    : mirror of Stripe's subscription.status
    --                            so the UI doesn't have to round-trip
    --                            Stripe on every render.
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
      ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
      ADD COLUMN IF NOT EXISTS subscription_status TEXT;
    CREATE INDEX IF NOT EXISTS idx_tenants_stripe_customer
      ON tenants(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
  `,

  '084_create_user_calendar_integrations': `
    -- Tier 4 (Calendar sync — PR 1). Per-user Google Calendar OAuth
    -- connections. Each technician/dispatcher connects THEIR OWN
    -- calendar (different shape from tenant_integrations, which is
    -- per-tenant). Tokens are stored encrypted with TENANT_ENCRYPTION_KEY
    -- using the same AES-256-GCM helper that Twilio/SendGrid creds use.
    --
    --   user_id (clerk_user_id) : the owner of this connection. We
    --                             store the Clerk subject (string) not
    --                             the users.id UUID, because the Clerk
    --                             webhook sometimes lands BEFORE we've
    --                             created the users row (race during
    --                             tenant bootstrap), and we want OAuth
    --                             to keep working in that window.
    --   provider                : 'google' for now; the schema admits
    --                             outlook/apple in future migrations.
    --   access_token_encrypted /
    --   refresh_token_encrypted : "iv:cipher:tag" hex per crypto.ts.
    --   access_token_expires_at : Used by the refresh path to know
    --                             when to call Google to mint a new
    --                             access token.
    --   external_account_email  : Display only ("Connected to alex@...");
    --                             never used as identity.
    --   calendar_id             : Default 'primary' (Google's special
    --                             alias for the user's main calendar).
    --                             Future: let the user pick which calendar.
    --   status                  : 'active' | 'expired' | 'revoked'.
    --                             'expired' means refresh-token rejected
    --                             (operator must reconnect); 'revoked'
    --                             is a soft-delete after disconnect.
    --
    -- UNIQUE on (tenant_id, user_id, provider) — at most one active
    -- Google connection per user. Reconnecting overwrites the row.
    CREATE TABLE IF NOT EXISTS user_calendar_integrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('google')),
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT NOT NULL,
      access_token_expires_at TIMESTAMPTZ NOT NULL,
      external_account_email TEXT NOT NULL,
      calendar_id TEXT NOT NULL DEFAULT 'primary',
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'revoked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, user_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_user_calendar_integrations_tenant
      ON user_calendar_integrations(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_user_calendar_integrations_user
      ON user_calendar_integrations(user_id);
    ALTER TABLE user_calendar_integrations ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_user_calendar_integrations ON user_calendar_integrations;
    CREATE POLICY tenant_isolation_user_calendar_integrations ON user_calendar_integrations
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // Blocker 3 RLS exception: oauth_states has tenant_id for the binding
  // record but is INTENTIONALLY NOT row-level-security protected. The
  // /callback path calls consume(stateId) BEFORE any tenant context is
  // set — recovering the tenant_id from the state row is the entire point
  // of the lookup. RLS would force the row to be invisible to the very
  // call that needs it. Safety: the id is a 128-bit random UUID acting as
  // a single-use nonce (consumed_at flips on read), expires_at enforces a
  // 5-minute window, and the row is created server-side bound to the
  // already-authenticated tenant/user. The schema-guard test
  // (every-table-with-tenant_id-has-FORCE) explicitly allowlists this
  // table; any change should be reviewed alongside that test.
  '085_create_oauth_states': `
    -- Tier 4 (Calendar sync — PR 1). Short-lived nonces for the
    -- Google OAuth flow. The /connect route mints a state, persists
    -- it, redirects the user to Google with state=<id>; the /callback
    -- route looks it up to bind the returned code back to the original
    -- tenant + user. Without this the callback would have no way to
    -- know whose token it just minted.
    --
    -- Rows are short-lived (5 min default); a cron job would TTL them.
    -- For PR 1 we just leave them; volume is tiny (1 row per
    -- connect attempt) and the lookup is by primary key.
    CREATE TABLE IF NOT EXISTS oauth_states (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('google')),
      redirect_after TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
      consumed_at TIMESTAMPTZ
    );
    -- PR 320 review (Gemini): the partial index on PK column 'id'
    -- was redundant — the primary key index already covers PK
    -- lookups, including the consume() lookup with a WHERE filter
    -- on consumed_at. The partial saved no work and bloated writes.
  `,

  '086_create_appointment_calendar_events': `
    -- Tier 4 (Calendar sync — PR 2). Maps an appointment + assigned
    -- technician to the Google Calendar event we created for them.
    -- Stored separately from the appointment row because:
    --   1. One appointment may sync to multiple techs' calendars
    --      (multi-assignment).
    --   2. Updating + deleting the event later needs the external id.
    --   3. Some techs may have no integration; we don't want to bloat
    --      the assignment row with mostly-null columns.
    --
    -- Status mirrors the lifecycle:
    --   'synced'  — event exists on Google; external_event_id is set.
    --   'failed'  — push failed; the operator can retry. An audit
    --               event ('appointment.calendar_push_failed') carries
    --               the error detail.
    --   'deleted' — Google event was deleted (soft); a future update
    --               syncs a fresh event.
    CREATE TABLE IF NOT EXISTS appointment_calendar_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('google')),
      external_event_id TEXT,
      external_calendar_id TEXT NOT NULL DEFAULT 'primary',
      status TEXT NOT NULL DEFAULT 'synced'
        CHECK (status IN ('synced', 'failed', 'deleted')),
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (appointment_id, user_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_appointment_calendar_events_tenant
      ON appointment_calendar_events(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_appointment_calendar_events_appt
      ON appointment_calendar_events(appointment_id);
    ALTER TABLE appointment_calendar_events ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_appointment_calendar_events ON appointment_calendar_events;
    CREATE POLICY tenant_isolation_appointment_calendar_events ON appointment_calendar_events
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '087_tenants_stripe_connect': `
    -- Tier 4 (Payment methods — PR 1). Stripe Connect onboarding for
    -- the tenant's OWN Stripe account. Distinct from the
    -- 'stripe_customer_id' columns (those bill the TENANT for Fieldly
    -- subscription); these track the connected ACCOUNT we route the
    -- tenant's CUSTOMER payments through.
    --
    --   stripe_connect_account_id : 'acct_...' returned by Stripe on
    --                                Connect Account creation.
    --   stripe_connect_charges_enabled : mirror of account.charges_enabled
    --                                from the account.updated webhook.
    --                                False on day 1 (onboarding incomplete);
    --                                flips true once Stripe verifies KYC.
    --   stripe_connect_payouts_enabled : same shape for payouts.
    --   stripe_connect_status     : 'pending' | 'active' | 'restricted' |
    --                               'disconnected'. UI shorthand derived
    --                               from charges + payouts enabled.
    --
    -- Nullable so existing tenants don't need a backfill. Connect
    -- routing only kicks in when status='active' AND charges_enabled.
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS stripe_connect_account_id TEXT,
      ADD COLUMN IF NOT EXISTS stripe_connect_charges_enabled BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS stripe_connect_payouts_enabled BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS stripe_connect_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (stripe_connect_status IN ('pending', 'active', 'restricted', 'disconnected'));
    -- Webhook lookup index: account.updated events arrive keyed on
    -- account id; partial keeps the index tight.
    CREATE INDEX IF NOT EXISTS idx_tenants_stripe_connect_account
      ON tenants(stripe_connect_account_id)
      WHERE stripe_connect_account_id IS NOT NULL;
  `,

  '088_fix_schema_constraints': `
    -- Make voice_recordings.file_id nullable. The original schema assumed
    -- recordings always come from an in-app file upload (voice notes), but
    -- Twilio inbound-call recordings do not have a pre-created file row.
    ALTER TABLE voice_recordings
      ALTER COLUMN file_id DROP NOT NULL;

    -- Relax the US-region check on tenant_settings. The constraint was added
    -- aspirationally but no application path currently sets country/region, so
    -- every tenant_settings INSERT was violating it. Allow region to be null
    -- while still validating the format when a value IS provided.
    ALTER TABLE tenant_settings
      DROP CONSTRAINT IF EXISTS tenant_settings_us_region_check;
    ALTER TABLE tenant_settings
      ADD CONSTRAINT tenant_settings_region_format_check
        CHECK (region IS NULL OR btrim(region) ~ '^[A-Z]{2}$');
  `,

  '089_drop_vertical_packs_type_check': `
    -- The vertical_packs.type column was originally CHECK (type IN ('hvac',
    -- 'plumbing')) but the registry stores packId values ('hvac-v1',
    -- 'plumbing-v1') in this column, so seedCanonicalVerticalPacks has been
    -- silently failing in production (errors swallowed by .catch()). Drop the
    -- stale check; UNIQUE on type still enforces one row per packId.
    ALTER TABLE vertical_packs
      DROP CONSTRAINT IF EXISTS vertical_packs_type_check;
  `,

  '090_tenant_settings_voice_persona': `
    -- Per-tenant voice persona fields used by the voice-persona-resolver
    -- to personalize AI greeting text on both the Twilio Gather and
    -- Media Streams paths. Both columns are optional: when absent the
    -- adapter falls back to the static businessName-based opener.
    -- Length limits mirror the API contract (contracts.ts) so that internal
    -- writes (scripts, migrations, direct SQL) are also bounded.
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS voice_agent_name TEXT,
      ADD COLUMN IF NOT EXISTS voice_greeting   TEXT;
    ALTER TABLE tenant_settings
      DROP CONSTRAINT IF EXISTS tenant_settings_voice_agent_name_length,
      ADD CONSTRAINT tenant_settings_voice_agent_name_length
        CHECK (voice_agent_name IS NULL OR length(voice_agent_name) <= 80);
    ALTER TABLE tenant_settings
      DROP CONSTRAINT IF EXISTS tenant_settings_voice_greeting_length,
      ADD CONSTRAINT tenant_settings_voice_greeting_length
        CHECK (voice_greeting IS NULL OR length(voice_greeting) <= 500);
  `,

  // B2 — Persistent outcome stamping. Mirrors voice_recordings.outcome
  // (migration 060) so in-app sessions, which never get a voice_recordings
  // row, also have a typed terminal-state column. The free-text
  // ended_reason column from migration 066 is preserved as a breadcrumb;
  // outcome is the dashboard-grade enum derived by deriveCallOutcome at
  // FSM hangup. call_sid is added so analytics can join voice_sessions
  // ↔ voice_recordings on telephony calls.
  '091_voice_session_outcome': `
    ALTER TABLE voice_sessions
      ADD COLUMN IF NOT EXISTS outcome TEXT
        CHECK (outcome IN ('completed', 'escalated_to_human', 'callback_required', 'dropped', 'no_intent', 'failed'));
    ALTER TABLE voice_sessions
      ADD COLUMN IF NOT EXISTS call_sid TEXT;
    CREATE INDEX IF NOT EXISTS idx_voice_sessions_tenant_outcome
      ON voice_sessions (tenant_id, outcome) WHERE outcome IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_voice_sessions_call_sid
      ON voice_sessions (call_sid) WHERE call_sid IS NOT NULL;
  `,

  // 092 — extend message_dispatches entity_type to support appointment
  // confirmation notices and delay notices. The original CHECK limited
  // the column to ('estimate','invoice'); new dispatch types require
  // the constraint to be widened. We drop the old constraint by name
  // and add the replacement in a single migration so it's idempotent
  // across environments that may already be on the new definition.
  '092_extend_dispatch_entity_types': `
    ALTER TABLE message_dispatches
      DROP CONSTRAINT IF EXISTS message_dispatches_entity_type_check;
    ALTER TABLE message_dispatches
      ADD CONSTRAINT message_dispatches_entity_type_check
        CHECK (entity_type IN ('estimate', 'invoice', 'appointment_confirmation', 'appointment_reminder', 'delay_notice'));
    CREATE INDEX IF NOT EXISTS idx_dispatches_tenant_sent_at
      ON message_dispatches (tenant_id, sent_at DESC);
  `,

  // 15.8/15.9 — Persist the in-memory FSM transcript onto the voice_sessions
  // row so the /api/interactions endpoint can surface full call transcripts
  // without relying on the in-memory store (which is process-scoped and lost
  // on restart). customer_id index improves the interactions list query that
  // joins to customers for the "correct customer linked" requirement.
  '092_voice_session_transcript': `
    ALTER TABLE voice_sessions
      ADD COLUMN IF NOT EXISTS transcript JSONB;
    CREATE INDEX IF NOT EXISTS idx_voice_sessions_customer
      ON voice_sessions (tenant_id, customer_id) WHERE customer_id IS NOT NULL;
  `,

  // 16D — Soft-delete support for users. When a Clerk user.deleted event is
  // received the row is stamped with deleted_at rather than purged. Tenant
  // data and the Twilio subaccount are intentionally NOT removed — they must
  // be retained for audit and billing, and the subaccount must not be
  // released until a manual deprovisioning step is performed by ops.
  '093_users_deleted_at': `
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_users_deleted ON users(tenant_id, deleted_at)
      WHERE deleted_at IS NOT NULL;
  `,
  '094_add_held_appointment_fields': `
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS hold_pending_approval BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS hold_expiry_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_appointments_hold_expiry
      ON appointments(tenant_id, hold_expiry_at)
      WHERE hold_pending_approval = true;
  `,
  '095_vertical_training_assets': `
    CREATE TABLE IF NOT EXISTS privacy_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id UUID NOT NULL,
      operation TEXT NOT NULL,
      redaction_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      redactions JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_privacy_audit_tenant_time
      ON privacy_audit (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_privacy_audit_entity
      ON privacy_audit (tenant_id, entity_type, entity_id);
    ALTER TABLE privacy_audit ENABLE ROW LEVEL SECURITY;
    ALTER TABLE privacy_audit FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_privacy_audit ON privacy_audit;
    CREATE POLICY tenant_isolation_privacy_audit ON privacy_audit
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

    CREATE TABLE IF NOT EXISTS vertical_training_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      vertical_type TEXT NOT NULL CHECK (vertical_type IN ('hvac', 'plumbing', 'electrical')),
      asset_kind TEXT NOT NULL CHECK (
        asset_kind IN (
          'prompt_context',
          'rag_seed',
          'eval_scenario',
          'labeled_call_example',
          'intake_question',
          'objection_script',
          'emergency_rule',
          'false_positive_guard'
        )
      ),
      status TEXT NOT NULL CHECK (
        status IN ('draft', 'redacted', 'quarantined', 'approved', 'active', 'archived')
      ),
      title TEXT NOT NULL,
      raw_text TEXT,
      scrubbed_text TEXT,
      labels JSONB NOT NULL DEFAULT '{}'::jsonb,
      provenance JSONB NOT NULL,
      redaction_summary JSONB,
      created_by TEXT NOT NULL,
      approved_by TEXT,
      activated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (status IN ('draft', 'quarantined') OR scrubbed_text IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_vertical_training_assets_tenant_vertical_status
      ON vertical_training_assets (tenant_id, vertical_type, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vertical_training_assets_tenant_kind
      ON vertical_training_assets (tenant_id, asset_kind, updated_at DESC);
    ALTER TABLE vertical_training_assets ENABLE ROW LEVEL SECURITY;
    ALTER TABLE vertical_training_assets FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_vertical_training_assets ON vertical_training_assets;
    CREATE POLICY tenant_isolation_vertical_training_assets ON vertical_training_assets
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,
  '096_create_expenses': `
    CREATE TABLE IF NOT EXISTS expenses (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      job_id       UUID REFERENCES jobs(id) ON DELETE SET NULL,
      description  TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      category     TEXT NOT NULL,
      vendor       TEXT,
      spent_at     TIMESTAMPTZ NOT NULL,
      created_by   TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_tenant_spent_at
      ON expenses(tenant_id, spent_at);
    CREATE INDEX IF NOT EXISTS idx_expenses_job
      ON expenses(tenant_id, job_id);
    ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_expenses ON expenses
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,
  '097_vertical_training_assets_idempotency': `
    ALTER TABLE vertical_training_assets
      ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vertical_training_assets_idempotency
      ON vertical_training_assets (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `,
  '098_tenant_settings_onboarding_fields': `
    ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS business_hours      JSONB       NOT NULL DEFAULT '{}';
    ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS service_area_text   TEXT;
    ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS service_area_radius INT;
    ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS job_buffer_minutes  INT         NOT NULL DEFAULT 30;
    ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS hourly_rate_cents   INT;
    ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS onboarding_test_call_skipped_at      TIMESTAMPTZ;
    ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS onboarding_upgrade_prompt_shown_at   TIMESTAMPTZ;
  `,
  '099_proposal_executions_idempotency_index': `
    -- §11 H1: replace the O(n) in-process scan in IdempotencyGuard with
    -- an indexed lookup keyed by (tenant_id, idempotency_key). The existing
    -- index on (tenant_id, proposal_id, idempotency_key) is wider than the
    -- guard's lookup (the guard doesn't know proposal_id up-front for a
    -- replay) so it can't be used. This partial unique index also serves
    -- as defense-in-depth against app-layer regressions.
    --
    -- Partial WHERE idempotency_key IS NOT NULL: most legacy executions
    -- and undo paths carry no key, and a NOT NULL constraint would block
    -- them.
    CREATE UNIQUE INDEX IF NOT EXISTS proposal_executions_tenant_idempotency_uniq
      ON proposal_executions (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `,

  // D2-4 — partial-refund tracking on payments. Previously a $50 refund on
  // a $500 payment could not be represented (PaymentStatus has no REFUNDED
  // state, and there was no mechanism for partials at all). Refunds are
  // modeled as cumulative magnitude on the original payment row plus a
  // last-refund timestamp/Stripe id; a refund is NOT a status flip — the
  // original payment row keeps its full magnitude, and the tax export
  // emits a paired negative income row dated by refunded_at.
  '100_payments_refund_tracking': `
    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS refunded_amount_cents BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS last_refund_stripe_id TEXT NULL;
    CREATE INDEX IF NOT EXISTS idx_payments_refunded_at
      ON payments(refunded_at) WHERE refunded_at IS NOT NULL;
  `,

  // P7-026 PR a — Google Business reviews monitoring foundation.
  // Mirror of upstream review rows; the worker polls every 15 minutes
  // and upserts on (tenant_id, external_review_id). PR b adds PII
  // redaction (separate column for redacted_text) and PR c hangs the
  // proposal pipeline off inserts. Indexed for "recent reviews per
  // tenant" + "freshly fetched" queries that the UI and reporting
  // will run.
  '101_google_reviews': `
    CREATE TABLE IF NOT EXISTS google_reviews (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      external_review_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      reviewer_display_name TEXT,
      reviewer_profile_url TEXT,
      rating SMALLINT NOT NULL CHECK (rating BETWEEN 0 AND 5),
      comment_text TEXT,
      review_create_time TIMESTAMPTZ NOT NULL,
      review_update_time TIMESTAMPTZ,
      -- first_fetched_at is set at insert and NEVER updated — the row's
      -- "first seen" moment. Useful for admin "when did we discover
      -- this review?" views.
      first_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- last_fetched_at advances on every upsert — useful for ops
      -- monitoring ("when did we last confirm this review still
      -- exists?"). Both default to now() on insert; ON CONFLICT
      -- updates last_fetched_at only.
      last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, external_review_id)
    );
    CREATE INDEX IF NOT EXISTS idx_google_reviews_tenant_create_time
      ON google_reviews(tenant_id, review_create_time DESC);
    CREATE INDEX IF NOT EXISTS idx_google_reviews_tenant_first_fetched_at
      ON google_reviews(tenant_id, first_fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_google_reviews_tenant_last_fetched_at
      ON google_reviews(tenant_id, last_fetched_at DESC);
    ALTER TABLE google_reviews ENABLE ROW LEVEL SECURITY;
    ALTER TABLE google_reviews FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_google_reviews ON google_reviews;
    CREATE POLICY tenant_isolation_google_reviews ON google_reviews
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P7-026 PR a — per-tenant poll watermark + 429 exponential backoff.
  // Single row per tenant. `cursor` is the ISO timestamp of the
  // newest review.updateTime we've persisted (the watermark). When
  // `backoff_until` is in the future, the worker skips this tenant
  // entirely. `consecutive_429_count` resets on the first successful
  // poll. The exponential math lives in reputation/poll-state.ts;
  // recordQuotaError() mirrors it in SQL so the increment is
  // race-free.
  '102_review_poll_state': `
    CREATE TABLE IF NOT EXISTS review_poll_state (
      tenant_id UUID PRIMARY KEY REFERENCES tenants(id),
      cursor TEXT,
      last_successful_poll_at TIMESTAMPTZ,
      backoff_until TIMESTAMPTZ,
      consecutive_429_count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_review_poll_state_backoff
      ON review_poll_state(backoff_until)
      WHERE backoff_until IS NOT NULL;
    ALTER TABLE review_poll_state ENABLE ROW LEVEL SECURITY;
    ALTER TABLE review_poll_state FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_review_poll_state ON review_poll_state;
    CREATE POLICY tenant_isolation_review_poll_state ON review_poll_state
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P7-026 PR c — service_credits ledger. One row per credit issued.
  // `amount_cents` is BIGINT (matches the established money-column
  // shape across the schema) and constrained > 0 (the in-memory repo
  // enforces the same — see service-credit.ts). `review_id` is
  // nullable because credits may originate from non-review flows in
  // the future. Indexed for the rolling-12-month sum query
  // (tenant_id + customer_id + issued_at) that the cap check uses.
  '103_service_credits': `
    CREATE TABLE IF NOT EXISTS service_credits (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      customer_id UUID NOT NULL REFERENCES customers(id),
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      review_id UUID NULL,
      proposal_id UUID NOT NULL REFERENCES proposals(id),
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_service_credits_tenant_customer_issued
      ON service_credits(tenant_id, customer_id, issued_at DESC);
    ALTER TABLE service_credits ENABLE ROW LEVEL SECURITY;
    ALTER TABLE service_credits FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_service_credits ON service_credits;
    CREATE POLICY tenant_isolation_service_credits ON service_credits
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P7-026 final wiring — service_credits.review_id FK with ON DELETE
  // SET NULL. The original 103_service_credits migration left review_id
  // as a NULLable column with no FK so PR c could land independently
  // of any FK ordering concerns. The cross-PR review flagged this: a
  // credit row with a non-null review_id should be guaranteed to point
  // at a real google_reviews row, and the rare case where a review row
  // is later deleted (manual ops cleanup; never an automated path)
  // should NULL out the credit's reference rather than orphan a
  // dangling id — the credit row itself is part of the financial ledger
  // and must be preserved for audit.
  //
  // `IF NOT EXISTS` is not supported on ADD CONSTRAINT, so the schema
  // runner's `DROP CONSTRAINT IF EXISTS` rewriter in `getMigrationSQL`
  // makes re-runs safe.
  '104_service_credits_review_fk': `
    ALTER TABLE service_credits
      ADD CONSTRAINT service_credits_review_id_fkey
      FOREIGN KEY (review_id) REFERENCES google_reviews(id) ON DELETE SET NULL;
  `,
  '105_create_dispatch_analytics': `
    CREATE TABLE IF NOT EXISTS dispatch_analytics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      event_type TEXT NOT NULL CHECK (event_type IN (
        'assigned', 'reassigned', 'rescheduled', 'canceled',
        'conflict_detected', 'delay_notice_sent', 'delay_notice_failed'
      )),
      appointment_id UUID,
      technician_id UUID,
      metadata JSONB,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_analytics_tenant_recorded ON dispatch_analytics(tenant_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dispatch_analytics_tenant_type ON dispatch_analytics(tenant_id, event_type);
    CREATE INDEX IF NOT EXISTS idx_dispatch_analytics_tenant_tech ON dispatch_analytics(tenant_id, technician_id) WHERE technician_id IS NOT NULL;
    ALTER TABLE dispatch_analytics ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_dispatch_analytics ON dispatch_analytics;
    CREATE POLICY tenant_isolation_dispatch_analytics ON dispatch_analytics
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '106_tenant_settings_escalation_settings': `
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS escalation_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
  `,

  // Production-readiness — replace permissive NULL-tenant portal_sessions reads
  // with an explicit system lookup GUC (mirrors 074 tenant_integrations).
  // Bumped to 107 because main landed 106_tenant_settings_escalation_settings first.
  '107_portal_sessions_system_lookup_rls': `
    DROP POLICY IF EXISTS tenant_isolation_portal_sessions ON portal_sessions;
    CREATE POLICY tenant_isolation_portal_sessions ON portal_sessions
      USING (
        current_setting('app.portal_token_lookup', true) = 'true'
        OR (
          current_setting('app.current_tenant_id', true) IS NOT NULL
          AND current_setting('app.current_tenant_id', true) <> ''
          AND tenant_id::text = current_setting('app.current_tenant_id', true)
        )
      );
  `,

  '108_tenant_settings_voice_agent_live': `
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS voice_agent_live_at TIMESTAMPTZ;
  `,

  // P1-022 — bind inbound communications (P6-028 tech "OUT" SMS reply,
  // P8-016 emergency owner-cell paging) to a user by mobile number.
  // Stored normalized to E.164 (`+15551234567`) by normalizeMobileE164().
  // Partial unique index: tenant-scoped uniqueness while permitting many
  // rows with NULL mobile (existing users have none on file). Idempotent
  // (IF NOT EXISTS) so the migration is safely replayable on Postgres 14+.
  '109_users_mobile_number': `
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS users_mobile_unique
      ON users (tenant_id, mobile_number)
      WHERE mobile_number IS NOT NULL;
  `,

  // P4-015 — per-tenant brand voice tone consumed by composeBrandVoiceMessage.
  // JSONB so the shape (formality / pronoun / vibe_words / business_name) can
  // evolve additively. Defaults to '{}' which mapRow surfaces as undefined,
  // so the composer falls back to its neutral default tone for existing rows.
  '110_tenant_settings_brand_voice': `
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS brand_voice JSONB NOT NULL DEFAULT '{}'::jsonb;
  `,

  // P0-036 — generic per-key sliding-window rate limiter backing domain-scoped
  // throttles (P8-015 dropped-call recovery is the first consumer). `scope`
  // namespaces unrelated limiters (e.g. 'sms_recovery' vs 'verify_code') so they
  // share one table without colliding. Each tryConsume() writes a row keyed by
  // NOW(); callers SUM counts over the trailing windowMs, so old windows age out
  // (a sliding window, not a fixed bucket). The PRIMARY KEY's btree on
  // (tenant_id, scope, key, window_start) is exactly the lookup index, so no
  // separate index is created. RLS-isolated by tenant.
  '111_phone_rate_limits': `
    CREATE TABLE IF NOT EXISTS phone_rate_limits (
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, scope, key, window_start)
    );
    ALTER TABLE phone_rate_limits ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_phone_rate_limits ON phone_rate_limits;
    CREATE POLICY tenant_isolation_phone_rate_limits ON phone_rate_limits
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P8-015 — durable queue for the 60s deferred dropped-call recovery SMS.
  // Inserting a row (scheduled_for = drop time + 60s) IS the enqueue; the
  // dropped-call-worker polls due rows via the partial index below, so a
  // restart between schedule (T=0) and send (T=60s) never loses a recovery
  // (vs. the superseded setTimeout MVP). UNIQUE (tenant_id, voice_session_id)
  // makes scheduling idempotent — a duplicate finalize is a no-op. sent_at /
  // suppressed_reason / sms_message_sid are stamped by the worker at send
  // time. RLS-isolated by tenant. Idempotent (IF NOT EXISTS + DROP/CREATE
  // POLICY) so the whole-string migration runner can replay it on every boot.
  '112_dropped_call_recoveries': `
    CREATE TABLE IF NOT EXISTS dropped_call_recoveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      voice_session_id UUID NOT NULL,
      caller_e164 TEXT NOT NULL,
      scheduled_for TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      suppressed_reason TEXT,
      sms_message_sid TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, voice_session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dropped_call_recoveries_due
      ON dropped_call_recoveries (scheduled_for)
      WHERE sent_at IS NULL AND suppressed_reason IS NULL;
    ALTER TABLE dropped_call_recoveries ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_dropped_call_recoveries ON dropped_call_recoveries;
    CREATE POLICY tenant_isolation_dropped_call_recoveries ON dropped_call_recoveries
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P8-016 — additive vulnerability fields on the tenant-scoped customers
  // table. `date_of_birth` lets the age detector derive age >65 from the
  // matched customer record (in addition to a self-reported age in the
  // utterance). `account_type` distinguishes residential callers from B2B
  // accounts (e.g. property managers) so the property-type detector can fire
  // conservatively. Both are nullable — existing rows have neither on file.
  // Idempotent (ADD COLUMN IF NOT EXISTS) so the whole-string runner replays
  // it on every boot. customers already has RLS (migration 014); no policy
  // change here.
  '113_customer_vulnerability_fields': `
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS date_of_birth DATE;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS account_type TEXT
      CHECK (account_type IS NULL OR account_type IN ('residential', 'b2b'));
  `,

  // P8-016 — PUBLIC weather cache. INTENTIONALLY NOT tenant-scoped: it caches
  // an external weather provider's reading keyed by ROUNDED lat/lng (~0.5°,
  // roughly 30 mi). Two tenants in the same locale share the same cached row,
  // so there is NO `tenant_id` column and NO RLS policy — the data is public
  // (ambient temperature) and not customer/tenant PII. Repos read/write it via
  // `withClient()` (the cross-tenant escape hatch on PgBaseRepository), NOT
  // `withTenant()`. `fetched_at` drives staleness (>1h = refetch). Idempotent
  // (IF NOT EXISTS) so the whole-string runner replays it on every boot.
  '114_weather_cache': `
    CREATE TABLE IF NOT EXISTS weather_cache (
      lat_rounded NUMERIC(4,1) NOT NULL,
      lng_rounded NUMERIC(4,1) NOT NULL,
      max_temp_f NUMERIC(5,1),
      min_temp_f NUMERIC(5,1),
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (lat_rounded, lng_rounded)
    );
    CREATE INDEX IF NOT EXISTS idx_weather_cache_fetched_at
      ON weather_cache (fetched_at);
  `,

  // P8-016 — analytics / post-incident-review log of every vulnerability
  // triage decision. Tenant-scoped + RLS. Carries the decision kind, urgency
  // tier, score total, the weather-unavailable gap flag, and the fired signals
  // (kind + NON-PII evidence + weight) as JSONB so a reviewer can audit "did
  // the matrix make the right call?" without replaying the call. NO transcript,
  // NO full address. Idempotent (IF NOT EXISTS + DROP/CREATE POLICY) so the
  // whole-string runner replays it on every boot.
  '115_vulnerability_signals': `
    CREATE TABLE IF NOT EXISTS vulnerability_signals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      voice_session_id UUID NOT NULL,
      customer_id UUID,
      decision_kind TEXT NOT NULL,
      urgency TEXT NOT NULL,
      score_total INT NOT NULL DEFAULT 0,
      weather_unavailable BOOLEAN NOT NULL DEFAULT false,
      signals JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_vulnerability_signals_tenant_created
      ON vulnerability_signals (tenant_id, created_at);
    ALTER TABLE vulnerability_signals ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_vulnerability_signals ON vulnerability_signals;
    CREATE POLICY tenant_isolation_vulnerability_signals ON vulnerability_signals
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P6-028 — PG-backed unavailable_blocks mirroring the in-memory
  // UnavailableBlock model (packages/api/src/availability/unavailable-block.ts).
  // A tech "I'm out today" SMS writes one row spanning the tenant-local day
  // (start_time = tenant-local midnight, end_time = +24h, reason = the
  // normalized keyword). Columns match the in-memory interface so both impls
  // satisfy `UnavailableBlockRepository`. Tenant-scoped + RLS. Idempotent
  // (IF NOT EXISTS + DROP/CREATE POLICY) so the whole-string runner replays it
  // on every boot.
  '116_tech_unavailable_blocks': `
    CREATE TABLE IF NOT EXISTS tech_unavailable_blocks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      technician_id UUID NOT NULL REFERENCES users(id),
      start_time TIMESTAMPTZ NOT NULL,
      end_time TIMESTAMPTZ NOT NULL,
      reason TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_tech_unavailable_blocks_tech_range
      ON tech_unavailable_blocks (tenant_id, technician_id, start_time, end_time);
    ALTER TABLE tech_unavailable_blocks ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_tech_unavailable_blocks ON tech_unavailable_blocks;
    CREATE POLICY tenant_isolation_tech_unavailable_blocks ON tech_unavailable_blocks
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // P6-028 — daily idempotency key for the tech "I'm out today" SMS. The PK
  // includes local_date (the tech's TENANT-LOCAL calendar date), so a second
  // OUT reply on the same day is a no-op (the INSERT conflicts) and a new day
  // simply has no row — "midnight clear" emerges from the PK with NO cron.
  // status mirrors the three accepted keywords; source_message_sid records the
  // inbound SMS provenance. Tenant-scoped + RLS. Idempotent (IF NOT EXISTS +
  // DROP/CREATE POLICY) so the whole-string runner replays it on every boot.
  '117_tech_status_today': `
    CREATE TABLE IF NOT EXISTS tech_status_today (
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      technician_id UUID NOT NULL REFERENCES users(id),
      local_date DATE NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('out','sick','unavailable')),
      source_message_sid TEXT NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, technician_id, local_date)
    );
    ALTER TABLE tech_status_today ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_tech_status_today ON tech_status_today;
    CREATE POLICY tenant_isolation_tech_status_today ON tech_status_today
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '118_jobs_money_state': `
    -- Denormalized money-state rollup read/written by refreshJobMoneyState
    -- (packages/api/src/jobs/pg-job.ts). The estimate/invoice transition
    -- handlers UPDATE jobs.money_state in the SAME transaction as the status
    -- change, so a missing column aborts the txn and silently rolls the
    -- transition back (the HTTP response still shows the new status). This
    -- column was required by code but created by no migration. IF NOT EXISTS
    -- keeps it safe on databases where it already exists out-of-band.
    ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS money_state TEXT NOT NULL DEFAULT 'no_estimate';
  `,

  '119_view_token_lookup_functions': `
    -- Token-lookup helpers used by pg-estimate.ts / pg-invoice.ts for the
    -- public approval/payment pages. The token IS the auth (no tenant GUC yet),
    -- so the lookup must bypass RLS: SECURITY DEFINER runs as the function
    -- owner, which on Railway/Supabase is a privileged role (superuser /
    -- BYPASSRLS). Required by code but created by no prior migration, so a DB
    -- built from these migrations 500s on every public estimate/invoice page.
    -- Conditional create (not CREATE OR REPLACE) so we NEVER overwrite a
    -- definition that already exists out-of-band in an environment.
    -- PROD-PARITY: confirm the deploy/migrate role can bypass RLS.
    DO $do$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'find_estimate_by_view_token') THEN
        CREATE FUNCTION find_estimate_by_view_token(p_token TEXT)
        RETURNS TABLE (id UUID, tenant_id UUID)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS 'SELECT e.id, e.tenant_id FROM estimates e WHERE e.view_token = p_token';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'find_invoice_by_view_token') THEN
        CREATE FUNCTION find_invoice_by_view_token(p_token TEXT)
        RETURNS TABLE (id UUID, tenant_id UUID)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS 'SELECT i.id, i.tenant_id FROM invoices i WHERE i.view_token = p_token';
      END IF;
    END $do$;
  `,

  // Per-tenant AI config + onboarding AI self-check state. ai_model is seeded
  // from AI_DEFAULT_MODEL when billing completes so the gateway's tenantOverrides
  // path has a model to resolve; the verify_ai worker then makes one real
  // gateway.complete() call and records pass/fail here. ai_api_key_enc is
  // reserved for a future bring-your-own-key flow (encrypted, unused today).
  '120_tenant_settings_ai_config': `
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS ai_model                   TEXT,
      ADD COLUMN IF NOT EXISTS ai_provider                TEXT,
      ADD COLUMN IF NOT EXISTS ai_api_key_enc             TEXT,
      ADD COLUMN IF NOT EXISTS ai_verification_status     TEXT,
      ADD COLUMN IF NOT EXISTS ai_verified_at             TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS ai_verification_error      TEXT,
      ADD COLUMN IF NOT EXISTS ai_verification_started_at TIMESTAMPTZ;
  `,

  '121_estimate_revision_versioning': `
    -- Optimistic-lock + customer re-sync support for the estimate
    -- edit/revise flow. 'version' increments on every persisted content
    -- change; the authenticated edit path and the public approve path
    -- both compare an expected version to reject stale writes. The public
    -- approval page also reads 'version' to detect that an estimate was
    -- revised after the customer loaded it. 'last_revised_at' records the
    -- most recent revise of an already-sent estimate.
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS last_revised_at TIMESTAMPTZ;
  `,

  '122_estimate_reminders': `
    -- Estimate-reminder worker support. 'reminder_count' caps how many
    -- follow-up nudges a sent-but-unanswered estimate receives;
    -- 'last_reminder_at' records the most recent nudge. The worker also
    -- needs to find estimates by send age — that uses the existing
    -- sent_at column with a new sentBefore list filter (no schema change).
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;
  `,

  // Durable record of tenant hard-deletes. Intentionally NOT tenant-scoped:
  // no FK to tenants (the tenant row is gone by the time we write this) and
  // NO row-level security, so it survives the purge and remains readable
  // cross-tenant by ops. This is the only audit trail of a deprovision, since
  // the tenant's audit_events rows are themselves purged. The schema-guard
  // test (every-table-with-tenant_id-has-FORCE) explicitly allowlists this
  // table; the tenant_id column is denormalized identity for the purged row,
  // not a tenancy boundary.
  '123_platform_deprovision_log': `
    CREATE TABLE IF NOT EXISTS platform_deprovision_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      reason TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      twilio_released BOOLEAN NOT NULL DEFAULT FALSE,
      twilio_subaccount_sid TEXT,
      twilio_error TEXT,
      rows_deleted JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_deprovision_log_tenant ON platform_deprovision_log(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_deprovision_log_created ON platform_deprovision_log(created_at);

  `,

  '124_tenant_settings_review_urls': `
    -- Public review links surfaced to happy customers on the post-job
    -- feedback page (4★+). Edited in Settings → Reviews; consumed by the
    -- public feedback POST response. NULL = not configured (no button).
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS google_review_url TEXT,
      ADD COLUMN IF NOT EXISTS yelp_review_url TEXT;
  `,

  // Restored from main: a prior merge into this branch dropped this
  // migration while the snapshot still referenced it. It widens the
  // message_dispatches entity_type CHECK to cover the transactional-comms
  // types the app actually emits (reminders, receipts, overdue, en_route).
  // Ordered before 125_estimates_deleted_at so insertion order stays
  // lexicographically non-decreasing.
  '125_dispatch_entity_en_route': `
    ALTER TABLE message_dispatches
      DROP CONSTRAINT IF EXISTS message_dispatches_entity_type_check;
    ALTER TABLE message_dispatches
      ADD CONSTRAINT message_dispatches_entity_type_check
        CHECK (entity_type IN (
          'estimate', 'invoice', 'appointment_confirmation',
          'appointment_reschedule', 'appointment_cancel', 'appointment_reminder',
          'payment_receipt', 'invoice_overdue', 'delay_notice', 'appointment_en_route'
        ));
  `,

  '125_estimates_deleted_at': `
    -- Soft-delete support for estimates. A non-null deleted_at hides the
    -- estimate from every read path (list/get/job/token lookups) without
    -- destroying the row, preserving the audit trail and any linked
    -- invoice. Accepted estimates are never deletable (enforced in the
    -- service layer). The partial index keeps the hot "live estimates"
    -- scans cheap by only indexing the soft-deleted minority.
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_estimates_deleted
      ON estimates(tenant_id, deleted_at) WHERE deleted_at IS NOT NULL;
  `,

  '126_invoices_estimate_unique': `
    -- One invoice per estimate. The convert-to-invoice flow is idempotent
    -- at the application layer (it returns the existing invoice), and this
    -- partial unique index is the DB-level backstop against a double
    -- convert racing two requests. NULL estimate_id (invoices not made
    -- from an estimate) is unconstrained.
    --
    -- Deploy safety: if existing data already has two invoices pointing at
    -- the same estimate (possible via the legacy POST /api/invoices path),
    -- a UNIQUE index would FAIL the whole migration batch. Detect that and
    -- fall back to a plain index, leaving app-level idempotency as the
    -- guard, so the deploy never breaks on dirty data.
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM invoices
        WHERE estimate_id IS NOT NULL
        GROUP BY estimate_id HAVING COUNT(*) > 1
      ) THEN
        CREATE INDEX IF NOT EXISTS idx_invoices_estimate
          ON invoices(estimate_id) WHERE estimate_id IS NOT NULL;
        RAISE WARNING 'invoices.estimate_id has duplicates; created NON-unique index. Reconcile duplicates then add the unique index manually.';
      ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_estimate
          ON invoices(estimate_id) WHERE estimate_id IS NOT NULL;
      END IF;
    END $$;
  `,

  '127_estimate_line_item_options': `
    -- Good-better-best tiers + optional add-ons on estimate line items.
    --   group_key (non-null)  -> the item is one option in a mutually
    --     exclusive group; the customer picks exactly one per group_key.
    --   group_label           -> human label for the group (e.g. "Roof tier").
    --   is_optional + null group_key -> a standalone add-on (checkbox).
    --   null group_key + is_optional=false -> always billed (the default).
    --   is_default_selected   -> pre-checked tier/add-on shown on first view.
    ALTER TABLE estimate_line_items
      ADD COLUMN IF NOT EXISTS group_key TEXT,
      ADD COLUMN IF NOT EXISTS group_label TEXT,
      ADD COLUMN IF NOT EXISTS is_optional BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS is_default_selected BOOLEAN NOT NULL DEFAULT FALSE;
  `,

  '128_estimates_accepted_selection': `
    -- Locks the customer's good-better-best / add-on selection at accept
    -- time. JSONB array of the estimate_line_item ids the customer chose;
    -- NULL means no optional/tiered items (the whole estimate stands as-is).
    -- The converted invoice reads this snapshot so a later revise can't
    -- change what the customer actually agreed to.
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS accepted_selection JSONB;
  `,

  '129_estimates_one_accepted_per_job': `
    -- At most one accepted estimate per job. The public approve flow has a
    -- read-before-write guard for a friendly message, but that's racy; this
    -- partial unique index is the atomic backstop so two simultaneous
    -- approvals on the same job can't both land 'accepted' and both convert
    -- to invoices. Soft-deleted rows are excluded.
    -- Deploy safety: if data already has two accepted estimates on a job,
    -- a UNIQUE index would fail the migration batch, so fall back to a plain
    -- index + warning (app-level guard still applies).
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM estimates
        WHERE status = 'accepted' AND deleted_at IS NULL
        GROUP BY tenant_id, job_id HAVING COUNT(*) > 1
      ) THEN
        CREATE INDEX IF NOT EXISTS idx_estimates_accepted_per_job
          ON estimates(tenant_id, job_id) WHERE status = 'accepted' AND deleted_at IS NULL;
        RAISE WARNING 'Multiple accepted estimates exist on some jobs; created NON-unique index. Reconcile then add the unique index manually.';
      ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS uq_estimates_accepted_per_job
          ON estimates(tenant_id, job_id) WHERE status = 'accepted' AND deleted_at IS NULL;
      END IF;
    END $$;
  `,

  '130_force_rls_missing_tables': `
    -- Blocker 3: FORCE row-level security on every tenant-scoped table whose
    -- earlier migration only called ENABLE. Without FORCE, the table OWNER
    -- (the role the app connects as on Railway) bypasses RLS, so an unscoped
    -- query inside a connection that forgot setTenantContext could silently
    -- leak across tenants. With FORCE the owner is subject to the same
    -- policies as everyone else; if the GUC is missing, the policy predicate
    -- evaluates to NULL and the row is filtered out.
    --
    -- Idempotent: FORCE ROW LEVEL SECURITY is a no-op when already set.
    ALTER TABLE ai_runs FORCE ROW LEVEL SECURITY;
    ALTER TABLE appointment_calendar_events FORCE ROW LEVEL SECURITY;
    ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
    ALTER TABLE call_summaries FORCE ROW LEVEL SECURITY;
    ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
    ALTER TABLE dispatch_analytics FORCE ROW LEVEL SECURITY;
    ALTER TABLE dropped_call_recoveries FORCE ROW LEVEL SECURITY;
    ALTER TABLE estimate_templates FORCE ROW LEVEL SECURITY;
    ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
    ALTER TABLE files FORCE ROW LEVEL SECURITY;
    ALTER TABLE messages FORCE ROW LEVEL SECURITY;
    ALTER TABLE pending_invitations FORCE ROW LEVEL SECURITY;
    ALTER TABLE phone_rate_limits FORCE ROW LEVEL SECURITY;
    ALTER TABLE portal_sessions FORCE ROW LEVEL SECURITY;
    ALTER TABLE proposals FORCE ROW LEVEL SECURITY;
    ALTER TABLE quality_metrics FORCE ROW LEVEL SECURITY;
    ALTER TABLE service_bundles FORCE ROW LEVEL SECURITY;
    ALTER TABLE tech_status_today FORCE ROW LEVEL SECURITY;
    ALTER TABLE tech_unavailable_blocks FORCE ROW LEVEL SECURITY;
    ALTER TABLE tenant_dnc_list FORCE ROW LEVEL SECURITY;
    ALTER TABLE tenant_oncall_rotation FORCE ROW LEVEL SECURITY;
    ALTER TABLE user_calendar_integrations FORCE ROW LEVEL SECURITY;
    ALTER TABLE users FORCE ROW LEVEL SECURITY;
    ALTER TABLE voice_recordings FORCE ROW LEVEL SECURITY;
    ALTER TABLE voice_sessions FORCE ROW LEVEL SECURITY;
    ALTER TABLE vulnerability_signals FORCE ROW LEVEL SECURITY;
    ALTER TABLE wording_preferences FORCE ROW LEVEL SECURITY;
  `,

  '131_appointment_assignments_no_double_booking': `
    -- Blocker 7: prevent a technician from being assigned to two overlapping
    -- appointments. The application-layer check in assignTechnician() is a
    -- backstop but is subject to a TOCTOU race across concurrent requests
    -- (two simultaneous assigns can both pass the existence check and both
    -- INSERT). This migration adds the authoritative DB-level guard.
    --
    -- Design:
    --
    --  - The conflict is between (technician_id, time-range), but
    --    appointment_assignments has technician_id while appointments
    --    has scheduled_start/end. PostgreSQL EXCLUDE constraints can only
    --    reference columns of the same row, so we denormalize the
    --    appointment's scheduled_start/scheduled_end/status onto
    --    appointment_assignments. The values are maintained by triggers
    --    so application code does not have to know about them.
    --  - A separate partial-unique index enforces at most one primary
    --    technician per appointment (closes the second TOCTOU race in
    --    assignTechnician's demote-then-create dance).
    --  - btree_gist is required so the EXCLUDE constraint can mix equality
    --    on UUID columns with range overlap on the time range in one GIST
    --    index.

    CREATE EXTENSION IF NOT EXISTS btree_gist;

    -- Denormalized columns from appointments. Nullable initially so the
    -- backfill below can run; promoted to NOT NULL once filled.
    ALTER TABLE appointment_assignments
      ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS scheduled_end TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS appointment_status TEXT;

    UPDATE appointment_assignments aa
       SET scheduled_start = a.scheduled_start,
           scheduled_end = a.scheduled_end,
           appointment_status = a.status
      FROM appointments a
     WHERE aa.appointment_id = a.id
       AND aa.tenant_id = a.tenant_id
       AND (aa.scheduled_start IS NULL OR aa.scheduled_end IS NULL OR aa.appointment_status IS NULL);

    -- Any rows still missing values point at a deleted/missing appointment
    -- — orphans that the FK should have prevented. Promote the columns to
    -- NOT NULL only after confirming the backfill covered everything.
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM appointment_assignments
         WHERE scheduled_start IS NULL OR scheduled_end IS NULL OR appointment_status IS NULL
      ) THEN
        RAISE WARNING 'appointment_assignments has rows with missing denormalized fields after backfill; leaving NULLable. Reconcile and re-deploy to enable NOT NULL.';
      ELSE
        ALTER TABLE appointment_assignments
          ALTER COLUMN scheduled_start SET NOT NULL,
          ALTER COLUMN scheduled_end SET NOT NULL,
          ALTER COLUMN appointment_status SET NOT NULL;
      END IF;
    END $$;

    -- Trigger 1 — fill denorm fields on INSERT (or when appointment_id
    -- changes on UPDATE) by reading from the appointment row. Application
    -- code does not need to supply scheduled_start/end/status.
    CREATE OR REPLACE FUNCTION sync_assignment_appointment_fields()
    RETURNS TRIGGER AS $$
    DECLARE
      appt_row RECORD;
    BEGIN
      SELECT scheduled_start, scheduled_end, status
        INTO appt_row
        FROM appointments
       WHERE id = NEW.appointment_id AND tenant_id = NEW.tenant_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Appointment % not found for tenant % when syncing assignment fields',
          NEW.appointment_id, NEW.tenant_id;
      END IF;
      NEW.scheduled_start := appt_row.scheduled_start;
      NEW.scheduled_end := appt_row.scheduled_end;
      NEW.appointment_status := appt_row.status;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_assignment_sync_appointment_fields ON appointment_assignments;
    CREATE TRIGGER trg_assignment_sync_appointment_fields
      BEFORE INSERT OR UPDATE OF appointment_id ON appointment_assignments
      FOR EACH ROW EXECUTE FUNCTION sync_assignment_appointment_fields();

    -- Trigger 2 — propagate scheduled_start/end/status changes from
    -- appointments down to every assignment that points at the row.
    -- Rescheduling an appointment INTO a conflict will surface as an
    -- exclusion_violation from this UPDATE, which is the correct outcome.
    CREATE OR REPLACE FUNCTION sync_appointment_to_assignments()
    RETURNS TRIGGER AS $$
    BEGIN
      IF (NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start
          OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end
          OR NEW.status IS DISTINCT FROM OLD.status) THEN
        UPDATE appointment_assignments
           SET scheduled_start = NEW.scheduled_start,
               scheduled_end = NEW.scheduled_end,
               appointment_status = NEW.status
         WHERE appointment_id = NEW.id AND tenant_id = NEW.tenant_id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_appointments_sync_to_assignments ON appointments;
    CREATE TRIGGER trg_appointments_sync_to_assignments
      AFTER UPDATE ON appointments
      FOR EACH ROW EXECUTE FUNCTION sync_appointment_to_assignments();

    -- EXCLUDE constraint — only added when no pre-existing overlaps remain.
    -- If overlaps exist (legacy data), we WARN and skip; operators must
    -- reconcile then re-deploy. We never silently downgrade to a weaker
    -- check, because that would mask the bug we are closing.
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM appointment_assignments aa1
          JOIN appointment_assignments aa2
            ON aa2.tenant_id = aa1.tenant_id
           AND aa2.technician_id = aa1.technician_id
           AND aa2.id <> aa1.id
         WHERE aa1.appointment_status IS NOT NULL
           AND aa2.appointment_status IS NOT NULL
           AND aa1.appointment_status NOT IN ('canceled', 'no_show')
           AND aa2.appointment_status NOT IN ('canceled', 'no_show')
           AND aa1.scheduled_start IS NOT NULL
           AND aa1.scheduled_end IS NOT NULL
           AND aa2.scheduled_start IS NOT NULL
           AND aa2.scheduled_end IS NOT NULL
           AND tstzrange(aa1.scheduled_start, aa1.scheduled_end)
               && tstzrange(aa2.scheduled_start, aa2.scheduled_end)
      ) THEN
        RAISE WARNING 'Pre-existing overlapping technician assignments detected; skipping no_double_booking EXCLUDE constraint. Reconcile then re-deploy.';
      ELSE
        ALTER TABLE appointment_assignments
          DROP CONSTRAINT IF EXISTS no_double_booking;
        ALTER TABLE appointment_assignments
          ADD CONSTRAINT no_double_booking
          EXCLUDE USING gist (
            tenant_id WITH =,
            technician_id WITH =,
            tstzrange(scheduled_start, scheduled_end) WITH &&
          )
          WHERE (appointment_status NOT IN ('canceled', 'no_show'));
      END IF;
    END $$;

    -- Partial unique — closes the demote-then-create race in
    -- assignTechnician. Without this, two concurrent primary assigns can
    -- both pass the demote step and both INSERT is_primary = true.
    DROP INDEX IF EXISTS uq_assignment_primary_per_appointment;
    CREATE UNIQUE INDEX uq_assignment_primary_per_appointment
      ON appointment_assignments (tenant_id, appointment_id)
      WHERE is_primary;
  `,

  '132_customer_consent_status': `
    -- Blocker 11 (TCPA / DNC compliance for voice-on launch).
    --
    -- An outbound AI call to a US number requires either prior express
    -- consent (autodialer / pre-recorded message) or a documented
    -- business relationship under the TCPA Safe Harbor. We store the
    -- per-customer consent decision so the outbound gate can refuse a
    -- call when the customer hasn't opted in.
    --
    -- The DNC list (\`tenant_dnc_list\`, migration 052) is the
    -- tenant-local opt-out registry; a number on that list overrides
    -- any granted consent.
    --
    -- Default 'not_requested' so existing rows don't accidentally
    -- become 'granted' (which would be the riskiest possible default).
    ALTER TABLE customers
      ADD COLUMN IF NOT EXISTS consent_status TEXT NOT NULL DEFAULT 'not_requested'
        CHECK (consent_status IN ('not_requested', 'granted', 'revoked', 'expired')),
      ADD COLUMN IF NOT EXISTS consent_recorded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS consent_recorded_by TEXT,
      ADD COLUMN IF NOT EXISTS consent_method TEXT;
  `,

  // Invoice-to-cash failure handling. A SETTLED payment can later FAIL:
  // an ACH/bank debit returned for insufficient funds (NSF), or a card
  // chargeback. Unlike a refund (D2-4, which keeps the row 'completed'
  // and accumulates refunded_amount_cents), a REVERSAL flips the payment
  // to 'failed' — so it drops out of gross-revenue math (the money
  // dashboard sums only status='completed') — and REOPENS the linked
  // invoice (paid -> open/partially_paid) so it re-enters collections.
  // reversed_at/reversal_reason record when + why; reversePayment()
  // flips 'completed' -> 'failed' atomically, guarded on
  // `reversed_at IS NULL` so a duplicate webhook delivery is a no-op.
  '133_payments_reversal_tracking': `
    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS reversal_reason TEXT NULL;
    CREATE INDEX IF NOT EXISTS idx_payments_reversed_at
      ON payments(reversed_at) WHERE reversed_at IS NOT NULL;

    -- Widen the payment_method CHECK to match the domain PaymentMethod
    -- union the code actually writes. The original inline constraint
    -- only allowed ('stripe','cash','check','other'), but the Stripe
    -- checkout webhook records 'credit_card' and the async-settlement
    -- (ACH) path records 'bank_transfer' — both previously violated the
    -- CHECK. Explicit DROP + ADD mirrors proposals_status_check.
    ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_method_check;
    ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check
      CHECK (payment_method IN ('stripe', 'cash', 'check', 'credit_card', 'bank_transfer', 'other'));
  `,

  '134_proposal_chains': `
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS chain_id UUID;
    CREATE INDEX IF NOT EXISTS idx_proposals_chain ON proposals(tenant_id, chain_id);
  `,

  // Idempotency key for AI-placed tentative holds. A redelivered voice
  // message (at-least-once queue) must not create a second appointment hold
  // for the same recording. The held-slot path stamps a deterministic key
  // (`voice-hold:<recordingId>`); the partial unique index dedups concurrent
  // re-inserts while leaving ordinary (keyless) appointments unaffected.
  '135_appointments_idempotency_key': `
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_idempotency
      ON appointments(tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `,

  '136_create_invoice_dunning': `
    CREATE TABLE IF NOT EXISTS invoice_dunning_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      -- ordered cadence, e.g.
      -- [{"offsetDays":3,"channel":"sms"},{"offsetDays":7,"channel":"email"}]
      reminder_steps JSONB NOT NULL DEFAULT '[]',
      late_fee_type TEXT NOT NULL DEFAULT 'none'
        CHECK (late_fee_type IN ('none','flat','percent')),
      -- flat: amount in integer cents; percent: basis points (bps) of amount_due
      late_fee_value_cents BIGINT NOT NULL DEFAULT 0,
      late_fee_grace_days INTEGER NOT NULL DEFAULT 0,
      late_fee_max_cents BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id)
    );
    -- (No separate tenant index: UNIQUE (tenant_id) already backs lookups.)
    ALTER TABLE invoice_dunning_configs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE invoice_dunning_configs FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_invoice_dunning_configs ON invoice_dunning_configs;
    CREATE POLICY tenant_isolation_invoice_dunning_configs ON invoice_dunning_configs
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

    CREATE TABLE IF NOT EXISTS invoice_dunning_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('reminder','late_fee')),
      -- Stable per-step idempotency key (survives cadence edits): reminders use
      -- '<offsetDays>:<channel>'; late fees use the accrual-period key supplied
      -- by the worker (one-time fees use 'initial').
      step_key TEXT NOT NULL,
      amount_cents BIGINT,
      channel TEXT,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, invoice_id, kind, step_key)
    );
    -- (No separate (tenant_id, invoice_id) index: the composite UNIQUE above
    --  leads with those columns and already serves per-invoice lookups.)
    CREATE INDEX IF NOT EXISTS idx_dunning_events_tenant ON invoice_dunning_events(tenant_id);
    ALTER TABLE invoice_dunning_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE invoice_dunning_events FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_invoice_dunning_events ON invoice_dunning_events;
    CREATE POLICY tenant_isolation_invoice_dunning_events ON invoice_dunning_events
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '137_technician_working_hours': `
    CREATE TABLE IF NOT EXISTS technician_working_hours (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      technician_id UUID NOT NULL REFERENCES users(id),
      day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT uq_working_hours_per_tech_day UNIQUE (tenant_id, technician_id, day_of_week)
    );
    CREATE INDEX IF NOT EXISTS idx_technician_working_hours_tech
      ON technician_working_hours (tenant_id, technician_id);
    ALTER TABLE technician_working_hours ENABLE ROW LEVEL SECURITY;
    ALTER TABLE technician_working_hours FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_technician_working_hours ON technician_working_hours;
    CREATE POLICY tenant_isolation_technician_working_hours ON technician_working_hours
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '138_tenant_settings_auto_invoice_on_completion': `
    -- P20-001: opt-in toggle to auto-draft an invoice when a job is marked
    -- complete. Off by default — owners opt in; the draft still routes
    -- through the proposal/approval gate before anything is sent.
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS auto_invoice_on_completion BOOLEAN NOT NULL DEFAULT false;
  `,

  '139_create_invoice_schedules': `
    -- P21-001: progress / milestone billing. One schedule splits a job's total
    -- into ordered milestones, each minted as its own invoice.
    CREATE TABLE IF NOT EXISTS invoice_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      estimate_id UUID REFERENCES estimates(id),
      total_amount_cents BIGINT NOT NULL,
      -- ordered milestones, e.g.
      -- [{"label":"Deposit","type":"percent","value":5000,"trigger":"on_accept"},
      --  {"label":"Balance","type":"remainder","value":0,"trigger":"on_completion"}]
      -- percent value is basis points (bps); flat is integer cents.
      milestones JSONB NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_schedules_job
      ON invoice_schedules(tenant_id, job_id);
    ALTER TABLE invoice_schedules ENABLE ROW LEVEL SECURITY;
    ALTER TABLE invoice_schedules FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_invoice_schedules ON invoice_schedules;
    CREATE POLICY tenant_isolation_invoice_schedules ON invoice_schedules
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

    -- Link each minted milestone invoice back to its schedule + position.
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES invoice_schedules(id),
      ADD COLUMN IF NOT EXISTS milestone_index INTEGER;
  `,

  '140_batch_invoicing': `
    -- P21-003: batch-invoice sweep. Per (tenant, job, batch_date) dedup ledger
    -- so a re-run never re-batches a job, plus a per-tenant opt-in toggle.
    CREATE TABLE IF NOT EXISTS batch_invoice_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      -- Calendar date (YYYY-MM-DD) the batch ran.
      batch_date TEXT NOT NULL,
      proposal_id UUID REFERENCES proposals(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, job_id, batch_date)
    );
    CREATE INDEX IF NOT EXISTS idx_batch_invoice_runs_tenant
      ON batch_invoice_runs(tenant_id);
    ALTER TABLE batch_invoice_runs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE batch_invoice_runs FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_batch_invoice_runs ON batch_invoice_runs;
    CREATE POLICY tenant_isolation_batch_invoice_runs ON batch_invoice_runs
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS batch_invoice_enabled BOOLEAN NOT NULL DEFAULT false;
  `,

  '141_milestone_billing_safeguards': `
    -- P0 launch hardening for milestone (schedule) billing.
    --
    -- (1) One billing schedule per job. A create_invoice_schedule execution
    --     that wrote the schedule row but then failed before drafting the
    --     deposit left the proposal retryable with no resultEntityId; the retry
    --     minted a SECOND schedule (fresh uuid). The completion hook dedups on
    --     schedule_id, so two schedules billed the on_completion balance TWICE.
    --     This unique index makes a duplicate schedule impossible at the DB.
    --
    --     RECONCILIATION (runs first): a DB that already hit this bug — or the
    --     double-mint bug (2) — has duplicate rows the indexes below would
    --     abort on. The deploy/migrate role bypasses RLS (see migration 119),
    --     so this runs fleet-wide. For each job we keep ONE surviving schedule,
    --     re-point every other duplicate's invoices onto it, unlink any invoice
    --     that would then collide on (schedule_id, milestone_index) — keeping
    --     the earliest and NULLing the rest's schedule link, so NO billing row
    --     is deleted, only detached for manual review — then delete the emptied
    --     duplicate schedules. Idempotent: once the indexes hold, every step
    --     below matches nothing, so re-running this migration is a no-op.

    --     (i) Re-point invoices from each non-surviving duplicate schedule onto
    --         the survivor (most invoices, then earliest, then lowest id).
    WITH counts AS (
      SELECT s.tenant_id, s.job_id, s.id, s.created_at, COUNT(i.id) AS inv_count
      FROM invoice_schedules s
      LEFT JOIN invoices i ON i.schedule_id = s.id
      GROUP BY s.tenant_id, s.job_id, s.id, s.created_at
    ),
    survivors AS (
      SELECT DISTINCT ON (tenant_id, job_id) tenant_id, job_id, id AS survivor_id
      FROM counts
      ORDER BY tenant_id, job_id, inv_count DESC, created_at ASC, id ASC
    )
    UPDATE invoices i
    SET schedule_id = sv.survivor_id
    FROM invoice_schedules s
    JOIN survivors sv ON sv.tenant_id = s.tenant_id AND sv.job_id = s.job_id
    WHERE i.schedule_id = s.id AND s.id <> sv.survivor_id;

    --     (ii) Resolve (schedule_id, milestone_index) collisions — from the
    --          re-point above OR a prior double-mint — keeping the earliest
    --          invoice per pair and unlinking the rest (schedule_id = NULL).
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY schedule_id, milestone_index
               ORDER BY created_at ASC, id ASC
             ) AS rn
      FROM invoices
      WHERE schedule_id IS NOT NULL AND milestone_index IS NOT NULL
    )
    UPDATE invoices i
    SET schedule_id = NULL
    FROM ranked
    WHERE i.id = ranked.id AND ranked.rn > 1;

    --     (iii) Delete the now-empty duplicate schedules (nothing references them).
    WITH counts AS (
      SELECT s.tenant_id, s.job_id, s.id, s.created_at, COUNT(i.id) AS inv_count
      FROM invoice_schedules s
      LEFT JOIN invoices i ON i.schedule_id = s.id
      GROUP BY s.tenant_id, s.job_id, s.id, s.created_at
    ),
    survivors AS (
      SELECT DISTINCT ON (tenant_id, job_id) tenant_id, job_id, id AS survivor_id
      FROM counts
      ORDER BY tenant_id, job_id, inv_count DESC, created_at ASC, id ASC
    )
    DELETE FROM invoice_schedules s
    USING survivors sv
    WHERE sv.tenant_id = s.tenant_id AND sv.job_id = s.job_id AND s.id <> sv.survivor_id;

    CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_schedules_job
      ON invoice_schedules(tenant_id, job_id);

    -- (2) One invoice per (schedule, milestone). The completion hook decided
    --     "already minted" from an application read with no DB backstop and no
    --     lock, so two concurrent / retried "mark complete" requests could both
    --     mint the same balance invoice. Partial — non-milestone invoices carry
    --     NULL schedule_id and must not collide.
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_schedule_milestone
      ON invoices(schedule_id, milestone_index)
      WHERE schedule_id IS NOT NULL;

    -- (3) Fleet-wide opt-in / kill switch for on-completion milestone minting.
    --     Mirrors auto_invoice_on_completion + batch_invoice_enabled (opt-in,
    --     default false) so milestone billing — which writes real invoices
    --     directly — is never silently active fleet-wide and can be halted in
    --     an incident without deleting schedules.
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS milestone_billing_enabled BOOLEAN NOT NULL DEFAULT false;
  `,

  '142_proposals_source_recording_index': `
    -- P1 perf: the voice redelivery dedup (findAlreadyProcessed) used to
    -- SELECT every proposal for the tenant and JS-scan for a recordingId on
    -- EVERY inbound voice message — O(tenant proposals), growing forever. The
    -- replacement findByRecordingId looks up by idempotency_key (already
    -- indexed) OR source_context->>'recordingId'; this index serves the latter
    -- branch so the whole lookup is indexed instead of a full-tenant scan.
    CREATE INDEX IF NOT EXISTS idx_proposals_source_recording
      ON proposals (tenant_id, (source_context->>'recordingId'));
  `,
  '143_tenant_settings_owner_phone': `
    -- P8-016 (forward-wiring) — the OWNER's personal cell phone used by
    -- vulnerability-aware emergency triage to patch a customer call
    -- directly to the owner with a 5-second context preface. Stored in
    -- E.164 (+15551234567). Distinct from business_phone (the public number
    -- the AI answers on) and from users.mobile_number (per-team-member
    -- binding, multi-user model). For V1 solo operators there is one owner
    -- per tenant, so settings is the natural home.
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS owner_phone TEXT;
  `,

  '144_tenants_pending_checkout_at': `
    -- Trial-checkout dedup. When a tenant opens Stripe Checkout, we
    -- stamp pending_checkout_at = NOW() inside the same advisory-lock
    -- transaction that mints the session. A second checkout request
    -- that arrives BEFORE Stripe's subscription.created webhook has
    -- flipped subscription_status to 'trialing' sees the pending
    -- timestamp inside its own gate check and refuses — closing the
    -- residual race the in-process advisory lock alone could not
    -- cover (lock-release vs webhook-delivery window). Cleared by
    -- the subscription.created webhook handler; a 30-minute timeout
    -- in the gate handles abandoned checkouts.
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS pending_checkout_at TIMESTAMPTZ;
  `,

  '145_tenants_pending_checkout_session_id': `
    -- Pair the pending_checkout_at marker with the Stripe session id
    -- so cancellation can actively EXPIRE the open session at Stripe
    -- before reopening the gate. Earlier attempts to round-trip the
    -- id via cancel_url interpolation failed — Stripe only expands
    -- {CHECKOUT_SESSION_ID} in success_url. Persisting it server-side
    -- on creation is the supported path. Cleared together with
    -- pending_checkout_at when the subscription.created webhook lands
    -- or when the cancel endpoint runs.
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS pending_checkout_session_id TEXT;
  `,

  '146_tenant_settings_activated_at': `
    -- Activation marker — stamped exactly once, the first time a tenant
    -- receives a "real" inbound call after the voice agent goes live (see
    -- voice/activation.ts for the count-based rule). Drives the
    -- first_real_call_received funnel event's once-per-tenant idempotency
    -- and the in-app celebration banner. Additive, nullable, no default:
    -- NULL means "not yet activated". Inherits tenant_settings' existing
    -- FORCE-RLS tenant_isolation policy — no new policy required.
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
  `,

  '147_tenant_settings_vapi_assistant': `
    -- Vapi voice-assistant binding. vapi_assistant_id is the assistant
    -- created (and linked to the tenant's provisioned phone number) during
    -- onboarding; voice_id is the chosen ElevenLabs preset voice persisted
    -- onto that assistant. Both additive + nullable; inherit tenant_settings'
    -- FORCE-RLS tenant_isolation policy. NULL = assistant not yet created.
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS vapi_assistant_id TEXT;
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS voice_id TEXT;
  `,

  '148_tenant_settings_business_profile_extras': `
    -- Business-profile fields collected by the onboarding identity step that
    -- weren't previously modelled: a street/service address, the list of ZIP
    -- codes the tenant serves, and the multi-select of services offered
    -- (catalog keys). Additive, nullable; arrays default to empty so reads
    -- never NPE. Inherit tenant_settings' FORCE-RLS policy.
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS service_address TEXT;
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS service_area_zips TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS services_offered TEXT[] NOT NULL DEFAULT '{}';
  `,

  '149_tenant_settings_calendar_provider': `
    -- Calendar connection chosen in the onboarding calendar step:
    -- 'google' (OAuth) or 'builtin' (skip path / use ServiceOS scheduling).
    -- NULL = not yet chosen. Additive; inherits the FORCE-RLS policy.
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS calendar_provider TEXT
        CHECK (calendar_provider IS NULL OR calendar_provider IN ('google', 'builtin'));
  `,

  '150_tenant_settings_availability_template': `
    -- Tech-availability template seeded from the next 7 days of the owner's
    -- Google Calendar free/busy on connect (see availability/seed-from-google.ts).
    -- JSONB: { source, generatedAt, windowDays, busy: [{start,end}] }. NULL
    -- until a Google calendar is connected + seeded. Additive; inherits the
    -- FORCE-RLS policy.
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS availability_template JSONB;
  `,

  '151_tenant_settings_bill_labor_from_time_entries': `
    -- Feature (launch): opt-in toggle to recompute an auto-drafted invoice's
    -- labor line from ACTUAL logged time entries instead of the estimated
    -- hours. Off by default — owners opt in; with no tracked time the estimate
    -- is billed as-is. tenant_settings already carries RLS, so this additive
    -- column needs no policy change.
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS bill_labor_from_time_entries BOOLEAN NOT NULL DEFAULT false;
  `,

  // Voice CSR parity — bilingual opt-in + single-line human transfer.
  // (Renumbered to 152/153 on merge: main landed 147–151 first; migrations
  // are append-only and ordered, so these slot in after.)
  //   * transfer_number: E.164 line the inbound-CSR warm transfer dials. When
  //     set it REPLACES the on-call rotation for the standard human handoff
  //     (low-confidence / caller-requested). Nullable — tenants without it fall
  //     back to the rotation path.
  //   * supported_languages: opt-in language stack for the voice agent. Defaults
  //     to ['en']; a tenant opts into Spanish by storing ARRAY['en','es']. The
  //     language detector only switches a call to 'es' when 'es' is present here.
  // App/Zod layer constrains values to the {en,es} subset; the DB keeps the
  // permissive TEXT[] so a future language add doesn't need a CHECK rewrite.
  '152_voice_parity_transfer_and_languages': `
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS transfer_number TEXT,
      ADD COLUMN IF NOT EXISTS supported_languages TEXT[] NOT NULL DEFAULT ARRAY['en']::TEXT[];
  `,

  // call_me_back_tasks — first-class follow-up captured when a warm transfer to
  // transfer_number fails (no-answer/busy). The AI takes a callback message from
  // the caller; the async sweep (call-me-back-worker, P0-009 pattern) notifies
  // the CSR. Distinct from proposals: a callback is an operational task, not an
  // AI mutation requiring approval.
  '153_create_call_me_back_tasks': `
    CREATE TABLE IF NOT EXISTS call_me_back_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      session_id TEXT,
      call_sid TEXT,
      caller_phone TEXT NOT NULL,
      caller_name TEXT,
      callback_message TEXT,
      intent_summary TEXT,
      reason TEXT NOT NULL DEFAULT 'transfer_failed',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'notified', 'completed', 'cancelled')),
      scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE call_me_back_tasks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE call_me_back_tasks FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_call_me_back ON call_me_back_tasks;
    CREATE POLICY tenant_isolation_call_me_back ON call_me_back_tasks
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
    CREATE INDEX IF NOT EXISTS idx_cmb_tenant
      ON call_me_back_tasks (tenant_id);
    CREATE INDEX IF NOT EXISTS idx_cmb_pending
      ON call_me_back_tasks (tenant_id) WHERE status = 'pending';
  `,

  // Idempotency for the failed-transfer callback. A Twilio retry of
  // /callback-message carries the same session id (?sid), so one pending
  // callback per session lets create() no-op + return the existing row
  // instead of inserting a duplicate that would notify the CSR twice. Partial
  // (session_id IS NOT NULL) so non-session-originated rows are unconstrained.
  '154_call_me_back_session_idempotency': `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cmb_session_unique
      ON call_me_back_tasks (tenant_id, session_id)
      WHERE session_id IS NOT NULL;
  `,

  '155_tenant_integrations_google_business': `
    -- QA-2026-06-10: google-reviews-worker logs "column credentials does not exist"
    -- on every sweep. Root cause: migration 101_google_reviews added the
    -- google_business integration but never updated tenant_integrations:
    --   1. The provider CHECK only allows ('twilio', 'sendgrid') — no 'google_business'
    --   2. There is no 'credentials' JSONB column — CredentialResolver.getCredential
    --      runs: SELECT tenant_id, provider, credentials, credential_version
    --            FROM tenant_integrations ...
    --      which fails immediately.
    -- Fix: widen the provider constraint and add the credentials column.

    -- Widen the provider CHECK constraint to include 'google_business'.
    ALTER TABLE tenant_integrations
      DROP CONSTRAINT IF EXISTS tenant_integrations_provider_check;
    ALTER TABLE tenant_integrations
      ADD CONSTRAINT tenant_integrations_provider_check
        CHECK (provider IN ('twilio', 'sendgrid', 'google_business'));

    -- Add the credentials JSONB column used by CredentialResolver.getCredential.
    -- Defaults to '{}' so existing twilio/sendgrid rows are unaffected.
    ALTER TABLE tenant_integrations
      ADD COLUMN IF NOT EXISTS credentials JSONB NOT NULL DEFAULT '{}';
  `,

  '156_proposal_sms_events': `
    -- P2-034: SMS approval transport. Append-only record of the SMS
    -- conversation around a proposal (outbound renders, inbound
    -- approve/reject replies, edit sessions, clarification nudges).
    -- Read paths: latest outbound render (which proposal is the owner
    -- replying to?) and open edit session (unconsumed, unexpired).
    CREATE TABLE IF NOT EXISTS proposal_sms_events (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      proposal_id UUID NOT NULL REFERENCES proposals(id),
      direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
      kind TEXT NOT NULL CHECK (kind IN (
        'proposal_rendered','reapproval_rendered','clarification_sent',
        'reply_approve','reply_reject','edit_session_opened','edit_request'
      )),
      message_sid TEXT,
      body TEXT NOT NULL,
      expires_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_proposal_sms_events_tenant_recent
      ON proposal_sms_events (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proposal_sms_events_proposal
      ON proposal_sms_events (tenant_id, proposal_id);
    ALTER TABLE proposal_sms_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE proposal_sms_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_proposal_sms_events ON proposal_sms_events
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  '157_proposal_sms_events_from_phone': `
    -- P2-034 review fix: edit sessions must be scoped to the sender.
    -- Tenants can have two approvers (owner + backup supervisor); a
    -- tenant-wide open session let approver B's Y/N be consumed as
    -- approver A's edit instruction. Normalized sender digits, set on
    -- inbound events; outbound rows stay NULL.
    ALTER TABLE proposal_sms_events
      ADD COLUMN IF NOT EXISTS from_phone TEXT;
  `,

  '158_proposal_sms_events_seq': `
    -- P2-034 review fix: created_at has millisecond precision, so
    -- back-to-back renders (multi-action chains) can tie and "the latest
    -- outbound render" — which decides what a Y/N reply targets — becomes
    -- nondeterministic. BIGSERIAL backfills existing rows in insertion
    -- order and gives every new row a monotonic tiebreaker.
    ALTER TABLE proposal_sms_events
      ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
  `,

  // RV-001: per-tenant feature flag overrides.
  // Resolution order: tenant override → platform flag → false.
  '159_create_tenant_feature_flags': `
    CREATE TABLE IF NOT EXISTS tenant_feature_flags (
      tenant_id  UUID      NOT NULL REFERENCES tenants(id),
      flag_key   TEXT      NOT NULL,
      enabled    BOOLEAN   NOT NULL,
      updated_by UUID,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, flag_key)
    );
    ALTER TABLE tenant_feature_flags ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_feature_flags FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_tenant_feature_flags ON tenant_feature_flags
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // RV-005: generalized attachments foundation — photos & documents linked
  // to any supported entity. `job_photos` stays untouched for back-compat;
  // new surfaces (invoice/estimate photo UX, voice attach, portal galleries)
  // read this table. `pair_group_id`/`pair_role` model before/after pairs;
  // `archived_at` is a soft delete (the underlying files row + S3 object
  // remain, mirroring the job-photos delete semantics).
  '160_create_attachments': `
    CREATE TABLE IF NOT EXISTS attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      file_id UUID NOT NULL REFERENCES files(id),
      entity_type TEXT NOT NULL CHECK (entity_type IN ('job','invoice','estimate','form_response','expense','agreement_run','customer')),
      entity_id UUID NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('photo','document')),
      caption TEXT,
      category TEXT CHECK (category IN ('before','after','problem','completion','receipt','signature','other')),
      pair_group_id UUID,
      pair_role TEXT CHECK (pair_role IN ('before','after')),
      portal_visible BOOLEAN NOT NULL DEFAULT false,
      annotated_file_id UUID REFERENCES files(id),
      uploaded_by TEXT,
      source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','voice','portal','sms')),
      sort_order INT NOT NULL DEFAULT 0,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_tenant_entity ON attachments(tenant_id, entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_tenant_pair_group ON attachments(tenant_id, pair_group_id);
    ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_attachments ON attachments
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // RV-006: image post-process pipeline outputs. The async worker stamps
  // dimensions (post EXIF-rotation), the 480px thumbnail key, whether EXIF
  // was stripped (false = non-image or graceful-degraded unsupported
  // format), and the SHA-256 of the final stored object. content_hash
  // doubles as the worker's idempotency marker and powers the attach-time
  // dedupe lookup, hence the (tenant_id, content_hash) index.
  '161_files_image_pipeline_columns': `
    ALTER TABLE files ADD COLUMN IF NOT EXISTS width INT;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS height INT;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS thumbnail_s3_key TEXT;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS exif_stripped BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS content_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_files_tenant_content_hash ON files(tenant_id, content_hash);
  `,
  // RV-060 (F-9): end-of-day digest snapshots. One row per tenant per
  // tenant-local calendar day; `payload` is the computed snapshot (money in,
  // jobs done, tomorrow's schedule, pending approvals, flags) so the web
  // view and voice readback render exactly what was sent. `narrative` is the
  // brand-voice text; `sms_dispatch_id` records the owner SMS send (NULL =
  // stored but not yet sent — the worker's resend guard keys off it). The
  // UNIQUE(tenant_id, digest_date) is the idempotency anchor: overlapping
  // sweeps INSERT … ON CONFLICT DO NOTHING and only the winner sends.
  // The message_dispatches CHECK is widened so the owner digest SMS can be
  // recorded in the same dispatch audit trail as every other send.
  '162_create_daily_digests': `
    CREATE TABLE IF NOT EXISTS daily_digests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      digest_date DATE NOT NULL,
      payload JSONB NOT NULL,
      narrative TEXT,
      sms_dispatch_id UUID,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(tenant_id, digest_date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_digests_tenant_date
      ON daily_digests (tenant_id, digest_date);
    ALTER TABLE daily_digests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE daily_digests FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_daily_digests ON daily_digests
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // RV-063 (F-9): per-tenant digest delivery settings. Opt-in
  // (digest_enabled defaults false); digest_time is a tenant-local
  // wall-clock time (the worker buckets it in tenant tz); digest_channel
  // 'none' keeps generating/storing the digest (web view) without SMS.
  '163_tenant_settings_digest': `
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS digest_time TIME NOT NULL DEFAULT '18:00';
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS digest_channel TEXT NOT NULL DEFAULT 'sms'
        CHECK (digest_channel IN ('sms','none'));
  `,

  // RV-061 (F-9): widen message_dispatches entity_type CHECK to allow
  // 'daily_digest' (owner end-of-day digest SMS, entity_id = daily_digests.id).
  // Mirrors the prior widenings in 092_extend_dispatch_entity_types and
  // 125_dispatch_entity_en_route — kept separate from 162_create_daily_digests
  // so the table-creation and the constraint change are independently
  // reviewable and reversible.
  '164_dispatch_entity_daily_digest': `
    ALTER TABLE message_dispatches
      DROP CONSTRAINT IF EXISTS message_dispatches_entity_type_check;
    ALTER TABLE message_dispatches
      ADD CONSTRAINT message_dispatches_entity_type_check
        CHECK (entity_type IN (
          'estimate', 'invoice', 'appointment_confirmation',
          'appointment_reschedule', 'appointment_cancel', 'appointment_reminder',
          'payment_receipt', 'invoice_overdue', 'delay_notice', 'appointment_en_route',
          'daily_digest'
        ));
  `,

  // RV-074 review fix: widen the proposal_sms_events kind CHECK from 156 to
  // allow 'review_required_rendered' — the outbound anchor row recorded when
  // a LOW/VERY_LOW-confidence proposal SMS ("needs review in app — reply N
  // to reject") goes out. Without an anchor, the reply transport's
  // findRecentOutbound targeted the previous (older) render, so the N the
  // message itself solicits would reject the WRONG proposal. Mirrors the
  // CHECK-widening style of 164_dispatch_entity_daily_digest.
  '165_proposal_sms_events_review_required_kind': `
    ALTER TABLE proposal_sms_events
      DROP CONSTRAINT IF EXISTS proposal_sms_events_kind_check;
    ALTER TABLE proposal_sms_events
      ADD CONSTRAINT proposal_sms_events_kind_check
        CHECK (kind IN (
          'proposal_rendered','reapproval_rendered','clarification_sent',
          'reply_approve','reply_reject','edit_session_opened','edit_request',
          'review_required_rendered'
        ));
  `,

  // RV-120 — per-call vulnerability triage outcomes. One row per
  // `evaluateTriage` evaluation (turn-batch grader, RV-122) so post-incident
  // review can audit the triage matrix per session without replaying audio.
  // `signals` carries the NON-PII evidence strings (same discipline as
  // migration 115's vulnerability_signals); `action_taken` records what the
  // call actually did with the decision (patched owner, urgent booking,
  // normal flow). voice_session_id is TEXT — in-memory session ids are not
  // UUIDs on every channel. Idempotent (IF NOT EXISTS + DROP/CREATE POLICY).
  '166_create_triage_events': `
    CREATE TABLE IF NOT EXISTS triage_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      voice_session_id TEXT NOT NULL,
      customer_id UUID,
      score NUMERIC NOT NULL,
      tier TEXT NOT NULL CHECK (tier IN ('none', 'low', 'elevated', 'critical')),
      signals JSONB NOT NULL DEFAULT '[]'::jsonb,
      action_taken TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_triage_events_tenant_created
      ON triage_events (tenant_id, created_at);
    ALTER TABLE triage_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE triage_events FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_triage_events ON triage_events;
    CREATE POLICY tenant_isolation_triage_events ON triage_events
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,
  // Rivet P2 F-1 — Supervisor Agent v1 (deterministic policy engine).
  // Note: migrations 165 and 166 are reserved by parallel sibling tracks.
  //
  // supervisor_policies: versioned per-tenant rule sets. `rules` is the
  // SupervisorRules JSONB (src/proposals/supervisor/policy.ts) — all keys
  // optional, unset = permissive. Exactly one version per tenant SHOULD be
  // active at a time (enforced by the repo's activate(), which deactivates
  // siblings in the same transaction); UNIQUE(tenant_id, version) pins the
  // version ledger. Indexed on (tenant_id, active) for the hot
  // getActive() read on every proposal creation.
  //
  // tenant_budget_counters: fixed-window counters backing the budget caps
  // (daily executed spend per UTC day, auto-approvals per UTC hour —
  // window_start is the UTC truncation; v1 deliberately does NOT use
  // tenant-local windows). Incremented via INSERT .. ON CONFLICT value =
  // value + delta so concurrent writers never lose updates.
  '167_create_supervisor_policies': `
    CREATE TABLE IF NOT EXISTS supervisor_policies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      version INT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT false,
      rules JSONB NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(tenant_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_supervisor_policies_tenant_active
      ON supervisor_policies (tenant_id, active);
    ALTER TABLE supervisor_policies ENABLE ROW LEVEL SECURITY;
    ALTER TABLE supervisor_policies FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_supervisor_policies ON supervisor_policies
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

    CREATE TABLE IF NOT EXISTS tenant_budget_counters (
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      counter_key TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      value BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, counter_key, window_start)
    );
    ALTER TABLE tenant_budget_counters ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_budget_counters FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_tenant_budget_counters ON tenant_budget_counters
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // RV-130 — append-only consent ledger. Every consent-relevant moment
  // (implicit recording consent at disclosure, an explicit "stop recording"
  // objection, an SMS opt-in/out, portal/manual grants) appends one event;
  // rows are NEVER updated or deleted (the derived customers.consent_status
  // from migration 132 is the mutable rollup). phone_normalized is the
  // digits-only E.164 so lookups survive formatting drift. Idempotent.
  '168_create_consent_events': `
    CREATE TABLE IF NOT EXISTS consent_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      customer_id UUID,
      phone_normalized TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('recording', 'sms', 'marketing')),
      state TEXT NOT NULL CHECK (state IN ('granted', 'revoked', 'implicit')),
      source TEXT NOT NULL CHECK (source IN ('voice', 'sms', 'portal', 'manual')),
      voice_session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_consent_events_tenant_phone
      ON consent_events (tenant_id, phone_normalized);
    ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE consent_events FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_consent_events ON consent_events;
    CREATE POLICY tenant_isolation_consent_events ON consent_events
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // RV-132 — per-tenant recording retention. recording_retention_days drives
  // the retention worker's purge horizon; legal_hold exempts a recording from
  // any purge regardless of age; purged_at is the tombstone the worker stamps
  // after deleting the S3 object (the row is kept for audit — the 007 status
  // CHECK has no 'deleted' value, so a dedicated nullable marker is the
  // non-destructive tombstone). Idempotent.
  '169_recording_retention': `
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS recording_retention_days INT NOT NULL DEFAULT 365;
    ALTER TABLE tenant_settings
      DROP CONSTRAINT IF EXISTS chk_recording_retention_days_positive;
    ALTER TABLE tenant_settings
      ADD CONSTRAINT chk_recording_retention_days_positive
        CHECK (recording_retention_days > 0);
    ALTER TABLE voice_recordings
      ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE voice_recordings
      ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_voice_recordings_retention
      ON voice_recordings (created_at)
      WHERE purged_at IS NULL AND legal_hold = false;
  `,
  // NOTE: recording_retention_days is not currently exposed at any settings
  // write surface (no API endpoint, no settings contract field). If a write
  // route is added in the future, validate retention_days > 0 there too.

  // RV-115 — state-aware dropped-call recovery. The scheduler snapshots
  // {state, intent, entitiesResolved, proposalIds} from the FSM at the moment
  // the call terminated without reaching 'closing'; the recovery SMS handler
  // composes a state-aware cue from it and the inbound resume handler
  // (RV-116) uses it to confirm a pending booking / schedule a callback.
  // JSONB NULL — rows scheduled before this migration simply have no context.
  '170_dropped_call_recovery_context': `
    ALTER TABLE dropped_call_recoveries
      ADD COLUMN IF NOT EXISTS context JSONB;
  `,
  // Track E (RV-225 audit fix): widen the proposal_sms_events kind CHECK
  // from 165 to allow 'voice_reapproval' — recorded when a VOICE edit is
  // applied and the updated values were read back by voice only (no SMS
  // re-render deps wired at the call site). It clears
  // hasUnappliedEditRequest like reapproval_rendered, but is EXCLUDED from
  // findRecentOutbound: no text was sent for it, so it must never become
  // the owner's Y/N reply anchor. Mirrors the CHECK-widening style of
  // 165_proposal_sms_events_review_required_kind.
  '171_proposal_sms_events_voice_reapproval_kind': `
    ALTER TABLE proposal_sms_events
      DROP CONSTRAINT IF EXISTS proposal_sms_events_kind_check;
    ALTER TABLE proposal_sms_events
      ADD CONSTRAINT proposal_sms_events_kind_check
        CHECK (kind IN (
          'proposal_rendered','reapproval_rendered','clarification_sent',
          'reply_approve','reply_reject','edit_session_opened','edit_request',
          'review_required_rendered','voice_reapproval'
        ));
  `,

  // F17 / P15-001 — per-tenant QuickBooks (Xero enum reserved) accounting sync.
  '172_create_accounting_integrations': `
    CREATE TABLE IF NOT EXISTS accounting_integrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('quickbooks', 'xero')),
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT NOT NULL,
      realm_id TEXT NOT NULL,
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_synced_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'disconnected', 'error')),
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE accounting_integrations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE accounting_integrations FORCE ROW LEVEL SECURITY;
    CREATE POLICY accounting_integrations_tenant ON accounting_integrations
      USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.system_lookup', true) = 'true'
      );

    CREATE TABLE IF NOT EXISTS accounting_sync_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      integration_id UUID NOT NULL REFERENCES accounting_integrations(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('invoice', 'customer', 'payment')),
      entity_id UUID NOT NULL,
      external_id TEXT,
      action TEXT NOT NULL CHECK (action IN ('push', 'pull', 'conflict')),
      status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
      payload_hash TEXT NOT NULL,
      error_message TEXT,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE accounting_sync_log ENABLE ROW LEVEL SECURITY;
    ALTER TABLE accounting_sync_log FORCE ROW LEVEL SECURITY;
    CREATE POLICY accounting_sync_log_tenant ON accounting_sync_log
      USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.system_lookup', true) = 'true'
      );
    CREATE INDEX IF NOT EXISTS accounting_sync_log_tenant_integration_synced_idx
      ON accounting_sync_log (tenant_id, integration_id, synced_at DESC);

    ALTER TABLE oauth_states DROP CONSTRAINT IF EXISTS oauth_states_provider_check;
    ALTER TABLE oauth_states ADD CONSTRAINT oauth_states_provider_check
      CHECK (provider IN ('google', 'quickbooks', 'xero'));
  `,

  '173_create_hfcr_weekly_sends': `
    CREATE TABLE IF NOT EXISTS hfcr_weekly_sends (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      -- Stable per-week idempotency key: the Monday (UTC) the summarized week
      -- started. UNIQUE (tenant_id, week_starting_date) makes the weekly sweep
      -- send exactly one owner HFCR summary per tenant per week.
      week_starting_date DATE NOT NULL,
      hfcr_cents BIGINT NOT NULL DEFAULT 0,
      recovered_call_count INTEGER NOT NULL DEFAULT 0,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, week_starting_date)
    );
    CREATE INDEX IF NOT EXISTS idx_hfcr_weekly_sends_tenant ON hfcr_weekly_sends(tenant_id);
    ALTER TABLE hfcr_weekly_sends ENABLE ROW LEVEL SECURITY;
    ALTER TABLE hfcr_weekly_sends FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_hfcr_weekly_sends ON hfcr_weekly_sends;
    CREATE POLICY tenant_isolation_hfcr_weekly_sends ON hfcr_weekly_sends
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

  // Membership engine (#6) — auto-renew on service_agreements. Additive ALTERs
  // only: the runner re-executes every migration on every boot, so each
  // statement is idempotent (ADD COLUMN IF NOT EXISTS, DROP+ADD the CHECK).
  // renewal_term_months is the stable membership term the renewal sweep rolls
  // ends_on forward by (positivity guarded here and in the Zod/service layer);
  // renewal_count is an audit counter. The partial index backs findRenewable.
  '173_service_agreements_auto_renew': `
    ALTER TABLE service_agreements
      ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE service_agreements
      ADD COLUMN IF NOT EXISTS renewal_term_months INTEGER;
    ALTER TABLE service_agreements
      ADD COLUMN IF NOT EXISTS renewal_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE service_agreements
      DROP CONSTRAINT IF EXISTS chk_agreement_renewal_term_positive;
    ALTER TABLE service_agreements
      ADD CONSTRAINT chk_agreement_renewal_term_positive
        CHECK (renewal_term_months IS NULL OR renewal_term_months > 0);
    CREATE INDEX IF NOT EXISTS idx_agreements_auto_renew
      ON service_agreements (tenant_id, ends_on)
      WHERE auto_renew = TRUE AND status = 'active';
  `,

  // Membership engine (#6 phase 2) — member pricing. A membership with
  // member_discount_bps > 0 confers that percentage discount on the customer's
  // estimates/invoices. Additive ALTER + re-run-safe DROP/ADD CHECK (0..10000
  // bps = 0..100%). Resolution reuses the existing tenant+customer index.
  '174_service_agreements_member_discount': `
    ALTER TABLE service_agreements
      ADD COLUMN IF NOT EXISTS member_discount_bps INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE service_agreements
      DROP CONSTRAINT IF EXISTS chk_agreement_member_discount_bps;
    ALTER TABLE service_agreements
      ADD CONSTRAINT chk_agreement_member_discount_bps
        CHECK (member_discount_bps >= 0 AND member_discount_bps <= 10000);
  `,

  // Membership engine (#6 phase 3) — priority booking. A membership with
  // priority_booking lets the customer book further into the future (extended
  // horizon) than a non-member in the self-service portal. Additive boolean.
  '175_service_agreements_priority_booking': `
    ALTER TABLE service_agreements
      ADD COLUMN IF NOT EXISTS priority_booking BOOLEAN NOT NULL DEFAULT FALSE;
  `,

  // Membership engine (#6 phase 4) — saved cards for off-session dues billing.
  // Stores ONLY Stripe ids + non-sensitive display metadata (brand/last4/exp);
  // raw card data never reaches our server (browser -> Stripe via SetupIntent).
  // The Stripe customer + payment method are scoped to the tenant's connected
  // account (where dues are charged). auto_collect_dues opts a membership into
  // automatic charging.
  '176_customer_payment_methods': `
    CREATE TABLE IF NOT EXISTS customer_payment_methods (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      customer_id UUID NOT NULL REFERENCES customers(id),
      stripe_customer_id TEXT NOT NULL,
      stripe_payment_method_id TEXT NOT NULL,
      brand TEXT,
      last4 TEXT,
      exp_month INT,
      exp_year INT,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, stripe_payment_method_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cpm_tenant_customer
      ON customer_payment_methods (tenant_id, customer_id);
    ALTER TABLE customer_payment_methods ENABLE ROW LEVEL SECURITY;
    ALTER TABLE customer_payment_methods FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_customer_payment_methods ON customer_payment_methods;
    CREATE POLICY tenant_isolation_customer_payment_methods ON customer_payment_methods
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

    ALTER TABLE service_agreements
      ADD COLUMN IF NOT EXISTS auto_collect_dues BOOLEAN NOT NULL DEFAULT FALSE;
  `,

  // P5-020: end-of-day digest entries with delivery tracking and owner reply.
  '177_digest_entries': `
    CREATE TABLE IF NOT EXISTS digest_entries (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      date          DATE NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','delivered','failed','acked')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      rendered_text TEXT NOT NULL,
      source_data   JSONB NOT NULL DEFAULT '{}',
      delivered_at  TIMESTAMPTZ,
      owner_reply   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, date)
    );
    ALTER TABLE digest_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE digest_entries FORCE ROW LEVEL SECURITY;
    CREATE POLICY digest_entries_tenant_isolation ON digest_entries
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,
};

function makePoliciesIdempotent(sql: string): string {
  return sql.replace(
    /CREATE POLICY\s+([a-zA-Z0-9_]+)\s+ON\s+([a-zA-Z0-9_]+)\s+USING\s*\(([^;]+)\);/g,
    (_match, policyName: string, tableName: string, usingClause: string) =>
      `DROP POLICY IF EXISTS ${policyName} ON ${tableName};\n    CREATE POLICY ${policyName} ON ${tableName}\n      USING (${usingClause});`
  );
}

export function getMigrationSQL(): string {
  return Object.values(MIGRATIONS)
    .map((migration) =>
      migration
        .replace(
          /CREATE POLICY\s+([a-zA-Z0-9_]+)\s+ON\s+([a-zA-Z0-9_]+)/g,
          'DROP POLICY IF EXISTS $1 ON $2;\n    CREATE POLICY $1 ON $2'
        )
        // ADD CONSTRAINT has no IF NOT EXISTS in PostgreSQL; prepend a
        // DROP CONSTRAINT IF EXISTS so re-runs on the same DB are safe.
        .replace(
          /(ALTER TABLE\s+\w+)\s*\n(\s+)(ADD CONSTRAINT\s+(\w+))/g,
          '$1 DROP CONSTRAINT IF EXISTS $4;\n$1\n$2$3'
        )
    )
    .join('\n');
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `tenantId` is the canonical UUID shape that `setTenantContext`
 * (and therefore every tenant-scoped DB path) accepts. Callers that take a
 * tenant id from untrusted input — e.g. a public webhook URL param — should
 * gate on this BEFORE doing any tenant-scoped work (resolver lookups, audit
 * writes), otherwise the malformed id throws inside `setTenantContext` deeper
 * in the call stack. Single source of truth so the guard can't drift from the
 * throw it protects against.
 */
export function isValidTenantId(tenantId: string): boolean {
  return UUID_REGEX.test(tenantId);
}

/**
 * Produce the SQL that sets `app.current_tenant_id` for the current
 * connection so RLS policies can scope queries to the tenant.
 *
 * **Callers must clear the GUC before returning the connection to the pool**
 * — issue `RESET app.current_tenant_id` (or a wrapping transaction with
 * `SET LOCAL` semantics) in the same `finally` that releases the client.
 * Without that, the connection comes back to the pool with the previous
 * tenant's context still set, and the next checkout silently bypasses RLS
 * for any unscoped query until something else overwrites it. The wrappers
 * in `pg-base.ts` enforce this; ad-hoc usages elsewhere (app.ts,
 * voice-service.ts, provision-twilio.ts) do the same in their finally.
 *
 * Why plain `SET` and not `SET LOCAL`: `SET LOCAL` requires an enclosing
 * transaction (it is silently dropped outside one), and a number of read
 * paths intentionally run without `BEGIN/COMMIT`. Plain `SET` works in
 * both shapes; the RESET-on-release pattern closes the leak window.
 *
 * Why interpolation is safe: the `UUID_REGEX` guard rejects anything other
 * than `[0-9a-f-]{36}` before we build the string, so no attacker-controlled
 * value ever reaches the SQL. PostgreSQL's `SET` syntax does not accept
 * bind parameters; the equivalent `SELECT set_config(..., $1, false)`
 * passes `(text, values)` to `client.query`, breaking the `(sql, params)`
 * shape that the repo unit-test mocks expect. Keeping a SQL string
 * preserves test compatibility while still closing the GUC-leak hole.
 */
export function setTenantContext(tenantId: string): string {
  if (!UUID_REGEX.test(tenantId)) {
    throw new Error('Invalid tenant ID format: must be a valid UUID');
  }
  return `SET app.current_tenant_id = '${tenantId}'`;
}
