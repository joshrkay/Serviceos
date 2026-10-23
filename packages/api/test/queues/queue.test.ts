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
    expect(result).toEqual({ success: true });
    expect(handled).toEqual(['value']);
  });

  it("processMessage logs a handler's own description of the payload in place of its snapshot", async () => {
    const lines: Array<[string, unknown]> = [];
    const log = {
      info: (m: string, meta?: unknown) => lines.push([m, meta]),
      warn: (m: string, meta?: unknown) => lines.push([m, meta]),
      error: (m: string, meta?: unknown) => lines.push([m, meta]),
      debug: () => undefined,
      child: () => log,
    } as unknown as Parameters<typeof processMessage>[2];
    const msg: QueueMessage<{ id: string; text: string }> = {
      id: '1',
      type: 'test.job',
      payload: { id: 'row-1', text: 'the caller said this' },
      attempts: 3,
      maxAttempts: 3,
      idempotencyKey: 'idem-1',
      createdAt: new Date().toISOString(),
    };
    const failing = async (): Promise<void> => {
      throw new Error('boom');
    };
    await processMessage(msg, { type: 'test.job', handle: failing, describePayload: (p) => ({ id: p.id }) }, log);
    expect(lines.filter(([m]) => m === 'Processing message' || m === 'Message processing failed').map(([, meta]) => (meta as { payload: unknown }).payload)).toEqual([
      { id: 'row-1' },
      { id: 'row-1' },
    ]);
    expect(JSON.stringify(lines)).not.toContain('the caller said');
    // Without one, the redacted snapshot (an excerpt of each text field) as before.
    lines.length = 0;
    await processMessage(msg, { type: 'test.job', handle: failing }, log);
    expect(JSON.stringify(lines)).toContain('the caller said');
  });

  it('validation — processMessage returns {success: false, error} for type mismatch', async () => {
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
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/type mismatch/i);
  });

  it('T4-F10 / Codex P2 — the DURABLE error is classification + fingerprint only, never the thrown message text', async () => {
    const handler: WorkerHandler = {
      type: 'test.job',
      async handle() {
        throw new Error('handler error with a +15551234567 phone number');
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
    expect(result.success).toBe(false);
    // Only the error class + a sha256 fingerprint — the message (which here
    // carries PII) is never persisted to last_error / the DLQ.
    expect(result.error).toBe(`Error [sha256:${result.error!.match(/[0-9a-f]{16}/)![0]}]`);
    expect(result.error).not.toContain('handler error');
    expect(result.error).not.toContain('+15551234567');
  });

  it('T4-F10 / Codex P2 — appends a short enum-like error code to the classification (e.g. ECONNRESET) but still no message', async () => {
    const handler: WorkerHandler = {
      type: 'test.job',
      async handle() {
        const err = new Error('connect ECONNRESET 10.0.0.1:5432') as Error & { code?: string };
        err.code = 'ECONNRESET';
        throw err;
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
    expect(result.error).toMatch(/^Error:ECONNRESET \[sha256:[0-9a-f]{16}\]$/);
    expect(result.error).not.toContain('10.0.0.1');
  });

  it('T4-F10 / Codex P2 — a huge (potentially sensitive) message is never persisted, verbatim or as an excerpt', async () => {
    const longMessage = 'x'.repeat(500);
    const handler: WorkerHandler = {
      type: 'test.job',
      async handle() {
        throw new Error(longMessage);
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
    // No excerpt at all — just the classification + fingerprint.
    expect(result.error!).toMatch(/^Error \[sha256:[0-9a-f]{16}\]$/);
    expect(result.error).not.toContain('xxxx');
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

  describe('T4-F10 — recordFailure (InMemoryQueue parity)', () => {
    it('stores the last error, retrievable via getLastError', async () => {
      await queue.recordFailure('msg-a', 'boom');
      expect(queue.getLastError('msg-a')).toBe('boom');
    });

    it('is cleared on delete()', async () => {
      await queue.recordFailure('msg-b', 'boom');
      await queue.delete('msg-b');
      expect(queue.getLastError('msg-b')).toBeUndefined();
    });

    it('is cleared once the message moves to the DLQ', async () => {
      const msg: QueueMessage = {
        id: 'msg-c',
        type: 'test.job',
        payload: {},
        attempts: 3,
        maxAttempts: 3,
        idempotencyKey: 'idem-c',
        createdAt: new Date().toISOString(),
      };
      await queue.recordFailure('msg-c', 'boom');
      await queue.moveToDeadLetter(msg, 'boom');
      expect(queue.getLastError('msg-c')).toBeUndefined();
    });
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

    it('does not count a message delayed into the future, however old the row is', async () => {
      // A delayed job (a durable timer, a 6 h A2P poll) is scheduled work,
      // not a stuck queue — counting it paged an operator every night.
      vi.useFakeTimers();
      try {
        await queue.send('test.job', { n: 1 }, 'delayed', { delaySeconds: 11 * 60 * 60 });
        vi.advanceTimersByTime(2 * 60 * 60 * 1000);

        expect(await queue.stalePendingCount(15 * 60)).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('counts a delayed message once it has been DUE and unclaimed for the window', async () => {
      vi.useFakeTimers();
      try {
        await queue.send('test.job', { n: 1 }, 'delayed', { delaySeconds: 60 * 60 });
        vi.advanceTimersByTime(60 * 60 * 1000 + 20 * 60 * 1000); // due 20 min ago

        expect(await queue.stalePendingCount(15 * 60)).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('S5a-3 — InMemoryQueue.sendOn is a plain send (no transaction to join)', () => {
  it('enqueues, honours delaySeconds, and dedupes on the idempotency key; the client is ignored', async () => {
    const queue = new InMemoryQueue();
    const client = {} as import('pg').PoolClient;
    await queue.sendOn(client, 'deactivate_payment_links', { tenantId: 't1' }, 'k-1');
    await queue.sendOn(client, 'deactivate_payment_links', { tenantId: 't1', dup: true }, 'k-1');
    await queue.sendOn(client, 'deactivate_payment_links', { tenantId: 't1', pass: 2 }, 'k-2', { delaySeconds: 120 });
    const batch = await queue.receiveBatch<{ tenantId: string }>(10);
    expect(batch.map((m) => [m.idempotencyKey, m.payload])).toEqual([['k-1', { tenantId: 't1' }]]);
    expect(await queue.depth()).toEqual({ pending: 1, deadLetter: 0 });
  });
});

// PRIV-3 — the recording hook reads the card-number rewrites still queued for
// a call (delayed or not yet run) to write them before the call is ingested.
describe('InMemoryQueue.findPending — the messages of a type still queued whose payload holds the match', () => {
  it('returns them oldest first, delayed ones included, and none once received', async () => {
    const queue = new InMemoryQueue();
    await queue.send('job', { tenantId: 't1', callSid: 'CA1', n: 1 }, 'k-1', { delaySeconds: 60 });
    await queue.send('job', { tenantId: 't1', callSid: 'CA2', n: 2 }, 'k-2');
    await queue.send('other', { tenantId: 't1', callSid: 'CA1', n: 3 }, 'k-3');
    await queue.send('job', { tenantId: 't2', callSid: 'CA1', n: 4 }, 'k-4');
    await queue.send('job', { tenantId: 't1', callSid: 'CA1', n: 5 }, 'k-5');
    const found = await queue.findPending<{ n: number }>('job', { tenantId: 't1', callSid: 'CA1' });
    expect(found.map((m) => m.payload.n)).toEqual([1, 5]);
    await queue.receiveBatch(10);
    expect(await queue.findPending('job', { tenantId: 't1', callSid: 'CA1' })).toEqual([
      expect.objectContaining({ idempotencyKey: 'k-1' }),
    ]);
  });
});
