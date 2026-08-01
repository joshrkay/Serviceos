/**
 * RV-143 / UC-5a — durable emergency page-retry ladder (unit).
 *
 * The ladder is queue-backed now: arming enqueues a DELAYED job per step and
 * the worker chains the next step. These tests pin the ladder→queue mapping
 * (attempt timing as delaySeconds, per-attempt idempotency keys, double-arm
 * dedup) and the worker's step semantics (resolution cancels, failed pages
 * never stop the ladder, exhaustion lands the durable call_me_back tail).
 * The Postgres half (delayed visibility, restart survival, replica races)
 * is pinned by test/integration/durable-telephony-timers.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  armEmergencyPageLadder,
  composeEmergencyRetryPage,
  createEmergencyPageWorker,
  createEmergencyPageResolvedCheck,
  emergencyPageIdempotencyKey,
  EMERGENCY_PAGE_INTERVAL_MS,
  EMERGENCY_PAGE_JOB_TYPE,
  MAX_EMERGENCY_PAGES,
  type EmergencyPageJobPayload,
  type EmergencyPageWorkerDeps,
} from '../../src/telephony/emergency-page-retry';
import { InMemoryQueue, type QueueMessage, type SendOptions } from '../../src/queues/queue';
import { InMemoryCallMeBackRepository } from '../../src/voice/call-me-back/call-me-back';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

const INPUT = {
  tenantId: 't1',
  sessionId: 's1',
  callSid: 'CA-1',
  callerPhone: '+15125550111',
  emergencyDescription: 'gas leak in the basement',
  businessName: 'Acme Plumbing',
};

interface RecordedSend {
  type: string;
  payload: EmergencyPageJobPayload;
  idempotencyKey: string | undefined;
  delaySeconds: number | undefined;
}

/** Capturing queue — records every send so timing/keys are assertable. */
function makeRecordingQueue() {
  const sends: RecordedSend[] = [];
  const queue = {
    async send(
      type: string,
      payload: unknown,
      idempotencyKey?: string,
      options?: SendOptions,
    ): Promise<string> {
      sends.push({
        type,
        payload: payload as EmergencyPageJobPayload,
        idempotencyKey,
        delaySeconds: options?.delaySeconds,
      });
      return `msg-${sends.length}`;
    },
    async receive() {
      return null;
    },
    async receiveBatch() {
      return [];
    },
    async delete() {},
    async moveToDeadLetter() {},
    async listDeadLetter() {
      return [];
    },
    getConfig() {
      return { maxRetries: 3, visibilityTimeout: 30 };
    },
  };
  return { queue, sends };
}

function makeMessage(
  payload: EmergencyPageJobPayload,
): QueueMessage<EmergencyPageJobPayload> {
  return {
    id: 'm1',
    type: EMERGENCY_PAGE_JOB_TYPE,
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: emergencyPageIdempotencyKey(
      payload.tenantId,
      payload.sessionId,
      payload.attempt,
    ),
    createdAt: new Date().toISOString(),
  };
}

function makeWorker(overrides: Partial<EmergencyPageWorkerDeps> = {}) {
  const { queue, sends } = makeRecordingQueue();
  const sent: Array<{ to: string; body: string }> = [];
  const deps: EmergencyPageWorkerDeps = {
    queue,
    sendSms: vi.fn(async (args: { to: string; body: string }) => {
      sent.push(args);
      return {};
    }),
    resolvePagePhone: vi.fn(async () => '+15125550999'),
    isResolved: vi.fn(async () => false),
    ...overrides,
  };
  return { worker: createEmergencyPageWorker(deps), deps, sends, sent };
}

describe('RV-143 / UC-5a — arming maps the ladder onto delayed queue jobs', () => {
  it('enqueues attempt 1 delayed by the page interval with the per-attempt idempotency key', async () => {
    const { queue, sends } = makeRecordingQueue();
    await armEmergencyPageLadder(INPUT, { queue });

    expect(sends).toHaveLength(1);
    expect(sends[0].type).toBe(EMERGENCY_PAGE_JOB_TYPE);
    expect(sends[0].idempotencyKey).toBe('emergency_page:t1:s1:1');
    // Attempt timing: step N fires N×interval after arm — expressed as a
    // delayed enqueue, not a timer.
    expect(sends[0].delaySeconds).toBe(EMERGENCY_PAGE_INTERVAL_MS / 1000);
    expect(sends[0].payload).toEqual({
      ...INPUT,
      attempt: 1,
      maxPages: MAX_EMERGENCY_PAGES,
      intervalMs: EMERGENCY_PAGE_INTERVAL_MS,
    });
  });

  it('double-arm is a no-op: both arms use the SAME idempotency key and the queue dedups', async () => {
    const queue = new InMemoryQueue();
    await armEmergencyPageLadder(INPUT, { queue, intervalMs: 5_000 });
    await armEmergencyPageLadder(INPUT, { queue, intervalMs: 5_000 });
    expect(queue.size()).toBe(1);
  });

  it('honors interval/maxPages overrides', async () => {
    const { queue, sends } = makeRecordingQueue();
    await armEmergencyPageLadder(INPUT, { queue, intervalMs: 1_000, maxPages: 2 });
    expect(sends[0].delaySeconds).toBe(1);
    expect(sends[0].payload.maxPages).toBe(2);
    expect(sends[0].payload.intervalMs).toBe(1_000);
  });
});

describe('RV-143 / UC-5a — emergency page worker (one ladder step)', () => {
  const payload = (attempt: number, maxPages = 3): EmergencyPageJobPayload => ({
    ...INPUT,
    attempt,
    maxPages,
    intervalMs: EMERGENCY_PAGE_INTERVAL_MS,
  });

  it('pages the owner and enqueues the next attempt (delayed, next-attempt key)', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const { worker, sends, sent } = makeWorker({ auditRepo });

    await worker.handle(makeMessage(payload(1)), logger);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('+15125550999');
    expect(sent[0].body).toContain('page 1/3');
    expect(sent[0].body).toContain('+15125550111');

    expect(sends).toHaveLength(1);
    expect(sends[0].idempotencyKey).toBe('emergency_page:t1:s1:2');
    expect(sends[0].delaySeconds).toBe(EMERGENCY_PAGE_INTERVAL_MS / 1000);
    expect(sends[0].payload.attempt).toBe(2);

    const audits = auditRepo.getAll().filter((e) => e.eventType === 'emergency_page.sent');
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ attempt: 1, maxPages: 3 });
  });

  it('a resolved transfer cancels silently — no page, no continuation', async () => {
    const { worker, sends, sent } = makeWorker({ isResolved: vi.fn(async () => true) });
    await worker.handle(makeMessage(payload(2)), logger);
    expect(sent).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it('an isResolved failure is indeterminate → keeps paging (bias toward paging)', async () => {
    const { worker, sent } = makeWorker({
      isResolved: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    await worker.handle(makeMessage(payload(1)), logger);
    expect(sent).toHaveLength(1);
  });

  it('a failed page does not stop the ladder — the next attempt is already enqueued', async () => {
    const { worker, sends } = makeWorker({
      sendSms: vi.fn(async () => {
        throw new Error('provider down');
      }),
    });
    await expect(worker.handle(makeMessage(payload(1)), logger)).resolves.toBeUndefined();
    expect(sends).toHaveLength(1);
    expect(sends[0].payload.attempt).toBe(2);
  });

  it('no resolvable page phone → no SMS, ladder still continues', async () => {
    const { worker, sends, sent } = makeWorker({
      resolvePagePhone: vi.fn(async () => null),
    });
    await worker.handle(makeMessage(payload(1)), logger);
    expect(sent).toHaveLength(0);
    expect(sends).toHaveLength(1);
  });

  it('the final attempt enqueues nothing and lands the durable urgent call_me_back task', async () => {
    const callMeBackRepo = new InMemoryCallMeBackRepository();
    const { worker, sends, sent } = makeWorker({ callMeBackRepo });

    await worker.handle(makeMessage(payload(3)), logger);

    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('page 3/3');
    expect(sends).toHaveLength(0); // no fourth page, ever

    const pending = await callMeBackRepo.listPending('t1');
    expect(pending).toHaveLength(1);
    expect(pending[0].reason).toBe('emergency_unanswered');
    expect(pending[0].callerPhone).toBe('+15125550111');
    expect(pending[0].callbackMessage).toContain('EMERGENCY');
  });

  it('final attempt without a caller phone → no call_me_back, no throw', async () => {
    const callMeBackRepo = new InMemoryCallMeBackRepository();
    const p = payload(3);
    delete p.callerPhone;
    const { worker } = makeWorker({ callMeBackRepo });
    await worker.handle(makeMessage(p), logger);
    expect(await callMeBackRepo.listPending('t1')).toHaveLength(0);
  });

  it('a malformed payload is dropped without throwing (never retries forever)', async () => {
    const { worker, sends, sent } = makeWorker();
    const bad = {
      id: 'm1',
      type: EMERGENCY_PAGE_JOB_TYPE,
      payload: { tenantId: 't1' } as unknown as EmergencyPageJobPayload,
      attempts: 1,
      maxAttempts: 3,
      idempotencyKey: 'k',
      createdAt: new Date().toISOString(),
    };
    await expect(worker.handle(bad, logger)).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it('walking the whole ladder yields exactly one page per step at interval spacing', async () => {
    // Chain the steps the way the poll loop would: process attempt N, take
    // the continuation it enqueued, process it, and so on.
    const callMeBackRepo = new InMemoryCallMeBackRepository();
    const { worker, sends, sent } = makeWorker({ callMeBackRepo });

    let next: EmergencyPageJobPayload | undefined = payload(1);
    const delays: Array<number | undefined> = [];
    const keys: string[] = [];
    while (next) {
      keys.push(emergencyPageIdempotencyKey(next.tenantId, next.sessionId, next.attempt));
      const before = sends.length;
      await worker.handle(makeMessage(next), logger);
      const enqueued = sends.slice(before);
      next = enqueued[0]?.payload;
      if (enqueued[0]) delays.push(enqueued[0].delaySeconds);
    }

    expect(sent.map((s) => s.body)).toEqual([
      expect.stringContaining('page 1/3'),
      expect.stringContaining('page 2/3'),
      expect.stringContaining('page 3/3'),
    ]);
    expect(keys).toEqual([
      'emergency_page:t1:s1:1',
      'emergency_page:t1:s1:2',
      'emergency_page:t1:s1:3',
    ]);
    // Every continuation is spaced one interval out.
    expect(delays).toEqual([
      EMERGENCY_PAGE_INTERVAL_MS / 1000,
      EMERGENCY_PAGE_INTERVAL_MS / 1000,
    ]);
    expect(await callMeBackRepo.listPending('t1')).toHaveLength(1);
  });
});

describe('createEmergencyPageResolvedCheck', () => {
  it('resolves from the live store fast path', async () => {
    const check = createEmergencyPageResolvedCheck({
      store: { peek: () => ({ terminalReason: 'transferred' }) },
    });
    expect(await check('t1', 's1')).toBe(true);
  });

  it('falls back to the persisted voice_sessions row (cross-replica truth)', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    await repo.create({
      id: 's1',
      tenantId: 't1',
      channel: 'voice_inbound',
      state: 'escalating',
    });
    await repo.markEnded('t1', 's1', {
      endedAt: new Date(),
      endedReason: 'transferred',
      outcome: 'escalated_to_human',
      state: 'terminated',
      channel: 'voice_inbound',
    });
    const check = createEmergencyPageResolvedCheck({
      store: { peek: () => undefined },
      voiceSessionRepo: repo,
    });
    expect(await check('t1', 's1')).toBe(true);
    expect(await check('t1', 'missing-session')).toBe(false);
  });

  it('treats lookup failures as unresolved (keep paging)', async () => {
    const check = createEmergencyPageResolvedCheck({
      voiceSessionRepo: {
        findById: async () => {
          throw new Error('db down');
        },
      },
    });
    expect(await check('t1', 's1')).toBe(false);
  });
});

describe('composeEmergencyRetryPage', () => {
  it('caps the body at 320 chars and counts attempts', () => {
    const body = composeEmergencyRetryPage(
      { ...INPUT, emergencyDescription: 'y'.repeat(400) },
      2,
      3,
    );
    expect(body.length).toBeLessThanOrEqual(320);
    expect(body).toContain('2/3');
  });
});
