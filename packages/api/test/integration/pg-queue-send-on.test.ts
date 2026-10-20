/**
 * Postgres integration — S5a-3 (U8): `PgQueue.sendOn`, the enqueue that joins
 * the CALLER's open transaction.
 *
 * The payment-mode switch must write its cleanup job row in the same
 * transaction as the settings row (S5a-5), so a rolled-back switch leaves no
 * job and a committed one always has one. `sendOn(client, …)` runs the same
 * `INSERT … ON CONFLICT (idempotency_key) DO NOTHING` as `send`, on the
 * supplied client, with no BEGIN/COMMIT of its own. The `_queue_messages`
 * bootstrap (CREATE TABLE IF NOT EXISTS) runs on the queue's OWN connection
 * first — DDL inside the caller's transaction would be rolled back with it.
 *
 * Fresh database: this file drops `_queue_messages` / `_queue_dlq` first, so
 * the first `sendOn` really bootstraps them; afterAll leaves both tables
 * existing and empty (the shared DB outlives this file; `queue.test.ts`
 * documents why the queue must be left empty).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, closeSharedTestDb, createTestTenant } from './shared';
import { PgQueue } from '../../src/queues/pg-queue';
import { applyTenantContext, clearTenantContext } from '../../src/db/rls-runtime-role';

/** A Pool stand-in that hands out REAL clients from the shared pool and logs every statement per connection. */
function spyingPool(real: Pool) {
  const statements: Array<{ conn: number; sql: string }> = [];
  let connects = 0;
  const pool = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async () => {
          const conn = ++connects;
          const client = await target.connect();
          return spyClient(client, conn, statements);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { pool, statements, connectCount: () => connects };
}

function spyClient(client: PoolClient, conn: number, log: Array<{ conn: number; sql: string }>): PoolClient {
  const original = client.query.bind(client) as (...args: unknown[]) => unknown;
  (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
    const first = args[0];
    log.push({ conn, sql: typeof first === 'string' ? first : String((first as { text?: string })?.text ?? '') });
    return original(...args);
  };
  return client;
}

const isDdl = (sql: string) => /\b(CREATE|ALTER)\s+TABLE\b/i.test(sql);

describe('Postgres integration — PgQueue.sendOn joins the caller transaction (S5a-3 / U8)', () => {
  let pool: Pool;

  async function rowCount(key: string): Promise<number> {
    const { rows } = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM _queue_messages WHERE idempotency_key = $1`,
      [key],
    );
    return rows[0].c;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    await pool.query('DROP TABLE IF EXISTS _queue_messages');
    await pool.query('DROP TABLE IF EXISTS _queue_dlq');
  });

  beforeEach(async () => {
    const exists = await pool.query<{ t: string | null }>(`SELECT to_regclass('public._queue_messages')::text AS t`);
    if (exists.rows[0].t) await pool.query('DELETE FROM _queue_messages');
  });

  afterAll(async () => {
    // Leave the tables existing and empty for later files.
    await new PgQueue(pool).send('s5a3.warmup', {}, 's5a3-warmup');
    await pool.query('DELETE FROM _queue_messages');
    await pool.query('DELETE FROM _queue_dlq');
    await closeSharedTestDb();
  });

  it('fresh database: the bootstrap runs on the queue\'s own connection, so a ROLLBACK of the caller leaves the table and no row', async () => {
    expect((await pool.query(`SELECT to_regclass('public._queue_messages')::text AS t`)).rows[0].t).toBeNull();
    const spy = spyingPool(pool);
    const queue = new PgQueue(spy.pool);

    const caller = await pool.connect();
    const callerLog: Array<{ conn: number; sql: string }> = [];
    const callerClient = spyClient(caller, 0, callerLog);
    try {
      await callerClient.query('BEGIN');
      await queue.sendOn(callerClient, 'deactivate_payment_links', { tenantId: 't' }, 's5a3-fresh-rollback');
      await callerClient.query('ROLLBACK');
    } finally {
      caller.release();
    }

    // The caller's transaction issued no DDL — only its own BEGIN, the
    // INSERT, and its ROLLBACK.
    expect(callerLog.filter((s) => isDdl(s.sql))).toEqual([]);
    expect(callerLog.map((s) => s.sql.trim().split(/\s+/)[0].toUpperCase())).toEqual(['BEGIN', 'INSERT', 'ROLLBACK']);
    // The bootstrap ran on a connection the queue took for itself.
    expect(spy.statements.filter((s) => isDdl(s.sql)).length).toBeGreaterThanOrEqual(2);
    expect(spy.connectCount()).toBe(1);
    // DDL survived the caller's ROLLBACK; the row did not.
    expect((await pool.query(`SELECT to_regclass('public._queue_messages')::text AS t`)).rows[0].t).toBe('_queue_messages');
    expect(await rowCount('s5a3-fresh-rollback')).toBe(0);
  });

  it('a second connection sees no row until COMMIT, then exactly one, received with its type, payload and key', async () => {
    const queue = new PgQueue(pool);
    const caller = await pool.connect();
    try {
      await caller.query('BEGIN');
      await queue.sendOn(caller, 'deactivate_payment_links', { tenantId: 't', pass: 1 }, 's5a3-commit');
      expect(await rowCount('s5a3-commit')).toBe(0); // the pool is a different connection
      expect(await queue.receive()).toBeNull();
      await caller.query('COMMIT');
    } finally {
      caller.release();
    }
    expect(await rowCount('s5a3-commit')).toBe(1);
    const msg = await queue.receive<{ tenantId: string; pass: number }>();
    expect(msg).toMatchObject({
      type: 'deactivate_payment_links',
      payload: { tenantId: 't', pass: 1 },
      idempotencyKey: 's5a3-commit',
      attempts: 1,
    });
  });

  it('sendOn of a key that already exists inserts nothing and resolves (pending row, and twice in one transaction)', async () => {
    const queue = new PgQueue(pool);
    await queue.send('deactivate_payment_links', { first: true }, 's5a3-dup');
    const caller = await pool.connect();
    try {
      await caller.query('BEGIN');
      await expect(
        queue.sendOn(caller, 'deactivate_payment_links', { first: false }, 's5a3-dup'),
      ).resolves.toEqual(expect.any(String));
      await queue.sendOn(caller, 'deactivate_payment_links', { n: 1 }, 's5a3-dup-tx');
      await queue.sendOn(caller, 'deactivate_payment_links', { n: 2 }, 's5a3-dup-tx');
      await caller.query('COMMIT');
    } finally {
      caller.release();
    }
    const { rows } = await pool.query<{ idempotency_key: string; payload: Record<string, unknown> }>(
      `SELECT idempotency_key, payload FROM _queue_messages WHERE idempotency_key LIKE 's5a3-dup%' ORDER BY idempotency_key`,
    );
    expect(rows).toEqual([
      { idempotency_key: 's5a3-dup', payload: { first: true } },
      { idempotency_key: 's5a3-dup-tx', payload: { n: 1 } },
    ]);
  });

  it('delaySeconds maps to visible_at (the pass-2 follow-up is a delayed row, invisible until due)', async () => {
    const queue = new PgQueue(pool);
    const caller = await pool.connect();
    try {
      await caller.query('BEGIN');
      await queue.sendOn(caller, 'deactivate_payment_links', { pass: 2 }, 's5a3-delay', { delaySeconds: 120 });
      await caller.query('COMMIT');
    } finally {
      caller.release();
    }
    const { rows } = await pool.query<{ delay: number }>(
      `SELECT EXTRACT(EPOCH FROM (visible_at - created_at))::float AS delay
         FROM _queue_messages WHERE idempotency_key = 's5a3-delay'`,
    );
    expect(rows[0].delay).toBeGreaterThanOrEqual(119);
    expect(rows[0].delay).toBeLessThanOrEqual(121);
    expect(await queue.receive()).toBeNull();
  });

  it('works on a tenant-scoped transaction (RLS runtime role), and once bootstrapped takes no connection of its own', async () => {
    const tenant = await createTestTenant(pool);
    const spy = spyingPool(pool);
    const queue = new PgQueue(spy.pool);
    // First use bootstraps (one connection); the steady state takes none, so a
    // caller holding the last pool connection can never wait on itself.
    await queue.send('s5a3.bootstrap', {}, 's5a3-bootstrap');
    const afterBootstrap = spy.connectCount();

    const caller = await pool.connect();
    try {
      await caller.query('BEGIN');
      await applyTenantContext(caller, tenant.tenantId, { transactional: true });
      if (process.env.RLS_RUNTIME_ROLE === 'true') {
        expect((await caller.query<{ u: string }>('SELECT current_user AS u')).rows[0].u).toBe('rls_app_runtime');
      }
      await queue.sendOn(caller, 'deactivate_payment_links', { tenantId: tenant.tenantId }, 's5a3-tenant');
      await caller.query('COMMIT');
    } finally {
      await clearTenantContext(caller);
      caller.release();
    }
    expect(spy.connectCount()).toBe(afterBootstrap);
    expect(await rowCount('s5a3-tenant')).toBe(1);
  });
});
