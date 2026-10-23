/**
 * Postgres integration — PgQueue claims are LIMIT-exact under a rescanning plan.
 *
 * `receiveBatch` used to claim with
 *   UPDATE … WHERE id IN (SELECT id … FOR UPDATE SKIP LOCKED LIMIT n)
 * Postgres may run that IN-subquery as the rescanned inner side of a nested
 * loop semi join. Each rescan re-runs LockRows → Limit, and LockRows skips the
 * rows this same UPDATE has already modified, so every rescan hands out the
 * NEXT n rows: `receiveBatch(3)` over five due messages claimed all five (seen
 * as a full-suite flake of queue.test.ts — `[0,1,2,3,4]` for a batch of 3 —
 * and it bumps attempts/visible_at on messages the caller never sized for).
 * The orphan DLQ reap right after it had the same shape (`DELETE … WHERE id
 * IN (… LIMIT 10)`), so a tick could reap past its per-tick bound.
 *
 * The planner picks that plan when its statistics say the table is tiny — an
 * autoanalyze while the table was nearly empty, then a burst of sends. Each
 * test here reproduces that deterministically: one row, ANALYZE (planner now
 * believes one row), then the rest. The queue under test also runs on its own
 * pool with hash join, merge join and materialize disabled, so the only joins
 * left to the planner are the nested loop ones. The controls prove the forced
 * plan really is the rescanning one and really over-claims with the old
 * statement shapes, so the PgQueue assertions can never pass vacuously.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { PgQueue } from '../../src/queues/pg-queue';

/** Per-connection planner settings that leave the planner only nested loop joins with an unmaterialized inner side. */
const RESCAN_PLAN_OPTIONS = '-c enable_hashjoin=off -c enable_mergejoin=off -c enable_material=off';

/** The claim statement `receiveBatch` ran before the fix, verbatim (control only). */
const IN_SUBQUERY_CLAIM = `UPDATE _queue_messages
   SET attempts = attempts + 1,
       visible_at = NOW() + (LEAST($1::float * POWER(2, attempts), $2)::int || ' seconds')::interval
   WHERE id IN (
     SELECT id FROM _queue_messages
     WHERE visible_at <= NOW()
       AND attempts < max_attempts
     ORDER BY created_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT $3
   )
   RETURNING *`;

/** The orphan reap `receiveBatch` ran before the fix, verbatim (control only). */
const IN_SUBQUERY_REAP = `DELETE FROM _queue_messages
   WHERE id IN (
     SELECT id FROM _queue_messages
     WHERE visible_at <= NOW()
       AND attempts >= max_attempts
     ORDER BY created_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 10
   )
   RETURNING *`;

interface PlanNode {
  'Node Type': string;
  'Parent Relationship'?: string;
  Plans?: PlanNode[];
}

function contains(node: PlanNode, nodeType: string): boolean {
  return node['Node Type'] === nodeType || (node.Plans ?? []).some((p) => contains(p, nodeType));
}

/** True when some nested loop re-executes a LockRows node once per outer row. */
function rescansLockRows(node: PlanNode): boolean {
  if (node['Node Type'] === 'Nested Loop') {
    const inner = node.Plans?.find((p) => p['Parent Relationship'] === 'Inner');
    if (inner && contains(inner, 'LockRows')) return true;
  }
  return (node.Plans ?? []).some(rescansLockRows);
}

describe('Postgres integration — PgQueue claims stay LIMIT-exact under a rescanning plan', () => {
  let pool: Pool;
  let forcedPool: Pool;
  let queue: PgQueue;

  async function analyzeQueueTable(): Promise<void> {
    await pool.query('ANALYZE _queue_messages');
  }

  async function enqueue(i: number): Promise<void> {
    await queue.send('rescan.job', { i }, `rescan-${i}`);
  }

  /** A message whose final attempt's worker died: attempts == max_attempts, visibility lapsed. */
  async function insertOrphan(i: number): Promise<void> {
    await pool.query(
      `INSERT INTO _queue_messages (id, type, payload, attempts, max_attempts, idempotency_key, visible_at, created_at)
       VALUES (gen_random_uuid(), 'orphan.job', $1, 3, 3, $2, NOW() - interval '1 second', NOW())`,
      [JSON.stringify({ i }), `orphan-${i}`],
    );
  }

  /** Five due messages, planned as if the table held one. */
  async function seedFiveDueWithOneRowStats(): Promise<void> {
    await enqueue(0);
    await analyzeQueueTable();
    for (let i = 1; i < 5; i++) await enqueue(i);
  }

  /** Twelve orphans, planned as if the table held one. */
  async function seedTwelveOrphansWithOneRowStats(): Promise<void> {
    await insertOrphan(0);
    await analyzeQueueTable();
    for (let i = 1; i < 12; i++) await insertOrphan(i);
  }

  async function explain(sql: string, params: unknown[]): Promise<PlanNode> {
    const { rows } = await forcedPool.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return (rows[0]['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0].Plan;
  }

  /** Run a statement on the forced-plan pool and roll it back; returns how many rows it touched. */
  async function rowsTouchedThenRollBack(sql: string, params: unknown[]): Promise<number> {
    const client = await forcedPool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(sql, params);
      return res.rowCount ?? 0;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    forcedPool = new Pool({ connectionString: process.env.TEST_DB_URL, options: RESCAN_PLAN_OPTIONS });
    queue = new PgQueue(forcedPool);
    // Bootstrap the tables before the per-test TRUNCATE.
    await queue.send('warmup', { ok: true });
  });

  beforeEach(async () => {
    // TRUNCATE (not DELETE) so every test starts from a fresh one-page heap
    // with never-analyzed statistics; each test then plants its own.
    await pool.query('TRUNCATE _queue_messages, _queue_dlq');
  });

  afterAll(async () => {
    // Leave the queue empty for later files (see queue.test.ts) and drop the
    // planted one-row statistics: TRUNCATE resets them to never-analyzed.
    await pool.query('TRUNCATE _queue_messages, _queue_dlq');
    await forcedPool.end();
    await closeSharedTestDb();
  });

  it('control: the forced plan rescans the IN-subquery claim and over-claims with it', async () => {
    await seedFiveDueWithOneRowStats();
    const params = ['30', '900', 3];

    expect(rescansLockRows(await explain(IN_SUBQUERY_CLAIM, params))).toBe(true);
    expect(await rowsTouchedThenRollBack(IN_SUBQUERY_CLAIM, params)).toBe(5);
  });

  it('receiveBatch(3) claims exactly the 3 oldest and leaves the rest untouched', async () => {
    await seedFiveDueWithOneRowStats();

    const first = await queue.receiveBatch<{ i: number }>(3);
    expect(first.map((m) => m.payload.i)).toEqual([0, 1, 2]);

    // The two messages outside the batch were never claimed: no attempt spent,
    // still visible now.
    const { rows } = await pool.query<{ i: number; attempts: number; due: boolean }>(
      `SELECT (payload->>'i')::int AS i, attempts, visible_at <= NOW() AS due
         FROM _queue_messages ORDER BY created_at ASC`,
    );
    expect(rows).toEqual([
      { i: 0, attempts: 1, due: false },
      { i: 1, attempts: 1, due: false },
      { i: 2, attempts: 1, due: false },
      { i: 3, attempts: 0, due: true },
      { i: 4, attempts: 0, due: true },
    ]);

    const second = await queue.receiveBatch<{ i: number }>(3);
    expect(second.map((m) => m.payload.i)).toEqual([3, 4]);
  });

  it('control: the forced plan rescans the IN-subquery orphan reap and reaps past its bound', async () => {
    await seedTwelveOrphansWithOneRowStats();

    expect(rescansLockRows(await explain(IN_SUBQUERY_REAP, []))).toBe(true);
    expect(await rowsTouchedThenRollBack(IN_SUBQUERY_REAP, [])).toBe(12);
  });

  it('a receiveBatch tick dead-letters at most 10 orphans, oldest first', async () => {
    await seedTwelveOrphansWithOneRowStats();

    expect(await queue.receiveBatch(5)).toEqual([]); // orphans are never claimable
    const firstTick = (await queue.listDeadLetter()).map((d) => d.idempotencyKey);
    expect(firstTick.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `orphan-${i}`).sort());
    const { rows } = await pool.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM _queue_messages ORDER BY created_at ASC',
    );
    expect(rows.map((r) => r.idempotency_key)).toEqual(['orphan-10', 'orphan-11']);

    // The next tick reaps the rest.
    expect(await queue.receiveBatch(5)).toEqual([]);
    expect(await queue.depth()).toEqual({ pending: 0, deadLetter: 12 });
  });
});
