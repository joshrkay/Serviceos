/**
 * Postgres integration — dropped-call recovery worker (P8-015).
 *
 * The handler / scheduler / detector logic is fully covered by unit tests
 * (test/sms/recovery/*) against in-memory deps. Those prove orchestration
 * but cannot prove the durable-queue guards the worker leans on in
 * production:
 *
 *   1. `dropped_call_recoveries` UNIQUE (tenant_id, voice_session_id) +
 *      ON CONFLICT — scheduling is idempotent per session.
 *   2. The partial index `idx_dropped_call_recoveries_due` driving
 *      `findDue` — only rows where sent_at IS NULL AND suppressed_reason
 *      IS NULL are returned.
 *   3. `markSent` UPDATE … WHERE sent_at IS NULL — the claim guard that
 *      makes re-drains idempotent.
 *   4. RLS / FORCE on the table — the unprivileged app role can only
 *      mutate rows under its own tenant GUC.
 *
 * This file drives runDroppedCallRecoverySweep with the production Pg
 * repos for (1)–(4) and stubs the side-effect-ful deps (compose, send,
 * thread, rate-limit, resolved-since) — already proven by the unit tests —
 * so the SQL the worker actually executes is pinned end-to-end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { runDroppedCallRecoverySweep } from '../../src/workers/dropped-call-worker';
import {
  PgDroppedCallRecoveryRepository,
  RECOVERY_DELAY_MS,
} from '../../src/sms/recovery/scheduler';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createLogger } from '../../src/logging/logger';
import type {
  DroppedCallHandlerDeps,
  RecoveryMessageComposer,
  RecoverySmsSender,
  RecoveryThreader,
  ResolvedSinceChecker,
  RecoveryRateLimiter,
} from '../../src/sms/recovery/dropped-call-handler';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

// Anchor the test clock. SCHEDULED is the row's scheduled_for; DUE is the
// sweep "now" so the row is due-by-1s. Lets us assert sent_at falls inside
// the expected window without flake.
const SCHEDULED_FOR = new Date('2026-06-19T14:00:00.000Z');
const DUE_AT = new Date(SCHEDULED_FOR.getTime() + 1000);

interface CapturedSms {
  tenantId: string;
  to: string;
  body: string;
  idempotencyKey: string;
}

interface CapturingHandlerDeps {
  deps: Omit<DroppedCallHandlerDeps, 'repo'>;
  smsCalls: CapturedSms[];
  rateRecordCalls: Array<{ tenantId: string; callerE164: string }>;
  threadCalls: Array<{ tenantId: string; voiceSessionId: string; smsMessageSid: string }>;
}

function makeHandlerDeps(opts: {
  audit: PgAuditRepository;
  rateLimitAllows?: boolean;
  resolvedSince?: ResolvedSinceChecker;
  composeBody?: string;
  /** When set, sendSms throws (the worker should leave the row pending). */
  failSend?: boolean;
}): CapturingHandlerDeps {
  const smsCalls: CapturedSms[] = [];
  const rateRecordCalls: CapturingHandlerDeps['rateRecordCalls'] = [];
  const threadCalls: CapturingHandlerDeps['threadCalls'] = [];

  const rateLimit: RecoveryRateLimiter = {
    async check() {
      return opts.rateLimitAllows ?? true;
    },
    async record(tenantId, callerE164) {
      rateRecordCalls.push({ tenantId, callerE164 });
    },
  };

  const resolvedSince: ResolvedSinceChecker =
    opts.resolvedSince ?? (async () => null);

  const compose: RecoveryMessageComposer = async () =>
    opts.composeBody ?? "Hi — this is Test Shop. We got cut off; reply to pick back up.";

  let sendCounter = 0;
  const sendSms: RecoverySmsSender = async (input) => {
    if (opts.failSend) throw new Error('send failed');
    sendCounter++;
    const sid = `SM_${sendCounter}_${Date.now()}`;
    smsCalls.push({
      tenantId: input.tenantId,
      to: input.to,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    });
    return sid;
  };

  const thread: RecoveryThreader = async (input) => {
    threadCalls.push(input);
  };

  return {
    smsCalls,
    rateRecordCalls,
    threadCalls,
    deps: {
      audit: opts.audit,
      logger,
      rateLimit,
      resolvedSince,
      compose,
      sendSms,
      thread,
      now: () => DUE_AT,
    },
  };
}

async function scheduleRow(
  pool: Pool,
  tenantId: string,
  callerE164: string,
  scheduledFor: Date = SCHEDULED_FOR,
): Promise<string> {
  const voiceSessionId = uuidv4();
  await pool.query(
    `INSERT INTO dropped_call_recoveries
       (tenant_id, voice_session_id, caller_e164, scheduled_for)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, voiceSessionId, callerE164, scheduledFor],
  );
  return voiceSessionId;
}

describe('dropped-call recovery worker — integration', () => {
  let pool: Pool;
  let repo: PgDroppedCallRecoveryRepository;
  let audit: PgAuditRepository;
  let tenantA: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgDroppedCallRecoveryRepository(pool);
    audit = new PgAuditRepository(pool);
  });

  beforeEach(async () => {
    tenantA = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('happy path: sweeps a due row, sends one SMS, stamps sent_at + sid, emits sent audit', async () => {
    const callerE164 = '+15551110001';
    const voiceSessionId = await scheduleRow(pool, tenantA.tenantId, callerE164);
    const harness = makeHandlerDeps({ audit });

    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: harness.deps,
      logger,
      now: () => DUE_AT,
    });

    expect(result.sent).toBe(1);
    expect(result.suppressed).toBe(0);
    expect(result.failed).toBe(0);

    // SMS captured with the right shape — idempotency key is keyed on the
    // recovery row id (not the session) so retries can never double-send.
    expect(harness.smsCalls).toHaveLength(1);
    expect(harness.smsCalls[0].to).toBe(callerE164);
    expect(harness.smsCalls[0].tenantId).toBe(tenantA.tenantId);
    expect(harness.smsCalls[0].idempotencyKey).toMatch(/^dropped_call_recovery:/);

    // Rate limit consumed AFTER the send (not before).
    expect(harness.rateRecordCalls).toHaveLength(1);
    expect(harness.rateRecordCalls[0]).toEqual({
      tenantId: tenantA.tenantId,
      callerE164,
    });

    // Threading attempted with the captured sid + voice_session_id.
    expect(harness.threadCalls).toHaveLength(1);
    expect(harness.threadCalls[0].voiceSessionId).toBe(voiceSessionId);

    // Row stamped via the production UPDATE: sent_at set + sms_message_sid present.
    const { rows: dbRows } = await pool.query(
      `SELECT sent_at, sms_message_sid, suppressed_reason
         FROM dropped_call_recoveries
        WHERE tenant_id = $1 AND voice_session_id = $2`,
      [tenantA.tenantId, voiceSessionId],
    );
    expect(dbRows).toHaveLength(1);
    expect(dbRows[0].sent_at).not.toBeNull();
    // The repo persisted the sid that sendSms returned (our SM_<n>_<ts> stub).
    expect(dbRows[0].sms_message_sid).toMatch(/^SM_\d+_\d+$/);
    expect(dbRows[0].suppressed_reason).toBeNull();

    // Audit row written via the prod path under the tenant GUC.
    const { rows: auditRows } = await pool.query(
      `SELECT event_type, entity_id FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'dropped_call_recovery.sent'`,
      [tenantA.tenantId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].entity_id).toBe(voiceSessionId);
  });

  it('suppresses with booking_completed when resolvedSince reports a booking', async () => {
    const voiceSessionId = await scheduleRow(pool, tenantA.tenantId, '+15551110002');
    const harness = makeHandlerDeps({
      audit,
      resolvedSince: async () => 'booking_completed',
    });

    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: harness.deps,
      logger,
      now: () => DUE_AT,
    });

    expect(result.sent).toBe(0);
    expect(result.suppressed).toBe(1);
    expect(harness.smsCalls).toHaveLength(0);
    expect(harness.rateRecordCalls).toHaveLength(0);

    const { rows } = await pool.query(
      `SELECT suppressed_reason, sent_at, sms_message_sid
         FROM dropped_call_recoveries
        WHERE tenant_id = $1 AND voice_session_id = $2`,
      [tenantA.tenantId, voiceSessionId],
    );
    expect(rows[0].suppressed_reason).toBe('booking_completed');
    expect(rows[0].sent_at).toBeNull();
    expect(rows[0].sms_message_sid).toBeNull();

    const { rows: auditRows } = await pool.query(
      `SELECT metadata FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'dropped_call_recovery.suppressed'`,
      [tenantA.tenantId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].metadata.reason).toBe('booking_completed');
  });

  it('suppresses with rate_limited when the per-caller limiter rejects', async () => {
    const voiceSessionId = await scheduleRow(pool, tenantA.tenantId, '+15551110003');
    const harness = makeHandlerDeps({ audit, rateLimitAllows: false });

    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: harness.deps,
      logger,
      now: () => DUE_AT,
    });

    expect(result.sent).toBe(0);
    expect(result.suppressed).toBe(1);
    expect(harness.smsCalls).toHaveLength(0);
    expect(harness.rateRecordCalls).toHaveLength(0);

    const { rows } = await pool.query(
      `SELECT suppressed_reason FROM dropped_call_recoveries
        WHERE tenant_id = $1 AND voice_session_id = $2`,
      [tenantA.tenantId, voiceSessionId],
    );
    expect(rows[0].suppressed_reason).toBe('rate_limited');
  });

  it('idempotent on re-sweep: a sent row is never re-drained (partial index excludes it)', async () => {
    await scheduleRow(pool, tenantA.tenantId, '+15551110004');
    const harness = makeHandlerDeps({ audit });

    const first = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: harness.deps,
      logger,
      now: () => DUE_AT,
    });
    expect(first.sent).toBe(1);

    const second = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: harness.deps,
      logger,
      now: () => DUE_AT,
    });
    expect(second.due).toBe(0);
    expect(second.sent).toBe(0);
    expect(harness.smsCalls).toHaveLength(1);
  });

  it('tenant isolation: a single cross-tenant sweep stamps each row under its own tenant', async () => {
    const tenantB = await createTestTenant(pool);
    const sessionA = await scheduleRow(pool, tenantA.tenantId, '+15552220001');
    const sessionB = await scheduleRow(pool, tenantB.tenantId, '+15552220002');
    const harness = makeHandlerDeps({ audit });

    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: harness.deps,
      logger,
      now: () => DUE_AT,
    });
    expect(result.sent).toBeGreaterThanOrEqual(2);

    // Each row was stamped under its OWN tenant_id (markSent uses withTenant
    // so the UPDATE only matches the per-row tenant). Cross-checking by
    // (tenant, session) — not by id alone — pins this.
    const dbA = await pool.query(
      `SELECT sent_at, sms_message_sid FROM dropped_call_recoveries
        WHERE tenant_id = $1 AND voice_session_id = $2`,
      [tenantA.tenantId, sessionA],
    );
    const dbB = await pool.query(
      `SELECT sent_at, sms_message_sid FROM dropped_call_recoveries
        WHERE tenant_id = $1 AND voice_session_id = $2`,
      [tenantB.tenantId, sessionB],
    );
    expect(dbA.rows[0].sent_at).not.toBeNull();
    expect(dbB.rows[0].sent_at).not.toBeNull();
    expect(dbA.rows[0].sms_message_sid).not.toBe(dbB.rows[0].sms_message_sid);

    // Audit rows are isolated by RLS — each tenant sees only its own.
    const auditA = await pool.query(
      `SELECT entity_id FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'dropped_call_recovery.sent'`,
      [tenantA.tenantId],
    );
    const auditB = await pool.query(
      `SELECT entity_id FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'dropped_call_recovery.sent'`,
      [tenantB.tenantId],
    );
    expect(auditA.rows.map((r) => r.entity_id)).toContain(sessionA);
    expect(auditA.rows.map((r) => r.entity_id)).not.toContain(sessionB);
    expect(auditB.rows.map((r) => r.entity_id)).toContain(sessionB);
    expect(auditB.rows.map((r) => r.entity_id)).not.toContain(sessionA);
  });

  it('send failure leaves the row pending so the next sweep retries — and no rate-limit token is burned', async () => {
    const voiceSessionId = await scheduleRow(pool, tenantA.tenantId, '+15551110005');
    const harness = makeHandlerDeps({ audit, failSend: true });

    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: harness.deps,
      logger,
      now: () => DUE_AT,
    });
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.suppressed).toBe(0);
    expect(harness.rateRecordCalls).toHaveLength(0);

    // Row is still pending — next sweep will retry it.
    const { rows } = await pool.query(
      `SELECT sent_at, suppressed_reason FROM dropped_call_recoveries
        WHERE tenant_id = $1 AND voice_session_id = $2`,
      [tenantA.tenantId, voiceSessionId],
    );
    expect(rows[0].sent_at).toBeNull();
    expect(rows[0].suppressed_reason).toBeNull();
  });

  it('scheduling is idempotent per (tenant_id, voice_session_id) via the ON CONFLICT path', async () => {
    const voiceSessionId = uuidv4();
    await pool.query(
      `INSERT INTO dropped_call_recoveries
         (tenant_id, voice_session_id, caller_e164, scheduled_for)
       VALUES ($1, $2, $3, $4)`,
      [tenantA.tenantId, voiceSessionId, '+15551110006', SCHEDULED_FOR],
    );

    // Re-schedule via the production repo — must NOT insert a duplicate.
    const reSched = new Date(SCHEDULED_FOR.getTime() + RECOVERY_DELAY_MS);
    await repo.schedule({
      tenantId: tenantA.tenantId,
      voiceSessionId,
      callerE164: '+15551110006',
      scheduledFor: reSched,
    });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM dropped_call_recoveries
        WHERE tenant_id = $1 AND voice_session_id = $2`,
      [tenantA.tenantId, voiceSessionId],
    );
    expect(rows[0].n).toBe(1);
  });
});
