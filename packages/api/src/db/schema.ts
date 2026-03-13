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
    CREATE POLICY tenant_isolation_audit ON audit_events
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

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
    CREATE POLICY tenant_isolation_voice ON voice_recordings
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,

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
};

export function getMigrationSQL(): string {
  return Object.values(MIGRATIONS).join('\n');
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParameterizedQuery {
  sql: string;
  params: string[];
}

export function setTenantContext(tenantId: string): ParameterizedQuery {
  if (!tenantId || !UUID_REGEX.test(tenantId)) {
    throw new Error('Invalid tenant ID format: must be a valid UUID');
  }
  return {
    sql: 'SELECT set_config($1, $2, true)',
    params: ['app.current_tenant_id', tenantId],
  };
}
