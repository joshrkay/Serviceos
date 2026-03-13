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
});
