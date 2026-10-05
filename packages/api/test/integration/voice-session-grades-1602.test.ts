/**
 * #1602 — Postgres integration: `voice_session_grades` (migration 305) and the
 * Pg store the production grader reads production calls through.
 *
 * Pins, against real columns:
 *   - the eligibility read over EXISTING tables: `voice_sessions` (ended,
 *     voice_inbound, transcript), `consent_events` (the recording-disclosure
 *     row the transports commit once the disclosure played; a later
 *     revocation un-grades the call), `call_usage_events.billable` (owner /
 *     business-phone test calls excluded) and `call_transcript_turns`
 *     timing markers;
 *   - a seeded ended call graded END-TO-END through `gradeVoiceSession`
 *     against this store, then read back through the owner summary;
 *   - the per-tenant quota columns on tenant_settings, with defaults;
 *   - RLS: FORCE + tenant_isolation, observed as the unprivileged runtime role.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import type { LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import { PgVoiceSessionGradeStore } from '../../src/voice/quality/pg-voice-session-grade-store';
import { createVoiceSessionGrader } from '../../src/voice/quality/grade-voice-session';
import { PgPlatformSloRepository } from '../../src/monitoring/pg-platform-slo';

const APP_ROLE = 'rls_app_runtime';
const NOW = new Date('2026-10-05T08:00:00.000Z');
const WINDOW = { endedSince: new Date('2026-10-04T08:00:00.000Z'), endedBefore: NOW, limit: 100 };

interface SeedCallOpts {
  channel?: 'voice_inbound' | 'inapp_voice';
  endedAt?: Date;
  disclosed?: boolean;
  revokedLater?: boolean;
  billable?: boolean | null;
  transcript?: string[] | null;
  timings?: Array<{ speaker: 'caller' | 'agent'; startedAt: Date }>;
}

async function seedCall(pool: Pool, tenant: TestTenant, opts: SeedCallOpts = {}): Promise<string> {
  const id = crypto.randomUUID();
  const endedAt = opts.endedAt ?? new Date('2026-10-04T15:02:00.000Z');
  const startedAt = new Date(endedAt.getTime() - 120_000);
  const callSid = `CA${id.replace(/-/g, '').slice(0, 30)}`;
  const transcript =
    opts.transcript === undefined
      ? [
          'agent: Thanks for calling Rivera Plumbing. This call may be recorded.',
          'caller: When is my next appointment?',
          'agent: Your next appointment is Tuesday at 10am.',
        ]
      : opts.transcript;
  await pool.query(
    `INSERT INTO voice_sessions (id, tenant_id, channel, call_sid, state, started_at, ended_at, ended_reason, outcome, transcript)
     VALUES ($1, $2, $3, $4, 'closing', $5, $6, 'hangup', 'completed', $7::jsonb)`,
    [id, tenant.tenantId, opts.channel ?? 'voice_inbound', callSid, startedAt, endedAt,
      transcript === null ? null : JSON.stringify(transcript)],
  );
  if (opts.disclosed ?? true) {
    await pool.query(
      `INSERT INTO consent_events (tenant_id, customer_id, phone_normalized, kind, state, source, voice_session_id)
       VALUES ($1, NULL, '+16025550101', 'recording', 'implicit', 'voice', $2)`,
      [tenant.tenantId, id],
    );
  }
  if (opts.revokedLater) {
    await pool.query(
      `INSERT INTO consent_events (tenant_id, customer_id, phone_normalized, kind, state, source, voice_session_id)
       VALUES ($1, NULL, '+16025550101', 'recording', 'revoked', 'voice', $2)`,
      [tenant.tenantId, id],
    );
  }
  const billable = opts.billable === undefined ? true : opts.billable;
  if (billable !== null) {
    await pool.query(
      `INSERT INTO call_usage_events (tenant_id, call_id, caller_phone, started_at, ended_at, duration_seconds, billable, not_billable_reason)
       VALUES ($1, $2, '+16025550101', $3, $4, 120, $5, $6)`,
      [tenant.tenantId, id, startedAt, endedAt, billable, billable ? null : 'own_number'],
    );
  }
  for (const [i, t] of (opts.timings ?? []).entries()) {
    await pool.query(
      `INSERT INTO call_transcript_turns (tenant_id, call_sid, session_id, turn_index, speaker, text, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenant.tenantId, callSid, id, i, t.speaker, `turn ${i}`, t.startedAt],
    );
  }
  return id;
}

function fakeGateway() {
  return {
    complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => ({
      content:
        req.taskType === 'voice_quality_perceived_completion'
          ? JSON.stringify({
              perceivedSatisfaction: 'good',
              rationale: 'Caller got the appointment time without friction',
              abandonmentRisk: 0,
            })
          : JSON.stringify({
              answerMeaningMatches: true,
              softSlotsReasonable: true,
              rationale: 'Gave the appointment day and time directly',
            }),
      model: 'judge-mock-1',
      provider: 'mock',
      tokenUsage: { input: 10, output: 5, total: 15 },
      latencyMs: 1,
      costMicroCents: 250_000,
    })),
  };
}

async function asTenantRole<T>(pool: Pool, tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
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

describe('Postgres integration — voice_session_grades + PgVoiceSessionGradeStore (#1602)', () => {
  let pool: Pool;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let store: PgVoiceSessionGradeStore;
  let eligible: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    for (const t of [tenantA, tenantB]) {
      await pool.query(
        `INSERT INTO tenant_settings (tenant_id, business_name, timezone) VALUES ($1, 'Rivera Plumbing', 'America/Phoenix')
         ON CONFLICT (tenant_id) DO NOTHING`,
        [t.tenantId],
      );
    }
    store = new PgVoiceSessionGradeStore(pool);

    eligible = await seedCall(pool, tenantA, {
      timings: [
        { speaker: 'caller', startedAt: new Date('2026-10-04T15:00:10.000Z') },
        { speaker: 'agent', startedAt: new Date('2026-10-04T15:00:12.000Z') },
      ],
    });
    await seedCall(pool, tenantA, { disclosed: false });
    await seedCall(pool, tenantA, { billable: false });
    await seedCall(pool, tenantA, { billable: null });
    await seedCall(pool, tenantA, { channel: 'inapp_voice' });
    await seedCall(pool, tenantA, { revokedLater: true });
    await seedCall(pool, tenantA, { transcript: null });
    await seedCall(pool, tenantA, { endedAt: new Date('2026-10-01T15:02:00.000Z') });
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('lists only ended inbound calls that carried the disclosure, were billable and have a transcript', async () => {
    expect(await store.listUngradedCandidates(tenantA.tenantId, WINDOW)).toEqual([eligible]);
    expect(await store.listUngradedCandidates(tenantB.tenantId, WINDOW)).toEqual([]);
  });

  it('loads the call with its disclosure + billable evidence, tenant zone and stored timing markers', async () => {
    const session = await store.loadSession(tenantA.tenantId, eligible);
    expect(session).toMatchObject({
      id: eligible,
      channel: 'voice_inbound',
      recordingDisclosed: true,
      billable: true,
      timezone: 'America/Phoenix',
      outcome: 'completed',
    });
    expect(session!.transcript).toHaveLength(3);
    expect(session!.turnTimings).toEqual([
      { speaker: 'caller', startedAt: new Date('2026-10-04T15:00:10.000Z') },
      { speaker: 'agent', startedAt: new Date('2026-10-04T15:00:12.000Z') },
    ]);
    expect(await store.loadSession(tenantB.tenantId, eligible)).toBeNull();
  });

  it('reads the per-tenant sample rate + daily cap from tenant_settings, defaulting to 20% / 20', async () => {
    expect(await store.quota(tenantA.tenantId)).toEqual({ sampleRatePct: 20, dailyCap: 20 });
    await pool.query(
      `UPDATE tenant_settings SET voice_quality_sample_rate_pct = 50, voice_quality_daily_cap = 5 WHERE tenant_id = $1`,
      [tenantB.tenantId],
    );
    expect(await store.quota(tenantB.tenantId)).toEqual({ sampleRatePct: 50, dailyCap: 5 });
  });

  it('grades the seeded call end-to-end and the owner summary reads it back', async () => {
    const grader = createVoiceSessionGrader({ store, gateway: fakeGateway(), now: () => NOW });
    // Platform SLO read (cross-tenant, 7-day window on graded_at). The lane DB
    // keeps earlier runs' rows, so assert the delta this grade contributes.
    const slo = new PgPlatformSloRepository(pool);
    const sloWindowStart = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const before = await slo.gradedPassRate(sloWindowStart);

    const result = await grader.gradeVoiceSession(tenantA.tenantId, eligible, { trigger: 'nightly' });

    expect(result.status).toBe('graded');
    const after = await slo.gradedPassRate(sloWindowStart);
    expect(after).toEqual({ total: before.total + 1, passed: before.passed + 1 });
    const summary = await store.summary(tenantA.tenantId, NOW);
    expect(summary.last7d).toEqual({ graded: 1, passed: 1 });
    expect(summary.last30d).toEqual({ graded: 1, passed: 1 });
    expect(summary.recent).toHaveLength(1);
    const stored = summary.recent[0];
    expect(stored).toMatchObject({
      sessionId: eligible,
      passed: true,
      model: 'judge-mock-1',
      judgeCalls: 2,
      costMicroCents: 500_000,
      trigger: 'nightly',
      callEndedAt: new Date('2026-10-04T15:02:00.000Z'),
      outcome: 'completed',
    });
    expect(stored.criteria).toEqual(
      expect.arrayContaining([
        { grader: 'floor', criterion: 3, name: 'noHang', passed: true, rationale: 'Every turn was answered within the 7s hard cap' },
        { grader: 'perceived_completion', criterion: 12, name: 'rightCallerFacingAnswer', passed: true, rationale: 'Caller got the appointment time without friction' },
      ]),
    );
    // Graded calls leave the candidate set and count against today's cap.
    expect(await store.listUngradedCandidates(tenantA.tenantId, WINDOW)).toEqual([]);
    expect(await store.countGradedSince(tenantA.tenantId, new Date('2026-10-05T00:00:00.000Z'))).toBe(1);
    // A second grade of the same call replaces, never duplicates.
    expect((await grader.gradeVoiceSession(tenantA.tenantId, eligible, { force: true })).status).toBe('graded');
    expect((await store.summary(tenantA.tenantId, NOW)).recent).toHaveLength(1);
  });

  it('isolates grades per tenant under RLS (FORCE + tenant_isolation, as the runtime role)', async () => {
    expect((await store.summary(tenantB.tenantId, NOW)).recent).toEqual([]);
    const seenByB = await asTenantRole(pool, tenantB.tenantId, async (c) => {
      const r = await c.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM voice_session_grades');
      return Number(r.rows[0].n);
    });
    const seenByA = await asTenantRole(pool, tenantA.tenantId, async (c) => {
      const r = await c.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM voice_session_grades');
      return Number(r.rows[0].n);
    });
    expect(seenByB).toBe(0);
    expect(seenByA).toBe(1);
    // FORCE: even the table owner is subject to the policy.
    const forced = await pool.query<{ relforcerowsecurity: boolean }>(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'voice_session_grades'`,
    );
    expect(forced.rows[0].relforcerowsecurity).toBe(true);
  });
});
