/**
 * U8 (R8) — call_transcript_turns mid-call durability against real Postgres.
 *
 * Pins migration 274 on real columns (the mocked-pool trap in
 * docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md):
 *   - voice_recording_id is nullable (rows exist before the recording webhook)
 *   - call_sid / session_id columns exist and the partial unique index
 *     (tenant_id, call_sid, session_id, turn_index) WHERE call_sid IS NOT NULL
 *     is what the mid-call upsert conflicts on
 *   - attachRecording renumbers two session legs of one CallSid into a single
 *     0-based sequence in ONE transaction, first-writer-wins
 *   - listByCallSid ordering (legs by first-seen time, then turn_index)
 *   - RLS keeps another tenant's turns invisible
 *
 * Runs only under `npm run test:integration` (vitest globalSetup starts the
 * Postgres testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import {
  getSharedTestDb,
  closeSharedTestDb,
  createTestTenant,
  createTestFile,
  RLS_APP_ROLE,
  type TestTenant,
} from './shared';
import { PgCallTranscriptTurnRepository } from '../../src/voice/pg-call-transcript-turn';
import { PgVoiceRepository } from '../../src/voice/pg-voice';

describe('Postgres integration — call_transcript_turns mid-call durability (U8)', () => {
  let pool: Pool;
  let repo: PgCallTranscriptTurnRepository;
  let voiceRepo: PgVoiceRepository;
  let tenant: TestTenant;
  let otherTenant: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgCallTranscriptTurnRepository(pool);
    voiceRepo = new PgVoiceRepository(pool);
    tenant = await createTestTenant(pool);
    otherTenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  let callCounter = 0;
  function newCallSid(): string {
    callCounter += 1;
    return `CA${String(callCounter).padStart(4, '0')}${crypto.randomUUID().replace(/-/g, '').slice(0, 28)}`;
  }

  async function makeRecording(t: TestTenant = tenant): Promise<string> {
    const fileId = await createTestFile(pool, t.tenantId, t.userId);
    const recording = await voiceRepo.create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      fileId,
      status: 'pending',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return recording.id;
  }

  async function seedLeg(
    callSid: string,
    sessionId: string,
    lines: ReadonlyArray<readonly ['agent' | 'caller', string]>,
    t: TestTenant = tenant,
  ): Promise<void> {
    for (let i = 0; i < lines.length; i++) {
      await repo.recordTurn({
        tenantId: t.tenantId,
        callSid,
        sessionId,
        turnIndex: i,
        speaker: lines[i][0],
        text: lines[i][1],
      });
    }
  }

  /** Mirror src/db/tenant-transaction.ts: unprivileged role + tenant GUC, always rolled back. */
  async function asTenant<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${RLS_APP_ROLE}`);
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  describe('migration 274 schema', () => {
    it('voice_recording_id is nullable and call_sid / session_id exist as TEXT', async () => {
      const { rows } = await pool.query<{
        column_name: string;
        is_nullable: string;
        data_type: string;
      }>(
        `SELECT column_name, is_nullable, data_type
           FROM information_schema.columns
          WHERE table_name = 'call_transcript_turns'
            AND column_name IN ('voice_recording_id', 'call_sid', 'session_id')
          ORDER BY column_name`,
      );
      expect(rows).toEqual([
        { column_name: 'call_sid', is_nullable: 'YES', data_type: 'text' },
        { column_name: 'session_id', is_nullable: 'YES', data_type: 'text' },
        { column_name: 'voice_recording_id', is_nullable: 'YES', data_type: 'uuid' },
      ]);
    });

    it('has the partial unique index on the mid-call key and the (tenant_id, call_sid) lookup index', async () => {
      const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'call_transcript_turns'
            AND indexname IN ('idx_call_transcript_turns_call_leg', 'idx_call_transcript_turns_call_sid')
          ORDER BY indexname`,
      );
      expect(rows.map((r) => r.indexname)).toEqual([
        'idx_call_transcript_turns_call_leg',
        'idx_call_transcript_turns_call_sid',
      ]);
      const leg = rows[0].indexdef;
      expect(leg).toMatch(/CREATE UNIQUE INDEX/);
      expect(leg).toMatch(/\(tenant_id, call_sid, session_id, turn_index\)/);
      expect(leg).toMatch(/WHERE \(call_sid IS NOT NULL\)/);
      expect(rows[1].indexdef).toMatch(/\(tenant_id, call_sid\)/);
    });

    it('the original (voice_recording_id, turn_index) unique index still holds after attach', async () => {
      const { rows } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'call_transcript_turns' AND indexname = 'idx_call_transcript_turns_recording'`,
      );
      expect(rows[0].indexdef).toMatch(/CREATE UNIQUE INDEX/);
    });
  });

  describe('mid-call recordTurn keyed by callSid + sessionId', () => {
    it('inserts a row with NULL voice_recording_id and upserts on the same leg index (real partial-index conflict target)', async () => {
      const callSid = newCallSid();
      const first = await repo.recordTurn({
        tenantId: tenant.tenantId,
        callSid,
        sessionId: 'leg-1',
        turnIndex: 0,
        speaker: 'caller',
        text: 'interim',
      });
      expect(first.voiceRecordingId).toBeUndefined();
      expect(first.callSid).toBe(callSid);
      expect(first.sessionId).toBe('leg-1');

      const second = await repo.recordTurn({
        tenantId: tenant.tenantId,
        callSid,
        sessionId: 'leg-1',
        turnIndex: 0,
        speaker: 'caller',
        text: 'final',
      });
      expect(second.id).toBe(first.id);
      expect(second.text).toBe('final');

      const { rows } = await pool.query<{ voice_recording_id: string | null; n: string }>(
        `SELECT voice_recording_id, COUNT(*) OVER () AS n
           FROM call_transcript_turns WHERE tenant_id = $1 AND call_sid = $2`,
        [tenant.tenantId, callSid],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].voice_recording_id).toBeNull();
    });

    it('a second session leg restarting at index 0 does not collide with the first', async () => {
      const callSid = newCallSid();
      await seedLeg(callSid, 'leg-1', [['agent', 'leg1-0']]);
      await seedLeg(callSid, 'leg-2', [['agent', 'leg2-0']]);
      const rows = await repo.listByCallSid(tenant.tenantId, callSid);
      expect(rows.map((r) => [r.sessionId, r.turnIndex, r.text])).toEqual([
        ['leg-1', 0, 'leg1-0'],
        ['leg-2', 0, 'leg2-0'],
      ]);
    });
  });

  describe('listByCallSid', () => {
    it('orders legs by first-seen created_at, then turn_index within a leg', async () => {
      const callSid = newCallSid();
      await seedLeg(callSid, 'leg-1', [['agent', 'a0'], ['caller', 'a1'], ['agent', 'a2']]);
      await seedLeg(callSid, 'leg-2', [['agent', 'b0'], ['caller', 'b1']]);
      const rows = await repo.listByCallSid(tenant.tenantId, callSid);
      expect(rows.map((r) => r.text)).toEqual(['a0', 'a1', 'a2', 'b0', 'b1']);
    });
  });

  describe('attachRecording', () => {
    it('renumbers two legs into one 0-based sequence and sets voice_recording_id in one transaction', async () => {
      const callSid = newCallSid();
      const recordingId = await makeRecording();
      await seedLeg(callSid, 'leg-1', [['agent', 'a0'], ['caller', 'a1'], ['agent', 'a2']]);
      await seedLeg(callSid, 'leg-2', [['agent', 'b0'], ['caller', 'b1']]);

      expect(await repo.attachRecording(tenant.tenantId, callSid, recordingId)).toBe(5);

      const attached = await repo.listByRecording(tenant.tenantId, recordingId);
      expect(attached.map((r) => [r.turnIndex, r.sessionId, r.text])).toEqual([
        [0, 'leg-1', 'a0'],
        [1, 'leg-1', 'a1'],
        [2, 'leg-1', 'a2'],
        [3, 'leg-2', 'b0'],
        [4, 'leg-2', 'b1'],
      ]);
      // The by-call ordering agrees with the renumbered sequence.
      const byCall = await repo.listByCallSid(tenant.tenantId, callSid);
      expect(byCall.map((r) => r.turnIndex)).toEqual([0, 1, 2, 3, 4]);
      expect(byCall.every((r) => r.voiceRecordingId === recordingId)).toBe(true);
    });

    it('renumbers a leg with a gap without tripping the partial unique index mid-update', async () => {
      const callSid = newCallSid();
      const recordingId = await makeRecording();
      // Turn 1's fire-and-forget write failed; turns 0 and 2 landed, then 3.
      for (const [turnIndex, text] of [[0, 'a0'], [2, 'a2'], [3, 'a3']] as const) {
        await repo.recordTurn({
          tenantId: tenant.tenantId, callSid, sessionId: 'leg-1', turnIndex, speaker: 'agent', text,
        });
      }
      expect(await repo.attachRecording(tenant.tenantId, callSid, recordingId)).toBe(3);
      const attached = await repo.listByRecording(tenant.tenantId, recordingId);
      expect(attached.map((r) => [r.turnIndex, r.text])).toEqual([[0, 'a0'], [1, 'a2'], [2, 'a3']]);
    });

    it('is first-writer-wins: the voicemail leg\'s second recording never re-points attached rows', async () => {
      const callSid = newCallSid();
      const recording1 = await makeRecording();
      const recording2 = await makeRecording();
      await seedLeg(callSid, 'leg-1', [['agent', 'a0'], ['caller', 'a1']]);

      expect(await repo.attachRecording(tenant.tenantId, callSid, recording1)).toBe(2);
      expect(await repo.attachRecording(tenant.tenantId, callSid, recording2)).toBe(0);

      expect(await repo.listByRecording(tenant.tenantId, recording2)).toEqual([]);
      const still = await repo.listByRecording(tenant.tenantId, recording1);
      expect(still.map((r) => [r.turnIndex, r.text])).toEqual([[0, 'a0'], [1, 'a1']]);
    });

    it('end-of-call ingestion upserts onto the attached rows by (voice_recording_id, turn_index) — no duplicates', async () => {
      const callSid = newCallSid();
      const recordingId = await makeRecording();
      await seedLeg(callSid, 'leg-1', [['agent', 'a0'], ['caller', 'interim']]);
      await repo.attachRecording(tenant.tenantId, callSid, recordingId);

      // What the worker does with the carried index.
      await repo.recordTurn({
        tenantId: tenant.tenantId, voiceRecordingId: recordingId, turnIndex: 1, speaker: 'caller', text: 'final',
      });

      const rows = await repo.listByRecording(tenant.tenantId, recordingId);
      expect(rows.map((r) => [r.turnIndex, r.text, r.callSid])).toEqual([
        [0, 'a0', callSid],
        [1, 'final', callSid],
      ]);
    });

    it('is tenant-scoped: another tenant attaching the same CallSid touches nothing', async () => {
      const callSid = newCallSid();
      const foreignRecording = await makeRecording(otherTenant);
      await seedLeg(callSid, 'leg-1', [['agent', 'a0']]);

      expect(await repo.attachRecording(otherTenant.tenantId, callSid, foreignRecording)).toBe(0);

      const rows = await repo.listByCallSid(tenant.tenantId, callSid);
      expect(rows).toHaveLength(1);
      expect(rows[0].voiceRecordingId).toBeUndefined();
    });
  });

  describe('RLS isolation', () => {
    it('another tenant cannot see the call\'s turns, even without a tenant_id predicate', async () => {
      const callSid = newCallSid();
      await seedLeg(callSid, 'leg-1', [['agent', 'a0'], ['caller', 'a1']]);

      expect(await repo.listByCallSid(otherTenant.tenantId, callSid)).toEqual([]);

      const own = await asTenant(tenant.tenantId, async (client) => {
        const { rows } = await client.query(
          'SELECT id FROM call_transcript_turns WHERE call_sid = $1',
          [callSid],
        );
        return rows.length;
      });
      const foreign = await asTenant(otherTenant.tenantId, async (client) => {
        const { rows } = await client.query(
          'SELECT id FROM call_transcript_turns WHERE call_sid = $1',
          [callSid],
        );
        return rows.length;
      });
      expect(own).toBe(2);
      expect(foreign).toBe(0);
    });
  });
});
