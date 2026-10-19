/**
 * S6-4 (U7, "the reaper") — when the demo lease reaper is registered and
 * how its tick behaves: only on a worker replica with a database, a lease
 * resetter and DEMO_CALLS_ENABLED on; every 30 s; behind its own leader
 * lock; one tick at a time. The sweeps' SQL (expired leases, stale resets)
 * is proven on real Postgres in test/integration/demo-tenant-leases.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import {
  scheduleDemoLeaseReaper,
  DEMO_LEASE_REAPER_INTERVAL_MS,
  type DemoLeaseReaperSchedule,
} from '../../src/workers/demo-lease-reaper';
import type { DemoLeaseResetter } from '../../src/demo/reset';

const LOCK = 590033;

function harness(overrides: Partial<DemoLeaseReaperSchedule> = {}) {
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const leaderRuns: number[] = [];
  const queries: string[] = [];
  let release: (() => void) | null = null;
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const resetter: DemoLeaseResetter = {
    resetAndRelease: async () => ({ kind: 'not_claimed', leaseId: 'x' }),
    continueReset: async () => ({ kind: 'not_claimed', leaseId: 'x' }),
  };
  const schedule: DemoLeaseReaperSchedule = {
    shouldRunWorkers: true,
    pool,
    resetter,
    isEnabled: () => true,
    lockKey: LOCK,
    runAsLeader: async (key, work) => {
      leaderRuns.push(key);
      await new Promise<void>((r) => (release = r));
      await work();
    },
    registerInterval: (h) => h,
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return 0 as unknown as NodeJS.Timeout;
    },
    ...overrides,
  };
  return { schedule, intervals, leaderRuns, queries, finish: () => release?.() };
}

describe('scheduleDemoLeaseReaper', () => {
  it('registers one 30 s interval on a worker replica with a database, a resetter and the demo call switched on', () => {
    const h = harness();
    expect(scheduleDemoLeaseReaper(h.schedule)).toBe(true);
    expect(h.intervals.map((i) => i.ms)).toEqual([DEMO_LEASE_REAPER_INTERVAL_MS]);
    expect(DEMO_LEASE_REAPER_INTERVAL_MS).toBe(30_000);
  });

  it.each([
    ['DEMO_CALLS_ENABLED off', { isEnabled: () => false }],
    ['not a worker replica', { shouldRunWorkers: false }],
    ['no database', { pool: null }],
    ['no lease resetter (a closed demo config)', { resetter: null }],
  ] as Array<[string, Partial<DemoLeaseReaperSchedule>]>)('%s → not registered', (_l, o) => {
    const h = harness(o);
    expect(scheduleDemoLeaseReaper(h.schedule)).toBe(false);
    expect(h.intervals).toEqual([]);
  });

  it('a tick runs the sweep behind its own leader lock, and a tick that fires while one runs is skipped', async () => {
    const h = harness();
    scheduleDemoLeaseReaper(h.schedule);
    const tick = h.intervals[0].fn;
    tick();
    tick();
    expect(h.leaderRuns).toEqual([LOCK]);
    h.finish();
    await new Promise((r) => setTimeout(r, 0));
    // Both sweeps read their leases (expired, then stale resets).
    expect(h.queries.some((q) => /state = 'active' AND expires_at <= now\(\)/.test(q))).toBe(true);
    expect(h.queries.some((q) => /state = 'resetting' AND reset_heartbeat_at/.test(q))).toBe(true);
    tick();
    expect(h.leaderRuns).toEqual([LOCK, LOCK]);
  });
});
