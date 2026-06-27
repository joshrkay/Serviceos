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
});
