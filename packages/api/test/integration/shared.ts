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
 * Unprivileged role for RLS-policy assertions. The testcontainer's default
 * user is a SUPERUSER (bypasses RLS), so any isolation assertion run as the
 * default user tests the application's WHERE-clause, not the policy. Reads/
 * writes routed through {@link asTenant} run under this NOBYPASSRLS role, so
 * the policy itself is the only thing gating cross-tenant access — drop the
 * policy and the assertion fails. Mirrors rls-tenant-isolation.test.ts.
 */
export const RLS_APP_ROLE = 'rls_app_runtime';

/** Create the unprivileged app role (idempotent) and grant table DML. */
export async function ensureRlsAppRole(pool: Pool): Promise<void> {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_APP_ROLE}') THEN
      CREATE ROLE ${RLS_APP_ROLE} NOLOGIN NOBYPASSRLS;
    END IF;
  END $$;`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${RLS_APP_ROLE}`);
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_APP_ROLE}`,
  );
}

/**
 * Run `fn` under the unprivileged RLS role with the tenant GUC set, inside a
 * transaction that is always rolled back (reads only need the policy applied;
 * writes are discarded). Call {@link ensureRlsAppRole} once in beforeAll.
 */
export async function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${RLS_APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
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