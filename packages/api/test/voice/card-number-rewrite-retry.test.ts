/**
 * PRIV-3 (durability) — the worker that retries a cross-turn card-number
 * rewrite of the stored call rows whose live write failed.
 *
 * The job (from `VoiceSessionStore`) names the rows by id with their
 * already-redacted text; the worker writes them through the repository's one
 * audited transaction. A failure is rethrown so the queue retries it with
 * backoff (bounded by its max attempts, then the dead-letter table); the
 * last attempt's failure is logged, counted and audited, and nothing it logs
 * or audits holds the caller's words or a digit of the card.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CARD_NUMBER_REWRITE_FAILED_EVENT,
  CARD_NUMBER_REWRITE_RETRY_JOB,
  createCardNumberRewriteRetryWorker,
  pendingCardNumberRewrites,
  type CardNumberRewriteRetryJob,
} from '../../src/voice/card-number-rewrite-retry';
import { InMemoryQueue, processMessage } from '../../src/queues/queue';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { cardNumberRewriteFailedTotal } from '../../src/monitoring/metrics';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

const JOB: CardNumberRewriteRetryJob = {
  tenantId: 'tenant-a',
  callSid: 'CA1',
  sessionId: 'session-1',
  turns: [
    { id: 'row-1', turnIndex: 1, text: 'my card is [card number]' },
    { id: 'row-3', turnIndex: 3, text: '[card number]' },
  ],
};

function message(payload: unknown, attempts = 1, maxAttempts = 3): QueueMessage<CardNumberRewriteRetryJob> {
  return {
    id: 'msg-1',
    type: CARD_NUMBER_REWRITE_RETRY_JOB,
    payload: payload as CardNumberRewriteRetryJob,
    attempts,
    maxAttempts,
    idempotencyKey: 'k',
    createdAt: new Date().toISOString(),
  };
}

function logger() {
  const calls: Array<[string, string, unknown]> = [];
  const log = {
    info: (m: string, meta?: unknown) => calls.push(['info', m, meta]),
    warn: (m: string, meta?: unknown) => calls.push(['warn', m, meta]),
    error: (m: string, meta?: unknown) => calls.push(['error', m, meta]),
    debug: () => undefined,
    child: () => log,
  } as unknown as Logger;
  return { log, calls };
}

describe('card-number rewrite retry worker', () => {
  it('writes the rows named in the job through the audited repository rewrite', async () => {
    const redactCardNumberTurns = vi.fn(async () => 2);
    const worker = createCardNumberRewriteRetryWorker({ callTranscriptTurnRepo: { redactCardNumberTurns } });
    expect(worker.type).toBe(CARD_NUMBER_REWRITE_RETRY_JOB);
    const { log } = logger();
    await worker.handle(message(JOB), log);
    expect(redactCardNumberTurns).toHaveBeenCalledWith({ ...JOB, actorId: 'card-number-rewrite-retry' });
  });

  it('drops a malformed job without writing anything', async () => {
    const redactCardNumberTurns = vi.fn(async () => 0);
    const worker = createCardNumberRewriteRetryWorker({ callTranscriptTurnRepo: { redactCardNumberTurns } });
    const { log, calls } = logger();
    for (const bad of [null, {}, { ...JOB, turns: [] }, { ...JOB, turns: [{ turnIndex: 1 }] }, { ...JOB, sessionId: 4 }]) {
      await worker.handle(message(bad), log);
    }
    expect(redactCardNumberTurns).not.toHaveBeenCalled();
    expect(calls.filter(([level]) => level === 'error')).toHaveLength(5);
  });

  it('rethrows a failed write for the queue to retry, with no text in the error', async () => {
    const redactCardNumberTurns = vi.fn(async () => {
      throw Object.assign(new Error('new row violates check constraint; Failing row contains (my card is 4111 1111)'), {
        code: '23514',
      });
    });
    const auditRepo = new InMemoryAuditRepository();
    const worker = createCardNumberRewriteRetryWorker({ callTranscriptTurnRepo: { redactCardNumberTurns }, auditRepo });
    const { log, calls } = logger();
    const before = (await cardNumberRewriteFailedTotal.get()).values.find((v) => v.labels.stage === 'retry_exhausted')?.value ?? 0;
    const thrown = await worker.handle(message(JOB, 1, 3), log).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('card-number rewrite of stored turns failed (Error:23514)');
    // Not the last attempt: nothing is alerted or audited yet.
    expect(calls.filter(([level]) => level === 'error')).toHaveLength(0);
    expect(auditRepo.getAll()).toHaveLength(0);
    const after = (await cardNumberRewriteFailedTotal.get()).values.find((v) => v.labels.stage === 'retry_exhausted')?.value ?? 0;
    expect(after).toBe(before);
  });

  it('logs, counts and audits the last attempt failing, with ids and indexes only', async () => {
    const redactCardNumberTurns = vi.fn(async () => {
      throw new Error('Failing row contains (my card is 4111 1111)');
    });
    const auditRepo = new InMemoryAuditRepository();
    const worker = createCardNumberRewriteRetryWorker({ callTranscriptTurnRepo: { redactCardNumberTurns }, auditRepo });
    const { log, calls } = logger();
    const count = async () =>
      (await cardNumberRewriteFailedTotal.get()).values.find((v) => v.labels.stage === 'retry_exhausted')?.value ?? 0;
    const before = await count();
    await expect(worker.handle(message(JOB, 3, 3), log)).rejects.toThrow('card-number rewrite of stored turns failed');
    expect(await count()).toBe(before + 1);
    const errors = calls.filter(([level]) => level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0][2]).toEqual({
      tenantId: 'tenant-a',
      callSid: 'CA1',
      sessionId: 'session-1',
      turnIndexes: [1, 3],
      attempts: 3,
      error: 'Error',
    });
    const [audit] = auditRepo.getAll();
    expect(audit).toMatchObject({
      tenantId: 'tenant-a',
      eventType: CARD_NUMBER_REWRITE_FAILED_EVENT,
      entityType: 'voice_session',
      entityId: 'session-1',
      metadata: { callSid: 'CA1', turnIndexes: [1, 3], attempts: 3 },
    });
    const everything = JSON.stringify({ calls, audits: auditRepo.getAll() });
    expect(everything).not.toMatch(/4111|my card|\[card number\]/);
  });
});

// The queue's runner logs every attempt ("Processing message", and "Message
// processing failed" on each failure, the last included) with a snapshot of
// the payload, which for this job is the caller's words (already free of
// card digits): the job's own description, ids only, is logged instead.
describe('card-number rewrite retry worker, run by the queue', () => {
  it('logs no word of the rows on any attempt, the last failing one included', async () => {
    const redactCardNumberTurns = vi.fn(async () => {
      throw new Error('connection terminated');
    });
    const worker = createCardNumberRewriteRetryWorker({ callTranscriptTurnRepo: { redactCardNumberTurns } });
    const { log, calls } = logger();
    for (const attempt of [1, 3]) {
      const result = await processMessage(message(JOB, attempt, 3), worker, log);
      expect(result.success).toBe(false);
    }
    const logged = calls.filter(([, m]) => m === 'Processing message' || m === 'Message processing failed');
    expect(logged).toHaveLength(4);
    for (const [, , meta] of logged) {
      expect((meta as { payload: unknown }).payload).toEqual({
        tenantId: 'tenant-a',
        callSid: 'CA1',
        sessionId: 'session-1',
        turnIndexes: [1, 3],
      });
    }
    expect(JSON.stringify(calls)).not.toMatch(/my card|\[card number\]/);
  });
});

describe('pendingCardNumberRewrites', () => {
  it("returns the call's rewrites still queued, oldest first, and drops a malformed one", async () => {
    const queue = new InMemoryQueue();
    await queue.send(CARD_NUMBER_REWRITE_RETRY_JOB, JOB, 'k-1', { delaySeconds: 60 });
    await queue.send(CARD_NUMBER_REWRITE_RETRY_JOB, { ...JOB, turns: 'not turns' }, 'k-2');
    await queue.send(CARD_NUMBER_REWRITE_RETRY_JOB, { ...JOB, callSid: 'CA2' }, 'k-3');
    await queue.send(CARD_NUMBER_REWRITE_RETRY_JOB, { ...JOB, tenantId: 'tenant-b' }, 'k-4');
    const later = { ...JOB, turns: [{ id: 'row-5', turnIndex: 5, text: '[card number]' }] };
    await queue.send(CARD_NUMBER_REWRITE_RETRY_JOB, later, 'k-5');
    expect(await pendingCardNumberRewrites(queue)('tenant-a', 'CA1')).toEqual([JOB, later]);
  });
});
