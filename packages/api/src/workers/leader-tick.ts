import type { Pool } from 'pg';

/**
 * Blocker 5 — one leader-gated sweep tick.
 *
 * Tenant-wide sweeps run in-process on every instance; this gates a tick
 * behind a Postgres SESSION advisory lock so exactly one instance runs it and
 * the others skip. The lock is held across `work()`, so `lockPool` must hand
 * out direct (non-PgBouncer) connections — see `createDirectPool`.
 *
 * `onSuccess` is the WS15 sweep heartbeat: called only when `work()` resolves
 * (a throwing tick must read as lag).
 *
 * Extracted from `app.ts` `runLeaderTick` (#1125) so the lock semantics can be
 * driven against a real Postgres; the in-memory (no pool) and shutdown guards
 * stay in app.ts.
 */
export async function runLeaderGatedTick(
  lockPool: Pool,
  lockKey: number,
  work: () => Promise<void>,
  onSuccess: () => void,
): Promise<void> {
  const client = await lockPool.connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [lockKey],
    );
    if (!res.rows[0]?.locked) return; // another instance owns this tick
    try {
      await work();
      onSuccess();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
  } finally {
    client.release();
  }
}
