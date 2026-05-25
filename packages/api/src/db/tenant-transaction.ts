import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { tenantContextStore } from '../middleware/tenant-context';

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
    return fn({ lock: async () => undefined });
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

      const scope: TransactionScope = {
        lock: async (key: string) => {
          const [k1, k2] = advisoryKeyPair(`${tenantId}\0${key}`);
          await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [k1, k2]);
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
