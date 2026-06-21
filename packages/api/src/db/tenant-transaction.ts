import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { tenantContextStore } from '../middleware/tenant-context';

/**
 * Run `fn` against a single pooled client inside a tenant-scoped transaction:
 * BEGIN, set the `app.current_tenant_id` GUC LOCAL (parameterized — never
 * interpolated), run `fn`, then COMMIT (or ROLLBACK on throw) and always
 * release the client. Use this for self-contained reads/writes that just need
 * RLS scoping and a rollback boundary, without the savepoint/advisory-lock
 * machinery of `PgTenantTransactionRunner`. The original error is re-thrown
 * after a best-effort ROLLBACK.
 */
export async function withTenantConnection<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
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

/**
 * A single tenant-scoped transaction. Repositories that honor
 * `tenantContextStore` (PgBaseRepository) automatically reuse this
 * transaction's client, so multiple repo writes inside `run` commit or roll
 * back atomically. `lock` takes a transaction-scoped advisory lock to
 * serialize concurrent units of work competing for the same logical resource
 * (e.g. a booking slot), released automatically at COMMIT/ROLLBACK.
 */
export interface TransactionScope {
  lock(key: string): Promise<void>;
  /**
   * Run `fn` inside a SAVEPOINT. If `fn` throws (e.g. a 23505 unique
   * violation), only `fn`'s writes roll back and the surrounding transaction
   * stays usable for the next unit of work — without this, the first failed
   * statement aborts the ENTIRE Postgres transaction. The original error is
   * re-thrown after the rollback so the caller can branch on it (e.g. skip a
   * row that was already processed). In-memory: runs `fn` directly (there is no
   * real transaction to poison), so the error simply propagates unchanged.
   */
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
}

export interface TenantTransactionRunner {
  run<T>(tenantId: string, fn: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

/**
 * No-op runner for in-memory repositories (tests / local dev without a pool).
 * In-memory repos don't participate in transactions and tests are
 * single-threaded, so the lock is a no-op and `fn` runs directly.
 */
export class InMemoryTransactionRunner implements TenantTransactionRunner {
  async run<T>(_tenantId: string, fn: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return fn({ lock: async () => undefined, savepoint: (work) => work() });
  }
}

function advisoryKeyPair(key: string): [number, number] {
  const digest = createHash('sha256').update(key).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Postgres-backed runner. Opens a transaction, sets the tenant GUC LOCAL to
 * it (parameterized to prevent injection), and runs `fn` inside the
 * AsyncLocalStorage scope so downstream `withTenant` calls reuse the client.
 */
export class PgTenantTransactionRunner implements TenantTransactionRunner {
  constructor(private readonly pool: Pool) {}

  async run<T>(tenantId: string, fn: (scope: TransactionScope) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

      let savepointSeq = 0;
      const scope: TransactionScope = {
        lock: async (key: string) => {
          const [k1, k2] = advisoryKeyPair(`${tenantId}\0${key}`);
          await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [k1, k2]);
        },
        savepoint: async <T>(work: () => Promise<T>): Promise<T> => {
          // Internally generated name (never user input) — safe to interpolate.
          const name = `sp_${(savepointSeq += 1)}`;
          await client.query(`SAVEPOINT ${name}`);
          try {
            const result = await work();
            await client.query(`RELEASE SAVEPOINT ${name}`);
            return result;
          } catch (err) {
            // Undo only this unit's writes; the outer transaction lives on.
            await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
            await client.query(`RELEASE SAVEPOINT ${name}`).catch(() => undefined);
            throw err;
          }
        },
      };

      const result = await tenantContextStore.run({ client, tenantId }, () => fn(scope));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* best effort — surface the original error */
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
