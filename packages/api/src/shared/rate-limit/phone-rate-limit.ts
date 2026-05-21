import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';

/**
 * Generic, tenant-scoped sliding-window rate limiter (P0-036).
 *
 * Backs domain-scoped throttles that the request-scoped `express-rate-limit`
 * middleware cannot express — e.g. "at most one recovery SMS per caller per
 * 5 minutes" (P8-015 dropped-call recovery is the first consumer). The HTTP
 * middleware limits requests; this limits domain events keyed by an arbitrary
 * `(scope, key)` pair backed by Postgres so the count is shared across every
 * API/worker process.
 *
 * `scope` namespaces independent limiters (e.g. `'sms_recovery'` vs
 * `'verify_code'`) so they can reuse the same table without interfering. The
 * limiter is deliberately ignorant of phone/SMS semantics — `key` is just a
 * string (an E.164 number today, anything tomorrow).
 *
 * Postgres-only: there is no in-memory fallback. A cross-process limiter that
 * silently degraded to per-process memory would let N processes each allow the
 * limit, defeating the point.
 */
export class PhoneRateLimiter extends PgBaseRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  /**
   * Atomically record one usage of `(scope, key)` for `tenantId` and report
   * whether it was within `limit` over the trailing `windowMs`.
   *
   * Returns `true` if the event is allowed (and was recorded), `false` if the
   * limit is already reached (in which case nothing is recorded).
   *
   * Concurrency: a transaction-scoped advisory lock on `(tenant, scope, key)`
   * serializes the read-decide-write below, so N parallel callers against the
   * same counter allow exactly `limit` of them — never more. The lock is
   * released automatically on COMMIT/ROLLBACK.
   */
  async tryConsume(
    tenantId: string,
    scope: string,
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<boolean> {
    if (limit <= 0) {
      return false;
    }

    return this.withTenantTransaction(tenantId, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${tenantId}:${scope}:${key}`,
      ]);

      const cutoff = new Date(Date.now() - windowMs);

      const { rows } = await client.query<{ total: number }>(
        `SELECT COALESCE(SUM(count), 0)::int AS total
           FROM phone_rate_limits
          WHERE scope = $1 AND key = $2 AND window_start > $3`,
        [scope, key, cutoff],
      );
      if (rows[0].total >= limit) {
        return false;
      }

      // tenant_id is sourced from the RLS GUC (set by withTenantTransaction) so
      // the inserted row can never diverge from the tenant context that gates
      // the count above. ON CONFLICT covers the rare case of two transactions
      // sharing a transaction_timestamp() — they coalesce into one bucket.
      await client.query(
        `INSERT INTO phone_rate_limits (tenant_id, scope, key, window_start, count)
         VALUES (current_setting('app.current_tenant_id')::uuid, $1, $2, NOW(), 1)
         ON CONFLICT (tenant_id, scope, key, window_start)
         DO UPDATE SET count = phone_rate_limits.count + 1`,
        [scope, key],
      );

      // Reap aged-out rows for this counter so the table stays bounded under
      // sustained traffic. Scoped to this (scope, key) to avoid a table scan.
      await client.query(
        `DELETE FROM phone_rate_limits
          WHERE scope = $1 AND key = $2 AND window_start <= $3`,
        [scope, key, cutoff],
      );

      return true;
    });
  }
}
