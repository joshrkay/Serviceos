import { Pool, QueryResult, QueryResultRow } from 'pg';
import { applyTenantContext } from '../db/rls-runtime-role';

/**
 * Runs one SQL statement for a background worker against tenant-scoped
 * tables.
 *
 * tenant_integrations is FORCE ROW LEVEL SECURITY with a policy on
 * app.current_tenant_id. Background workers run outside
 * withTenantTransaction, so every DB op against such tables must run in a
 * transaction that sets the GUC first. Twilio HTTP calls happen between
 * these blocks — never hold a DB transaction open across network I/O.
 *
 * (Was copy-pasted into each Twilio worker; kept in one place now.)
 */
export async function tenantQuery<R extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  tenantId: string,
  sql: string,
  params: unknown[] = []
): Promise<QueryResult<R>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyTenantContext(client, tenantId, { transactional: true });
    const result = await client.query<R>(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
    throw err;
  } finally {
    // GUC leak fix: plain `SET app.current_tenant_id` persists past
    // COMMIT/ROLLBACK on the underlying connection. Clear it before
    // release so the next pool checkout doesn't inherit this tenant's
    // context.
    try { await client.query('RESET app.current_tenant_id'); } catch { /* ignore */ }
    client.release();
  }
}
