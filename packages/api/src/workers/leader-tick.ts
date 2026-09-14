import type { Pool } from 'pg';
import { runWithSessionLease, watchSessionLease } from '../db/session-lease';

/**
 * Blocker 5 — one leader-gated sweep tick.
 *
 * Tenant-wide sweeps run in-process on every instance; this gates a tick
 * behind a Postgres SESSION advisory lock so exactly one instance runs it and
 * the others skip. The lock is held across `work()`, so `lockPool` must hand
 * out direct (non-PgBouncer) connections — see `createDirectPool`.
 *
 * `onSuccess` is the WS15 sweep heartbeat: called only when `work()` resolves
 * with the lock still held (a throwing or fenced tick must read as lag).
 *
 * #1125 — fencing. The lock connection sits idle for the whole of `work()`,
 * so a Postgres-terminated backend releases the lock without this process
 * learning it through any promise, and another replica can start the same
 * tick. The lock client's error/end marks the lease lost, and `work()` runs
 * with that lease ambient: its next repository call (PgBaseRepository)
 * throws `SessionLeaseLostError` instead of committing, so the sweep stops
 * writing while the new leader runs. When `work()` settles on a lost lease
 * the tick rejects with that error (callers log it), records no heartbeat,
 * skips the unlock (the lock is already gone) and destroys the client.
 *
 * The in-memory (no pool) and shutdown guards stay in app.ts `runLeaderTick`.
 */
export async function runLeaderGatedTick(
  lockPool: Pool,
  lockKey: number,
  work: () => Promise<void>,
  onSuccess: () => void,
): Promise<void> {
  const client = await lockPool.connect();
  let lost = false;
  try {
    const res = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [lockKey],
    );
    if (!res.rows[0]?.locked) return; // another instance owns this tick
    const { lease, stopWatching } = watchSessionLease(client, `leader lock ${lockKey}`);
    try {
      await runWithSessionLease(lease, work);
      lease.assertHeld(); // work that finished after the lock was gone is not a successful tick
      onSuccess();
    } finally {
      lost = lease.lost;
      stopWatching();
      if (!lost) {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      }
    }
  } finally {
    client.release(lost ? true : undefined);
  }
}
