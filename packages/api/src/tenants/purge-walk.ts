/**
 * The tenant purge walk: delete a tenant's rows from every table that
 * carries a `tenant_id` column (the project's core RLS pattern), so a table
 * added later is purged by default. Shared by two callers:
 *
 *   - `tenants/deprovision.ts` passes its own client, already inside its one
 *     transaction with `session_replication_role = 'replica'`, and no
 *     options: one `DELETE … WHERE tenant_id = $1` per table, exactly as it
 *     always ran.
 *   - `demo/reset.ts` (U7) passes the pool, a keep-list, a batch size and a
 *     `beforeStep` fence: every batch is its own short transaction, so a
 *     share lock taken by the fence never holds a heartbeat back for long,
 *     and a fence that fails rolls back only the batch it guards.
 *
 * Returns the rows deleted per table (tables with nothing to delete report
 * 0 in the single-transaction mode, as deprovision always has).
 */
import type { Pool, PoolClient } from 'pg';

/** Postgres identifier guard for the dynamically-discovered table names. */
const IDENT_REGEX = /^[a-z_][a-z0-9_]*$/;

export interface PurgeTenantRowsOptions {
  /** Tables left untouched (the tenant row's own table, a ledger, an audit trail). */
  keep?: readonly string[];
  /**
   * Delete at most this many rows per statement, each batch in its own
   * transaction. Requires a Pool. Unset: one DELETE per table on the
   * caller's client and transaction.
   */
  batchRows?: number;
  /**
   * Batched mode only: runs on each batch's own transaction before its
   * DELETE. A throw rolls the batch back and stops the walk.
   */
  beforeStep?: (client: PoolClient, table: string) => Promise<void>;
}

async function listTenantTables(target: Pool | PoolClient): Promise<string[]> {
  const tablesRes = await target.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'
        ORDER BY table_name`,
  );
  return tablesRes.rows.map(({ table_name }) => {
    if (!IDENT_REGEX.test(table_name)) {
      throw new Error(`Refusing to purge unsafe table name: ${table_name}`);
    }
    return table_name;
  });
}

export async function purgeTenantRows(
  target: Pool | PoolClient,
  tenantId: string,
  options: PurgeTenantRowsOptions = {},
): Promise<Record<string, number>> {
  const keep = new Set(options.keep ?? []);
  const rowsDeletedByTable: Record<string, number> = {};
  const tables = (await listTenantTables(target)).filter((t) => !keep.has(t));

  if (options.batchRows === undefined) {
    for (const table_name of tables) {
      const res = await target.query(
        `DELETE FROM "${table_name}" WHERE tenant_id = $1`,
        [tenantId],
      );
      rowsDeletedByTable[table_name] = res.rowCount ?? 0;
    }
    return rowsDeletedByTable;
  }

  const batchRows = options.batchRows;
  if (!Number.isSafeInteger(batchRows) || batchRows < 1) {
    throw new Error(`purgeTenantRows: batchRows must be a positive integer, got ${batchRows}`);
  }
  if (!isPool(target)) {
    throw new Error('purgeTenantRows: batched mode owns its transactions and needs a Pool');
  }
  for (const table of tables) {
    let total = 0;
    for (;;) {
      const deleted = await deleteBatch(target, table, tenantId, batchRows, options.beforeStep);
      total += deleted;
      if (deleted < batchRows) break;
    }
    if (total > 0) rowsDeletedByTable[table] = total;
  }
  return rowsDeletedByTable;
}

function isPool(target: Pool | PoolClient): target is Pool {
  return typeof (target as PoolClient).release !== 'function';
}

/**
 * One batch: its own transaction, FK triggers off for it alone (the walk is
 * alphabetical, so a parent can go before its children; the tenant is
 * unusable until the walk ends) and the tenant's GUC transaction-local so
 * FORCE-RLS tables are reachable under any principal. The outer
 * `tenant_id` predicate means a ctid can never reach another tenant's row.
 */
async function deleteBatch(
  pool: Pool,
  table: string,
  tenantId: string,
  batchRows: number,
  beforeStep: PurgeTenantRowsOptions['beforeStep'],
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    if (beforeStep) await beforeStep(client, table);
    const res = await client.query(
      `DELETE FROM "${table}"
        WHERE tenant_id = $1
          AND ctid = ANY(ARRAY(SELECT ctid FROM "${table}" WHERE tenant_id = $1 LIMIT $2))`,
      [tenantId, batchRows],
    );
    await client.query('COMMIT');
    return res.rowCount ?? 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
