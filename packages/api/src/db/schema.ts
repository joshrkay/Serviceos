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
    ALTER TABLE users FORCE ROW LEVEL SECURITY;
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
    ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
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
    ALTER TABLE files FORCE ROW LEVEL SECURITY;
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
    ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
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
    ALTER TABLE messages FORCE ROW LEVEL SECURITY;
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
    ALTER TABLE voice_recordings FORCE ROW LEVEL SECURITY;
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
    ALTER TABLE ai_runs FORCE ROW LEVEL SECURITY;
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
    ALTER TABLE document_revisions FORCE ROW LEVEL SECURITY;
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
    ALTER TABLE diff_analyses FORCE ROW LEVEL SECURITY;
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
    ALTER TABLE proposals FORCE ROW LEVEL SECURITY;
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
    ALTER TABLE estimate_templates FORCE ROW LEVEL SECURITY;
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
    ALTER TABLE service_bundles FORCE ROW LEVEL SECURITY;
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
    ALTER TABLE wording_preferences FORCE ROW LEVEL SECURITY;
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
    ALTER TABLE quality_metrics FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_qm ON quality_metrics;
    CREATE POLICY tenant_isolation_qm ON quality_metrics
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,
};

export const SCHEMA_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_key TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

export function getMigrationSQL(): string {
  return Object.values(MIGRATIONS).join('\n');
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function setTenantContext(tenantId: string): string {
  if (!UUID_REGEX.test(tenantId)) {
    throw new Error('Invalid tenant ID format: must be a valid UUID');
  }
  return `SET app.current_tenant_id = '${tenantId}'`;
}
