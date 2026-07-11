import { vi } from 'vitest';
import { InMemoryQueue, processMessage, WorkerHandler, QueueMessage } from '../../src/queues/queue';
import { createLogger } from '../../src/logging/logger';

describe('P0-009 — Async job processing with SQS', () => {
  let queue: InMemoryQueue;
  const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

  beforeEach(() => {
    queue = new InMemoryQueue({ maxRetries: 3 });
  });

  it('happy path — sends and receives messages', async () => {
    const id = await queue.send('test.job', { data: 'hello' });
    expect(id).toBeTruthy();

    const msg = await queue.receive<{ data: string }>();
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('test.job');
    expect(msg!.payload.data).toBe('hello');
    expect(msg!.attempts).toBe(1);
  });

  it('happy path — returns null when empty', async () => {
    const msg = await queue.receive();
    expect(msg).toBeNull();
  });

  it('receiveBatch — claims up to max, oldest-first, increments attempts (P3)', async () => {
    await queue.send('test.job', { n: 1 });
    await queue.send('test.job', { n: 2 });
    await queue.send('test.job', { n: 3 });

    const first = await queue.receiveBatch<{ n: number }>(2);
    expect(first.map((m) => m.payload.n)).toEqual([1, 2]); // FIFO claim order
    expect(first.every((m) => m.attempts === 1)).toBe(true);

    // A second batch claims the remainder — no message is returned twice.
    const second = await queue.receiveBatch<{ n: number }>(2);
    expect(second.map((m) => m.payload.n)).toEqual([3]);

    expect(await queue.receiveBatch(5)).toEqual([]); // drained
  });

  it('receiveBatch — returns [] for max <= 0 and when empty', async () => {
    expect(await queue.receiveBatch(0)).toEqual([]);
    expect(await queue.receiveBatch(-1)).toEqual([]);
    expect(await queue.receiveBatch(5)).toEqual([]);
  });

  it('happy path — processMessage calls handler', async () => {
    const handled: string[] = [];
    const handler: WorkerHandler<{ key: string }> = {
      type: 'test.job',
      async handle(msg) {
        handled.push(msg.payload.key);
      },
    };

    const msg: QueueMessage<{ key: string }> = {
      id: '1',
      type: 'test.job',
      payload: { key: 'value' },
      attempts: 1,
      maxAttempts: 3,
      idempotencyKey: 'idem-1',
      createdAt: new Date().toISOString(),
    };

    const result = await processMessage(msg, handler, logger);
    expect(result).toBe(true);
    expect(handled).toEqual(['value']);
  });

  it('validation — processMessage returns false for type mismatch', async () => {
    const handler: WorkerHandler = {
      type: 'other.type',
      async handle() {},
    };

    const msg: QueueMessage = {
      id: '1',
      type: 'test.job',
      payload: {},
      attempts: 1,
      maxAttempts: 3,
      idempotencyKey: 'idem-1',
      createdAt: new Date().toISOString(),
    };

    const result = await processMessage(msg, handler, logger);
    expect(result).toBe(false);
  });

  it('validation — processMessage handles handler errors', async () => {
    const handler: WorkerHandler = {
      type: 'test.job',
      async handle() {
        throw new Error('handler error');
      },
    };

    const msg: QueueMessage = {
      id: '1',
      type: 'test.job',
      payload: {},
      attempts: 1,
      maxAttempts: 3,
      idempotencyKey: 'idem-1',
      createdAt: new Date().toISOString(),
    };

    const result = await processMessage(msg, handler, logger);
    expect(result).toBe(false);
  });

  it('happy path — idempotency key is set', async () => {
    await queue.send('test', { x: 1 }, 'custom-key');
    const msg = await queue.receive();
    expect(msg!.idempotencyKey).toBe('custom-key');
  });

  it('UC-5 — dedups a pending duplicate idempotency key (PgQueue ON CONFLICT parity)', async () => {
    await queue.send('test.job', { n: 1 }, 'same-key');
    await queue.send('test.job', { n: 2 }, 'same-key');
    expect(queue.size()).toBe(1);

    const msg = await queue.receive<{ n: number }>();
    expect(msg!.payload.n).toBe(1); // the first send wins

    // Once delivered (removed), the key is free again — mirrors PgQueue
    // where a deleted row no longer blocks the unique index.
    await queue.send('test.job', { n: 3 }, 'same-key');
    expect(queue.size()).toBe(1);
  });

  it('UC-5 — a delayed message stays invisible until its delay elapses', async () => {
    vi.useFakeTimers();
    try {
      await queue.send('delayed.job', { d: true }, 'delay-key', { delaySeconds: 60 });
      await queue.send('immediate.job', { d: false });

      // Only the immediate message is visible; the delayed one is skipped
      // (not consumed, not reordered away).
      const first = await queue.receiveBatch<{ d: boolean }>(10);
      expect(first.map((m) => m.type)).toEqual(['immediate.job']);
      expect(await queue.receive()).toBeNull();
      expect(queue.size()).toBe(1);

      vi.advanceTimersByTime(60_000);
      const msg = await queue.receive<{ d: boolean }>();
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe('delayed.job');
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC#3 — moveToDeadLetter persists the message with error context', async () => {
    const msg: QueueMessage = {
      id: 'msg-1',
      type: 'test.job',
      payload: { k: 'v' },
      attempts: 3,
      maxAttempts: 3,
      idempotencyKey: 'idem-dlq-1',
      createdAt: new Date().toISOString(),
    };
    await queue.moveToDeadLetter(msg, 'max attempts exceeded');

    const dlq = await queue.listDeadLetter();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].messageId).toBe('msg-1');
    expect(dlq[0].type).toBe('test.job');
    expect(dlq[0].attempts).toBe(3);
    expect(dlq[0].error).toBe('max attempts exceeded');
    expect(dlq[0].failedAt).toBeTruthy();
  });

  it('AC#3 — listDeadLetter starts empty and grows with each failure', async () => {
    expect(await queue.listDeadLetter()).toHaveLength(0);

    for (let i = 0; i < 3; i++) {
      await queue.moveToDeadLetter(
        {
          id: `msg-${i}`,
          type: 'test.job',
          payload: { i },
          attempts: 3,
          maxAttempts: 3,
          idempotencyKey: `idem-${i}`,
          createdAt: new Date().toISOString(),
        },
        'handler error'
      );
    }

    const dlq = await queue.listDeadLetter();
    expect(dlq).toHaveLength(3);
    expect(queue.dlqSize()).toBe(3);
  });

  it('depth() reports pending backlog and dead-letter counts (Queue interface parity)', async () => {
    expect(await queue.depth()).toEqual({ pending: 0, deadLetter: 0 });
    await queue.send('a', { n: 1 });
    await queue.send('b', { n: 2 });
    expect(await queue.depth()).toEqual({ pending: 2, deadLetter: 0 });
    await queue.moveToDeadLetter(
      {
        id: 'x',
        type: 'a',
        payload: { n: 1 },
        attempts: 3,
        maxAttempts: 3,
        idempotencyKey: 'idem-x',
        createdAt: new Date().toISOString(),
      },
      'boom',
    );
    expect((await queue.depth()).deadLetter).toBe(1);
  });

  describe('WS15 — stalePendingCount (queue-staleness SLO feed)', () => {
    it('counts only pending messages older than the age window', async () => {
      vi.useFakeTimers();
      try {
        await queue.send('test.job', { n: 1 }); // will be 20min old
        vi.advanceTimersByTime(10 * 60 * 1000);
        await queue.send('test.job', { n: 2 }); // will be 10min old
        vi.advanceTimersByTime(10 * 60 * 1000);
        await queue.send('test.job', { n: 3 }); // fresh

        expect(await queue.stalePendingCount(15 * 60)).toBe(1); // only the 20min row
        expect(await queue.stalePendingCount(5 * 60)).toBe(2);
        expect(await queue.stalePendingCount(60 * 60)).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns 0 on an empty queue', async () => {
      expect(await queue.stalePendingCount(0)).toBe(0);
    });
  });
});
