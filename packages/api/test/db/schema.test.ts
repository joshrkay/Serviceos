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

  // EXCEPTIONS — tables that genuinely should not be RLS-protected even
  // though they carry a tenant_id column. Hoisted to the describe scope so
  // both the "FORCE everywhere except here" assertion and the "allowlist
  // didn't silently grow" pin reference the same set (otherwise the pin
  // test compares a duplicate constant against itself and can never fail).
  const RLS_EXEMPT_TABLES_SHARED = new Set<string>([
    // oauth_states: short-lived Google OAuth state nonces. The /callback
    // path calls consume(stateId) BEFORE tenant context is set —
    // recovering tenant_id from the row IS the lookup. RLS would make the
    // row invisible to the call that needs it.
    'oauth_states',
    // platform_deprovision_log: cross-tenant audit trail of tenant
    // hard-deletes. By design, this row outlives the tenant it records.
    'platform_deprovision_log',
  ]);

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

  it('Blocker 3 — every table with a tenant_id column also FORCEs RLS (stronger guard)', () => {
    // The Blocker-3 regression above checks: tables that ENABLE RLS must
    // also FORCE it. This stronger guard catches a different failure mode:
    // a new tenant-scoped table whose author forgot RLS entirely. Without
    // it, a future migration could add `CREATE TABLE foo (tenant_id ...)`
    // without ENABLE/FORCE and the existing guard would not fire — the
    // table would just have no RLS at all and silently leak across tenants.
    //
    // EXCEPTIONS — tables that genuinely should not be RLS-protected even
    // though they carry a tenant_id column. Each exception is documented in
    // the corresponding migration block in schema.ts.
    //
    // - oauth_states: short-lived Google OAuth state nonces. The /callback
    //   path calls consume(stateId) BEFORE tenant context is set —
    //   recovering tenant_id from the row IS the lookup. RLS would make the
    //   row invisible to the call that needs it. Safety: 128-bit random
    //   UUID acts as a single-use nonce with a 5-minute expiry.
    //
    // - platform_deprovision_log: cross-tenant audit trail of tenant
    //   hard-deletes. By design, this row outlives the tenant it records,
    //   so it cannot be tenant-scoped — the tenant_id column is denormalized
    //   identity for the purged row, not a tenancy boundary. Only ops
    //   reads it (via direct DB queries).
    const RLS_EXEMPT_TABLES = RLS_EXEMPT_TABLES_SHARED;

    const sql = getMigrationSQL();

    // Find every table whose CREATE TABLE body declares a tenant_id column.
    // Inline body capture uses [^;]* to stop at the terminating semicolon
    // without dragging in ALTER statements that follow.
    const tenantScoped = new Set<string>();
    const createRe = /CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)\s*\(([^;]*?)\);/gi;
    for (const m of sql.matchAll(createRe)) {
      const tableName = m[1];
      const body = m[2];
      if (/\btenant_id\b/.test(body)) {
        tenantScoped.add(tableName);
      }
    }

    const forced = new Set<string>();
    for (const m of sql.matchAll(/ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+FORCE ROW LEVEL SECURITY/gi)) {
      forced.add(m[1]);
    }

    // Sanity: the parse should find a healthy number of tenant-scoped
    // tables. If this drops, the CREATE TABLE regex broke.
    expect(tenantScoped.size).toBeGreaterThan(50);

    const missing = [...tenantScoped]
      .filter((t) => !forced.has(t) && !RLS_EXEMPT_TABLES.has(t))
      .sort();

    expect(
      missing,
      `Tables with tenant_id but no FORCE ROW LEVEL SECURITY (and not in the documented exempt list): ${missing.join(
        ', ',
      )}. If a new tenant-scoped table genuinely should not have RLS, add it to RLS_EXEMPT_TABLES in this test AND document the rationale in its migration block in schema.ts. Otherwise, add a new migration that runs \`ALTER TABLE <name> ENABLE ROW LEVEL SECURITY; ALTER TABLE <name> FORCE ROW LEVEL SECURITY;\` plus a tenant_isolation policy.`,
    ).toEqual([]);
  });

  it('Blocker 3 — the RLS exemption allowlist is not silently growing', () => {
    // Pins the exemption set so a future PR can't quietly add a table to
    // it without showing up in this test diff. References the same set
    // the "FORCE everywhere" assertion uses, so any add to that set
    // breaks this pin as well — otherwise the test compares a duplicate
    // constant against itself and is tautological.
    const ALLOWED_EXEMPT = ['oauth_states', 'platform_deprovision_log'];
    expect([...RLS_EXEMPT_TABLES_SHARED].sort()).toEqual(ALLOWED_EXEMPT.sort());
  });

  it('Blocker 7 — migration 131 installs the double-booking exclusion guard', () => {
    expect(Object.keys(MIGRATIONS)).toContain('131_appointment_assignments_no_double_booking');
    const migration = MIGRATIONS['131_appointment_assignments_no_double_booking'];
    // Required pieces:
    //  - btree_gist extension (needed for `=` on UUID inside a GIST index)
    //  - denormalized scheduled_start/scheduled_end/status columns
    //  - backfill from the appointments row
    //  - sync triggers (assignment ← appointment, appointment → assignments)
    //  - the EXCLUDE constraint itself, gated on no-pre-existing-conflicts
    //  - partial unique index for at-most-one-primary-per-appointment
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS btree_gist');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMPTZ');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS scheduled_end TIMESTAMPTZ');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS appointment_status TEXT');
    expect(migration).toContain('UPDATE appointment_assignments aa');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION sync_assignment_appointment_fields');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION sync_appointment_to_assignments');
    expect(migration).toContain('trg_assignment_sync_appointment_fields');
    expect(migration).toContain('trg_appointments_sync_to_assignments');
    expect(migration).toContain('CONSTRAINT no_double_booking');
    expect(migration).toContain('EXCLUDE USING gist');
    expect(migration).toContain('tstzrange(scheduled_start, scheduled_end) WITH &&');
    expect(migration).toContain("WHERE (appointment_status NOT IN ('canceled', 'no_show'))");
    expect(migration).toContain('uq_assignment_primary_per_appointment');
    expect(migration).toMatch(/WHERE is_primary/);
  });
});
