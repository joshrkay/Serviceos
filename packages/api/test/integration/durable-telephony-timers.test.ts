/**
 * UC-5 — durable telephony timers (Postgres integration).
 *
 * Pins the two timer subsystems the in-memory MVPs used to hold in process
 * state (lost on deploy, split across replicas):
 *
 *  (a) Emergency page-retry ladder → delayed PgQueue jobs:
 *      - a delayed enqueue is INVISIBLE until its delay elapses (real
 *        `visible_at` SQL, not mocks);
 *      - restart survival: the job persists in Postgres and a freshly
 *        instantiated consumer (≈ a new process/replica) claims and fires it;
 *      - double-arm dedup: the per-attempt idempotency key makes the second
 *        arm an ON CONFLICT no-op;
 *      - replica race: two consumers claim one due page exactly once
 *        (FOR UPDATE SKIP LOCKED);
 *      - exhaustion lands the durable call_me_back row + audit event through
 *        the production Pg repos (real columns);
 *      - resolution is durable: a voice_sessions row stamped
 *        ended_reason='transferred' cancels the ladder from a fresh repo
 *        instance (cross-replica answer detection).
 *
 *  (b) Dropped-call recovery → the durable dropped_call_recoveries queue
 *      (worker mechanics are pinned by dropped-call-worker.test.ts; here we
 *      pin the UC-5 claims): the phone→session bridge lookup works from a
 *      fresh process instance (replacing the in-memory Map the inbound SMS
 *      webhook used to depend on), double-arm is a single row, and a
 *      restart between schedule and send still sends (fresh repo sweep).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgQueue } from '../../src/queues/pg-queue';
import { processMessage } from '../../src/queues/queue';
import {
  armEmergencyPageLadder,
  createEmergencyPageWorker,
  createEmergencyPageResolvedCheck,
  emergencyPageIdempotencyKey,
  EMERGENCY_PAGE_JOB_TYPE,
  type EmergencyPageJobPayload,
  type EmergencyPageWorkerDeps,
} from '../../src/telephony/emergency-page-retry';
import { PgCallMeBackRepository } from '../../src/voice/call-me-back/pg-call-me-back';
import { PgVoiceSessionRepository } from '../../src/voice/pg-voice-session';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import {
  DroppedCallScheduler,
  PgDroppedCallRecoveryRepository,
} from '../../src/sms/recovery/scheduler';
import { runDroppedCallRecoverySweep } from '../../src/workers/dropped-call-worker';
import type {
  DroppedCallHandlerDeps,
} from '../../src/sms/recovery/dropped-call-handler';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

const OWNER_PHONE = '+15125550999';

function ladderInput(tenantId: string, sessionId: string) {
  return {
    tenantId,
    sessionId,
    callSid: 'CA-uc5',
    callerPhone: '+15125550111',
    emergencyDescription: 'gas leak in the basement',
    businessName: 'Acme Plumbing',
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('UC-5 — durable telephony timers', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    // Force PgQueue's lazy DDL so the per-test cleanup has tables to hit.
    await new PgQueue(pool).send('warmup', { ok: true });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM _queue_messages');
    await pool.query('DELETE FROM _queue_dlq');
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** Build the production-shaped worker over the real Pg repos. */
  function makeWorker(
    consumer: PgQueue,
    overrides: Partial<EmergencyPageWorkerDeps> = {},
  ) {
    const smsCalls: Array<{ to: string; body: string }> = [];
    const worker = createEmergencyPageWorker({
      queue: consumer,
      sendSms: async (args) => {
        smsCalls.push(args);
        return {};
      },
      resolvePagePhone: async () => OWNER_PHONE,
      isResolved: async () => false,
      callMeBackRepo: new PgCallMeBackRepository(pool),
      auditRepo: new PgAuditRepository(pool),
      ...overrides,
    });
    return { worker, smsCalls };
  }

  /**
   * Poll like app.ts's unified loop until one emergency-page message is
   * claimed and processed (receive → handle → delete). Throws on deadline.
   */
  async function processNextPage(
    consumer: PgQueue,
    worker: ReturnType<typeof makeWorker>['worker'],
    timeoutMs = 20_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const msg = await consumer.receive<EmergencyPageJobPayload>();
      if (msg) {
        const ok = await processMessage(msg, worker, logger);
        expect(ok).toBe(true);
        await consumer.delete(msg.id);
        return;
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for a due emergency page job');
      }
      await sleep(100);
    }
  }

  it('(a) arm → delayed job → restart-survival: a fresh consumer fires the page and chains the next delayed step', async () => {
    const sessionId = crypto.randomUUID();
    const producer = new PgQueue(pool);

    await armEmergencyPageLadder(ladderInput(tenant.tenantId, sessionId), {
      queue: producer,
      intervalMs: 2_000,
      maxPages: 2,
    });

    // The job is persisted but INVISIBLE until the delay elapses.
    const { rows: pending } = await pool.query(
      `SELECT idempotency_key, visible_at > NOW() AS delayed
         FROM _queue_messages WHERE type = $1`,
      [EMERGENCY_PAGE_JOB_TYPE],
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].idempotency_key).toBe(
      emergencyPageIdempotencyKey(tenant.tenantId, sessionId, 1),
    );
    expect(pending[0].delayed).toBe(true);
    expect(await producer.receive()).toBeNull();

    // "Restart": the producer process dies; a brand-new consumer instance
    // (fresh PgQueue over the same database) picks the ladder up.
    const consumer = new PgQueue(pool);
    const { worker, smsCalls } = makeWorker(consumer);
    await processNextPage(consumer, worker);

    expect(smsCalls).toHaveLength(1);
    expect(smsCalls[0].to).toBe(OWNER_PHONE);
    expect(smsCalls[0].body).toContain('page 1/2');
    expect(smsCalls[0].body).toContain('+15125550111');

    // The continuation (attempt 2) is already durable — delayed again.
    const { rows: next } = await pool.query(
      `SELECT idempotency_key, visible_at > NOW() AS delayed
         FROM _queue_messages WHERE type = $1`,
      [EMERGENCY_PAGE_JOB_TYPE],
    );
    expect(next).toHaveLength(1);
    expect(next[0].idempotency_key).toBe(
      emergencyPageIdempotencyKey(tenant.tenantId, sessionId, 2),
    );
    expect(next[0].delayed).toBe(true);
  });

  it('(a) double-arm dedup: the second arm is a no-op (one attempt-1 job)', async () => {
    const sessionId = crypto.randomUUID();
    const queue = new PgQueue(pool);
    await armEmergencyPageLadder(ladderInput(tenant.tenantId, sessionId), {
      queue,
      intervalMs: 60_000,
    });
    // Second replica / re-dispatched scan arms again.
    await armEmergencyPageLadder(ladderInput(tenant.tenantId, sessionId), {
      queue: new PgQueue(pool),
      intervalMs: 60_000,
    });

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM _queue_messages WHERE type = $1`,
      [EMERGENCY_PAGE_JOB_TYPE],
    );
    expect(rows[0].n).toBe(1);
  });

  it('(a) two racing consumers claim a due page exactly once (SKIP LOCKED)', async () => {
    const sessionId = crypto.randomUUID();
    const queue = new PgQueue(pool);
    await queue.send(
      EMERGENCY_PAGE_JOB_TYPE,
      { ...ladderInput(tenant.tenantId, sessionId), attempt: 1, maxPages: 3, intervalMs: 60_000 },
      emergencyPageIdempotencyKey(tenant.tenantId, sessionId, 1),
      { delaySeconds: 0 },
    );

    const replicaA = new PgQueue(pool);
    const replicaB = new PgQueue(pool);
    const [a, b] = await Promise.all([
      replicaA.receiveBatch<EmergencyPageJobPayload>(5),
      replicaB.receiveBatch<EmergencyPageJobPayload>(5),
    ]);
    expect(a.length + b.length).toBe(1);
  });

  it('(a) the exhausted ladder lands the durable URGENT call_me_back row + audit event (real columns)', async () => {
    const sessionId = crypto.randomUUID();
    const queue = new PgQueue(pool);
    // Final step of a 2-page ladder, due immediately.
    await queue.send(
      EMERGENCY_PAGE_JOB_TYPE,
      { ...ladderInput(tenant.tenantId, sessionId), attempt: 2, maxPages: 2, intervalMs: 60_000 },
      emergencyPageIdempotencyKey(tenant.tenantId, sessionId, 2),
      { delaySeconds: 0 },
    );

    const { worker, smsCalls } = makeWorker(queue);
    await processNextPage(queue, worker);

    expect(smsCalls).toHaveLength(1);
    expect(smsCalls[0].body).toContain('page 2/2');

    // No continuation — the ladder is exhausted.
    const { rows: remaining } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM _queue_messages WHERE type = $1`,
      [EMERGENCY_PAGE_JOB_TYPE],
    );
    expect(remaining[0].n).toBe(0);

    // Durable tail through the production PgCallMeBackRepository.
    const { rows: tasks } = await pool.query(
      `SELECT reason, caller_phone, call_sid, status, callback_message
         FROM call_me_back_tasks
        WHERE tenant_id = $1 AND session_id = $2`,
      [tenant.tenantId, sessionId],
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].reason).toBe('emergency_unanswered');
    expect(tasks[0].caller_phone).toBe('+15125550111');
    expect(tasks[0].call_sid).toBe('CA-uc5');
    expect(tasks[0].callback_message).toContain('EMERGENCY');

    // Page audited through the production PgAuditRepository.
    const { rows: audits } = await pool.query(
      `SELECT metadata FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'emergency_page.sent' AND entity_id = $2`,
      [tenant.tenantId, sessionId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ attempt: 2, maxPages: 2 });
  });

  it('(a) an answered transfer cancels the ladder durably — resolution read from a FRESH repo instance', async () => {
    const sessionId = crypto.randomUUID();
    const sessions = new PgVoiceSessionRepository(pool);
    await sessions.create({
      id: sessionId,
      tenantId: tenant.tenantId,
      channel: 'voice_inbound',
      state: 'escalating',
    });
    // The /dial-result success branch stamps this via markEnded.
    await sessions.markEnded(tenant.tenantId, sessionId, {
      endedAt: new Date(),
      endedReason: 'transferred',
      outcome: 'escalated_to_human',
      state: 'terminated',
      channel: 'voice_inbound',
    });

    const queue = new PgQueue(pool);
    await queue.send(
      EMERGENCY_PAGE_JOB_TYPE,
      { ...ladderInput(tenant.tenantId, sessionId), attempt: 1, maxPages: 3, intervalMs: 60_000 },
      emergencyPageIdempotencyKey(tenant.tenantId, sessionId, 1),
      { delaySeconds: 0 },
    );

    // Fresh instance, no in-process session store — the check must resolve
    // purely from the persisted voice_sessions row (another replica answered).
    const { worker, smsCalls } = makeWorker(queue, {
      isResolved: createEmergencyPageResolvedCheck({
        voiceSessionRepo: new PgVoiceSessionRepository(pool),
      }),
    });
    await processNextPage(queue, worker);

    expect(smsCalls).toHaveLength(0);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM _queue_messages WHERE type = $1`,
      [EMERGENCY_PAGE_JOB_TYPE],
    );
    expect(rows[0].n).toBe(0); // no page, no continuation — ladder over
  });

  it('(b) dropped-call bridge: double-arm is one row and the phone→session lookup works from a fresh process instance', async () => {
    const sessionId = crypto.randomUUID();
    const scheduler = new DroppedCallScheduler(
      new PgDroppedCallRecoveryRepository(pool),
      logger,
    );

    const row = await scheduler.schedule({
      tenantId: tenant.tenantId,
      voiceSessionId: sessionId,
      callerE164: '+15551234567',
      outcome: 'dropped',
      channel: 'telephony',
    });
    expect(row).not.toBeNull();

    // Duplicate finalize (second replica / retried webhook) → same row.
    await scheduler.schedule({
      tenantId: tenant.tenantId,
      voiceSessionId: sessionId,
      callerE164: '+15551234567',
      outcome: 'dropped',
      channel: 'telephony',
    });
    const { rows: count } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM dropped_call_recoveries
        WHERE tenant_id = $1 AND voice_session_id = $2`,
      [tenant.tenantId, sessionId],
    );
    expect(count[0].n).toBe(1);

    // The inbound-SMS webhook may land on ANY replica: a brand-new repo
    // instance (fresh process) must find the thread — including through
    // caller-id formatting drift.
    const freshRepo = new PgDroppedCallRecoveryRepository(pool);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const hit = await freshRepo.findRecentByPhone(
      tenant.tenantId,
      '+1 (555) 123-4567',
      since,
    );
    expect(hit).not.toBeNull();
    expect(hit!.voiceSessionId).toBe(sessionId);

    // Tenant isolation: another tenant never sees the thread.
    const otherTenant = await createTestTenant(pool);
    expect(
      await freshRepo.findRecentByPhone(otherTenant.tenantId, '+15551234567', since),
    ).toBeNull();
  });

  it('(b) a restart between schedule and send never loses the recovery: a fresh sweep sends the SMS', async () => {
    const sessionId = crypto.randomUUID();
    const repo = new PgDroppedCallRecoveryRepository(pool);
    // Row scheduled in the (near) past — the process that scheduled it died.
    await repo.schedule({
      tenantId: tenant.tenantId,
      voiceSessionId: sessionId,
      callerE164: '+15551110042',
      scheduledFor: new Date(Date.now() - 1_000),
    });

    const smsCalls: Array<{ to: string; body: string }> = [];
    const handlerDeps: Omit<DroppedCallHandlerDeps, 'repo'> = {
      audit: new PgAuditRepository(pool),
      logger,
      rateLimit: {
        check: async () => true,
        record: async () => undefined,
      },
      resolvedSince: async () => null,
      compose: async () => 'Hi — this is Acme. We got cut off; reply to pick back up.',
      sendSms: async (input) => {
        smsCalls.push({ to: input.to, body: input.body });
        return `SM_uc5_${Date.now()}`;
      },
      thread: async () => undefined,
    };

    // Fresh repo + worker instances ≈ the restarted process's sweep.
    const result = await runDroppedCallRecoverySweep({
      repo: new PgDroppedCallRecoveryRepository(pool),
      handlerDeps,
      logger,
    });

    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(smsCalls.some((s) => s.to === '+15551110042')).toBe(true);

    const { rows } = await pool.query(
      `SELECT sent_at, sms_message_sid FROM dropped_call_recoveries
        WHERE tenant_id = $1 AND voice_session_id = $2`,
      [tenant.tenantId, sessionId],
    );
    expect(rows[0].sent_at).not.toBeNull();
    expect(rows[0].sms_message_sid).toMatch(/^SM_uc5_/);
  });
});
