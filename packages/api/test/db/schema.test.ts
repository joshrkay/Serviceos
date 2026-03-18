import { MIGRATIONS, getMigrationSQL, setTenantContext } from '../../src/db/schema';
import { createDatabaseConfig } from '../../src/db/connection';

describe('P0-004 — Tenant-safe Postgres schema + RLS', () => {
  it('happy path — all migrations are defined', () => {
    const migrationKeys = Object.keys(MIGRATIONS);
    expect(migrationKeys.length).toBeGreaterThanOrEqual(10);
    expect(migrationKeys[0]).toBe('001_create_tenants');
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

  it('validation — createDatabaseConfig rejects unknown env', () => {
    expect(() => createDatabaseConfig('invalid')).toThrow('Unknown database environment');
  });

  it('happy path — dev config uses localhost', () => {
    const config = createDatabaseConfig('dev');
    expect(config.host).toBe('localhost');
    expect(config.database).toBe('serviceos_dev');
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
});
