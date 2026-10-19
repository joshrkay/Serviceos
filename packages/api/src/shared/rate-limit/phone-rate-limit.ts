import type { Pool, PoolClient } from 'pg';
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
   * Non-consuming check: report whether one more event for `(scope, key)` would
   * be within `limit` over the trailing `windowMs`, WITHOUT recording it.
   *
   * Use this when the recorded action can fail AFTER the limit decision (e.g. an
   * outbound SMS send): gate on `check()` before the action and only
   * `tryConsume()` once it has succeeded, so a transient failure cannot burn a
   * scarce token and strand the caller. The check↔consume gap is a benign race
   * under concurrency (two callers may both pass `check` then both `consume`);
   * `tryConsume` remains the authoritative atomic gate where exactness matters.
   */
  async check(
    tenantId: string,
    scope: string,
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<boolean> {
    if (limit <= 0) {
      return false;
    }
    return this.withTenant(tenantId, async (client) => {
      const cutoff = new Date(Date.now() - windowMs);
      const { rows } = await client.query<{ total: number }>(
        `SELECT COALESCE(SUM(count), 0)::int AS total
           FROM phone_rate_limits
          WHERE tenant_id = current_setting('app.current_tenant_id')::uuid
            AND scope = $1 AND key = $2 AND window_start > $3`,
        [scope, key, cutoff],
      );
      return rows[0].total < limit;
    });
  }

  /**
   * Atomically record one usage of `(scope, key)` for `tenantId` and report
   * whether it was within `limit` over the trailing `windowMs`, in a
   * transaction of its own. Returns `true` if the event is allowed (and was
   * recorded), `false` if the limit is already reached (nothing recorded).
   * The statements are `tryConsumeOn`'s.
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

    // The RLS policy still checks the GUC withTenantTransaction sets against
    // the same id that tryConsumeOn binds as a parameter.
    return this.withTenantTransaction(tenantId, async (client) => {
      const { allowed } = await tryConsumeOn(client, tenantId, scope, key, limit, windowMs);
      return allowed;
    });
  }
}

export interface ConsumeOnResult {
  allowed: boolean;
  /**
   * The `window_start` of the bucket this event was counted in (null when
   * refused). Exactly the stored value, so `releaseOn` can name the bucket.
   */
  windowStart: Date | null;
}

/**
 * The limiter on the caller's open transaction (S6-2, U7 "Allowance"): the
 * same advisory lock, count, insert and reap as `tryConsume`, in the same
 * order, on `client`, opening, committing and rolling back nothing. The
 * caller's COMMIT spends the event; its ROLLBACK leaves the count as it was.
 * The demo start transaction spends the visitor's one-call-a-day allowance
 * this way so a refused request (no free tenant, no budget) keeps it.
 *
 * `tenantId` is a bound parameter in every statement (the platform
 * transaction sets no tenant role). The lock string is the one `tryConsume`
 * has always taken, so the two entry points serialize against each other
 * and share one counter.
 *
 * `window_start` and the cutoff come from the same clock (`now`, the host
 * clock unless injected): a value read back from `NOW()` would carry
 * microseconds a JS Date cannot hold, so `releaseOn` could never name it,
 * and a cutoff on one clock against rows stamped by another would reap or
 * keep the wrong buckets.
 */
export async function tryConsumeOn(
  client: PoolClient,
  tenantId: string,
  scope: string,
  key: string,
  limit: number,
  windowMs: number,
  now: () => Date = () => new Date(),
): Promise<ConsumeOnResult> {
  if (limit <= 0) {
    return { allowed: false, windowStart: null };
  }

  // Concurrency: a transaction-scoped advisory lock on (tenant, scope, key)
  // serializes the read-decide-write below, so N parallel callers against the
  // same counter allow exactly `limit` of them. Released on COMMIT/ROLLBACK;
  // the count runs after the lock, so it sees a committed winner's row.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `${tenantId}:${scope}:${key}`,
  ]);

  const at = now();
  const cutoff = new Date(at.getTime() - windowMs);

  const { rows } = await client.query<{ total: number }>(
    `SELECT COALESCE(SUM(count), 0)::int AS total
       FROM phone_rate_limits
      WHERE tenant_id = $1
        AND scope = $2 AND key = $3 AND window_start > $4`,
    [tenantId, scope, key, cutoff],
  );
  if (rows[0].total >= limit) {
    return { allowed: false, windowStart: null };
  }

  // ON CONFLICT covers two events stamped in the same millisecond: they
  // coalesce into one bucket, which the SUM above still counts correctly.
  const inserted = await client.query<{ window_start: Date }>(
    `INSERT INTO phone_rate_limits (tenant_id, scope, key, window_start, count)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (tenant_id, scope, key, window_start)
     DO UPDATE SET count = phone_rate_limits.count + 1
     RETURNING window_start`,
    [tenantId, scope, key, at],
  );

  // Reap aged-out rows for this counter so the table stays bounded under
  // sustained traffic. Scoped to this (scope, key) to avoid a table scan.
  await client.query(
    `DELETE FROM phone_rate_limits
      WHERE tenant_id = $1
        AND scope = $2 AND key = $3 AND window_start <= $4`,
    [tenantId, scope, key, cutoff],
  );

  return { allowed: true, windowStart: inserted.rows[0].window_start };
}

/**
 * Return one event to the bucket `tryConsumeOn` counted it in (D11: a demo
 * call that provably never existed gives the visitor's allowance back).
 * Guarded by `count > 0`, so it can never go negative; the caller's own
 * once-only guard (`demo_calls.allowance_released_at`) is what makes a
 * replay a no-op. A bucket at zero is harmless (the SUM ignores it) and is
 * reaped once it ages out. Returns whether a bucket was decremented.
 */
export async function releaseOn(
  client: PoolClient,
  tenantId: string,
  scope: string,
  key: string,
  windowStart: Date,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE phone_rate_limits SET count = count - 1
      WHERE tenant_id = $1 AND scope = $2 AND key = $3 AND window_start = $4 AND count > 0`,
    [tenantId, scope, key, windowStart],
  );
  return (rowCount ?? 0) > 0;
}
