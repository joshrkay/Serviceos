/**
 * Postgres integration — S6-3 of the "pick, don't build" plan (U7 "One live
 * call per tenant", "Pool exhausted"). The real lease pick
 * (`demo/lease.ts#insertLease` / `demoLeaseStep`) inside the real start
 * transaction, on real Postgres, with two or more real connections.
 *
 * Shared-DB rule: every case owns a fresh trade string (so its pool is only
 * the demo tenants it created), fresh phone hashes and a far-future UTC day.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomInt, randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getSharedTestDb } from './shared';
import { insertLease, demoLeaseStep, PRE_LIVE_WINDOW_S } from '../../src/demo/lease';
import { runStartTransaction, type DemoStartRequest, type StartOutcome } from '../../src/demo/start-transaction';
import { loadDemoConfig } from '../../src/demo/config';
import { DEMO_CALL_ALLOWANCE_SCOPE } from '../../src/demo/call-budget';
import { DEMO_PLATFORM_TENANT_ID } from '../../src/demo/platform-tenant';
import { withTenantSession } from '../../src/db/rls-runtime-role';

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_DAY_MS = Date.UTC(2200, 0, 1) + randomInt(0, 2_000_000) * DAY_MS;
let dayCounter = 0;
function freshDay(): Date {
  dayCounter += 2;
  return new Date(BASE_DAY_MS + dayCounter * DAY_MS + 12 * 60 * 60 * 1000);
}

const freshTrade = () => `lease-test-${randomUUID().slice(0, 8)}`;

describe('Postgres integration — demo tenant leases (S6-3)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  async function demoTenants(trade: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO tenants (id, owner_id, owner_email, name, demo, demo_trade)
         VALUES ($1, $2, 'demo-lease-test@invalid.rivet.local', 'Demo lease test', true, $3)`,
        [id, `demo-lease-test:${id}`, trade],
      );
      ids.push(id);
    }
    return ids;
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

  function visitor(trade: string): DemoStartRequest {
    const digits = String(randomInt(0, 10_000_000)).padStart(7, '0');
    return {
      phoneHash: `lease-phone-${randomUUID()}`,
      e164: `+1512${digits}`,
      trade,
      businessName: `Lease Visitor ${digits}`,
      correlationId: `demo-${randomUUID()}`,
    };
  }

  const start = (req: DemoStartRequest, at: Date): Promise<StartOutcome> =>
    runStartTransaction(pool, req, demoLeaseStep, {
      config: loadDemoConfig({ DEMO_CALLS_DAILY_CAP: '100000', DEMO_COST_DAILY_CAP_CENTS: '100000000' }),
      isEnabled: () => true,
      alert: async () => undefined,
      now: () => at,
    });

  async function releaseAll(trade: string): Promise<void> {
    await pool.query(
      `UPDATE demo_tenant_leases SET state = 'released', released_at = now()
        WHERE released_at IS NULL AND tenant_id IN (SELECT id FROM tenants WHERE demo_trade = $1)`,
      [trade],
    );
  }

  async function writesFor(phoneHash: string) {
    const [leases, calls, allowance] = await Promise.all([
      pool.query(`SELECT 1 FROM demo_tenant_leases WHERE visitor_phone_hash = $1`, [phoneHash]),
      pool.query(`SELECT 1 FROM demo_calls WHERE phone_hash = $1`, [phoneHash]),
      pool.query<{ n: number }>(
        `SELECT COALESCE(SUM(count), 0)::int AS n FROM phone_rate_limits WHERE tenant_id = $1 AND scope = $2 AND key = $3`,
        [DEMO_PLATFORM_TENANT_ID, DEMO_CALL_ALLOWANCE_SCOPE, phoneHash],
      ),
    ]);
    return { leases: leases.rowCount, calls: calls.rowCount, allowance: allowance.rows[0].n };
  }

  it('leases a demo tenant of the trade with expires_at = leased_at + 70 s, active, unrenewed, a fresh generation', async () => {
    const trade = freshTrade();
    const [tenantId] = await demoTenants(trade, 1);
    const at = new Date(Date.UTC(2030, 4, 6, 7, 8, 9, 123));
    const lease = await inTx((c) => insertLease(c, { trade, phoneHash: `p-${randomUUID()}` }, at));
    expect(lease).not.toBeNull();
    expect(lease!.tenantId).toBe(tenantId);
    expect(lease!.leasedAt.getTime()).toBe(at.getTime());
    expect(lease!.expiresAt.getTime()).toBe(at.getTime() + PRE_LIVE_WINDOW_S * 1000);

    const { rows } = await pool.query(
      `SELECT state, renewed_at, call_sid, released_at, generation, expires_at - leased_at AS window
         FROM demo_tenant_leases WHERE id = $1`,
      [lease!.id],
    );
    expect(rows[0]).toMatchObject({ state: 'active', renewed_at: null, call_sid: null, released_at: null });
    expect(Number(rows[0].generation)).toBe(lease!.generation);
    expect(rows[0].window).toMatchObject({ minutes: 1, seconds: 10 });

    // The generation comes from the sequence: the next lease draws a larger one.
    await releaseAll(trade);
    const next = await inTx((c) => insertLease(c, { trade, phoneHash: `p-${randomUUID()}` }, at));
    expect(next!.generation).toBeGreaterThan(lease!.generation);
  });

  it('never picks a non-demo tenant, the platform tenant, another trade, or a tenant whose lease is active or resetting; a released lease frees it', async () => {
    const trade = freshTrade();
    // A non-demo tenant carrying the trade name, and a demo tenant of another trade.
    const plain = randomUUID();
    await pool.query(
      `INSERT INTO tenants (id, owner_id, owner_email, name, demo_trade) VALUES ($1, $2, 'x@invalid.test', 'Plain', $3)`,
      [plain, `plain:${plain}`, trade],
    );
    await demoTenants(freshTrade(), 1);
    const at = freshDay();
    expect(await inTx((c) => insertLease(c, { trade, phoneHash: `p-${randomUUID()}` }, at))).toBeNull();
    // The platform tenant is not demo, so no trade ever reaches it.
    const platform = await pool.query(`SELECT demo, platform FROM tenants WHERE id = $1`, [DEMO_PLATFORM_TENANT_ID]);
    expect(platform.rows[0]).toEqual({ demo: false, platform: true });

    const [tenantId] = await demoTenants(trade, 1);
    const first = await inTx((c) => insertLease(c, { trade, phoneHash: `p-${randomUUID()}` }, at));
    expect(first!.tenantId).toBe(tenantId);
    expect(await inTx((c) => insertLease(c, { trade, phoneHash: `p-${randomUUID()}` }, at))).toBeNull();

    await pool.query(`UPDATE demo_tenant_leases SET state = 'resetting' WHERE id = $1`, [first!.id]);
    expect(await inTx((c) => insertLease(c, { trade, phoneHash: `p-${randomUUID()}` }, at))).toBeNull();

    await releaseAll(trade);
    const again = await inTx((c) => insertLease(c, { trade, phoneHash: `p-${randomUUID()}` }, at));
    expect(again!.tenantId).toBe(tenantId);
  });

  it('the partial unique indexes reject a second unreleased lease per tenant and per visitor hash', async () => {
    const trade = freshTrade();
    const [t1, t2] = await demoTenants(trade, 2);
    const hash = `p-${randomUUID()}`;
    const expires = new Date(Date.now() + 70_000);
    await pool.query(`INSERT INTO demo_tenant_leases (tenant_id, visitor_phone_hash, expires_at) VALUES ($1, $2, $3)`, [
      t1,
      hash,
      expires,
    ]);
    await expect(
      pool.query(`INSERT INTO demo_tenant_leases (tenant_id, visitor_phone_hash, expires_at) VALUES ($1, $2, $3)`, [
        t1,
        `p-${randomUUID()}`,
        expires,
      ]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'idx_demo_tenant_leases_open_tenant' });
    await expect(
      pool.query(`INSERT INTO demo_tenant_leases (tenant_id, visitor_phone_hash, expires_at) VALUES ($1, $2, $3)`, [
        t2,
        hash,
        expires,
      ]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'idx_demo_tenant_leases_open_visitor' });
    // Released leases do not count.
    await releaseAll(trade);
    await pool.query(`INSERT INTO demo_tenant_leases (tenant_id, visitor_phone_hash, expires_at) VALUES ($1, $2, $3)`, [
      t1,
      hash,
      expires,
    ]);
  });

  it('a visitor who still holds an unreleased lease gets busy, not an error, and keeps the allowance', async () => {
    const trade = freshTrade();
    const [held] = await demoTenants(trade, 2);
    const req = visitor(trade);
    await pool.query(`INSERT INTO demo_tenant_leases (tenant_id, visitor_phone_hash, expires_at) VALUES ($1, $2, $3)`, [
      held,
      req.phoneHash,
      new Date(Date.now() + 70_000),
    ]);
    // Direct: the insert answers null instead of raising 23505.
    expect(await inTx((c) => insertLease(c, { trade, phoneHash: req.phoneHash }, freshDay()))).toBeNull();
    // Through the start transaction: 503 busy, nothing spent.
    const out = await start(req, freshDay());
    expect(out).toEqual({ kind: 'busy', cause: 'pool' });
    expect(await writesFor(req.phoneHash)).toEqual({ leases: 1, calls: 0, allowance: 0 });
  });

  it('two concurrent callers for one trade get distinct tenants, and rows under one are invisible under the other (looped)', async () => {
    const trade = freshTrade();
    const tenants = await demoTenants(trade, 2);
    for (let i = 0; i < 8; i += 1) {
      const at = freshDay();
      const [a, b] = [visitor(trade), visitor(trade)];
      const [ra, rb] = await Promise.all([start(a, at), start(b, at)]);
      expect(ra.kind).toBe('started');
      expect(rb.kind).toBe('started');
      if (ra.kind !== 'started' || rb.kind !== 'started') throw new Error('unreachable');
      expect(ra.call.tenantId).not.toBe(rb.call.tenantId);
      expect(tenants).toContain(ra.call.tenantId);
      expect(tenants).toContain(rb.call.tenantId);

      if (i === 0) {
        // A row written under each leased tenant is not visible under the other's tenant context.
        const leadIds: string[] = [];
        for (const t of [ra.call.tenantId, rb.call.tenantId]) {
          const { rows } = await withTenantSession(pool, t, (c) =>
            c.query<{ id: string }>(
              `INSERT INTO leads (id, tenant_id, source, stage, created_by) VALUES ($1, $2, 'other', 'new', 'demo-lease-test') RETURNING id`,
              [randomUUID(), t],
            ),
          );
          leadIds.push(rows[0].id);
        }
        const seenByB = await withTenantSession(pool, rb.call.tenantId, (c) =>
          c.query(`SELECT 1 FROM leads WHERE id = $1`, [leadIds[0]]),
        );
        const seenByA = await withTenantSession(pool, ra.call.tenantId, (c) =>
          c.query(`SELECT 1 FROM leads WHERE id = $1`, [leadIds[1]]),
        );
        if (process.env.RLS_RUNTIME_ROLE === 'true') {
          expect(seenByB.rowCount).toBe(0);
          expect(seenByA.rowCount).toBe(0);
        }
      }
      await releaseAll(trade);
    }
  });

  it('a pool of N with N + 1 concurrent callers refuses exactly one, which wrote nothing and kept its allowance (looped)', async () => {
    const N = 3;
    const trade = freshTrade();
    await demoTenants(trade, N);
    for (let i = 0; i < 6; i += 1) {
      const at = freshDay();
      const reqs = Array.from({ length: N + 1 }, () => visitor(trade));
      const outs = await Promise.all(reqs.map((r) => start(r, at)));
      const busy = outs.map((o, idx) => ({ o, idx })).filter(({ o }) => o.kind === 'busy');
      expect(busy).toHaveLength(1);
      expect(busy[0].o).toEqual({ kind: 'busy', cause: 'pool' });
      const tenantsTaken = outs.flatMap((o) => (o.kind === 'started' ? [o.call.tenantId] : []));
      expect(new Set(tenantsTaken).size).toBe(N);
      expect(await writesFor(reqs[busy[0].idx].phoneHash)).toEqual({ leases: 0, calls: 0, allowance: 0 });
      await releaseAll(trade);
    }
  });
});
