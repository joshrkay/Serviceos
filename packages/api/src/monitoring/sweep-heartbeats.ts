/**
 * WS15 — in-process sweep heartbeat registry.
 *
 * The leader-locked sweeps (app.ts `runAsLeader`) are fire-and-forget: nothing
 * durable records "this sweep last completed at T". The SLO monitor needs a
 * sweep-lag signal ("the worker loop is wedged / its DB queries are failing"),
 * so `runAsLeader` records a heartbeat here after each successful `work()`,
 * keyed by sweep name, and the monitor reads the age of the canary sweep.
 *
 * DELIBERATELY the smallest honest mechanism — a module-level Map, NOT a new
 * table (none exists today and this repo has no migrations dir under
 * packages/api).
 *
 * DOCUMENTED LIMITATION (multi-replica): each worker replica has its own Map,
 * and each sweep tick is independently leader-elected, so on a multi-replica
 * worker deploy the replica evaluating the SLO monitor may not be the replica
 * that last won the canary sweep's lock — its local heartbeat can be stale and
 * produce a false sweep-lag page. Acceptable because: (1) current prod is
 * single-replica (NUM_REPLICAS default 1), where this is exact; (2) the SLO
 * monitor is itself leader-locked and cooldown-limited, bounding noise; and
 * (3) the runbook's first-response step is to verify before trusting the page.
 * If workers go multi-replica, promote this to a durable worker_heartbeats
 * table.
 */

const lastSuccessAt = new Map<string, number>();

/** Record a successful completion of the named sweep (called by runAsLeader). */
export function recordSweepSuccess(name: string, now: number = Date.now()): void {
  lastSuccessAt.set(name, now);
}

/**
 * Epoch-ms of the named sweep's last recorded success in THIS process, or
 * undefined if it has never succeeded here (fresh boot / never won the lock).
 */
export function sweepLastSuccessMs(name: string): number | undefined {
  return lastSuccessAt.get(name);
}

/** Test convenience — clear all recorded heartbeats. */
export function resetSweepHeartbeats(): void {
  lastSuccessAt.clear();
}
