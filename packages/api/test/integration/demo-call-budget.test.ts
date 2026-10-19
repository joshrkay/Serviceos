/**
 * Postgres integration — S6-2 of the "pick, don't build" plan (U7 "Daily
 * budget", "Allowance", "Release", "Configuration and alerts"; D1 first
 * test; D11 first test).
 *
 * Every case runs the real start transaction (`runStartTransaction`), the
 * real reservation statement (`demo/call-budget.ts#reserve`, imported, never
 * copied), the real release (`releaseNoCall`), the real limiter on the
 * caller's client (`tryConsumeOn`/`releaseOn`) and the real lead capture on
 * the hidden platform tenant, on real Postgres. The one injected step is the
 * lease (S6-3 owns pool selection): here it inserts a real
 * `demo_tenant_leases` row for a real tenant in the same transaction, or
 * reports an exhausted pool. The operator page is recorded at the alert seam.
 *
 * Shared-DB rule: every case owns its own UTC day (a random far-future day
 * per run, so reruns on a persistent EXTERNAL_TEST_DB_URL never collide) and
 * its own phone hashes; nothing asserts table-wide totals.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, randomInt } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getSharedTestDb } from './shared';
import {
  runStartTransaction,
  DEMO_CALL_STARTED_EVENT,
  type DemoStartRequest,
  type StartOutcome,
  type StartTransactionSteps,
  type TakenLease,
} from '../../src/demo/start-transaction';
import {
  reserve,
  releaseNoCall,
  budgetDayFor,
  DEMO_BUDGET_ALERT_EVENT,
  DEMO_CALL_ALLOWANCE_SCOPE,
} from '../../src/demo/call-budget';
import { loadDemoConfig, type DemoConfig } from '../../src/demo/config';
import { DEMO_PLATFORM_TENANT_ID } from '../../src/demo/platform-tenant';
import { tryConsumeOn } from '../../src/shared/rate-limit/phone-rate-limit';
import type { OperatorAlert } from '../../src/monitoring/alert-operator';
import { demoCallBudgetRefusalsTotal } from '../../src/monitoring/metrics';

const DAY_MS = 24 * 60 * 60 * 1000;
// A random far-future base day per run; each case takes the next day.
const BASE_DAY_MS = Date.UTC(2100, 0, 1) + randomInt(0, 2_000_000) * DAY_MS;
let dayCounter = 0;
/** Noon UTC on a day no other case (and no earlier run) uses; the next four days are the case's too. */
function freshDay(): Date {
  dayCounter += 5;
  return new Date(BASE_DAY_MS + dayCounter * DAY_MS + 12 * 60 * 60 * 1000);
}

function visitor(overrides: Partial<DemoStartRequest> = {}): DemoStartRequest {
  const digits = String(randomInt(0, 10_000_000)).padStart(7, '0');
  return {
    phoneHash: `test-phone-hash-${randomUUID()}`,
    e164: `+1512${digits}`,
    trade: 'plumbing',
    businessName: `Visitor Plumbing ${digits}`,
    metroCode: 'austin',
    metroName: 'Austin',
    correlationId: `demo-${randomUUID()}`,
    ...overrides,
  };
}

function config(env: Record<string, string> = {}): DemoConfig {
  return loadDemoConfig(env);
}

/** The real lease row (S6-3 replaces the tenant pick), written on the start transaction's client. */
function leaseStep(): StartTransactionSteps & { calls: number } {
  const step = {
    calls: 0,
    async takeLease(client: PoolClient, req: DemoStartRequest, at: Date): Promise<TakenLease | null> {
      step.calls += 1;
      const tenantId = randomUUID();
      await client.query(
        `INSERT INTO tenants (id, owner_id, owner_email, name) VALUES ($1, $2, 'lease-test@invalid.test', 'Lease test tenant')`,
        [tenantId, `lease-test:${tenantId}`],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO demo_tenant_leases (tenant_id, visitor_phone_hash, expires_at)
         VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, req.phoneHash, new Date(at.getTime() + 70_000)],
      );
      return { leaseId: rows[0].id, tenantId };
    },
  };
  return step;
}

const exhaustedPool = (): StartTransactionSteps & { calls: number } => {
  const step = {
    calls: 0,
    async takeLease(): Promise<TakenLease | null> {
      step.calls += 1;
      return null;
    },
  };
  return step;
};

describe('Postgres integration — demo call budget, allowance and release (S6-2)', () => {
  let pool: Pool;
  /** Every operator page the start transaction sent, in order (the alert seam). */
  const pagesAll: OperatorAlert[] = [];

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  async function start(
    req: DemoStartRequest,
    at: Date,
    cfg: DemoConfig = config(),
    steps: StartTransactionSteps = leaseStep(),
    p: Pool = pool,
  ): Promise<StartOutcome> {
    return runStartTransaction(p, req, steps, {
      config: cfg,
      isEnabled: () => true,
      alert: async (a) => {
        pagesAll.push(a);
      },
      now: () => at,
    });
  }

  async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async function budgetRow(at: Date) {
    const { rows } = await pool.query<{
      calls_reserved: number;
      calls_cap: number;
      est_cost_cents: number;
      cost_cap_cents: number;
    }>(`SELECT calls_reserved, calls_cap, est_cost_cents, cost_cap_cents FROM demo_call_budget WHERE day = $1::date`, [
      budgetDayFor(at),
    ]);
    return rows[0] ?? null;
  }

  async function allowanceCount(phoneHash: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COALESCE(SUM(count), 0)::int AS n FROM phone_rate_limits
        WHERE tenant_id = $1 AND scope = $2 AND key = $3`,
      [DEMO_PLATFORM_TENANT_ID, DEMO_CALL_ALLOWANCE_SCOPE, phoneHash],
    );
    return rows[0].n;
  }

  async function rowsFor(req: DemoStartRequest) {
    const leases = await pool.query(`SELECT id FROM demo_tenant_leases WHERE visitor_phone_hash = $1`, [req.phoneHash]);
    const calls = await pool.query(`SELECT id FROM demo_calls WHERE phone_hash = $1`, [req.phoneHash]);
    const leads = await pool.query(`SELECT id FROM leads WHERE tenant_id = $1 AND primary_phone = $2`, [
      DEMO_PLATFORM_TENANT_ID,
      req.e164,
    ]);
    return { leases: leases.rowCount, calls: calls.rowCount, leads: leads.rowCount };
  }

  /**
   * The lease's end state after its reset (S6-3's not-created branch and
   * S6-4's resetAndRelease own that path): one open lease per visitor is a
   * real unique index, so a same-number retry needs the first one released.
   */
  async function markLeaseReleased(leaseId: string): Promise<void> {
    await pool.query(`UPDATE demo_tenant_leases SET state = 'released', released_at = now() WHERE id = $1`, [leaseId]);
  }

  function started(o: StartOutcome) {
    if (o.kind !== 'started') throw new Error(`expected started, got ${JSON.stringify(o)}`);
    return o.call;
  }

  // ---------------------------------------------------------------- D1 / shape

  it('D1: on the migrated database the allowance and the lead land on the platform tenant, with no FK failure', async () => {
    const at = freshDay();
    const req = visitor();
    const call = started(await start(req, at));

    const allowance = await pool.query<{ tenant_id: string; count: number; window_start: Date }>(
      `SELECT tenant_id, count, window_start FROM phone_rate_limits WHERE scope = $1 AND key = $2`,
      [DEMO_CALL_ALLOWANCE_SCOPE, req.phoneHash],
    );
    expect(allowance.rows).toHaveLength(1);
    expect(allowance.rows[0]).toMatchObject({ tenant_id: DEMO_PLATFORM_TENANT_ID, count: 1 });
    expect(allowance.rows[0].window_start.toISOString()).toBe(at.toISOString());

    const lead = await pool.query(
      `SELECT tenant_id, source, source_detail, company_name, primary_phone FROM leads WHERE id = $1`,
      [call.leadId],
    );
    expect(lead.rows[0]).toEqual({
      tenant_id: DEMO_PLATFORM_TENANT_ID,
      source: 'other',
      source_detail: 'demo_call',
      company_name: req.businessName,
      primary_phone: req.e164,
    });

    const row = await pool.query(
      `SELECT phone_hash, trade, business_name, metro_code, metro_name, lease_id, lead_id, status, call_sid,
              budget_day::text AS budget_day, reserved_cents, budget_released_at, allowance_window_start,
              allowance_released_at, callback_deadline_at, correlation_id
         FROM demo_calls WHERE id = $1`,
      [call.demoCallId],
    );
    expect(row.rows[0]).toEqual({
      phone_hash: req.phoneHash,
      trade: 'plumbing',
      business_name: req.businessName,
      metro_code: 'austin',
      metro_name: 'Austin',
      lease_id: call.leaseId,
      lead_id: call.leadId,
      status: 'initiating',
      call_sid: null,
      budget_day: budgetDayFor(at),
      reserved_cents: 50,
      budget_released_at: null,
      allowance_window_start: at,
      allowance_released_at: null,
      callback_deadline_at: new Date(at.getTime() + 24 * 60 * 60 * 1000),
      correlation_id: req.correlationId,
    });
    expect(call.callbackDeadlineAt.toISOString()).toBe(new Date(at.getTime() + DAY_MS).toISOString());

    const audit = await pool.query(
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2`,
      [DEMO_PLATFORM_TENANT_ID, call.demoCallId],
    );
    expect(audit.rows.map((r) => r.event_type)).toEqual([DEMO_CALL_STARTED_EVENT]);
  });

  it('a repeat visitor on a later day attaches to their open lead instead of tripping the open-phone index', async () => {
    const at = freshDay();
    const req = visitor();
    const first = started(await start(req, at));
    await markLeaseReleased(first.leaseId);
    const second = started(
      await start({ ...req, correlationId: `demo-${randomUUID()}` }, new Date(at.getTime() + 2 * DAY_MS)),
    );
    expect(second.leadId).toBe(first.leadId);
  });

  it('demo_calls and demo_call_budget have no tenant_id and no RLS, on real Postgres', async () => {
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean; tenant_cols: number }>(
      `SELECT c.relname, c.relrowsecurity,
              (SELECT count(*)::int FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = c.relname AND column_name = 'tenant_id') AS tenant_cols
         FROM pg_class c
        WHERE c.relname IN ('demo_calls', 'demo_call_budget') AND c.relkind = 'r'
        ORDER BY c.relname`,
    );
    expect(rows).toEqual([
      { relname: 'demo_call_budget', relrowsecurity: false, tenant_cols: 0 },
      { relname: 'demo_calls', relrowsecurity: false, tenant_cols: 0 },
    ]);
  });

  // ---------------------------------------------------------------- concurrency

  /** A latch the lease step waits on, so every request's transaction is open at once. */
  function latchedLeaseStep(parties: number): StartTransactionSteps {
    const inner = leaseStep();
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    return {
      async takeLease(client, req, at) {
        arrived += 1;
        if (arrived === parties) open();
        await gate;
        return inner.takeLease(client, req, at);
      },
    };
  }

  it('concurrent reservations never exceed the calls cap: N + 5 simultaneous requests, N succeed (looped)', async () => {
    for (let round = 0; round < 5; round++) {
      const at = freshDay();
      const N = 3;
      const cfg = config({ DEMO_CALLS_DAILY_CAP: String(N) });
      const reqs = Array.from({ length: N + 5 }, () => visitor());
      const steps = latchedLeaseStep(reqs.length);
      const outcomes = await Promise.all(reqs.map((r) => start(r, at, cfg, steps)));

      expect(outcomes.filter((o) => o.kind === 'started')).toHaveLength(N);
      expect(outcomes.filter((o) => o.kind === 'busy' && o.cause === 'budget')).toHaveLength(5);
      expect(await budgetRow(at)).toEqual({ calls_reserved: N, calls_cap: N, est_cost_cents: N * 50, cost_cap_cents: 2500 });
      for (const [i, o] of outcomes.entries()) {
        if (o.kind === 'started') continue;
        expect(await rowsFor(reqs[i])).toEqual({ leases: 0, calls: 0, leads: 0 });
        expect(await allowanceCount(reqs[i].phoneHash)).toBe(0);
      }
    }
  });

  it('with the cost cap binding first (175 cents at 50 a call) exactly 3 of 6 succeed (looped)', async () => {
    for (let round = 0; round < 3; round++) {
      const at = freshDay();
      const cfg = config({ DEMO_CALLS_DAILY_CAP: '1000', DEMO_COST_DAILY_CAP_CENTS: '175', DEMO_CALL_EST_COST_CENTS: '50' });
      const reqs = Array.from({ length: 6 }, () => visitor());
      const steps = latchedLeaseStep(reqs.length);
      const outcomes = await Promise.all(reqs.map((r) => start(r, at, cfg, steps)));
      expect(outcomes.filter((o) => o.kind === 'started')).toHaveLength(3);
      expect(await budgetRow(at)).toEqual({ calls_reserved: 3, calls_cap: 1000, est_cost_cents: 150, cost_cap_cents: 175 });
    }
  });

  it('the first reservation of an empty day is checked too: a calls cap of 0, or a unit above the cost cap, refuses and writes no row', async () => {
    const zero = freshDay();
    expect(
      await inTx((c) => reserve(c, { day: budgetDayFor(zero), unitCents: 50, caps: { callsCap: 0, costCapCents: 2500 } })),
    ).toEqual({ reserved: false });
    expect(await budgetRow(zero)).toBeNull();

    const subUnit = freshDay();
    expect(
      await inTx((c) => reserve(c, { day: budgetDayFor(subUnit), unitCents: 60, caps: { callsCap: 50, costCapCents: 50 } })),
    ).toEqual({ reserved: false });
    expect(await budgetRow(subUnit)).toBeNull();
  });

  // ---------------------------------------------------------------- UTC rollover

  it('UTC rollover (injected clock): 23:59:59 and 00:00:00 land on two rows, a full yesterday blocks nothing, and a release after midnight goes back to its own day', async () => {
    const noon = freshDay();
    const lastSecond = new Date(Date.UTC(noon.getUTCFullYear(), noon.getUTCMonth(), noon.getUTCDate(), 23, 59, 59));
    const midnight = new Date(lastSecond.getTime() + 1000);
    const cfg = config({ DEMO_CALLS_DAILY_CAP: '1' });

    const late = started(await start(visitor(), lastSecond, cfg));
    expect(await start(visitor(), lastSecond, cfg)).toEqual({ kind: 'busy', cause: 'budget' });
    const early = started(await start(visitor(), midnight, cfg));

    expect(late.budgetDay).not.toBe(early.budgetDay);
    expect(await budgetRow(lastSecond)).toMatchObject({ calls_reserved: 1, est_cost_cents: 50 });
    expect(await budgetRow(midnight)).toMatchObject({ calls_reserved: 1, est_cost_cents: 50 });

    expect(await inTx((c) => releaseNoCall(c, late.demoCallId))).toMatchObject({ released: true, budgetDay: late.budgetDay });
    expect(await budgetRow(lastSecond)).toMatchObject({ calls_reserved: 0, est_cost_cents: 0 });
    expect(await budgetRow(midnight)).toMatchObject({ calls_reserved: 1, est_cost_cents: 50 });
  });

  // ---------------------------------------------------------------- release (D11)

  it('D11: a call that provably never existed returns its unit and the allowance once; the same-day retry is free; a replay touches nothing', async () => {
    const at = freshDay();
    const req = visitor();
    const call = started(await start(req, at));
    expect(await allowanceCount(req.phoneHash)).toBe(1);
    expect(await budgetRow(at)).toMatchObject({ calls_reserved: 1, est_cost_cents: 50 });

    expect(await inTx((c) => releaseNoCall(c, call.demoCallId))).toEqual({
      released: true,
      budgetDay: budgetDayFor(at),
      reservedCents: 50,
      allowanceReturned: true,
    });
    expect(await budgetRow(at)).toMatchObject({ calls_reserved: 0, est_cost_cents: 0 });
    expect(await allowanceCount(req.phoneHash)).toBe(0);
    const marks = await pool.query(
      `SELECT budget_released_at IS NOT NULL AS b, allowance_released_at IS NOT NULL AS a FROM demo_calls WHERE id = $1`,
      [call.demoCallId],
    );
    expect(marks.rows[0]).toEqual({ b: true, a: true });

    // Replayed: zero rows, nothing touched.
    expect(await inTx((c) => releaseNoCall(c, call.demoCallId))).toEqual({ released: false });
    expect(await budgetRow(at)).toMatchObject({ calls_reserved: 0, est_cost_cents: 0 });
    expect(await allowanceCount(req.phoneHash)).toBe(0);
    const released = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND entity_id = $2 AND event_type = 'demo_call_budget_released'`,
      [DEMO_PLATFORM_TENANT_ID, call.demoCallId],
    );
    expect(released.rows[0].n).toBe(1);

    // The same number's same-day retry passes the allowance.
    await markLeaseReleased(call.leaseId);
    const retry = started(await start({ ...req, correlationId: `demo-${randomUUID()}` }, new Date(at.getTime() + 60_000)));
    expect(retry.demoCallId).not.toBe(call.demoCallId);
    expect(await allowanceCount(req.phoneHash)).toBe(1);
  });

  it('D11: two releases racing for one call return the unit and the allowance exactly once', async () => {
    const at = freshDay();
    const req = visitor();
    const call = started(await start(req, at));
    const results = await Promise.all([
      inTx((c) => releaseNoCall(c, call.demoCallId)),
      inTx((c) => releaseNoCall(c, call.demoCallId)),
    ]);
    expect(results.filter((r) => r.released)).toHaveLength(1);
    expect(await budgetRow(at)).toMatchObject({ calls_reserved: 0, est_cost_cents: 0 });
    expect(await allowanceCount(req.phoneHash)).toBe(0);
  });

  it('D11: a CallSid bound on the lease, or on the call row, pins the reservation and the allowance', async () => {
    for (const where of ['lease', 'call'] as const) {
      const at = freshDay();
      const req = visitor();
      const call = started(await start(req, at));
      if (where === 'lease') {
        await pool.query(`UPDATE demo_tenant_leases SET call_sid = $2 WHERE id = $1`, [call.leaseId, `CA${randomUUID().replace(/-/g, '')}`]);
      } else {
        await pool.query(`UPDATE demo_calls SET call_sid = $2 WHERE id = $1`, [call.demoCallId, `CA${randomUUID().replace(/-/g, '')}`]);
      }
      expect(await inTx((c) => releaseNoCall(c, call.demoCallId))).toEqual({ released: false });
      expect(await budgetRow(at)).toMatchObject({ calls_reserved: 1, est_cost_cents: 50 });
      expect(await allowanceCount(req.phoneHash)).toBe(1);
      expect(await start({ ...req, correlationId: `demo-${randomUUID()}` }, at)).toEqual({ kind: 'rate_limited' });
    }
  });

  it('D11: an ambiguous outcome (a timeout or a 5xx leaves the row unconfirmed, never released) keeps the allowance and the unit', async () => {
    const at = freshDay();
    const req = visitor();
    const call = started(await start(req, at));
    await pool.query(`UPDATE demo_calls SET status = 'unconfirmed' WHERE id = $1`, [call.demoCallId]);
    expect(await allowanceCount(req.phoneHash)).toBe(1);
    expect(await budgetRow(at)).toMatchObject({ calls_reserved: 1, est_cost_cents: 50 });
    expect(await start({ ...req, correlationId: `demo-${randomUUID()}` }, new Date(at.getTime() + 60_000))).toEqual({
      kind: 'rate_limited',
    });
    // Once its callback window closes with no CallSid ever bound (case 2), the same release returns both.
    expect(await inTx((c) => releaseNoCall(c, call.demoCallId))).toMatchObject({ released: true, allowanceReturned: true });
    expect(await allowanceCount(req.phoneHash)).toBe(0);
  });

  // ---------------------------------------------------------------- cap reached

  it('cap reached: twenty distinct numbers each answer busy with no lease, call row, lead or allowance spent, and the counters do not move', async () => {
    const at = freshDay();
    const cfg = config({ DEMO_CALLS_DAILY_CAP: '2' });
    started(await start(visitor(), at, cfg));
    started(await start(visitor(), at, cfg));
    const before = await budgetRow(at);

    const reqs = Array.from({ length: 20 }, () => visitor());
    for (const req of reqs) {
      expect(await start(req, at, cfg)).toEqual({ kind: 'busy', cause: 'budget' });
      expect(await rowsFor(req)).toEqual({ leases: 0, calls: 0, leads: 0 });
      expect(await allowanceCount(req.phoneHash)).toBe(0);
    }
    expect(await budgetRow(at)).toEqual(before);
  });

  it('an exhausted pool with budget room answers busy before the budget is touched', async () => {
    const at = freshDay();
    started(await start(visitor(), at));
    const before = await budgetRow(at);
    const req = visitor();
    expect(await start(req, at, config(), exhaustedPool())).toEqual({ kind: 'busy', cause: 'pool' });
    expect(await budgetRow(at)).toEqual(before);
    expect(await rowsFor(req)).toEqual({ leases: 0, calls: 0, leads: 0 });
    expect(await allowanceCount(req.phoneHash)).toBe(0);
  });

  // ---------------------------------------------------------------- allowance cases

  it('allowance (a): two simultaneous requests for one number take one lease, one call, one unit and one allowance, in both arrival orders (looped)', async () => {
    for (let round = 0; round < 6; round++) {
      const at = freshDay();
      const req = visitor();
      const other = { ...req, correlationId: `demo-${randomUUID()}` };
      const step = leaseStep();
      const [a, b] = round % 2 === 0 ? [req, other] : [other, req];
      const outcomes = await Promise.all([start(a, at, config(), step), start(b, at, config(), step)]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(['rate_limited', 'started']);
      expect(step.calls).toBe(1);
      expect(await rowsFor(req)).toEqual({ leases: 1, calls: 1, leads: 1 });
      expect(await budgetRow(at)).toMatchObject({ calls_reserved: 1, est_cost_cents: 50 });
      expect(await allowanceCount(req.phoneHash)).toBe(1);
    }
  });

  it('allowance (b): an exhausted pool leaves the allowance unspent; the same-day retry succeeds once a tenant frees', async () => {
    const at = freshDay();
    const req = visitor();
    expect(await start(req, at, config(), exhaustedPool())).toEqual({ kind: 'busy', cause: 'pool' });
    expect(await allowanceCount(req.phoneHash)).toBe(0);
    started(await start(req, new Date(at.getTime() + 60_000)));
    expect(await allowanceCount(req.phoneHash)).toBe(1);
  });

  it('allowance (c): a refused budget leaves the allowance unspent and no lease; the retry succeeds once room opens', async () => {
    const at = freshDay();
    const cfg = config({ DEMO_CALLS_DAILY_CAP: '1' });
    const holder = started(await start(visitor(), at, cfg));
    const req = visitor();
    expect(await start(req, at, cfg)).toEqual({ kind: 'busy', cause: 'budget' });
    expect(await allowanceCount(req.phoneHash)).toBe(0);
    expect(await rowsFor(req)).toEqual({ leases: 0, calls: 0, leads: 0 });

    await inTx((c) => releaseNoCall(c, holder.demoCallId));
    started(await start(req, new Date(at.getTime() + 60_000), cfg));
    expect(await allowanceCount(req.phoneHash)).toBe(1);
  });

  it('allowance (d): a fault after the allowance row and before the commit spends nothing, and a fresh request succeeds', async () => {
    const at = freshDay();
    const req = visitor();
    const faulty: StartTransactionSteps = {
      async takeLease(client, r, t) {
        await leaseStep().takeLease(client, r, t);
        throw new Error('injected fault before commit');
      },
    };
    await expect(start(req, at, config(), faulty)).rejects.toThrow('injected fault before commit');
    expect(await allowanceCount(req.phoneHash)).toBe(0);
    expect(await rowsFor(req)).toEqual({ leases: 0, calls: 0, leads: 0 });
    started(await start(req, at));
  });

  it('allowance (d): a killed backend mid-transaction spends nothing, and a fresh request succeeds', async () => {
    const at = freshDay();
    const req = visitor();
    const killer: StartTransactionSteps = {
      async takeLease(client) {
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        await pool.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
        await client.query('SELECT 1');
        return null;
      },
    };
    await expect(start(req, at, config(), killer)).rejects.toThrow();
    expect(await allowanceCount(req.phoneHash)).toBe(0);
    expect(await rowsFor(req)).toEqual({ leases: 0, calls: 0, leads: 0 });
    started(await start(req, at));
  });

  it('allowance (d): a second request waiting on the key lock when the first faults is not refused; it consumes once and completes', async () => {
    const at = freshDay();
    const req = visitor();
    let fail!: () => void;
    const failGate = new Promise<void>((r) => (fail = r));
    const first: StartTransactionSteps = {
      async takeLease() {
        await failGate;
        throw new Error('injected fault while a second request waits');
      },
    };
    const firstRun = start(req, at, config(), first);
    // Wait until the first holds the key lock (it is inside takeLease).
    const lockKey = `${DEMO_PLATFORM_TENANT_ID}:${DEMO_CALL_ALLOWANCE_SCOPE}:${req.phoneHash}`;
    const lockState = async (granted: boolean) => {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND granted = $2
            AND objid = (hashtext($1)::bigint & 4294967295)::oid`,
        [lockKey, granted],
      );
      return rows[0].n;
    };
    for (let i = 0; i < 100 && (await lockState(true)) === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const secondRun = start({ ...req, correlationId: `demo-${randomUUID()}` }, at);
    for (let i = 0; i < 100 && (await lockState(false)) === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await lockState(false)).toBe(1);

    fail();
    await expect(firstRun).rejects.toThrow('injected fault while a second request waits');
    started(await secondRun);
    expect(await allowanceCount(req.phoneHash)).toBe(1);
    expect(await rowsFor(req)).toEqual({ leases: 1, calls: 1, leads: 1 });
  });

  it('allowance (e): after a committed call the next request for the number answers 429 before the pool or the budget row is read', async () => {
    const at = freshDay();
    const req = visitor();
    started(await start(req, at));

    const statements: string[] = [];
    const spyPool = {
      async connect() {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, prop, receiver) {
            if (prop === 'query') {
              return (...args: unknown[]) => {
                statements.push(String(typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text));
                return (target.query as (...a: unknown[]) => unknown).apply(target, args);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    } as unknown as Pool;
    const step = leaseStep();
    expect(await start({ ...req, correlationId: `demo-${randomUUID()}` }, at, config(), step, spyPool)).toEqual({
      kind: 'rate_limited',
    });
    expect(step.calls).toBe(0);
    expect(statements.some((s) => /demo_call_budget|demo_tenant_leases|tenants\b/.test(s))).toBe(false);
    expect(statements.some((s) => /phone_rate_limits/.test(s))).toBe(true);
  });

  it('allowance (f): the start transaction and a direct tryConsumeOn share the platform counter for a number', async () => {
    const at = freshDay();
    const req = visitor();
    const direct = await inTx((c) =>
      tryConsumeOn(c, DEMO_PLATFORM_TENANT_ID, DEMO_CALL_ALLOWANCE_SCOPE, req.phoneHash, 1, DAY_MS, () => at),
    );
    expect(direct.allowed).toBe(true);
    expect(await start(req, at)).toEqual({ kind: 'rate_limited' });
  });

  // ---------------------------------------------------------------- alerts and config

  it('alerts: a cap of 7 pages on the 6th reservation and on the 7th, writes one demo_budget_alert row each, and later refusals page nobody', async () => {
    const at = freshDay();
    const day = budgetDayFor(at);
    const cfg = config({ DEMO_CALLS_DAILY_CAP: '7' });
    pagesAll.length = 0;
    const refusalsBefore = await refusals();

    const seen: Record<number, string[]> = {};
    for (let i = 1; i <= 9; i++) {
      const before = pagesAll.length;
      const o = await start(visitor(), at, cfg);
      expect(o.kind).toBe(i <= 7 ? 'started' : 'busy');
      const now = pagesAll.slice(before).map((p) => p.rule);
      if (now.length) seen[i] = now;
    }
    expect(seen).toEqual({ 6: ['demo_budget_calls_80pct'], 7: ['demo_budget_calls_full'] });
    expect(pagesAll.find((p) => p.rule === 'demo_budget_calls_full')?.severity).toBe('critical');
    expect((await refusals()) - refusalsBefore).toBe(2);

    const audit = await pool.query<{ rule: string }>(
      `SELECT metadata->>'rule' AS rule FROM audit_events
        WHERE tenant_id = $1 AND event_type = $2 AND entity_id = $3 ORDER BY created_at`,
      [DEMO_PLATFORM_TENANT_ID, DEMO_BUDGET_ALERT_EVENT, day],
    );
    expect(audit.rows.map((r) => r.rule)).toEqual(['demo_budget_calls_80pct', 'demo_budget_calls_full']);

    // A cap changed mid-day does not alter that day's row.
    expect(await start(visitor(), at, config({ DEMO_CALLS_DAILY_CAP: '20' }))).toEqual({ kind: 'busy', cause: 'budget' });
    expect(await budgetRow(at)).toMatchObject({ calls_reserved: 7, calls_cap: 7 });
  });

  it('a reservation whose transaction rolls back pages nobody and leaves no alert row', async () => {
    const at = freshDay();
    const cfg = config({ DEMO_CALLS_DAILY_CAP: '1' });
    const first = visitor();
    started(await start(first, freshDay()));
    pagesAll.length = 0;
    // Reusing a committed correlation id fails the demo_calls insert after the crossing reservation.
    await expect(start(visitor({ correlationId: first.correlationId }), at, cfg)).rejects.toThrow();
    expect(pagesAll).toEqual([]);
    expect(await budgetRow(at)).toBeNull();
    const audit = await pool.query(
      `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = $2 AND entity_id = $3`,
      [DEMO_PLATFORM_TENANT_ID, DEMO_BUDGET_ALERT_EVENT, budgetDayFor(at)],
    );
    expect(audit.rowCount).toBe(0);
  });

  it('a malformed env value closes the module: every request is refused and nothing is written', async () => {
    const at = freshDay();
    const bad: Record<string, string>[] = [
      { DEMO_CALLS_DAILY_CAP: 'lots' },
      { DEMO_COST_DAILY_CAP_CENTS: '0' },
      { DEMO_CALL_EST_COST_CENTS: '9999' },
    ];
    for (const env of bad) {
      const req = visitor();
      const step = leaseStep();
      const o = await start(req, at, config(env), step);
      expect(o).toMatchObject({ kind: 'disabled' });
      expect(step.calls).toBe(0);
      expect(await allowanceCount(req.phoneHash)).toBe(0);
    }
    expect(await budgetRow(at)).toBeNull();
  });

  it('the kill switch: DEMO_CALLS_ENABLED off (the default) refuses every request and writes nothing', async () => {
    const at = freshDay();
    const req = visitor();
    const saved = process.env.DEMO_CALLS_ENABLED;
    delete process.env.DEMO_CALLS_ENABLED;
    try {
      const o = await runStartTransaction(pool, req, leaseStep(), { config: config(), alert: async () => undefined, now: () => at });
      expect(o).toEqual({ kind: 'disabled', reason: 'DEMO_CALLS_ENABLED is off' });
    } finally {
      if (saved !== undefined) process.env.DEMO_CALLS_ENABLED = saved;
    }
    expect(await allowanceCount(req.phoneHash)).toBe(0);
    expect(await budgetRow(at)).toBeNull();
  });

  async function refusals(): Promise<number> {
    const metric = await demoCallBudgetRefusalsTotal.get();
    return metric.values.reduce((sum, v) => sum + v.value, 0);
  }
});
