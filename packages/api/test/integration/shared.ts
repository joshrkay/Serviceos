import { Pool, PoolClient } from 'pg';

// Container lifecycle (start, migrations, stop) is owned by vitest globalSetup
// at test/integration/global-setup.ts. This module only wraps a process-wide
// pg.Pool against TEST_DB_URL so per-file beforeAll/afterAll are near-instant.
let sharedPool: Pool | null = null;

export async function getSharedTestDb(): Promise<Pool> {
  if (!sharedPool) {
    const uri = process.env.TEST_DB_URL;
    if (!uri) {
      throw new Error(
        'TEST_DB_URL not set — integration tests must run via `npm run test:integration` ' +
          'so vitest globalSetup (test/integration/global-setup.ts) can start the testcontainer.',
      );
    }
    sharedPool = new Pool({ connectionString: uri });
  }
  return sharedPool;
}

export async function closeSharedTestDb(): Promise<void> {
  // No-op: container lifecycle is owned by vitest globalSetup. The pool
  // stays open for the duration of `vitest run` and is reaped on process
  // exit. We deliberately don't end the pool per-file because the next
  // file's beforeAll would just rebuild it.
}

/**
 * WS1 — provision the `rls_app_runtime` role so the integration suite can run
 * under RLS_RUNTIME_ROLE=true (see the `test:integration:rls` npm script). This
 * ONLY makes the role assumable + grants it table/sequence access; it does NOT
 * turn RLS enforcement on. The app assumes the role (SET ROLE) only when
 * RLS_RUNTIME_ROLE=true (src/db/rls-runtime-role.ts), so calling this
 * unconditionally in global-setup is safe for the default (role-off) run.
 *
 * Idempotent — safe to call repeatedly against the shared container.
 * Previously this logic lived inline in rls-tenant-isolation.test.ts; hoisted
 * here so the FULL suite can share it.
 */
export const RLS_APP_ROLE = 'rls_app_runtime';

export async function ensureRlsRuntimeRole(pool: Pool): Promise<void> {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_APP_ROLE}') THEN
      CREATE ROLE ${RLS_APP_ROLE} NOLOGIN NOBYPASSRLS;
    END IF;
  END $$;`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${RLS_APP_ROLE}`);
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_APP_ROLE}`,
  );
  await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RLS_APP_ROLE}`);
  // The connecting principal must be a member of the role to `SET ROLE` into it
  // (superusers can regardless; this covers a non-superuser external DB).
  const { rows } = await pool.query<{ u: string }>('SELECT current_user AS u');
  await pool.query(`GRANT ${RLS_APP_ROLE} TO "${rows[0].u}"`);
}

export interface TestTenant {
  tenantId: string;
  userId: string;
}

export async function createTestTenant(pool: Pool): Promise<TestTenant> {
  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO tenants (id, owner_id, owner_email, name) VALUES ($1, $2, $3, $4)`,
    [tenantId, userId, 'test@example.com', 'Test Tenant']
  );

  await pool.query(
    `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, $5)`,
    [userId, tenantId, userId, 'test@example.com', 'owner']
  );

  return { tenantId, userId };
}

export async function setTenantContext(pool: Pool, tenantId: string): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
  return client;
}

/**
 * Insert a `files` row and return its id. Useful as the FK target for
 * `voice_recordings.file_id` (and other entity tables that FK into
 * files). Defaults are intentionally generic so individual tests can
 * call it without spelling out s3 / content-type metadata.
 */
export async function createTestFile(
  pool: Pool,
  tenantId: string,
  userId: string,
): Promise<string> {
  const fileId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO files (id, tenant_id, filename, content_type, size_bytes, s3_bucket, s3_key, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [fileId, tenantId, 'test.wav', 'audio/wav', 1024, 'test-bucket', `test-key-${fileId}`, userId],
  );
  return fileId;
}