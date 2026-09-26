/**
 * #1208 (PRIVACY/RETENTION) — `voice_sessions.transcript` must be cleared by
 * the recording-retention sweep once the call is past the tenant's
 * `recording_retention_days`.
 *
 * `PgVoiceSessionRepository.markEnded` persists the full FSM transcript onto
 * `voice_sessions.transcript` (migration 092) at hangup. The C6 purge clears
 * `voice_recordings.transcript` and #1202 purges `call_transcript_turns`, but
 * before this fix nothing cleared this copy of the same text, so it survived
 * forever whether or not the call had a recording.
 *
 * Readers checked (see the PR): only `GET /api/interactions` (list excerpt +
 * detail transcript) and `PgVoiceSessionRepository.findById` read the column,
 * and both already treat NULL as "no transcript" (`[]` / empty excerpt).
 *
 * Every assertion runs the PRODUCTION sweep against the PRODUCTION repository
 * at real Postgres with RLS_RUNTIME_ROLE on. Sessions are written through the
 * product writer (`PgVoiceSessionRepository.markEnded`). SQL fixtures only for
 * what no product surface can produce: `recording_retention_days`,
 * `legal_hold`, and aging `started_at` (the clock, never the content).
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  closeSharedTestDb,
  createTestTenant,
  getSharedTestDb,
  type TestTenant,
} from './shared';
import { PgVoiceSessionRepository } from '../../src/voice/pg-voice-session';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { DevStorageProvider } from '../../src/files/storage-provider';
import { recordInboundCall } from '../../src/voice/voice-service';
import {
  PgRecordingRetentionRepository,
  runRecordingRetentionSweep,
  type RecordingRetentionSweepResult,
} from '../../src/workers/recording-retention-worker';
import type { Logger } from '../../src/logging/logger';

interface LoggedLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

function capturingLogger(lines: LoggedLine[]): Logger {
  const push = (level: LoggedLine['level']) => (message: string, meta?: Record<string, unknown>) => {
    lines.push({ level, message, ...(meta ? { meta } : {}) });
  };
  const logger: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return logger;
}

let pool: Pool;
let sessionRepo: PgVoiceSessionRepository;
let auditRepo: PgAuditRepository;
const storage = new DevStorageProvider({
  bucket: 'dev',
  publicUrlBase: 'http://localhost:3000/storage-dev',
});

beforeAll(async () => {
  pool = await getSharedTestDb();
  sessionRepo = new PgVoiceSessionRepository(pool);
  auditRepo = new PgAuditRepository(pool);
});

afterAll(async () => {
  await closeSharedTestDb();
});

async function seedTenant(retentionDays: number): Promise<TestTenant> {
  const t = await createTestTenant(pool);
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, recording_retention_days)
     VALUES (gen_random_uuid(), $1, $2, $3)`,
    [t.tenantId, `Retention ${retentionDays}d Co`, retentionDays],
  );
  return t;
}

function newCallSid(): string {
  return `CA${crypto.randomUUID().replace(/-/g, '')}`;
}

/** A finished call exactly as the FSM hangup writes it, aged by `ageDays`. */
async function seedEndedSession(
  t: TestTenant,
  ageDays: number,
  transcript: string[],
  callSid: string = newCallSid(),
): Promise<{ id: string; callSid: string }> {
  const id = crypto.randomUUID();
  const row = await sessionRepo.markEnded(t.tenantId, id, {
    endedAt: new Date(),
    endedReason: 'caller_hangup',
    outcome: 'completed',
    state: 'ended',
    channel: 'voice_inbound',
    callSid,
    transcript,
  });
  expect(row?.transcript).toEqual(transcript);
  // Fixture clock only.
  await pool.query(
    `UPDATE voice_sessions
        SET started_at = now() - make_interval(days => $3),
            ended_at   = now() - make_interval(days => $3)
      WHERE tenant_id = $1 AND id = $2`,
    [t.tenantId, id, ageDays],
  );
  return { id, callSid };
}

async function voicemailLeg(t: TestTenant, callSid: string, legalHold: boolean): Promise<string> {
  const { voiceRecordingId, inserted } = await recordInboundCall(pool, {
    tenantId: t.tenantId,
    callSid,
    recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE${crypto.randomUUID().replace(/-/g, '')}`,
    durationSeconds: 12,
    storageBucket: 'test-bucket',
    storageKey: `voicemail/${t.tenantId}/${callSid}.mp3`,
    sizeBytes: 2048,
    createdBy: 'voicemail_webhook',
  });
  expect(inserted).toBe(true);
  if (legalHold) {
    await pool.query(`UPDATE voice_recordings SET legal_hold = true WHERE id = $1`, [voiceRecordingId]);
  }
  return voiceRecordingId;
}

async function sessionRow(
  tenantId: string,
  id: string,
): Promise<{ transcript: unknown; outcome: string | null; call_sid: string | null }> {
  const { rows } = await pool.query(
    `SELECT transcript, outcome, call_sid FROM voice_sessions WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0];
}

describe('#1208 — the retention sweep clears voice_sessions.transcript past the tenant horizon (real Postgres)', () => {
  let tenantA: TestTenant; // 30-day retention
  let tenantB: TestTenant; // 90-day retention (T3: divergent config)
  let stranger: TestTenant; // holds a recording under tenant A's CallSid string
  let oldA: { id: string; callSid: string };
  let freshA: { id: string; callSid: string };
  let heldA: { id: string; callSid: string };
  let unheldRecordingA: { id: string; callSid: string };
  let strangerHeldA: { id: string; callSid: string };
  let oldB: { id: string; callSid: string };
  let result: RecordingRetentionSweepResult;
  const lines: LoggedLine[] = [];

  beforeAll(async () => {
    tenantA = await seedTenant(30);
    tenantB = await seedTenant(90);
    stranger = await seedTenant(30);

    // A: 31-day-old call with no recording (Media Streams / inapp).
    oldA = await seedEndedSession(tenantA, 31, ['caller: my furnace is banging', 'agent: booking you in']);
    // A: yesterday's call — inside the horizon.
    freshA = await seedEndedSession(tenantA, 1, ['caller: is anyone available today']);
    // A: 400-day-old call whose voicemail-leg recording is on legal hold.
    heldA = await seedEndedSession(tenantA, 400, ['caller: I want to dispute the invoice']);
    await voicemailLeg(tenantA, heldA.callSid, true);
    // A: old call with a recording that is NOT on hold → still cleared.
    unheldRecordingA = await seedEndedSession(tenantA, 31, ['caller: call me back about my quote']);
    await voicemailLeg(tenantA, unheldRecordingA.callSid, false);
    // A: old call; ANOTHER tenant holds a recording with the same CallSid string (T1).
    strangerHeldA = await seedEndedSession(tenantA, 31, ['caller: the thermostat is blank']);
    await voicemailLeg(stranger, strangerHeldA.callSid, true);
    // B (90d): same 31-day age as A's cleared call.
    oldB = await seedEndedSession(tenantB, 31, ['caller: my AC stopped cooling', 'agent: Thursday works']);

    const dump = `SELECT CASE tenant_id WHEN $1 THEN 'A (30d)' ELSE 'B (90d)' END AS tenant,
                         call_sid, outcome, transcript,
                         extract(day from now() - started_at)::int AS age_days
                    FROM voice_sessions WHERE tenant_id IN ($1, $2) ORDER BY 1, started_at`;
    const before = await pool.query(dump, [tenantA.tenantId, tenantB.tenantId]);
    console.log('[#1208] voice_sessions BEFORE sweep:\n' + JSON.stringify(before.rows, null, 2));

    result = await runRecordingRetentionSweep({
      repo: new PgRecordingRetentionRepository(pool),
      storage,
      auditRepo,
      logger: capturingLogger(lines),
    });

    const after = await pool.query(dump, [tenantA.tenantId, tenantB.tenantId]);
    console.log('[#1208] voice_sessions AFTER sweep:\n' + JSON.stringify(after.rows, null, 2));
    console.log('[#1208] sweep result: ' + JSON.stringify(result));
  });

  it("clears tenant A's 31-day-old session transcript; the row and its non-content columns are kept", async () => {
    expect(await sessionRow(tenantA.tenantId, oldA.id)).toEqual({
      transcript: null,
      outcome: 'completed',
      call_sid: oldA.callSid,
    });
  });

  it('also clears an old session whose same-CallSid recording is NOT on legal hold', async () => {
    expect((await sessionRow(tenantA.tenantId, unheldRecordingA.id)).transcript).toBeNull();
  });

  it("keeps tenant A's 1-day-old session transcript (inside the horizon)", async () => {
    expect((await sessionRow(tenantA.tenantId, freshA.id)).transcript).toEqual([
      'caller: is anyone available today',
    ]);
  });

  it('keeps a session transcript past retention when a same-tenant recording for its CallSid is on legal hold', async () => {
    expect((await sessionRow(tenantA.tenantId, heldA.id)).transcript).toEqual([
      'caller: I want to dispute the invoice',
    ]);
  });

  it("T1: another tenant's held recording with the same CallSid string does not protect this tenant's session", async () => {
    expect((await sessionRow(tenantA.tenantId, strangerHeldA.id)).transcript).toBeNull();
  });

  it('T3: tenant B (90-day retention) keeps its 31-day-old session transcript in the same sweep', async () => {
    expect((await sessionRow(tenantB.tenantId, oldB.id)).transcript).toEqual([
      'caller: my AC stopped cooling',
      'agent: Thursday works',
    ]);
  });

  it('counts the clears in the sweep result and the completion log', async () => {
    expect(result.sessionTranscriptsPurged).toBeGreaterThanOrEqual(3);
    expect(result.sessionTranscriptTenantsFailed).toBe(0);
    const completed = lines.find((l) => l.message === 'recording-retention sweep completed');
    expect(completed?.meta?.sessionTranscriptsPurged).toBe(result.sessionTranscriptsPurged);
  });

  it('emits a system audit event per cleared session, and none for tenant B', async () => {
    const events = await auditRepo.findByEntity(tenantA.tenantId, 'voice_session', oldA.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: tenantA.tenantId,
      actorId: 'recording-retention-worker',
      actorRole: 'system',
      eventType: 'voice_session.transcript_purged',
      entityType: 'voice_session',
      entityId: oldA.id,
    });
    expect(events[0].metadata).toMatchObject({
      callSid: oldA.callSid,
      reason: 'session_transcript_past_retention',
      derivedPurged: { sessionTranscriptLines: 2 },
    });
    expect(await auditRepo.findByEntity(tenantB.tenantId, 'voice_session', oldB.id)).toEqual([]);
  });

  it('is idempotent: a second sweep clears nothing more for these tenants and writes no new audit', async () => {
    await runRecordingRetentionSweep({
      repo: new PgRecordingRetentionRepository(pool),
      storage,
      auditRepo,
      logger: capturingLogger([]),
    });
    expect(await auditRepo.findByEntity(tenantA.tenantId, 'voice_session', oldA.id)).toHaveLength(1);
    expect((await sessionRow(tenantA.tenantId, freshA.id)).transcript).not.toBeNull();
  });
});

describe('#1208 — T4: one tenant\'s failed clear does not stop the rest (real selector, real Postgres failure)', () => {
  class VisitOrderRepo extends PgRecordingRetentionRepository {
    public visited: string[] = [];
    override async purgeSessionTranscripts(
      ...args: Parameters<PgRecordingRetentionRepository['purgeSessionTranscripts']>
    ): ReturnType<PgRecordingRetentionRepository['purgeSessionTranscripts']> {
      this.visited.push(args[0]);
      return super.purgeSessionTranscripts(...args);
    }
  }

  it("a tenant whose UPDATE raises in Postgres is rolled back and logged; tenant C is still cleared in the same sweep", async () => {
    const doomed = await seedTenant(30);
    const tenantC = await seedTenant(30);
    // Older than tenant C's so the oldest-first selector reaches it first.
    const doomedSession = await seedEndedSession(doomed, 60, ['caller: doomed line', 'agent: doomed reply']);
    const sessionC = await seedEndedSession(tenantC, 35, ['caller: tenant C line']);

    await pool.query(`
      CREATE OR REPLACE FUNCTION test_1208_fail_update() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'test_1208: simulated update failure for tenant %', OLD.tenant_id;
      END
      $fn$`);
    await pool.query(`
      CREATE TRIGGER test_1208_fail_update
        BEFORE UPDATE ON voice_sessions
        FOR EACH ROW WHEN (OLD.tenant_id = '${doomed.tenantId}'::uuid)
        EXECUTE FUNCTION test_1208_fail_update()`);

    const repo = new VisitOrderRepo(pool);
    const lines: LoggedLine[] = [];
    let result: RecordingRetentionSweepResult;
    try {
      result = await runRecordingRetentionSweep({
        repo,
        storage,
        auditRepo,
        logger: capturingLogger(lines),
      });
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS test_1208_fail_update ON voice_sessions`);
      await pool.query(`DROP FUNCTION IF EXISTS test_1208_fail_update()`);
    }

    const doomedAt = repo.visited.indexOf(doomed.tenantId);
    const survivorAt = repo.visited.indexOf(tenantC.tenantId);
    expect(doomedAt).toBeGreaterThanOrEqual(0);
    expect(survivorAt).toBeGreaterThan(doomedAt);

    expect((await sessionRow(doomed.tenantId, doomedSession.id)).transcript).toEqual([
      'caller: doomed line',
      'agent: doomed reply',
    ]);
    expect(result!.sessionTranscriptTenantsFailed).toBeGreaterThanOrEqual(1);
    const warn = lines.find((l) => l.level === 'warn' && l.meta?.tenantId === doomed.tenantId);
    expect(String(warn?.meta?.error)).toContain('test_1208: simulated update failure');

    expect((await sessionRow(tenantC.tenantId, sessionC.id)).transcript).toBeNull();
    const events = await auditRepo.findByEntity(tenantC.tenantId, 'voice_session', sessionC.id);
    expect(events.map((e) => e.eventType)).toEqual(['voice_session.transcript_purged']);
  });
});

describe('#1208 — bounded batches (real Postgres)', () => {
  it('clears at most the per-tenant batch per sweep; the remainder goes on the next sweep', async () => {
    const t = await seedTenant(30);
    const s1 = await seedEndedSession(t, 50, ['caller: one']);
    const s2 = await seedEndedSession(t, 45, ['caller: two']);
    const repo = new PgRecordingRetentionRepository(pool);
    const logger = capturingLogger([]);

    await runRecordingRetentionSweep({ repo, storage, logger, sessionTranscriptBatchSize: 1 });
    expect((await sessionRow(t.tenantId, s1.id)).transcript).toBeNull();
    expect((await sessionRow(t.tenantId, s2.id)).transcript).toEqual(['caller: two']);

    await runRecordingRetentionSweep({ repo, storage, logger, sessionTranscriptBatchSize: 1 });
    expect((await sessionRow(t.tenantId, s2.id)).transcript).toBeNull();
  });
});
