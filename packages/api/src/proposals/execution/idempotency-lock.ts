import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import {
  runWithSessionLease,
  watchSessionLease,
  type SessionLease,
} from '../../db/session-lease';

export interface IdempotencyLockProvider {
  /**
   * Run `fn` while holding the per-(tenant, key) lock. DATA-31: `fn` receives
   * the locked `PoolClient` when the provider owns one (the Postgres
   * implementation), so the caller can open a SINGLE transaction on that same
   * connection — the domain mutation, the idempotency record, and the proposal
   * status transition then commit atomically WHILE the lock is still held, and
   * only unlock after COMMIT. Providers that own no connection (the no-op)
   * invoke `fn` with `undefined`, and the caller runs without a transaction.
   *
   * #1125: a provider holding a real session lock also passes that lock's
   * `SessionLease` and runs `fn` with the lease ambient, so the caller can
   * fence its critical points on `lease.assertHeld()`, and any repository
   * call `fn` makes after the lock's connection dies refuses.
   */
  withLock<T>(
    tenantId: string,
    idempotencyKey: string,
    fn: (client?: PoolClient, lease?: SessionLease) => Promise<T>,
  ): Promise<T>;
}

/** Single-threaded tests: no cross-process contention. */
export class NoOpIdempotencyLockProvider implements IdempotencyLockProvider {
  async withLock<T>(
    _tenantId: string,
    _idempotencyKey: string,
    fn: (client?: PoolClient, lease?: SessionLease) => Promise<T>,
  ): Promise<T> {
    // No pooled connection to hand out — the caller runs its work directly
    // (in-memory repos / single-threaded unit tests need no transaction).
    return fn(undefined, undefined);
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
    fn: (client?: PoolClient, lease?: SessionLease) => Promise<T>,
  ): Promise<T> {
    const [k1, k2] = advisoryKeyPair(tenantId, idempotencyKey);
    const client = await this.pool.connect();
    let watch: ReturnType<typeof watchSessionLease> | undefined;
    try {
      await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [k1, k2]);
      // #1125 — from here on the lock lives exactly as long as this backend:
      // if Postgres terminates it, the lock is released and another caller can
      // take it. The lease is how the work below finds out.
      watch = watchSessionLease(client, `proposal idempotency lock ${idempotencyKey}`);
      const lease = watch.lease;
      // DATA-31: hand the locked connection to `fn` so it can BEGIN/COMMIT a
      // transaction on THIS session. The session-level advisory lock survives
      // the COMMIT (it's session- not xact-scoped), so it is still held through
      // the whole commit and is only released by the unlock in `finally` below.
      return await runWithSessionLease(lease, () => fn(client, lease));
    } finally {
      const lost = watch?.lease.lost ?? false;
      watch?.stopWatching();
      if (lost) {
        // The backend is gone and took the lock with it: nothing to unlock,
        // and the client is unusable — destroy it.
        client.release(true);
      } else {
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
}
