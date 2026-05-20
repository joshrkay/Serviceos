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
    ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_us_region_check
      CHECK (country <> 'US' OR (region IS NOT NULL AND btrim(region) ~ '^[A-Z]{2}$'));

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
        CHECK (entity_type IN ('estimate', 'invoice', 'appointment_confirmation', 'delay_notice'));
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

  // Production-readiness — replace permissive NULL-tenant portal_sessions reads
  // with an explicit system lookup GUC (mirrors 074 tenant_integrations).
  '106_portal_sessions_system_lookup_rls': `
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

export function setTenantContext(tenantId: string): string {
  if (!UUID_REGEX.test(tenantId)) {
    throw new Error('Invalid tenant ID format: must be a valid UUID');
  }
  return `SET app.current_tenant_id = '${tenantId}'`;
}
