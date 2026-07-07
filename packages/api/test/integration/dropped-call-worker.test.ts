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
import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import {
  runDroppedCallRecoverySweep,
  DROPPED_CALL_RECOVERY_FLAG,
} from '../../src/workers/dropped-call-worker';
import {
  PgDroppedCallRecoveryRepository,
  RECOVERY_DELAY_MS,
} from '../../src/sms/recovery/scheduler';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PhoneRateLimiter } from '../../src/shared/rate-limit/phone-rate-limit';
import { createRecoveryRateLimiter } from '../../src/sms/recovery/recovery-rate-limiter';
import { createDroppedCallResolvedSince } from '../../src/sms/recovery/resolved-since';
import { createRecoveryThreader } from '../../src/sms/recovery/recovery-threader';
import { createRecoveryComposer } from '../../src/sms/recovery/recovery-composer';
import { createInboundCaptureHandler } from '../../src/sms/inbound-capture';
import { PgFeatureFlagRepository } from '../../src/flags/pg-feature-flags';
import { PgTenantFeatureFlagRepository } from '../../src/flags/pg-tenant-feature-flags';
import { PgDncRepository } from '../../src/compliance/dnc';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgConversationRepository } from '../../src/conversations/pg-conversation';
import { PgConversationLinkRepository } from '../../src/conversations/pg-conversation-link';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgVoiceSessionRepository } from '../../src/voice/pg-voice-session';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
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

/**
 * Unprivileged role + GUC pattern mirrored from rls-tenant-isolation.test.ts.
 * The testcontainer's default user is a SUPERUSER (bypasses RLS), so any
 * isolation assertion that runs as the default user is testing the
 * application's WHERE-clause, not the policy. Running through asTenant under
 * this unprivileged NOBYPASSRLS role makes the policy itself the only thing
 * gating cross-tenant reads — if the policy were dropped, the assertion fails.
 */
const APP_ROLE = 'rls_app_runtime';

async function ensureRlsAppRole(pool: Pool): Promise<void> {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
      CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
    END IF;
  END $$;`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
}

async function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
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
    await ensureRlsAppRole(pool);
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

    // Audit rows are isolated by RLS. Query under the unprivileged
    // rls_app_runtime role with `app.current_tenant_id` set, and OMIT the
    // tenant_id predicate from the SQL — only the policy can scope these
    // results, so a dropped policy would fail this assertion (whereas a
    // `WHERE tenant_id = $1` query would still pass).
    const auditA = await asTenant(pool, tenantA.tenantId, (client) =>
      client.query(
        `SELECT entity_id FROM audit_events
          WHERE event_type = 'dropped_call_recovery.sent'`,
      ).then((r) => r.rows),
    );
    const auditB = await asTenant(pool, tenantB.tenantId, (client) =>
      client.query(
        `SELECT entity_id FROM audit_events
          WHERE event_type = 'dropped_call_recovery.sent'`,
      ).then((r) => r.rows),
    );
    expect(auditA.map((r: { entity_id: string }) => r.entity_id)).toContain(sessionA);
    expect(auditA.map((r: { entity_id: string }) => r.entity_id)).not.toContain(sessionB);
    expect(auditB.map((r: { entity_id: string }) => r.entity_id)).toContain(sessionB);
    expect(auditB.map((r: { entity_id: string }) => r.entity_id)).not.toContain(sessionA);
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

/**
 * P8-015 production adapter — ResolvedSinceChecker over REAL voice_sessions /
 * proposals rows, driven through the actual sweep so the dropped_call_recoveries
 * context JSONB round-trip (parseContext) is pinned against real Postgres.
 */
describe('resolved-since checker — integration (voice_sessions / proposals)', () => {
  let pool: Pool;
  let repo: PgDroppedCallRecoveryRepository;
  let audit: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let resolvedSince: ReturnType<typeof createDroppedCallResolvedSince>;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgDroppedCallRecoveryRepository(pool);
    audit = new PgAuditRepository(pool);
    resolvedSince = createDroppedCallResolvedSince({
      voiceSessionRepo: new PgVoiceSessionRepository(pool),
      proposalRepo: new PgProposalRepository(pool),
      logger,
    });
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
    // findDue drains cross-tenant: clear pending rows left by earlier
    // describes in this file so sweep counts here are exact.
    await pool.query(
      `DELETE FROM dropped_call_recoveries WHERE sent_at IS NULL AND suppressed_reason IS NULL`,
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedSession(opts: {
    outcome: string | null;
    customerId?: string;
    startedAt?: Date;
  }): Promise<string> {
    const id = uuidv4();
    await pool.query(
      `INSERT INTO voice_sessions (id, tenant_id, channel, state, customer_id, started_at, ended_at, outcome)
       VALUES ($1, $2, 'voice_inbound', 'ended', $3, $4, $4, $5)`,
      [id, tenant.tenantId, opts.customerId ?? null, opts.startedAt ?? SCHEDULED_FOR, opts.outcome],
    );
    return id;
  }

  async function sweepOnce(harness: CapturingHandlerDeps) {
    return runDroppedCallRecoverySweep({
      repo,
      handlerDeps: { ...harness.deps, resolvedSince },
      logger,
      now: () => DUE_AT,
    });
  }

  it('signal 1: a session that resolved to completed suppresses as booking_completed', async () => {
    const voiceSessionId = await seedSession({ outcome: 'completed' });
    await pool.query(
      `INSERT INTO dropped_call_recoveries (tenant_id, voice_session_id, caller_e164, scheduled_for)
       VALUES ($1, $2, '+15553330001', $3)`,
      [tenant.tenantId, voiceSessionId, SCHEDULED_FOR],
    );

    const harness = makeHandlerDeps({ audit });
    const result = await sweepOnce(harness);

    expect(result.suppressed).toBe(1);
    expect(harness.smsCalls).toHaveLength(0);
    const { rows } = await pool.query(
      `SELECT suppressed_reason FROM dropped_call_recoveries WHERE voice_session_id = $1`,
      [voiceSessionId],
    );
    expect(rows[0].suppressed_reason).toBe('booking_completed');
  });

  it('signal 2: an executed proposal from the persisted context suppresses (JSONB round-trip)', async () => {
    const voiceSessionId = await seedSession({ outcome: 'dropped' });
    const proposalId = uuidv4();
    await pool.query(
      `INSERT INTO proposals (id, tenant_id, proposal_type, created_by, status)
       VALUES ($1, $2, 'create_appointment', $3, 'executed')`,
      [proposalId, tenant.tenantId, tenant.userId],
    );
    // Persist context via the PRODUCTION schedule path so findDue's
    // parseContext reads it back from real JSONB.
    await repo.schedule({
      tenantId: tenant.tenantId,
      voiceSessionId,
      callerE164: '+15553330002',
      scheduledFor: SCHEDULED_FOR,
      context: { state: 'collecting', bucket: 'proposal_created', proposalIds: [proposalId] },
    });

    const harness = makeHandlerDeps({ audit });
    const result = await sweepOnce(harness);

    expect(result.suppressed).toBe(1);
    expect(harness.smsCalls).toHaveLength(0);
  });

  it('signal 3: a newer completed call-back for the same customer suppresses', async () => {
    const customerId = uuidv4();
    await pool.query(
      `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
       VALUES ($1, $2, 'Cal', 'Back', 'Cal Back', $3)`,
      [customerId, tenant.tenantId, tenant.userId],
    );
    const droppedId = await seedSession({
      outcome: 'dropped',
      customerId,
      startedAt: SCHEDULED_FOR,
    });
    await seedSession({
      outcome: 'completed',
      customerId,
      startedAt: new Date(SCHEDULED_FOR.getTime() + 30_000),
    });
    await pool.query(
      `INSERT INTO dropped_call_recoveries (tenant_id, voice_session_id, caller_e164, scheduled_for)
       VALUES ($1, $2, '+15553330003', $3)`,
      [tenant.tenantId, droppedId, SCHEDULED_FOR],
    );

    const harness = makeHandlerDeps({ audit });
    const result = await sweepOnce(harness);

    expect(result.suppressed).toBe(1);
    expect(harness.smsCalls).toHaveLength(0);
  });

  it('unresolved drop (outcome=dropped, no proposals, no call-back) proceeds to send', async () => {
    const voiceSessionId = await seedSession({ outcome: 'dropped' });
    await pool.query(
      `INSERT INTO dropped_call_recoveries (tenant_id, voice_session_id, caller_e164, scheduled_for)
       VALUES ($1, $2, '+15553330004', $3)`,
      [tenant.tenantId, voiceSessionId, SCHEDULED_FOR],
    );

    const harness = makeHandlerDeps({ audit });
    const result = await sweepOnce(harness);

    expect(result.sent).toBe(1);
    expect(harness.smsCalls).toHaveLength(1);
  });
});

/**
 * P8-015 — end-to-end wiring shape (U7): the sweep with FULL production
 * adapters (resolved-since, rate limit, DNC gate, threader over real
 * Postgres; deterministic composer; captured send) plus the per-tenant
 * flag gate resolved through the REAL tenant_feature_flags → _feature_flags
 * order — the SQL resolution unit tests cannot pin.
 */
describe('dropped-call recovery — end-to-end wiring (flag gate + production adapters)', () => {
  let pool: Pool;
  let repo: PgDroppedCallRecoveryRepository;
  let audit: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let platformFlags: PgFeatureFlagRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgDroppedCallRecoveryRepository(pool);
    audit = new PgAuditRepository(pool);
    platformFlags = new PgFeatureFlagRepository(pool);
    // _feature_flags is lazily created by the repo — force it into existence
    // so the beforeEach reset below can DELETE from it.
    await platformFlags.list();
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
    await pool.query(
      `DELETE FROM dropped_call_recoveries WHERE sent_at IS NULL AND suppressed_reason IS NULL`,
    );
    // Platform flag state is global — reset between tests.
    await pool.query(`DELETE FROM _feature_flags WHERE name = $1`, [
      DROPPED_CALL_RECOVERY_FLAG,
    ]);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** Fresh resolver per call — PgTenantFeatureFlagRepository caches 30s per instance. */
  function flagGate(): (tenantId: string) => Promise<boolean> {
    const tenantFlags = new PgTenantFeatureFlagRepository(pool, platformFlags);
    return (tenantId) => tenantFlags.isEnabledForTenant(tenantId, DROPPED_CALL_RECOVERY_FLAG);
  }

  function productionDeps(smsCalls: CapturedSms[]): Omit<DroppedCallHandlerDeps, 'repo'> {
    return {
      audit,
      logger,
      rateLimit: createRecoveryRateLimiter(new PhoneRateLimiter(pool), logger),
      resolvedSince: createDroppedCallResolvedSince({
        voiceSessionRepo: new PgVoiceSessionRepository(pool),
        proposalRepo: new PgProposalRepository(pool),
        logger,
      }),
      preSendSuppress: async (row) =>
        (await new PgDncRepository(pool).isOnDnc(
          row.tenantId,
          row.callerE164.replace(/\D/g, ''),
        ))
          ? 'opted_out'
          : null,
      compose: createRecoveryComposer({
        composerDeps: {
          gateway: { complete: async () => ({ content: 'unused', model: 'x', provider: 'x', tokenUsage: { input: 0, output: 0, total: 0 }, latencyMs: 0 }) } as never,
          settingsRepo: new PgSettingsRepository(pool),
        },
        businessName: 'Itest Shop',
        aiEnabled: false, // deterministic template — no LLM in integration
        logger,
      }),
      sendSms: async (input) => {
        smsCalls.push({
          tenantId: input.tenantId,
          to: input.to,
          body: input.body,
          idempotencyKey: input.idempotencyKey,
        });
        return `SM_e2e_${smsCalls.length}`;
      },
      thread: createRecoveryThreader({
        conversationRepo: new PgConversationRepository(pool),
        conversationLinkRepo: new PgConversationLinkRepository(pool),
        customerRepo: new PgCustomerRepository(pool),
        auditRepo: audit,
        logger,
      }),
      now: () => DUE_AT,
    };
  }

  it('flag off everywhere → row skipped and left pending; tenant override on → sends', async () => {
    const voiceSessionId = await scheduleRow(pool, tenant.tenantId, '+15556660001');
    const smsCalls: CapturedSms[] = [];
    const deps = productionDeps(smsCalls);

    // 1. No platform flag, no tenant override → skipped, still pending.
    const first = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: deps,
      logger,
      isEnabledForTenant: flagGate(),
      now: () => DUE_AT,
    });
    expect(first.skipped).toBe(1);
    expect(first.sent).toBe(0);
    const { rows: pending } = await pool.query(
      `SELECT sent_at, suppressed_reason FROM dropped_call_recoveries WHERE voice_session_id = $1`,
      [voiceSessionId],
    );
    expect(pending[0].sent_at).toBeNull();
    expect(pending[0].suppressed_reason).toBeNull();

    // 2. Tenant override on → the SAME row sends on the next sweep.
    const tenantFlags = new PgTenantFeatureFlagRepository(pool, platformFlags);
    await tenantFlags.setTenantFlag(tenant.tenantId, DROPPED_CALL_RECOVERY_FLAG, true);
    const second = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: deps,
      logger,
      isEnabledForTenant: flagGate(),
      now: () => DUE_AT,
    });
    expect(second.sent).toBe(1);
    expect(smsCalls).toHaveLength(1);
    // The production sendSms contract: tenantId for subaccount routing and
    // the row-derived idempotency key for Twilio-side dedupe.
    expect(smsCalls[0].tenantId).toBe(tenant.tenantId);
    expect(smsCalls[0].idempotencyKey).toMatch(/^dropped_call_recovery:/);
    expect(smsCalls[0].body).toContain('Itest Shop');
  });

  it('tenant override OFF wins over an enabled platform flag (kill switch)', async () => {
    await scheduleRow(pool, tenant.tenantId, '+15556660002');
    await platformFlags.upsert({
      name: DROPPED_CALL_RECOVERY_FLAG,
      enabled: true,
      description: 'test',
    });
    const tenantFlags = new PgTenantFeatureFlagRepository(pool, platformFlags);
    await tenantFlags.setTenantFlag(tenant.tenantId, DROPPED_CALL_RECOVERY_FLAG, false);

    const smsCalls: CapturedSms[] = [];
    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: productionDeps(smsCalls),
      logger,
      isEnabledForTenant: flagGate(),
      now: () => DUE_AT,
    });
    expect(result.skipped).toBe(1);
    expect(smsCalls).toHaveLength(0);
  });

  it('a DNC caller is suppressed as opted_out through the production gate', async () => {
    const callerE164 = '+15556660003';
    const voiceSessionId = await scheduleRow(pool, tenant.tenantId, callerE164);
    await new PgDncRepository(pool).addToDnc(
      tenant.tenantId,
      callerE164.replace(/\D/g, ''),
      'sms_stop',
    );
    const tenantFlags = new PgTenantFeatureFlagRepository(pool, platformFlags);
    await tenantFlags.setTenantFlag(tenant.tenantId, DROPPED_CALL_RECOVERY_FLAG, true);

    const smsCalls: CapturedSms[] = [];
    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: productionDeps(smsCalls),
      logger,
      isEnabledForTenant: flagGate(),
      now: () => DUE_AT,
    });
    expect(result.suppressed).toBe(1);
    expect(smsCalls).toHaveLength(0);
    const { rows } = await pool.query(
      `SELECT suppressed_reason FROM dropped_call_recoveries WHERE voice_session_id = $1`,
      [voiceSessionId],
    );
    expect(rows[0].suppressed_reason).toBe('opted_out');
  });

  it('concurrent sweeps: no SKIP LOCKED means both may fetch, but markSent is single-winner and both sends share one idempotency key', async () => {
    const voiceSessionId = await scheduleRow(pool, tenant.tenantId, '+15556660004');
    const tenantFlags = new PgTenantFeatureFlagRepository(pool, platformFlags);
    await tenantFlags.setTenantFlag(tenant.tenantId, DROPPED_CALL_RECOVERY_FLAG, true);

    const smsCalls: CapturedSms[] = [];
    const deps = productionDeps(smsCalls);
    const gate = flagGate();
    // Two "replicas" sweeping the same instant (the leader lock normally
    // prevents this — this pins the documented defense-in-depth behavior).
    await Promise.all([
      runDroppedCallRecoverySweep({ repo, handlerDeps: deps, logger, isEnabledForTenant: gate, now: () => DUE_AT }),
      runDroppedCallRecoverySweep({ repo, handlerDeps: deps, logger, isEnabledForTenant: gate, now: () => DUE_AT }),
    ]);

    // Both may have attempted the send (documented: exactly-once rests on the
    // leader lock + provider idempotency), but every attempt carried the SAME
    // row-derived idempotency key, so Twilio collapses them...
    expect(smsCalls.length).toBeGreaterThanOrEqual(1);
    expect(new Set(smsCalls.map((c) => c.idempotencyKey)).size).toBe(1);
    // ...and the row is stamped exactly once (markSent WHERE sent_at IS NULL).
    const { rows } = await pool.query(
      `SELECT sent_at, sms_message_sid FROM dropped_call_recoveries WHERE voice_session_id = $1`,
      [voiceSessionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sent_at).not.toBeNull();
    expect(rows[0].sms_message_sid).toBeTruthy();
  });
});

/**
 * P8-015 / P0-037 production adapter — RecoveryThreader over REAL
 * conversations / messages / conversation_links. The unit tests prove the
 * threading logic against in-memory repos; only real Postgres can prove the
 * actual P0-037 outcome — the outbound recovery and the caller's later
 * INBOUND reply resolve to the SAME conversation row (both directions share
 * the phone→thread resolution and the one-open-thread unique indexes).
 */
describe('recovery threader — integration (conversations / conversation_links)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let conversationRepo: PgConversationRepository;
  let linkRepo: PgConversationLinkRepository;
  let customerRepo: PgCustomerRepository;
  let audit: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    conversationRepo = new PgConversationRepository(pool);
    linkRepo = new PgConversationLinkRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    audit = new PgAuditRepository(pool);
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('outbound recovery and a later inbound reply land on the SAME conversation', async () => {
    const callerE164 = '+15554440001';
    const voiceSessionId = uuidv4();
    const customerId = uuidv4();
    // primary_phone feeds the GENERATED phone_normalized column that
    // findByPhoneNormalized (both directions' thread resolution) matches on.
    await pool.query(
      `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, primary_phone, created_by)
       VALUES ($1, $2, 'Rey', 'Ortiz', 'Rey Ortiz', $3, $4)`,
      [customerId, tenant.tenantId, callerE164, tenant.userId],
    );

    const thread = createRecoveryThreader({
      conversationRepo,
      conversationLinkRepo: linkRepo,
      customerRepo,
      auditRepo: audit,
      logger,
    });
    await thread({
      tenantId: tenant.tenantId,
      voiceSessionId,
      smsMessageSid: 'SM_out_1',
      callerE164,
      body: 'We got cut off — reply to pick back up.',
    });

    // The caller replies: run the REAL inbound capture handler.
    const capture = createInboundCaptureHandler({
      conversationRepo,
      customerRepo,
      auditRepo: audit,
      logger,
    });
    const captureResult = await capture.handle({
      tenantId: tenant.tenantId,
      fromE164: callerE164,
      body: 'Yes please — same time tomorrow works.',
      messageSid: 'SM_in_1',
    });
    expect(captureResult.handled).toBe(true);

    // One conversation, both directions on it.
    const conversations = await conversationRepo.findByEntity(
      tenant.tenantId,
      'customer',
      customerId,
    );
    expect(conversations).toHaveLength(1);
    const messages = await conversationRepo.getMessages(tenant.tenantId, conversations[0].id);
    expect(messages).toHaveLength(2);
    const directions = messages.map((m) => (m.metadata ?? {}).direction).sort();
    expect(directions).toEqual(['inbound', 'outbound']);

    // P0-037 links resolve the voice session to that conversation.
    const links = await linkRepo.findByEntity(tenant.tenantId, 'voice_session', voiceSessionId);
    expect(links).toHaveLength(1);
    expect(links[0].conversationId).toBe(conversations[0].id);
  });

  it('re-threading is idempotent against the real unique indexes (links + one open thread)', async () => {
    const callerE164 = '+15554440002';
    const voiceSessionId = uuidv4();
    const thread = createRecoveryThreader({
      conversationRepo,
      conversationLinkRepo: linkRepo,
      customerRepo,
      auditRepo: audit,
      logger,
    });
    const input = {
      tenantId: tenant.tenantId,
      voiceSessionId,
      smsMessageSid: 'SM_out_2',
      callerE164,
      body: 'We got cut off — reply to pick back up.',
    };
    await thread(input);
    await thread(input);

    const conversations = await conversationRepo.findByEntity(
      tenant.tenantId,
      'sms_unmatched',
      callerE164,
    );
    expect(conversations).toHaveLength(1);
    const links = await linkRepo.findByEntity(tenant.tenantId, 'voice_session', voiceSessionId);
    expect(links).toHaveLength(1);
  });
});

/**
 * P8-015 production adapter — RecoveryRateLimiter over the REAL
 * phone_rate_limits table. The adapter's unit tests pin the delegation
 * mapping against a stub; only real Postgres can prove the semantics the
 * check/record split exists for: checks record nothing, one send records
 * one bucket, and the advisory-xact-lock keeps concurrent consumes exact.
 */
describe('recovery rate-limiter — integration (phone_rate_limits)', () => {
  let pool: Pool;
  let tenant: { tenantId: string };
  let adapter: ReturnType<typeof createRecoveryRateLimiter>;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    adapter = createRecoveryRateLimiter(new PhoneRateLimiter(pool), logger);
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function bucketCount(tenantId: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(count), 0)::int AS total
         FROM phone_rate_limits WHERE tenant_id = $1 AND scope = 'sms_recovery'`,
      [tenantId],
    );
    return rows[0].total;
  }

  it('check() is non-consuming: N checks leave zero rows and stay allowed', async () => {
    const caller = '+15552220001';
    for (let i = 0; i < 5; i++) {
      expect(await adapter.check(tenant.tenantId, caller)).toBe(true);
    }
    expect(await bucketCount(tenant.tenantId)).toBe(0);
  });

  it('record() after a send consumes exactly one token; the next check is denied', async () => {
    const caller = '+15552220002';
    expect(await adapter.check(tenant.tenantId, caller)).toBe(true);
    await adapter.record(tenant.tenantId, caller);

    expect(await bucketCount(tenant.tenantId)).toBe(1);
    // RECOVERY_RATE_LIMIT_MAX = 1: the caller's single 5-minute token is gone.
    expect(await adapter.check(tenant.tenantId, caller)).toBe(false);
  });

  it('concurrent record()s for one caller admit exactly the limit (advisory-lock atomicity)', async () => {
    const caller = '+15552220003';
    await Promise.all(
      Array.from({ length: 5 }, () => adapter.record(tenant.tenantId, caller)),
    );
    // tryConsume's transaction-scoped advisory lock serializes the
    // read-decide-write: exactly RECOVERY_RATE_LIMIT_MAX (1) is recorded no
    // matter how many racers; the rest hit the cap (logged, not thrown).
    expect(await bucketCount(tenant.tenantId)).toBe(1);
  });
});
