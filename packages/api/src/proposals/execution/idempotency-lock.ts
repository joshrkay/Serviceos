import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';

export interface IdempotencyLockProvider {
  /**
   * Run `fn` while holding the per-(tenant, key) lock. DATA-31: `fn` receives
   * the locked `PoolClient` when the provider owns one (the Postgres
   * implementation), so the caller can open a SINGLE transaction on that same
   * connection — the domain mutation, the idempotency record, and the proposal
   * status transition then commit atomically WHILE the lock is still held, and
   * only unlock after COMMIT. Providers that own no connection (the no-op)
   * invoke `fn` with `undefined`, and the caller runs without a transaction.
   */
  withLock<T>(
    tenantId: string,
    idempotencyKey: string,
    fn: (client?: PoolClient) => Promise<T>,
  ): Promise<T>;
}

/** Single-threaded tests: no cross-process contention. */
export class NoOpIdempotencyLockProvider implements IdempotencyLockProvider {
  async withLock<T>(
    _tenantId: string,
    _idempotencyKey: string,
    fn: (client?: PoolClient) => Promise<T>,
  ): Promise<T> {
    // No pooled connection to hand out — the caller runs its work directly
    // (in-memory repos / single-threaded unit tests need no transaction).
    return fn(undefined);
  }
}

function advisoryKeyPair(tenantId: string, idempotencyKey: string): [number, number] {
  const digest = createHash('sha256').update(`${tenantId}\0${idempotencyKey}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Session-level advisory lock keyed by (tenant, idempotencyKey). Serializes
 * concurrent `checkAndExecute` for the same key so only one handler runs.
 */
export class PgIdempotencyLockProvider implements IdempotencyLockProvider {
  constructor(private readonly pool: Pool) {}

  async withLock<T>(
    tenantId: string,
    idempotencyKey: string,
    fn: (client?: PoolClient) => Promise<T>,
  ): Promise<T> {
    const [k1, k2] = advisoryKeyPair(tenantId, idempotencyKey);
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [k1, k2]);
      // DATA-31: hand the locked connection to `fn` so it can BEGIN/COMMIT a
      // transaction on THIS session. The session-level advisory lock survives
      // the COMMIT (it's session- not xact-scoped), so it is still held through
      // the whole commit and is only released by the unlock in `finally` below.
      return await fn(client);
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [k1, k2]);
        client.release();
      } catch {
        // Unlock failed (broken connection / server restart). Destroy the
        // connection instead of returning it: a pooled client that still
        // holds the session-level advisory lock would both leak the slot
        // and block every other holder of this key. Disconnecting releases
        // the advisory lock server-side.
        client.release(true);
      }
    }
  }
}
