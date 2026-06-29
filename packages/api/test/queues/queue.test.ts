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
});
