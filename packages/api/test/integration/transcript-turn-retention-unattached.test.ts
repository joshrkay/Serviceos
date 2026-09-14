/**
 * #1202 (PRIVACY/RETENTION) — mid-call transcript turns that never get a
 * recording must still be purged by the retention sweep.
 *
 * `voice-session-store.ts` `persistTurn` writes every mid-call utterance to
 * `call_transcript_turns` with `voice_recording_id` NULL; only the recording
 * webhook's `attachRecording` later links the rows to a recording. Before this
 * fix the retention sweep deleted turns solely through `purgeDerived`
 * (`WHERE voice_recording_id = <due recording>`), so a call that never got a
 * recording (Media Streams, missing storage/Twilio credentials, a failed
 * upload) kept its caller + agent transcript forever, whatever the tenant's
 * `recording_retention_days`.
 *
 * Every assertion runs the PRODUCTION sweep (`runRecordingRetentionSweep`)
 * against the PRODUCTION repository (`PgRecordingRetentionRepository`) at real
 * Postgres with RLS_RUNTIME_ROLE on — no stubbed tenant list, no stubbed
 * selector. Rows are written through the product repositories
 * (`PgCallTranscriptTurnRepository.recordTurn` / `attachRecording`,
 * `PgVoiceRepository.create`). Two things are SQL fixtures because no product
 * surface can produce them:
 *   - `tenant_settings.recording_retention_days` (migration 169 notes there is
 *     no settings write surface for it) and `voice_recordings.legal_hold`
 *     (no setter exists);
 *   - aging a turn's `created_at` — the column defaults to NOW() and retention
 *     is measured in days; only the clock is faked, never the row's content
 *     or linkage.
 *
 * The shared container holds tenants from other integration files, so only
 * row-level assertions on this file's own ids are made (aggregate counters are
 * asserted as lower bounds).
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  closeSharedTestDb,
  createTestFile,
  createTestTenant,
  getSharedTestDb,
  type TestTenant,
} from './shared';
import { PgCallTranscriptTurnRepository } from '../../src/voice/pg-call-transcript-turn';
import { PgVoiceRepository } from '../../src/voice/pg-voice';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { DevStorageProvider } from '../../src/files/storage-provider';
import { recordInboundCall } from '../../src/voice/voice-service';
import {
  PgRecordingRetentionRepository,
  runRecordingRetentionSweep,
  type RecordingRetentionSweepResult,
} from '../../src/workers/recording-retention-worker';
import type { Logger } from '../../src/logging/logger';

const DAY_MS = 24 * 3600 * 1000;

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
let turnRepo: PgCallTranscriptTurnRepository;
let voiceRepo: PgVoiceRepository;
let auditRepo: PgAuditRepository;
const storage = new DevStorageProvider({
  bucket: 'dev',
  publicUrlBase: 'http://localhost:3000/storage-dev',
});

beforeAll(async () => {
  pool = await getSharedTestDb();
  turnRepo = new PgCallTranscriptTurnRepository(pool);
  voiceRepo = new PgVoiceRepository(pool);
  auditRepo = new PgAuditRepository(pool);
});

afterAll(async () => {
  await closeSharedTestDb();
});

async function seedTenant(retentionDays: number): Promise<TestTenant> {
  const t = await createTestTenant(pool);
  // SQL fixture: recording_retention_days has no settings write surface.
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

/** Mid-call turns exactly as `persistTurn` writes them: call SID + session id, no recording. */
async function seedUnattachedCall(t: TestTenant, lines: ReadonlyArray<string>): Promise<string> {
  const callSid = newCallSid();
  const sessionId = crypto.randomUUID();
  for (let i = 0; i < lines.length; i++) {
    await turnRepo.recordTurn({
      tenantId: t.tenantId,
      callSid,
      sessionId,
      turnIndex: i,
      speaker: i % 2 === 0 ? 'caller' : 'agent',
      text: lines[i],
    });
  }
  return callSid;
}

async function createRecording(t: TestTenant, ageDays: number): Promise<string> {
  const fileId = await createTestFile(pool, t.tenantId, t.userId);
  const createdAt = new Date(Date.now() - ageDays * DAY_MS);
  const recording = await voiceRepo.create({
    id: crypto.randomUUID(),
    tenantId: t.tenantId,
    fileId,
    status: 'completed',
    createdBy: t.userId,
    createdAt,
    updatedAt: createdAt,
  });
  return recording.id;
}

/** Fixture clock: age every turn of a call. Linkage and content are untouched. */
async function ageCallTurns(tenantId: string, callSid: string, ageDays: number): Promise<void> {
  await pool.query(
    `UPDATE call_transcript_turns
        SET created_at = now() - make_interval(days => $3)
      WHERE tenant_id = $1 AND call_sid = $2`,
    [tenantId, callSid, ageDays],
  );
}

async function turnsOfCall(
  tenantId: string,
  callSid: string,
): Promise<Array<{ turn_index: number; voice_recording_id: string | null }>> {
  const { rows } = await pool.query(
    `SELECT turn_index, voice_recording_id
       FROM call_transcript_turns
      WHERE tenant_id = $1 AND call_sid = $2
      ORDER BY turn_index`,
    [tenantId, callSid],
  );
  return rows;
}

describe('#1202 — the retention sweep purges unattached transcript turns past the tenant horizon (real Postgres)', () => {
  let tenantA: TestTenant; // recording_retention_days = 30
  let tenantB: TestTenant; // recording_retention_days = 90 (T3: divergent config)
  let oldUnattachedA: string;
  let freshUnattachedA: string;
  let attachedWithinRetentionA: string;
  let attachedRecordingA: string;
  let heldCallA: string;
  let heldRecordingA: string;
  let oldUnattachedB: string;
  let result: RecordingRetentionSweepResult;
  const lines: LoggedLine[] = [];

  beforeAll(async () => {
    tenantA = await seedTenant(30);
    tenantB = await seedTenant(90);

    // Tenant A — a Media Streams call 31 days ago that never got a recording.
    oldUnattachedA = await seedUnattachedCall(tenantA, [
      'my furnace is making a banging noise',
      'I can book a technician for tomorrow morning',
    ]);
    await ageCallTurns(tenantA.tenantId, oldUnattachedA, 31);

    // Tenant A — yesterday's unattached call: inside the 30-day horizon.
    freshUnattachedA = await seedUnattachedCall(tenantA, ['is anyone available today']);
    await ageCallTurns(tenantA.tenantId, freshUnattachedA, 1);

    // Tenant A — turns attached (by the product's attachRecording) to a
    // recording that is only 5 days old. The turn rows themselves are aged 31
    // days so the only thing keeping them is their recording linkage.
    attachedWithinRetentionA = await seedUnattachedCall(tenantA, ['water heater leaking', 'on our way']);
    attachedRecordingA = await createRecording(tenantA, 5);
    expect(
      await turnRepo.attachRecording(tenantA.tenantId, attachedWithinRetentionA, attachedRecordingA),
    ).toBe(2);
    await ageCallTurns(tenantA.tenantId, attachedWithinRetentionA, 31);

    // Tenant A — turns attached to a 400-day-old recording on legal hold.
    heldCallA = await seedUnattachedCall(tenantA, ['I want to dispute the invoice']);
    heldRecordingA = await createRecording(tenantA, 400);
    expect(await turnRepo.attachRecording(tenantA.tenantId, heldCallA, heldRecordingA)).toBe(1);
    await pool.query(`UPDATE voice_recordings SET legal_hold = true WHERE id = $1`, [heldRecordingA]);
    await ageCallTurns(tenantA.tenantId, heldCallA, 400);

    // Tenant B (90-day retention) — the SAME 31-day age as tenant A's purged call.
    oldUnattachedB = await seedUnattachedCall(tenantB, [
      'my AC stopped cooling',
      'we can come by Thursday',
    ]);
    await ageCallTurns(tenantB.tenantId, oldUnattachedB, 31);

    const before = await pool.query(
      `SELECT CASE tenant_id WHEN $1 THEN 'A (30d)' ELSE 'B (90d)' END AS tenant,
              call_sid, turn_index, voice_recording_id,
              extract(day from now() - created_at)::int AS age_days
         FROM call_transcript_turns
        WHERE tenant_id IN ($1, $2)
        ORDER BY 1, call_sid, turn_index`,
      [tenantA.tenantId, tenantB.tenantId],
    );
    console.log('[#1202] call_transcript_turns BEFORE sweep:\n' + JSON.stringify(before.rows, null, 2));

    result = await runRecordingRetentionSweep({
      repo: new PgRecordingRetentionRepository(pool),
      storage,
      auditRepo,
      logger: capturingLogger(lines),
    });

    const after = await pool.query(
      `SELECT CASE tenant_id WHEN $1 THEN 'A (30d)' ELSE 'B (90d)' END AS tenant,
              call_sid, turn_index, voice_recording_id,
              extract(day from now() - created_at)::int AS age_days
         FROM call_transcript_turns
        WHERE tenant_id IN ($1, $2)
        ORDER BY 1, call_sid, turn_index`,
      [tenantA.tenantId, tenantB.tenantId],
    );
    console.log('[#1202] call_transcript_turns AFTER sweep:\n' + JSON.stringify(after.rows, null, 2));
    console.log('[#1202] sweep result: ' + JSON.stringify(result));
  });

  it('deletes tenant A\'s unattached turns older than its 30-day retention', async () => {
    expect(await turnsOfCall(tenantA.tenantId, oldUnattachedA)).toEqual([]);
  });

  it('keeps tenant A\'s unattached turn that is only 1 day old (still inside the horizon / ingestion window)', async () => {
    expect(await turnsOfCall(tenantA.tenantId, freshUnattachedA)).toEqual([
      { turn_index: 0, voice_recording_id: null },
    ]);
  });

  it('keeps tenant A\'s attached turns whose recording is within retention, even though the turn rows are 31 days old', async () => {
    expect(await turnsOfCall(tenantA.tenantId, attachedWithinRetentionA)).toEqual([
      { turn_index: 0, voice_recording_id: attachedRecordingA },
      { turn_index: 1, voice_recording_id: attachedRecordingA },
    ]);
  });

  it('keeps tenant A\'s attached turns whose recording is past retention but on legal hold', async () => {
    expect(await turnsOfCall(tenantA.tenantId, heldCallA)).toEqual([
      { turn_index: 0, voice_recording_id: heldRecordingA },
    ]);
    const { rows } = await pool.query(
      `SELECT purged_at, legal_hold FROM voice_recordings WHERE id = $1`,
      [heldRecordingA],
    );
    expect(rows).toEqual([{ purged_at: null, legal_hold: true }]);
  });

  it('T3: tenant B (90-day retention) keeps its 31-day-old unattached turns in the same sweep', async () => {
    expect(await turnsOfCall(tenantB.tenantId, oldUnattachedB)).toEqual([
      { turn_index: 0, voice_recording_id: null },
      { turn_index: 1, voice_recording_id: null },
    ]);
  });

  it('counts the deletions in the sweep result and the completion log', async () => {
    expect(result.unattachedTurnsPurged).toBeGreaterThanOrEqual(2);
    expect(result.unattachedTurnTenantsFailed).toBe(0);
    const completed = lines.find((l) => l.message === 'recording-retention sweep completed');
    expect(completed?.meta?.unattachedTurnsPurged).toBe(result.unattachedTurnsPurged);
  });

  it('emits a system audit event for the purged call (per-class counts, like voice_recording.purged), and none for tenant B', async () => {
    const events = await auditRepo.findByEntity(tenantA.tenantId, 'voice_session', oldUnattachedA);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: tenantA.tenantId,
      actorId: 'recording-retention-worker',
      actorRole: 'system',
      eventType: 'voice_session.transcript_purged',
      entityType: 'voice_session',
      entityId: oldUnattachedA,
    });
    expect(events[0].metadata).toMatchObject({
      callSid: oldUnattachedA,
      reason: 'no_recording_past_retention',
      derivedPurged: { transcriptTurns: 2 },
    });
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'voice_session.transcript_purged'`,
      [tenantB.tenantId],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('#1202 review — a legal hold on the call\'s recording protects its unattached turns (real Postgres)', () => {
  // `voice_recording_id IS NULL` does NOT mean "this call has no recording".
  // Two product paths leave a call's turns unattached next to a real
  // voice_recordings row for the same CallSid:
  //   - voicemail-status-route.ts persists the voicemail leg through
  //     recordInboundCall and never attaches turns (a Media Streams call whose
  //     patch dial failed keeps its AI-conversation turns unattached);
  //   - recording-transcript-hook.ts swallows an attachRecording failure and
  //     Twilio retries arrive inserted=false, so nothing re-attaches.
  // The recording row here is written by recordInboundCall, the voicemail
  // leg's own writer. legal_hold has no product setter, so it is a fixture.
  let held: TestTenant; // 30-day retention, hold on one call's recording
  let neighbour: TestTenant; // 30-day retention, no hold of its own
  let stranger: TestTenant; // holds a recording with neighbour's CallSid string
  let heldCall: string;
  let unheldCall: string;
  let neighbourCall: string;
  let heldRecordingId: string;
  let strangerRecordingId: string;

  async function voicemailLeg(t: TestTenant, callSid: string): Promise<string> {
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
    return voiceRecordingId;
  }

  beforeAll(async () => {
    held = await seedTenant(30);
    neighbour = await seedTenant(30);
    stranger = await seedTenant(30);

    // Held: 31-day-old unattached turns + a voicemail-leg recording for the
    // same CallSid that is on legal hold.
    heldCall = await seedUnattachedCall(held, [
      'I slipped on the wet floor your tech left',
      'I am sorry, let me get a manager',
    ]);
    await ageCallTurns(held.tenantId, heldCall, 31);
    heldRecordingId = await voicemailLeg(held, heldCall);
    await pool.query(`UPDATE voice_recordings SET legal_hold = true WHERE id = $1`, [heldRecordingId]);

    // Same tenant, same shape, recording NOT on hold → still purged.
    unheldCall = await seedUnattachedCall(held, ['please call me back about my quote']);
    await ageCallTurns(held.tenantId, unheldCall, 31);
    await voicemailLeg(held, unheldCall);

    // T1: another tenant holds a recording under the SAME CallSid string.
    neighbourCall = await seedUnattachedCall(neighbour, ['the thermostat is blank']);
    await ageCallTurns(neighbour.tenantId, neighbourCall, 31);
    strangerRecordingId = await voicemailLeg(stranger, neighbourCall);
    await pool.query(`UPDATE voice_recordings SET legal_hold = true WHERE id = $1`, [strangerRecordingId]);

    const dump = `SELECT CASE t.tenant_id WHEN $1 THEN 'held' WHEN $2 THEN 'neighbour' END AS tenant,
                         t.call_sid, t.turn_index, t.voice_recording_id,
                         extract(day from now() - t.created_at)::int AS age_days,
                         (SELECT string_agg(CASE vr.tenant_id WHEN $1 THEN 'held' WHEN $2 THEN 'neighbour' ELSE 'stranger' END
                                            || ':legal_hold=' || vr.legal_hold, ', ')
                            FROM voice_recordings vr WHERE vr.call_sid = t.call_sid) AS recordings_for_call_sid
                    FROM call_transcript_turns t
                   WHERE t.tenant_id IN ($1, $2)
                   ORDER BY 1, t.call_sid, t.turn_index`;
    const before = await pool.query(dump, [held.tenantId, neighbour.tenantId]);
    console.log('[#1202 hold] call_transcript_turns BEFORE sweep:\n' + JSON.stringify(before.rows, null, 2));

    const result = await runRecordingRetentionSweep({
      repo: new PgRecordingRetentionRepository(pool),
      storage,
      auditRepo,
      logger: capturingLogger([]),
    });

    const after = await pool.query(dump, [held.tenantId, neighbour.tenantId]);
    console.log('[#1202 hold] call_transcript_turns AFTER sweep:\n' + JSON.stringify(after.rows, null, 2));
    console.log('[#1202 hold] sweep result: ' + JSON.stringify(result));
  });

  it('keeps unattached turns past retention when a recording for the same CallSid is on legal hold', async () => {
    expect(await turnsOfCall(held.tenantId, heldCall)).toEqual([
      { turn_index: 0, voice_recording_id: null },
      { turn_index: 1, voice_recording_id: null },
    ]);
    expect(await auditRepo.findByEntity(held.tenantId, 'voice_session', heldCall)).toEqual([]);
  });

  it('still purges unattached turns past retention when the same-CallSid recording is NOT on hold', async () => {
    expect(await turnsOfCall(held.tenantId, unheldCall)).toEqual([]);
  });

  it("T1: another tenant's held recording with the same CallSid string does not protect this tenant's turns", async () => {
    expect(await turnsOfCall(neighbour.tenantId, neighbourCall)).toEqual([]);
    const { rows } = await pool.query(
      `SELECT tenant_id, legal_hold, purged_at FROM voice_recordings WHERE id = $1`,
      [strangerRecordingId],
    );
    expect(rows).toEqual([{ tenant_id: stranger.tenantId, legal_hold: true, purged_at: null }]);
  });
});

describe('#1202 — bounded batches (real Postgres)', () => {
  it('deletes at most the per-tenant batch per sweep; the remainder goes on the next sweep', async () => {
    const t = await seedTenant(30);
    const callSid = await seedUnattachedCall(t, ['one', 'two', 'three']);
    await ageCallTurns(t.tenantId, callSid, 45);
    const repo = new PgRecordingRetentionRepository(pool);
    const logger = capturingLogger([]);

    await runRecordingRetentionSweep({ repo, storage, logger, unattachedTurnBatchSize: 2 });
    expect(await turnsOfCall(t.tenantId, callSid)).toHaveLength(1);

    await runRecordingRetentionSweep({ repo, storage, logger, unattachedTurnBatchSize: 2 });
    expect(await turnsOfCall(t.tenantId, callSid)).toEqual([]);
  });
});

describe('#1202 — T4: one tenant\'s failed purge does not stop the rest (real selector, real Postgres failure)', () => {
  /** Passthrough — records the order the REAL selector hands tenants to the REAL delete. */
  class VisitOrderRepo extends PgRecordingRetentionRepository {
    public visited: string[] = [];
    override async purgeUnattachedTurns(
      ...args: Parameters<PgRecordingRetentionRepository['purgeUnattachedTurns']>
    ): ReturnType<PgRecordingRetentionRepository['purgeUnattachedTurns']> {
      this.visited.push(args[0]);
      return super.purgeUnattachedTurns(...args);
    }
  }

  it('a tenant whose DELETE raises in Postgres is rolled back and logged; tenant C is still purged in the same sweep', async () => {
    const doomed = await seedTenant(30);
    const tenantC = await seedTenant(30);
    const doomedCall = await seedUnattachedCall(doomed, ['doomed caller line', 'doomed agent line']);
    // Older than tenant C's rows so the selector (oldest backlog first) reaches
    // the failing tenant BEFORE the survivor — the failure precedes the
    // surviving work by construction, not by luck.
    await ageCallTurns(doomed.tenantId, doomedCall, 60);
    const callC = await seedUnattachedCall(tenantC, ['tenant C caller line']);
    await ageCallTurns(tenantC.tenantId, callC, 35);

    // A real Postgres error inside the doomed tenant's tenant-scoped delete
    // transaction (not a JS stub): a row trigger that raises for that tenant only.
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_1202_fail_delete() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'test_1202: simulated delete failure for tenant %', OLD.tenant_id;
      END
      $fn$`);
    await pool.query(`
      CREATE TRIGGER test_1202_fail_delete
        BEFORE DELETE ON call_transcript_turns
        FOR EACH ROW WHEN (OLD.tenant_id = '${doomed.tenantId}'::uuid)
        EXECUTE FUNCTION test_1202_fail_delete()`);

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
      await pool.query(`DROP TRIGGER IF EXISTS test_1202_fail_delete ON call_transcript_turns`);
      await pool.query(`DROP FUNCTION IF EXISTS test_1202_fail_delete()`);
    }

    // The real selector reached both tenants, the doomed one first.
    const doomedAt = repo.visited.indexOf(doomed.tenantId);
    const survivorAt = repo.visited.indexOf(tenantC.tenantId);
    expect(doomedAt).toBeGreaterThanOrEqual(0);
    expect(survivorAt).toBeGreaterThan(doomedAt);

    // Doomed tenant: whole delete rolled back, failure logged + counted.
    expect(await turnsOfCall(doomed.tenantId, doomedCall)).toHaveLength(2);
    expect(result!.unattachedTurnTenantsFailed).toBeGreaterThanOrEqual(1);
    const warn = lines.find(
      (l) => l.level === 'warn' && l.meta?.tenantId === doomed.tenantId,
    );
    expect(String(warn?.meta?.error)).toContain('test_1202: simulated delete failure');

    // Tenant C: purged in the same sweep, with its audit event.
    expect(await turnsOfCall(tenantC.tenantId, callC)).toEqual([]);
    const events = await auditRepo.findByEntity(tenantC.tenantId, 'voice_session', callC);
    expect(events.map((e) => e.eventType)).toEqual(['voice_session.transcript_purged']);
  });
});
