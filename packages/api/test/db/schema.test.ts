import { MIGRATIONS, getMigrationSQL, setTenantContext } from '../../src/db/schema';

describe('P0-004 — Tenant-safe Postgres schema + RLS', () => {
  it('happy path — all migrations are defined', () => {
    const migrationKeys = Object.keys(MIGRATIONS);
    expect(migrationKeys.length).toBeGreaterThanOrEqual(10);
    expect(migrationKeys[0]).toBe('001_create_tenants');
    expect(migrationKeys).toContain('070_tenant_location_and_integrations');
  });

  it('happy path — getMigrationSQL returns all SQL', () => {
    const sql = getMigrationSQL();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS tenants');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS audit_events');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS files');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS conversations');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS messages');
  });


  it('idempotency — migration SQL drops policies before creating them', () => {
    const sql = getMigrationSQL();
    expect(sql).toContain('DROP POLICY IF EXISTS tenant_isolation_users ON users');
    expect(sql).toContain('DROP POLICY IF EXISTS tenant_isolation_audit ON audit_events');
    expect(sql).toContain('CREATE POLICY tenant_isolation_users ON users');
  });

  it('tenant isolation — RLS is enabled on tenant-scoped tables', () => {
    const sql = getMigrationSQL();
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('tenant_isolation_users');
    expect(sql).toContain('tenant_isolation_audit');
    expect(sql).toContain('tenant_isolation_files');
    expect(sql).toContain('tenant_isolation_conversations');
    expect(sql).toContain('tenant_isolation_messages');
  });

  it('tenant isolation — policy creation is idempotent', () => {
    const sql = getMigrationSQL();
    expect(sql).toContain('DROP POLICY IF EXISTS tenant_isolation_users ON users;');
    expect(sql).toContain('CREATE POLICY tenant_isolation_users ON users');
  });

  it('happy path — setTenantContext generates correct SQL', () => {
    const sql = setTenantContext('550e8400-e29b-41d4-a716-446655440000');
    expect(sql).toBe("SET app.current_tenant_id = '550e8400-e29b-41d4-a716-446655440000'");
  });

  it('security — setTenantContext rejects non-UUID input', () => {
    expect(() => setTenantContext('abc-123')).toThrow('Invalid tenant ID format');
    expect(() => setTenantContext("'; DROP TABLE tenants; --")).toThrow('Invalid tenant ID format');
    expect(() => setTenantContext('')).toThrow('Invalid tenant ID format');
  });

  it('tenant isolation — each table has tenant_id reference', () => {
    const sql = getMigrationSQL();
    const tenantScopedTables = ['users', 'audit_events', 'files', 'conversations', 'messages', 'voice_recordings', 'ai_runs', 'document_revisions'];
    for (const table of tenantScopedTables) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('happy path — audit fields present', () => {
    const sql = getMigrationSQL();
    expect(sql).toContain('created_at TIMESTAMPTZ');
    expect(sql).toContain('updated_at TIMESTAMPTZ');
  });

  it('happy path — indexes created', () => {
    const sql = getMigrationSQL();
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS');
  });

  it('phase A — tenant integration foundation schema is present', () => {
    const sql = getMigrationSQL();
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS country CHAR(2) NOT NULL DEFAULT \'US\'');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS region TEXT');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS tenant_integrations');
    expect(sql).toContain("CHECK (provider IN ('twilio', 'sendgrid'))");
    expect(sql).toContain('tenant_settings_us_region_check');
    expect(sql).toContain('UNIQUE (tenant_id, provider)');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS tenant_provisioning_costs');
  });

  it('dispatch analytics — migration 105 creates dispatch_analytics table', () => {
    expect(Object.keys(MIGRATIONS)).toContain('105_create_dispatch_analytics');
    expect(getMigrationSQL()).toContain('CREATE TABLE IF NOT EXISTS dispatch_analytics');
  });

  it('Blocker 3 — every ENABLE-RLS table also FORCEs RLS', () => {
    // Without FORCE, the table OWNER (the app's connection role) bypasses
    // RLS, so any unscoped query inside a connection that forgot
    // setTenantContext silently sees all tenants' rows. Migration 130 closed
    // the gap; this guard catches future migrations that add ENABLE without
    // its matching FORCE.
    const sql = getMigrationSQL();
    const enabled = new Set<string>();
    const forced = new Set<string>();
    for (const m of sql.matchAll(/ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+ENABLE ROW LEVEL SECURITY/gi)) {
      enabled.add(m[1]);
    }
    for (const m of sql.matchAll(/ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+FORCE ROW LEVEL SECURITY/gi)) {
      forced.add(m[1]);
    }
    const missing = [...enabled].filter((t) => !forced.has(t)).sort();
    expect(missing, `tables with ENABLE but no FORCE RLS: ${missing.join(', ')}`).toEqual([]);
  });

  it('Blocker 3 — migration 130 is registered and covers the known gap', () => {
    expect(Object.keys(MIGRATIONS)).toContain('130_force_rls_missing_tables');
    const migration = MIGRATIONS['130_force_rls_missing_tables'];
    const sample = [
      'ai_runs', 'audit_events', 'conversations', 'files', 'messages',
      'portal_sessions', 'proposals', 'users', 'voice_sessions', 'tenant_dnc_list',
    ];
    for (const table of sample) {
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
  });
});
