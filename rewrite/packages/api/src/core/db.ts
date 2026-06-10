import { Pool, type PoolClient } from 'pg';

export interface Db {
  /** RLS-enforced pool (non-superuser role). All tenant work goes here. */
  app: Pool;
  /** Privileged pool: platform layer only (webhook ledger, outbox drain, auth lookup). */
  admin: Pool;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string, databaseAdminUrl: string): Db {
  const app = new Pool({ connectionString: databaseUrl, max: 10 });
  const admin = new Pool({ connectionString: databaseAdminUrl, max: 5 });
  return {
    app,
    admin,
    async close() {
      await Promise.all([app.end(), admin.end()]);
    },
  };
}

/**
 * Runs fn inside a transaction with the tenant RLS context set. SET LOCAL
 * scopes app.tenant_id to this transaction only, so pooled connections never
 * leak tenant context.
 */
export async function withTenantTransaction<T>(
  db: Db,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
