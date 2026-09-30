import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  IDEMPOTENCY_KEY_TTL_MS,
  type ClaimResult,
  type IdempotencyScope,
  type IdempotencyStore,
  type StoredResponse,
} from './idempotency-store';

/**
 * Postgres-backed idempotency store (#1489, migration 302).
 *
 * Inside a request, `withTenant` reuses the request-scoped transaction, so the
 * claim row commits (or rolls back) atomically with the record the handler
 * creates. A concurrent duplicate's INSERT waits on the uncommitted claim row
 * and, once the first request commits, finds it and replays its response.
 */
const LOCK_NOT_AVAILABLE = '55P03';

export interface PgIdempotencyStoreOptions {
  /**
   * How long a duplicate waits for the in-flight request holding its key
   * before giving up with `in_progress` (default 10s).
   */
  waitMs?: number;
}

export class PgIdempotencyStore extends PgBaseRepository implements IdempotencyStore {
  private readonly waitMs: number;

  constructor(pool: Pool, opts: PgIdempotencyStoreOptions = {}) {
    super(pool);
    this.waitMs = opts.waitMs ?? 10_000;
  }

  async claim(scope: IdempotencyScope, fingerprint: string): Promise<ClaimResult> {
    try {
      return await this.claimOnce(scope, fingerprint);
    } catch (err) {
      // The duplicate waited `waitMs` on the first request's uncommitted
      // claim row. (The failed statement aborts this request's transaction;
      // the caller answers 409 and the request rolls back.)
      if ((err as { code?: string }).code === LOCK_NOT_AVAILABLE) return { kind: 'in_progress' };
      throw err;
    }
  }

  private async claimOnce(scope: IdempotencyScope, fingerprint: string): Promise<ClaimResult> {
    return this.withTenant(scope.tenantId, async (client) => {
      // Bound the wait on a concurrent claim, then restore the transaction's
      // lock_timeout so the handler's own statements are unaffected.
      const { rows: prevRows } = await client.query<{ prev: string }>(
        `SELECT current_setting('lock_timeout') AS prev, set_config('lock_timeout', $1, true)`,
        [`${this.waitMs}ms`],
      );
      // Insert the claim; an EXPIRED row under the same key is taken over
      // (TTL is enforced here, not only by the prune sweep).
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (tenant_id, user_id, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, user_id, idempotency_key) DO UPDATE
           SET request_fingerprint = EXCLUDED.request_fingerprint,
               response_status = NULL,
               response_content_type = NULL,
               response_body = NULL,
               created_at = NOW(),
               completed_at = NULL
           WHERE idempotency_keys.created_at < NOW() - make_interval(secs => $5)
         RETURNING 1`,
        [scope.tenantId, scope.userId, scope.key, fingerprint, IDEMPOTENCY_KEY_TTL_MS / 1000],
      );
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [prevRows[0].prev]);
      if (inserted.rowCount === 1) return { kind: 'claimed' };

      const { rows } = await client.query<{
        request_fingerprint: string;
        response_status: number | null;
        response_content_type: string | null;
        response_body: string | null;
      }>(
        `SELECT request_fingerprint, response_status, response_content_type, response_body
           FROM idempotency_keys
          WHERE tenant_id = $1 AND user_id = $2 AND idempotency_key = $3`,
        [scope.tenantId, scope.userId, scope.key],
      );
      const row = rows[0];
      if (row.request_fingerprint !== fingerprint) return { kind: 'mismatch' };
      if (row.response_status === null) return { kind: 'in_progress' };
      return {
        kind: 'replay',
        response: {
          status: row.response_status,
          contentType: row.response_content_type,
          body: row.response_body ?? '',
        },
      };
    });
  }

  async complete(scope: IdempotencyScope, response: StoredResponse): Promise<void> {
    await this.withTenant(scope.tenantId, async (client) => {
      await client.query(
        `UPDATE idempotency_keys
            SET response_status = $4, response_content_type = $5, response_body = $6,
                completed_at = NOW()
          WHERE tenant_id = $1 AND user_id = $2 AND idempotency_key = $3`,
        [scope.tenantId, scope.userId, scope.key, response.status, response.contentType, response.body],
      );
    });
  }

  async release(scope: IdempotencyScope): Promise<void> {
    await this.withTenant(scope.tenantId, async (client) => {
      await client.query(
        `DELETE FROM idempotency_keys
          WHERE tenant_id = $1 AND user_id = $2 AND idempotency_key = $3 AND response_status IS NULL`,
        [scope.tenantId, scope.userId, scope.key],
      );
    });
  }

  async pruneExpired(tenantId: string, olderThan: Date): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM idempotency_keys WHERE tenant_id = $1 AND created_at < $2`,
        [tenantId, olderThan],
      );
      return result.rowCount ?? 0;
    });
  }
}
