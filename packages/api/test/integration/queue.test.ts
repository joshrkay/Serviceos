/**
 * Postgres integration — PgQueue (SELECT ... FOR UPDATE SKIP LOCKED).
 *
 * The Postgres-backed queue underpins the async worker pattern but was only
 * covered by the in-memory queue's unit tests. This exercises the real DDL,
 * idempotent enqueue (ON CONFLICT), visibility/attempt accounting, the
 * max-attempts cutoff, and the dead-letter move. The queue is global, so each
 * test starts from a clean table.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { PgQueue } from '../../src/queues/pg-queue';

describe('Postgres integration — PgQueue', () => {
  let pool: Pool;
  let queue: PgQueue;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    queue = new PgQueue(pool);
    // Force lazy table creation so the per-test cleanup below has tables to hit.
    await queue.send('warmup', { ok: true });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM _queue_messages');
    await pool.query('DELETE FROM _queue_dlq');
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('send then receive returns the enqueued message', async () => {
    const id = await queue.send('email.send', { to: 'a@example.com' });
    const msg = await queue.receive<{ to: string }>();
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe(id);
    expect(msg!.type).toBe('email.send');
    expect(msg!.payload).toEqual({ to: 'a@example.com' });
    expect(msg!.attempts).toBe(1); // receive increments the attempt counter
  });

  it('returns null when no message is visible', async () => {
    expect(await queue.receive()).toBeNull();
  });

  it('dedupes on idempotency key (ON CONFLICT DO NOTHING)', async () => {
    await queue.send('job.run', { n: 1 }, 'dup-key');
    await queue.send('job.run', { n: 2 }, 'dup-key');
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM _queue_messages');
    expect(rows[0].c).toBe(1);
  });

  it('hides a received message for the visibility timeout', async () => {
    await queue.send('slow.task', {});
    const first = await queue.receive();
    expect(first).not.toBeNull();
    // Default visibility timeout is 30s, so an immediate re-receive sees nothing.
    expect(await queue.receive()).toBeNull();
  });

  it('stops delivering once attempts reach max_attempts', async () => {
    // visibilityTimeout 0 makes the message immediately visible again, so we
    // can drive it to the attempt cap within the test.
    const retryQueue = new PgQueue(pool, { maxRetries: 2, visibilityTimeout: 0 });
    await retryQueue.send('retry.me', {});
    expect(await retryQueue.receive()).not.toBeNull(); // attempts 0 -> 1
    expect(await retryQueue.receive()).not.toBeNull(); // attempts 1 -> 2
    expect(await retryQueue.receive()).toBeNull(); // attempts == max, no longer eligible
  });

  it('delete removes a message so it is never delivered', async () => {
    const id = await queue.send('one.shot', {});
    await queue.delete(id);
    expect(await queue.receive()).toBeNull();
  });

  it('moveToDeadLetter relocates a message and listDeadLetter returns it', async () => {
    await queue.send('bad.job', { broken: true }, 'dlq-key');
    const msg = await queue.receive();
    expect(msg).not.toBeNull();

    await queue.moveToDeadLetter(msg!, 'handler threw: boom');

    // Removed from the live queue...
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM _queue_messages');
    expect(rows[0].c).toBe(0);

    // ...and recorded in the dead-letter table.
    const dlq = await queue.listDeadLetter();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].messageId).toBe(msg!.id);
    expect(dlq[0].type).toBe('bad.job');
    expect(dlq[0].idempotencyKey).toBe('dlq-key');
    expect(dlq[0].error).toBe('handler threw: boom');
  });

  it('moveToDeadLetter is idempotent on message_id', async () => {
    await queue.send('twice', {}, 'twice-key');
    const msg = await queue.receive();
    await queue.moveToDeadLetter(msg!, 'first');
    await queue.moveToDeadLetter(msg!, 'second');
    const dlq = await queue.listDeadLetter();
    expect(dlq.filter((d) => d.messageId === msg!.id)).toHaveLength(1);
  });

  it('receiveBatch claims up to N oldest messages, disjointly (P3)', async () => {
    for (let i = 0; i < 5; i++) await queue.send('batch.job', { i }, `b-${i}`);

    const first = await queue.receiveBatch<{ i: number }>(3);
    expect(first.map((m) => m.payload.i)).toEqual([0, 1, 2]); // oldest-first

    // The remaining batch is disjoint — no message is delivered twice.
    const second = await queue.receiveBatch<{ i: number }>(3);
    expect(second.map((m) => m.payload.i)).toEqual([3, 4]);
    const ids = new Set([...first, ...second].map((m) => m.id));
    expect(ids.size).toBe(5);

    expect(await queue.receiveBatch(3)).toEqual([]); // all claimed (now invisible)
  });

  it('two concurrent receiveBatch calls split the work with no overlap (SKIP LOCKED)', async () => {
    for (let i = 0; i < 6; i++) await queue.send('concurrent.job', { i });

    // Two batches racing on one table must partition the rows, never double-claim.
    const [a, b] = await Promise.all([queue.receiveBatch(6), queue.receiveBatch(6)]);
    const ids = [...a, ...b].map((m) => m.id);
    expect(ids.length).toBe(6);
    expect(new Set(ids).size).toBe(6); // disjoint
  });

  // scale-to-1000 C1 — depth() feeds the pg_queue_depth gauge + P2 alert.
  it('depth() counts the pending backlog and the dead-letter queue', async () => {
    expect(await queue.depth()).toEqual({ pending: 0, deadLetter: 0 });

    for (let i = 0; i < 4; i++) await queue.send('depth.job', { i }, `d-${i}`);
    // Claiming does NOT remove rows (they stay in the table, invisible), so they
    // remain part of the backlog until delete()/DLQ — depth still counts them.
    const claimed = await queue.receiveBatch<{ i: number }>(2);
    expect((await queue.depth()).pending).toBe(4);

    // Move one claimed message to the DLQ: pending drops by one, deadLetter rises.
    await queue.moveToDeadLetter(claimed[0], 'boom');
    const d = await queue.depth();
    expect(d).toEqual({ pending: 3, deadLetter: 1 });

    // delete() removes from the backlog entirely.
    await queue.delete(claimed[1].id);
    expect((await queue.depth()).pending).toBe(2);
  });

  describe('T4-F10 — recordFailure persists the real handler error', () => {
    it('recordFailure sets last_error on the real _queue_messages row', async () => {
      const id = await queue.send('flaky.job', { n: 1 }, 'flaky-key-1');
      await queue.receive(); // attempts 0 -> 1

      await queue.recordFailure(id, 'handler threw: connection refused');

      const { rows } = await pool.query<{ last_error: string | null }>(
        'SELECT last_error FROM _queue_messages WHERE id = $1',
        [id],
      );
      expect(rows[0].last_error).toBe('handler threw: connection refused');
    });

    it('recordFailure is a no-op (never throws) once the message row is gone', async () => {
      const id = await queue.send('one.shot.fail', {}, 'one-shot-fail-key');
      await queue.delete(id);
      await expect(queue.recordFailure(id, 'too late')).resolves.toBeUndefined();
    });

    it('end-to-end: fail-then-exhaust-then-DLQ ends with the DLQ error matching the real thrown message, not a hardcoded constant', async () => {
      // maxRetries: 1 + a normal (nonzero) visibilityTimeout so the single
      // receive() below both claims the message AND exhausts it in one
      // step, without racing PgQueue's own crash-orphan reaper (which runs
      // inside every receiveBatch call and would otherwise reap an
      // already-exhausted, immediately-revisible row before this test gets
      // to call recordFailure/moveToDeadLetter on it — a visibilityTimeout:
      // 0 artifact unrelated to what this test is proving).
      const singleAttemptQueue = new PgQueue(pool, { maxRetries: 1, visibilityTimeout: 30 });
      const id = await singleAttemptQueue.send('exhausting.job', { n: 1 }, 'exhaust-key-1');

      const msg = await singleAttemptQueue.receive();
      expect(msg).not.toBeNull();
      expect(msg!.attempts).toBe(1);
      expect(msg!.maxAttempts).toBe(1);

      // Mirrors app.ts's handleQueueMessage: processMessage's real error is
      // persisted via recordFailure BEFORE the maxAttempts check.
      const realError = 'ECONNRESET: handler threw on the only attempt';
      await singleAttemptQueue.recordFailure(id, realError);

      const row = await pool.query<{ last_error: string | null }>(
        'SELECT last_error FROM _queue_messages WHERE id = $1',
        [id],
      );
      expect(row.rows[0].last_error).toBe(realError);

      // attempts (1) >= maxAttempts (1) — the real caller now passes the
      // real error into moveToDeadLetter instead of a hardcoded string.
      await singleAttemptQueue.moveToDeadLetter(msg!, realError);

      const dlq = await singleAttemptQueue.listDeadLetter();
      const ours = dlq.find((d) => d.messageId === id);
      expect(ours?.error).toBe(realError);
      expect(ours?.error).not.toBe('max attempts exceeded');

      // The message row is gone — no lingering _queue_messages entry.
      const remaining = await pool.query('SELECT 1 FROM _queue_messages WHERE id = $1', [id]);
      expect(remaining.rows).toHaveLength(0);
    });
  });

  // Codex P2 (PR #705, round 3) — the crash-orphan reaper must carry the real
  // recorded failure to the DLQ, not overwrite it with the hardcoded orphan
  // text. The exact crash it handles is "worker persisted last_error on its
  // final attempt, then died before moveToDeadLetter".
  describe('crash-orphan reaper preserves the recorded failure', () => {
    it('reaps an orphan with its real last_error (not the hardcoded orphan text)', async () => {
      const singleAttemptQueue = new PgQueue(pool, { maxRetries: 1, visibilityTimeout: 30 });
      const id = await singleAttemptQueue.send('orphan.job', { n: 1 }, 'orphan-key-1');

      const msg = await singleAttemptQueue.receive(); // attempts 0 -> 1 (== max)
      expect(msg!.attempts).toBe(1);

      // Worker records the real failure on its final attempt, then CRASHES
      // before moveToDeadLetter — the row is orphaned in _queue_messages.
      const realError = 'ETIMEDOUT: handler died on the final attempt';
      await singleAttemptQueue.recordFailure(id, realError);

      // Simulate the visibility timeout elapsing so the reaper considers it.
      await pool.query(
        "UPDATE _queue_messages SET visible_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
        [id],
      );

      // Any receiveBatch runs the reaper; the orphan lands in the DLQ carrying
      // the real handler error.
      await singleAttemptQueue.receive();

      const dlq = await singleAttemptQueue.listDeadLetter();
      const ours = dlq.find((d) => d.messageId === id);
      expect(ours?.error).toBe(realError);
      expect(ours?.error).not.toMatch(/orphaned: attempts exhausted/);

      // Row is gone from _queue_messages (reaped, not left stuck).
      const remaining = await pool.query('SELECT 1 FROM _queue_messages WHERE id = $1', [id]);
      expect(remaining.rows).toHaveLength(0);
    });

    it('falls back to the hardcoded orphan text when no last_error was ever recorded', async () => {
      const singleAttemptQueue = new PgQueue(pool, { maxRetries: 1, visibilityTimeout: 30 });
      const id = await singleAttemptQueue.send('orphan.job.nofail', {}, 'orphan-key-2');

      const msg = await singleAttemptQueue.receive(); // attempts -> 1, no recordFailure
      expect(msg!.attempts).toBe(1);

      await pool.query(
        "UPDATE _queue_messages SET visible_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
        [id],
      );
      await singleAttemptQueue.receive(); // reaper runs

      const dlq = await singleAttemptQueue.listDeadLetter();
      const ours = dlq.find((d) => d.messageId === id);
      expect(ours?.error).toMatch(/orphaned: attempts exhausted without completion/);
    });
  });
});
