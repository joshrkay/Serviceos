import { describe, it, expect, beforeAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb } from './shared';
import { PgIdempotencyLockProvider } from '../../src/proposals/execution/idempotency-lock';

/**
 * U2a gate — session-scoped Postgres locks must keep working on a DIRECT
 * (non-PgBouncer) connection. Under PgBouncer transaction-mode pooling these
 * would break (lock acquired on one backend, released on another), which is why
 * leader election (`app.ts` runAsLeader) and the proposal idempotency lock are
 * routed to the direct pool. These tests pin the invariants those mechanisms
 * rely on against a real Postgres (the shared test pool connects directly to PG,
 * mirroring the production direct DSN).
 *
 * Runs in PR CI via `npm run test:integration` (Docker-gated).
 */
describe('session-scoped DB locks (direct-connection semantics)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  it('leader election: a session advisory lock is held by exactly one connection at a time', async () => {
    const key = 99_000_777;
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      const r1 = await a.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
      expect(r1.rows[0].locked).toBe(true); // A becomes leader

      const r2 = await b.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
      expect(r2.rows[0].locked).toBe(false); // B cannot — A still holds it (same backend)

      // The unlock MUST run on the same connection that holds the lock — this is
      // exactly why runAsLeader needs a stable (direct) connection.
      await a.query('SELECT pg_advisory_unlock($1)', [key]);

      const r3 = await b.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
      expect(r3.rows[0].locked).toBe(true); // now B can take leadership
      await b.query('SELECT pg_advisory_unlock($1)', [key]);
    } finally {
      a.release();
      b.release();
    }
  });

  it('idempotency lock serializes concurrent same-key work (no double execution)', async () => {
    const lock = new PgIdempotencyLockProvider(pool);
    const order: string[] = [];
    const tenant = 'tenant-x';
    const key = 'proposal-run:tenant-x:abc';
    const run = (label: string) =>
      lock.withLock(tenant, key, async () => {
        order.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, 50));
        order.push(`${label}:end`);
      });

    await Promise.all([run('A'), run('B')]);

    const aStart = order.indexOf('A:start');
    const aEnd = order.indexOf('A:end');
    const bStart = order.indexOf('B:start');
    const bEnd = order.indexOf('B:end');
    // One holder must fully finish before the other starts — never interleaved.
    const serialized = aEnd < bStart || bEnd < aStart;
    expect(serialized, `interleaved execution: ${order.join(',')}`).toBe(true);
  });

  it('idempotency lock runs DIFFERENT keys concurrently (no false contention)', async () => {
    const lock = new PgIdempotencyLockProvider(pool);
    const order: string[] = [];
    const run = (label: string, key: string) =>
      lock.withLock('t', key, async () => {
        order.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, 50));
        order.push(`${label}:end`);
      });

    await Promise.all([run('A', 'k1'), run('B', 'k2')]);

    // Distinct keys → distinct locks → both acquire immediately and interleave.
    const bothStartedBeforeEither = order.slice(0, 2).every((s) => s.endsWith(':start'));
    expect(bothStartedBeforeEither, `did not run concurrently: ${order.join(',')}`).toBe(true);
  });
});
