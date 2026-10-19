import { describe, it, expect, beforeAll } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import {
  PhoneRateLimiter,
  releaseOn,
  tryConsumeOn,
} from '../../src/shared/rate-limit/phone-rate-limit';

describe('Postgres integration — PhoneRateLimiter (P0-036)', () => {
  let pool: Pool;
  let limiter: PhoneRateLimiter;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    limiter = new PhoneRateLimiter(pool);
    tenant = await createTestTenant(pool);
  });

  it('consume → consume → deny (limit=2)', async () => {
    const key = `+1555${Date.now()}`;
    expect(await limiter.tryConsume(tenant.tenantId, 'consume_deny', key, 2, 60_000)).toBe(true);
    expect(await limiter.tryConsume(tenant.tenantId, 'consume_deny', key, 2, 60_000)).toBe(true);
    expect(await limiter.tryConsume(tenant.tenantId, 'consume_deny', key, 2, 60_000)).toBe(false);
  });

  it('window expiry — count resets for the same key after windowMs', async () => {
    const key = `+1555${Date.now()}`;
    // Cutoff uses host Date.now(); window_start uses Postgres NOW(). Under
    // Colima/testcontainers those clocks can diverge by tens–hundreds of ms,
    // so sub-second windows flake both ways (deny never sticks, or never
    // expires). A 1s window + 1.5s wait is still cheap for integration and
    // absorbs realistic skew.
    const windowMs = 1_000;
    expect(await limiter.tryConsume(tenant.tenantId, 'expiry', key, 1, windowMs)).toBe(true);
    expect(await limiter.tryConsume(tenant.tenantId, 'expiry', key, 1, windowMs)).toBe(false);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await limiter.tryConsume(tenant.tenantId, 'expiry', key, 1, windowMs)).toBe(true);
  });

  it('distinct scopes count independently for the same key', async () => {
    const key = `+1555${Date.now()}`;
    expect(await limiter.tryConsume(tenant.tenantId, 'sms_recovery', key, 1, 60_000)).toBe(true);
    // Same key, same limit, different scope — must not be throttled by the above.
    expect(await limiter.tryConsume(tenant.tenantId, 'verify_code', key, 1, 60_000)).toBe(true);
    // Re-consuming within the same scope is denied.
    expect(await limiter.tryConsume(tenant.tenantId, 'sms_recovery', key, 1, 60_000)).toBe(false);
  });

  it('distinct tenants count independently (RLS-isolated)', async () => {
    const other = await createTestTenant(pool);
    const key = `+1555${Date.now()}`;
    expect(await limiter.tryConsume(tenant.tenantId, 'tenant_iso', key, 1, 60_000)).toBe(true);
    // Same scope+key under a different tenant is a separate counter.
    expect(await limiter.tryConsume(other.tenantId, 'tenant_iso', key, 1, 60_000)).toBe(true);
    expect(await limiter.tryConsume(tenant.tenantId, 'tenant_iso', key, 1, 60_000)).toBe(false);
  });

  it('concurrent calls — 10 parallel with limit=3 allow exactly 3', async () => {
    const key = `+1555${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        limiter.tryConsume(tenant.tenantId, 'concurrency', key, 3, 60_000),
      ),
    );
    expect(results.filter((allowed) => allowed)).toHaveLength(3);
  });

  it('limit <= 0 always denies', async () => {
    const key = `+1555${Date.now()}`;
    expect(await limiter.tryConsume(tenant.tenantId, 'zero', key, 0, 60_000)).toBe(false);
  });
});

/**
 * S6-2 (U7 "Allowance", case f; D11). `tryConsumeOn` is the same limiter on a
 * caller's transaction client: the demo start transaction spends the
 * visitor's one-call-a-day allowance in the transaction that also takes the
 * lease and the budget unit, so a rollback must leave the count, and both
 * entry points must share one counter and one advisory-lock string.
 */
describe('Postgres integration — PhoneRateLimiter.tryConsumeOn / releaseOn (S6-2)', () => {
  let pool: Pool;
  let limiter: PhoneRateLimiter;
  let tenant: { tenantId: string; userId: string };

  const DAY = 24 * 60 * 60 * 1000;
  const uniqueKey = () => `+1555${Date.now()}${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    limiter = new PhoneRateLimiter(pool);
    tenant = await createTestTenant(pool);
  });

  async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>, outcome: 'COMMIT' | 'ROLLBACK' = 'COMMIT'): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query(outcome);
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async function countFor(scope: string, key: string): Promise<number> {
    const { rows } = await pool.query<{ total: number }>(
      `SELECT COALESCE(SUM(count), 0)::int AS total FROM phone_rate_limits
        WHERE tenant_id = $1 AND scope = $2 AND key = $3`,
      [tenant.tenantId, scope, key],
    );
    return rows[0].total;
  }

  it('tryConsume and tryConsumeOn over one key share a counter, in both orders', async () => {
    const a = uniqueKey();
    const first = await inTransaction((c) => tryConsumeOn(c, tenant.tenantId, 'shared', a, 1, DAY));
    expect(first.allowed).toBe(true);
    expect(await limiter.tryConsume(tenant.tenantId, 'shared', a, 1, DAY)).toBe(false);

    const b = uniqueKey();
    expect(await limiter.tryConsume(tenant.tenantId, 'shared', b, 1, DAY)).toBe(true);
    const second = await inTransaction((c) => tryConsumeOn(c, tenant.tenantId, 'shared', b, 1, DAY));
    expect(second).toEqual({ allowed: false, windowStart: null });
  });

  it('returns the window_start of the row it wrote, exactly as stored', async () => {
    const key = uniqueKey();
    const now = new Date('2031-03-04T05:06:07.089Z');
    const r = await inTransaction((c) => tryConsumeOn(c, tenant.tenantId, 'window', key, 1, DAY, () => now));
    expect(r.allowed).toBe(true);
    expect(r.windowStart?.toISOString()).toBe('2031-03-04T05:06:07.089Z');
    const { rows } = await pool.query<{ window_start: Date }>(
      `SELECT window_start FROM phone_rate_limits WHERE tenant_id = $1 AND scope = 'window' AND key = $2`,
      [tenant.tenantId, key],
    );
    expect(rows.map((row) => row.window_start.toISOString())).toEqual(['2031-03-04T05:06:07.089Z']);
  });

  it('tryConsumeOn on a client that then rolls back leaves the count unchanged', async () => {
    const key = uniqueKey();
    const r = await inTransaction((c) => tryConsumeOn(c, tenant.tenantId, 'rollback', key, 1, DAY), 'ROLLBACK');
    expect(r.allowed).toBe(true);
    expect(await countFor('rollback', key)).toBe(0);
    expect(await limiter.tryConsume(tenant.tenantId, 'rollback', key, 1, DAY)).toBe(true);
  });

  it('both entry points take the advisory lock on the same <tenantId>:<scope>:<key> string', async () => {
    const key = uniqueKey();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      expect((await tryConsumeOn(holder, tenant.tenantId, 'lock', key, 1, DAY)).allowed).toBe(true);

      // tryConsume must now wait on holder's xact lock, then see its row.
      const waiting = limiter.tryConsume(tenant.tenantId, 'lock', key, 1, DAY);
      const lockKey = `${tenant.tenantId}:lock:${key}`;
      let waited = false;
      for (let i = 0; i < 100 && !waited; i++) {
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND objid = (hashtext($1)::bigint & 4294967295)::oid`,
          [lockKey],
        );
        waited = rows[0].n > 0;
        if (!waited) await new Promise((r) => { setTimeout(r, 20); });
      }
      expect(waited).toBe(true);
      await holder.query('COMMIT');
      expect(await waiting).toBe(false);
    } finally {
      holder.release();
    }
  });

  it('10 parallel callers at limit 3 allow exactly 3 through tryConsumeOn, and mixed with tryConsume', async () => {
    const key = uniqueKey();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        inTransaction((c) => tryConsumeOn(c, tenant.tenantId, 'parallel_on', key, 3, DAY)),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);

    const mixedKey = uniqueKey();
    const mixed = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0
          ? inTransaction((c) => tryConsumeOn(c, tenant.tenantId, 'parallel_mixed', mixedKey, 3, DAY)).then((r) => r.allowed)
          : limiter.tryConsume(tenant.tenantId, 'parallel_mixed', mixedKey, 3, DAY),
      ),
    );
    expect(mixed.filter(Boolean)).toHaveLength(3);
    expect(await countFor('parallel_mixed', mixedKey)).toBe(3);
  });

  it('limit <= 0 denies without writing', async () => {
    const key = uniqueKey();
    const r = await inTransaction((c) => tryConsumeOn(c, tenant.tenantId, 'zero_on', key, 0, DAY));
    expect(r).toEqual({ allowed: false, windowStart: null });
    expect(await countFor('zero_on', key)).toBe(0);
  });

  it('releaseOn returns one allowance on that window once, never below zero (D11)', async () => {
    const key = uniqueKey();
    const r = await inTransaction((c) => tryConsumeOn(c, tenant.tenantId, 'release', key, 1, DAY));
    expect(await limiter.tryConsume(tenant.tenantId, 'release', key, 1, DAY)).toBe(false);

    expect(await inTransaction((c) => releaseOn(c, tenant.tenantId, 'release', key, r.windowStart!))).toBe(true);
    expect(await countFor('release', key)).toBe(0);
    // A second release on the same window finds count = 0 and changes nothing.
    expect(await inTransaction((c) => releaseOn(c, tenant.tenantId, 'release', key, r.windowStart!))).toBe(false);
    expect(await countFor('release', key)).toBe(0);
    // The same-day retry is free again.
    expect(await limiter.tryConsume(tenant.tenantId, 'release', key, 1, DAY)).toBe(true);
  });

  it('releaseOn touches only its own tenant, scope, key and window', async () => {
    const other = await createTestTenant(pool);
    const key = uniqueKey();
    const mine = await inTransaction((c) => tryConsumeOn(c, tenant.tenantId, 'release_iso', key, 5, DAY));
    await inTransaction((c) => tryConsumeOn(c, other.tenantId, 'release_iso', key, 5, DAY));
    await inTransaction((c) => tryConsumeOn(c, tenant.tenantId, 'release_iso_other', key, 5, DAY));

    expect(await inTransaction((c) => releaseOn(c, tenant.tenantId, 'release_iso', key, new Date(mine.windowStart!.getTime() + 1)))).toBe(false);
    expect(await inTransaction((c) => releaseOn(c, tenant.tenantId, 'release_iso', key, mine.windowStart!))).toBe(true);
    const { rows } = await pool.query<{ tenant_id: string; scope: string; count: number }>(
      `SELECT tenant_id, scope, count FROM phone_rate_limits WHERE key = $1 ORDER BY scope, tenant_id`,
      [key],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { tenant_id: tenant.tenantId, scope: 'release_iso', count: 0 },
        { tenant_id: other.tenantId, scope: 'release_iso', count: 1 },
        { tenant_id: tenant.tenantId, scope: 'release_iso_other', count: 1 },
      ]),
    );
  });
});
