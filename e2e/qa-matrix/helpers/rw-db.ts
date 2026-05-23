import { Client } from 'pg';

/**
 * The qa-matrix DbVerifier uses the READ-ONLY connection. A few edge cases need
 * to seed state (deposit on a job, backdated due date, a DNC entry). Those use
 * the service-role connection (E2E_DB_URL_READWRITE, same one fixtures/seed.ts
 * uses). Guarded so specs degrade to `na` when it isn't provided.
 */

export function rwAvailable(): boolean {
  return !!process.env.E2E_DB_URL_READWRITE;
}

export async function withRw<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.E2E_DB_URL_READWRITE });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => void 0);
  }
}

/** Run a write scoped to a tenant (RLS GUC set) inside a transaction. */
export async function rwExec(tenantId: string, sql: string, params: unknown[] = []): Promise<unknown[]> {
  return withRw(async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL app.current_tenant_id = '${tenantId.replace(/'/g, "''")}'`);
      const res = await c.query(sql, params);
      await c.query('COMMIT');
      return res.rows;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => void 0);
      throw err;
    }
  });
}
