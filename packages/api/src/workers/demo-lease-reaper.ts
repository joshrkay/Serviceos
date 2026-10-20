/**
 * U7 (S6-4) — the demo lease reaper: a leader-gated P0-009 sweep, driven
 * from app.ts every 30 s behind its own advisory lock, registered only when
 * the demo call is switched on and a database exists.
 *
 * This story's two sweeps:
 *   (a) `active` leases past `expires_at`: end them through
 *       `resetAndRelease(…, { source: 'reaper' })`, whose claim re-checks
 *       `expires_at <= now()`, so a renewal that committed after this read
 *       leaves the claim zero rows and a live call is never reset;
 *   (b) `resetting` leases whose heartbeat is 60 s stale: take the reset
 *       over under a new token and run it again from the top. The age of
 *       the claim never justifies a takeover, only missed heartbeats.
 *
 * Later stories add their sweeps here: the unconfirmed-expired return and
 * the queued-call cancel (S6-6), the outbox re-enqueue (S6-7), the stale
 * in-flight reap (S6-8).
 *
 * Each tick works a bounded number of leases, oldest first, one at a time;
 * a lease whose reset fails has already alerted and returned its claim, so
 * the next tick retries it.
 */
import type { Pool } from 'pg';
import type { Logger } from '../logging/logger';
import {
  DEMO_RESET_STALE_SECONDS,
  takeOverStaleReset,
  type DemoLeaseResetter,
  type ResetOutcome,
} from '../demo/reset';

export const DEMO_LEASE_REAPER_INTERVAL_MS = 30_000;
/** Leases per sweep per tick. */
export const DEMO_LEASE_REAPER_BATCH = 10;

export interface DemoLeaseReaperDeps {
  pool: Pool;
  resetter: DemoLeaseResetter;
  limit?: number;
  staleSeconds?: number;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface DemoLeaseReaperResult {
  expired: ResetOutcome[];
  takenOver: ResetOutcome[];
}

export async function runDemoLeaseReaperSweep(deps: DemoLeaseReaperDeps): Promise<DemoLeaseReaperResult> {
  const limit = deps.limit ?? DEMO_LEASE_REAPER_BATCH;
  const staleSeconds = deps.staleSeconds ?? DEMO_RESET_STALE_SECONDS;
  const result: DemoLeaseReaperResult = { expired: [], takenOver: [] };

  const expired = await deps.pool.query<{ id: string }>(
    `SELECT id FROM demo_tenant_leases
      WHERE state = 'active' AND expires_at <= now()
      ORDER BY expires_at, id
      LIMIT $1`,
    [limit],
  );
  for (const { id } of expired.rows) {
    try {
      result.expired.push(await deps.resetter.resetAndRelease(id, { source: 'reaper' }));
    } catch (err) {
      deps.logger?.error('demo lease reaper: expired-lease reset threw', { leaseId: id, error: errorText(err) });
    }
  }

  const stale = await deps.pool.query<{ id: string }>(
    `SELECT id FROM demo_tenant_leases
      WHERE state = 'resetting' AND reset_heartbeat_at < now() - make_interval(secs => $2)
      ORDER BY reset_heartbeat_at, id
      LIMIT $1`,
    [limit, staleSeconds],
  );
  for (const { id } of stale.rows) {
    try {
      const token = await takeOverStaleReset(deps.pool, id, staleSeconds);
      if (!token) continue;
      deps.logger?.warn('demo lease reaper: took over a reset whose heartbeat went stale', { leaseId: id });
      result.takenOver.push(await deps.resetter.continueReset(id, token));
    } catch (err) {
      deps.logger?.error('demo lease reaper: takeover threw', { leaseId: id, error: errorText(err) });
    }
  }
  return result;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface DemoLeaseReaperSchedule {
  shouldRunWorkers: boolean;
  pool: Pool | null;
  /** Null without a database or with a closed demo config. */
  resetter: DemoLeaseResetter | null;
  /** `DEMO_CALLS_ENABLED`, read once at boot. */
  isEnabled: () => boolean;
  lockKey: number;
  runAsLeader: (lockKey: number, work: () => Promise<void>) => Promise<void>;
  registerInterval: (handle: NodeJS.Timeout) => NodeJS.Timeout;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
  setInterval?: (fn: () => void, ms: number) => NodeJS.Timeout;
}

/**
 * Register the reaper: only on a worker replica with a database and a lease
 * resetter while the demo call is switched on. Every 30 s, behind its own
 * leader lock; a tick that fires while the previous one runs is skipped.
 * Returns whether it was registered.
 */
export function scheduleDemoLeaseReaper(s: DemoLeaseReaperSchedule): boolean {
  const { pool, resetter } = s;
  if (!s.shouldRunWorkers || !pool || !resetter || !s.isEnabled()) return false;
  const every = s.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  let inFlight = false;
  s.registerInterval(
    every(() => {
      if (inFlight) return;
      inFlight = true;
      void s
        .runAsLeader(s.lockKey, async () => {
          await runDemoLeaseReaperSweep({ pool, resetter, logger: s.logger });
        })
        .catch((err: unknown) => {
          s.logger?.error('demo lease reaper tick failed', { error: errorText(err) });
        })
        .finally(() => {
          inFlight = false;
        });
    }, DEMO_LEASE_REAPER_INTERVAL_MS),
  );
  return true;
}
