/**
 * Voice parity U1 (docs/plans/2026-10-16-001) — the reply gap on real Postgres.
 *
 * Pins migration 326 on real columns (the mocked-pool trap in
 * docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md):
 *   - the nine timing columns exist, nullable, with the two CHECKs
 *   - `recordTurn` writes the append-time stamps and an interim → final
 *     replacement without timing keeps them (COALESCE)
 *   - `markReplyAudio` is an UPDATE on the mid-call key that never inserts:
 *     a filler's first_audible_at survives the later real frame, the real
 *     frame sets first_audio_at + reply_gap_ms, a repeat is a no-op, a missing
 *     row returns 0, and RLS keeps another tenant's rows out of reach
 *   - a Gather turn carries transport + stt_final_at only
 *
 * Runs only under `npm run test:integration` (vitest globalSetup starts the
 * Postgres testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb, createTestTenant, type TestTenant } from './shared';
import { PgCallTranscriptTurnRepository } from '../../src/voice/pg-call-transcript-turn';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';

interface TurnTimingRow {
  turn_index: number;
  last_word_at: Date | null;
  stt_final_at: Date | null;
  first_audio_enqueued_at: Date | null;
  first_audio_at: Date | null;
  first_audible_at: Date | null;
  reply_gap_ms: number | null;
  endpoint_delay_ms: number | null;
  reply_unacked_reason: string | null;
  transport: string | null;
}

describe('Postgres integration — call_transcript_turns reply timing (U1)', () => {
  let pool: Pool;
  let repo: PgCallTranscriptTurnRepository;
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  let callCounter = 0;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgCallTranscriptTurnRepository(pool);
    tenant = await createTestTenant(pool);
    otherTenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function newCallSid(): string {
    callCounter += 1;
    return `CAU1${String(callCounter).padStart(4, '0')}${crypto.randomUUID().replace(/-/g, '').slice(0, 26)}`;
  }

  async function readTiming(tenantId: string, callSid: string): Promise<TurnTimingRow[]> {
    const { rows } = await pool.query<TurnTimingRow>(
      `SELECT turn_index, last_word_at, stt_final_at, first_audio_enqueued_at, first_audio_at,
              first_audible_at, reply_gap_ms, endpoint_delay_ms, reply_unacked_reason, transport
         FROM call_transcript_turns
        WHERE tenant_id = $1 AND call_sid = $2
        ORDER BY turn_index`,
      [tenantId, callSid],
    );
    return rows;
  }

  describe('migration 326 schema', () => {
    it('adds the nine nullable timing columns with the expected types', async () => {
      const { rows } = await pool.query<{ column_name: string; is_nullable: string; data_type: string }>(
        `SELECT column_name, is_nullable, data_type
           FROM information_schema.columns
          WHERE table_name = 'call_transcript_turns'
            AND column_name IN ('last_word_at', 'stt_final_at', 'first_audio_enqueued_at',
                                'first_audio_at', 'first_audible_at', 'reply_gap_ms',
                                'endpoint_delay_ms', 'reply_unacked_reason', 'transport')
          ORDER BY column_name`,
      );
      expect(rows).toEqual([
        { column_name: 'endpoint_delay_ms', is_nullable: 'YES', data_type: 'integer' },
        { column_name: 'first_audible_at', is_nullable: 'YES', data_type: 'timestamp with time zone' },
        { column_name: 'first_audio_at', is_nullable: 'YES', data_type: 'timestamp with time zone' },
        { column_name: 'first_audio_enqueued_at', is_nullable: 'YES', data_type: 'timestamp with time zone' },
        { column_name: 'last_word_at', is_nullable: 'YES', data_type: 'timestamp with time zone' },
        { column_name: 'reply_gap_ms', is_nullable: 'YES', data_type: 'integer' },
        { column_name: 'reply_unacked_reason', is_nullable: 'YES', data_type: 'text' },
        { column_name: 'stt_final_at', is_nullable: 'YES', data_type: 'timestamp with time zone' },
        { column_name: 'transport', is_nullable: 'YES', data_type: 'text' },
      ]);
    });

    it('rejects an unknown transport and an unknown unacked reason', async () => {
      const callSid = newCallSid();
      await expect(
        pool.query(
          `INSERT INTO call_transcript_turns (tenant_id, call_sid, session_id, turn_index, speaker, text, transport)
           VALUES ($1, $2, 'sess', 0, 'caller', 'hi', 'sms')`,
          [tenant.tenantId, callSid],
        ),
      ).rejects.toThrow(/call_transcript_turns_transport_check/);
      await expect(
        pool.query(
          `INSERT INTO call_transcript_turns (tenant_id, call_sid, session_id, turn_index, speaker, text, reply_unacked_reason)
           VALUES ($1, $2, 'sess', 0, 'caller', 'hi', 'lost')`,
          [tenant.tenantId, callSid],
        ),
      ).rejects.toThrow(/call_transcript_turns_reply_unacked_reason_check/);
    });
  });

  describe('recordTurn carries the append-time stamps', () => {
    it('writes last_word_at / stt_final_at / endpoint_delay_ms / transport and keeps them on an interim → final replacement', async () => {
      const callSid = newCallSid();
      const lastWordAt = new Date('2026-10-20T10:00:00.000Z');
      const sttFinalAt = new Date('2026-10-20T10:00:01.000Z');
      await repo.recordTurn({
        tenantId: tenant.tenantId,
        callSid,
        sessionId: 'sess-1',
        turnIndex: 0,
        speaker: 'caller',
        text: 'is the shop open',
        lastWordAt,
        sttFinalAt,
        endpointDelayMs: 1000,
        transport: 'realtime',
      });
      // The final replacement carries no timing of its own.
      await repo.recordTurn({
        tenantId: tenant.tenantId,
        callSid,
        sessionId: 'sess-1',
        turnIndex: 0,
        speaker: 'caller',
        text: 'is the shop open today',
      });
      const [row] = await readTiming(tenant.tenantId, callSid);
      expect(row.last_word_at?.toISOString()).toBe(lastWordAt.toISOString());
      expect(row.stt_final_at?.toISOString()).toBe(sttFinalAt.toISOString());
      expect(row.endpoint_delay_ms).toBe(1000);
      expect(row.transport).toBe('realtime');
      expect(row.first_audio_at).toBeNull();
      expect(row.reply_gap_ms).toBeNull();
    });

    it('a Gather turn carries transport and stt_final_at only', async () => {
      const callSid = newCallSid();
      const sttFinalAt = new Date('2026-10-20T11:00:00.000Z');
      await repo.recordTurn({
        tenantId: tenant.tenantId,
        callSid,
        sessionId: 'sess-g',
        turnIndex: 0,
        speaker: 'caller',
        text: 'book me in',
        sttFinalAt,
        transport: 'gather',
      });
      const [row] = await readTiming(tenant.tenantId, callSid);
      expect(row.transport).toBe('gather');
      expect(row.stt_final_at?.toISOString()).toBe(sttFinalAt.toISOString());
      expect(row.last_word_at).toBeNull();
      expect(row.endpoint_delay_ms).toBeNull();
      expect(row.first_audio_at).toBeNull();
      expect(row.first_audible_at).toBeNull();
      expect(row.reply_gap_ms).toBeNull();
    });
  });

  describe('markReplyAudio', () => {
    async function seedCallerTurn(callSid: string, t: TestTenant = tenant): Promise<void> {
      await repo.recordTurn({
        tenantId: t.tenantId,
        callSid,
        sessionId: 'sess-1',
        turnIndex: 0,
        speaker: 'caller',
        text: 'hello',
        lastWordAt: new Date('2026-10-20T10:00:00.000Z'),
        sttFinalAt: new Date('2026-10-20T10:00:00.800Z'),
        endpointDelayMs: 800,
        transport: 'realtime',
      });
    }

    it('keeps the filler first_audible_at, then the real frame sets first_audio_at + reply_gap_ms; a repeat is a no-op', async () => {
      const callSid = newCallSid();
      await seedCallerTurn(callSid);
      const fillerAt = new Date('2026-10-20T10:00:00.900Z');
      const enqueuedAt = new Date('2026-10-20T10:00:01.400Z');
      const ackedAt = new Date('2026-10-20T10:00:01.650Z');

      expect(
        await repo.markReplyAudio({
          tenantId: tenant.tenantId, callSid, sessionId: 'sess-1', turnIndex: 0, firstAudibleAt: fillerAt,
        }),
      ).toBe(1);
      expect(
        await repo.markReplyAudio({
          tenantId: tenant.tenantId, callSid, sessionId: 'sess-1', turnIndex: 0, firstAudioEnqueuedAt: enqueuedAt,
        }),
      ).toBe(1);
      expect(
        await repo.markReplyAudio({
          tenantId: tenant.tenantId,
          callSid,
          sessionId: 'sess-1',
          turnIndex: 0,
          firstAudibleAt: ackedAt,
          firstAudioAt: ackedAt,
          replyGapMs: 1650,
        }),
      ).toBe(1);
      // A redelivered stamp changes nothing.
      expect(
        await repo.markReplyAudio({
          tenantId: tenant.tenantId, callSid, sessionId: 'sess-1', turnIndex: 0, firstAudioAt: new Date(), replyGapMs: 99_999,
        }),
      ).toBe(1);

      const [row] = await readTiming(tenant.tenantId, callSid);
      expect(row.first_audible_at?.toISOString()).toBe(fillerAt.toISOString());
      expect(row.first_audio_enqueued_at?.toISOString()).toBe(enqueuedAt.toISOString());
      expect(row.first_audio_at?.toISOString()).toBe(ackedAt.toISOString());
      expect(row.reply_gap_ms).toBe(1650);
      expect(row.reply_unacked_reason).toBeNull();
    });

    it('a fillerless turn gets first_audible_at = first_audio_at from the real frame', async () => {
      const callSid = newCallSid();
      await seedCallerTurn(callSid);
      const ackedAt = new Date('2026-10-20T10:00:01.200Z');
      await repo.markReplyAudio({
        tenantId: tenant.tenantId, callSid, sessionId: 'sess-1', turnIndex: 0,
        firstAudibleAt: ackedAt, firstAudioAt: ackedAt, replyGapMs: 1200,
      });
      const [row] = await readTiming(tenant.tenantId, callSid);
      expect(row.first_audible_at?.toISOString()).toBe(ackedAt.toISOString());
      expect(row.first_audio_at?.toISOString()).toBe(ackedAt.toISOString());
    });

    it('an unacked reply keeps first_audio_at and reply_gap_ms null and records the reason', async () => {
      const callSid = newCallSid();
      await seedCallerTurn(callSid);
      await repo.markReplyAudio({
        tenantId: tenant.tenantId, callSid, sessionId: 'sess-1', turnIndex: 0,
        firstAudioEnqueuedAt: new Date('2026-10-20T10:00:01.400Z'),
      });
      await repo.markReplyAudio({
        tenantId: tenant.tenantId, callSid, sessionId: 'sess-1', turnIndex: 0, replyUnackedReason: 'ack_timeout',
      });
      const [row] = await readTiming(tenant.tenantId, callSid);
      expect(row.first_audio_enqueued_at).not.toBeNull();
      expect(row.first_audio_at).toBeNull();
      expect(row.reply_gap_ms).toBeNull();
      expect(row.reply_unacked_reason).toBe('ack_timeout');
    });

    it('returns 0 and inserts nothing when the row is gone', async () => {
      const callSid = newCallSid();
      expect(
        await repo.markReplyAudio({
          tenantId: tenant.tenantId, callSid, sessionId: 'sess-none', turnIndex: 0, firstAudioAt: new Date(), replyGapMs: 1,
        }),
      ).toBe(0);
      expect(await readTiming(tenant.tenantId, callSid)).toEqual([]);
    });

    it('RLS: another tenant cannot stamp the row', async () => {
      const callSid = newCallSid();
      await seedCallerTurn(callSid);
      expect(
        await repo.markReplyAudio({
          tenantId: otherTenant.tenantId, callSid, sessionId: 'sess-1', turnIndex: 0, firstAudioAt: new Date(), replyGapMs: 1,
        }),
      ).toBe(0);
      const [row] = await readTiming(tenant.tenantId, callSid);
      expect(row.first_audio_at).toBeNull();
    });
  });

  describe('through VoiceSessionStore with the real repository', () => {
    it('a realtime caller turn then the reply stamp lands every column on the row', async () => {
      const store = new VoiceSessionStore({ startInterval: false, callTranscriptTurnRepo: repo });
      try {
        const callSid = newCallSid();
        const session = store.create(tenant.tenantId, 'telephony', { callSid });
        const lastWordAt = new Date('2026-10-20T11:00:00.000Z');
        const sttFinalAt = new Date('2026-10-20T11:00:01.000Z');
        const firstAudioAt = new Date('2026-10-20T11:00:02.250Z');

        store.appendTranscript(session.id, { speaker: 'agent', text: 'Thanks for calling.' });
        store.beginCallerTurnTiming(session.id, { transport: 'realtime', sttFinalAt, lastWordAt });
        store.appendTranscript(session.id, { speaker: 'caller', text: 'my AC is broken' });
        const anchor = session.replyTiming!;
        expect(anchor.turnIndex).toBe(1);

        // Stamped straight away: the update chains behind the (possibly pending) insert.
        await store.markReplyAudio(session.id, {
          turnIndex: anchor.turnIndex,
          firstAudioEnqueuedAt: new Date('2026-10-20T11:00:02.100Z'),
        });
        await store.markReplyAudio(session.id, {
          turnIndex: anchor.turnIndex,
          firstAudioAt,
          firstAudibleAt: firstAudioAt,
          replyGapMs: firstAudioAt.getTime() - lastWordAt.getTime(),
        });

        const rows = await readTiming(tenant.tenantId, callSid);
        expect(rows.map((r) => r.turn_index)).toEqual([0, 1]);
        expect(rows[0].transport).toBeNull();
        expect(rows[1].transport).toBe('realtime');
        expect(rows[1].last_word_at?.toISOString()).toBe(lastWordAt.toISOString());
        expect(rows[1].stt_final_at?.toISOString()).toBe(sttFinalAt.toISOString());
        expect(rows[1].endpoint_delay_ms).toBe(1000);
        expect(rows[1].first_audio_enqueued_at?.toISOString()).toBe('2026-10-20T11:00:02.100Z');
        expect(rows[1].first_audio_at?.toISOString()).toBe(firstAudioAt.toISOString());
        expect(rows[1].first_audible_at?.toISOString()).toBe(firstAudioAt.toISOString());
        expect(rows[1].reply_gap_ms).toBe(2250);
        expect(rows[1].reply_unacked_reason).toBeNull();
      } finally {
        store.dispose();
      }
    });

    it('a Gather caller turn records transport and stt_final_at only, never a gap', async () => {
      const store = new VoiceSessionStore({ startInterval: false, callTranscriptTurnRepo: repo });
      try {
        const callSid = newCallSid();
        const session = store.create(tenant.tenantId, 'telephony', { callSid });
        const sttFinalAt = new Date('2026-10-20T12:00:00.000Z');

        store.beginCallerTurnTiming(session.id, { transport: 'gather', sttFinalAt });
        store.appendTranscript(session.id, { speaker: 'caller', text: 'hello' });
        // Let the fire-and-forget insert settle through the retained promise.
        await session.pendingTurnPersist.get(0);

        const [row] = await readTiming(tenant.tenantId, callSid);
        expect(row.transport).toBe('gather');
        expect(row.stt_final_at?.toISOString()).toBe(sttFinalAt.toISOString());
        expect(row.last_word_at).toBeNull();
        expect(row.endpoint_delay_ms).toBeNull();
        expect(row.first_audio_at).toBeNull();
        expect(row.first_audible_at).toBeNull();
        expect(row.reply_gap_ms).toBeNull();
      } finally {
        store.dispose();
      }
    });
  });
});
