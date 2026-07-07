import { createHash } from 'crypto';
import type { Pool } from 'pg';

export interface IdempotencyLockProvider {
  withLock<T>(tenantId: string, idempotencyKey: string, fn: () => Promise<T>): Promise<T>;
}

/** Single-threaded tests: no cross-process contention. */
export class NoOpIdempotencyLockProvider implements IdempotencyLockProvider {
  async withLock<T>(_tenantId: string, _idempotencyKey: string, fn: () => Promise<T>): Promise<T> {
    return fn();
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

  async withLock<T>(tenantId: string, idempotencyKey: string, fn: () => Promise<T>): Promise<T> {
    const [k1, k2] = advisoryKeyPair(tenantId, idempotencyKey);
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [k1, k2]);
      return await fn();
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
