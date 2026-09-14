import { describe, it, expect } from 'vitest';
import {
  InMemoryCallTranscriptTurnRepository,
  parseTranscriptLine,
} from '../../src/voice/call-transcript-turn';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const RECORDING_1 = '33333333-3333-3333-3333-333333333333';
const RECORDING_2 = '44444444-4444-4444-4444-444444444444';
const CALL_SID = 'CA00000000000000000000000000000001';
const SESSION_1 = 'session-leg-1';
const SESSION_2 = 'session-leg-2';

async function seedLeg(
  repo: InMemoryCallTranscriptTurnRepository,
  sessionId: string,
  lines: ReadonlyArray<readonly ['agent' | 'caller', string]>,
  tenantId = TENANT_A,
): Promise<void> {
  for (let i = 0; i < lines.length; i++) {
    await repo.recordTurn({
      tenantId,
      callSid: CALL_SID,
      sessionId,
      turnIndex: i,
      speaker: lines[i][0],
      text: lines[i][1],
    });
  }
}

describe('InMemoryCallTranscriptTurnRepository', () => {
  describe('recordTurn validation', () => {
    it('rejects empty tenantId', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await expect(
        repo.recordTurn({
          tenantId: '',
          voiceRecordingId: RECORDING_1,
          turnIndex: 0,
          speaker: 'agent',
          text: 'Hello',
        }),
      ).rejects.toThrow(/tenantId is required/);
    });

    it('rejects a turn keyed by neither voiceRecordingId nor callSid+sessionId', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      for (const key of [
        {},
        { voiceRecordingId: '' },
        { callSid: CALL_SID },
        { callSid: CALL_SID, sessionId: '' },
        { sessionId: SESSION_1 },
      ]) {
        await expect(
          repo.recordTurn({
            tenantId: TENANT_A,
            ...key,
            turnIndex: 0,
            speaker: 'agent',
            text: 'Hello',
          }),
        ).rejects.toThrow(/exactly one of voiceRecordingId or callSid\+sessionId/);
      }
    });

    it('rejects a turn keyed by BOTH voiceRecordingId and callSid+sessionId', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await expect(
        repo.recordTurn({
          tenantId: TENANT_A,
          voiceRecordingId: RECORDING_1,
          callSid: CALL_SID,
          sessionId: SESSION_1,
          turnIndex: 0,
          speaker: 'agent',
          text: 'Hello',
        }),
      ).rejects.toThrow(/exactly one of voiceRecordingId or callSid\+sessionId/);
    });

    it('accepts a mid-call turn keyed by callSid+sessionId with no recording yet', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      const turn = await repo.recordTurn({
        tenantId: TENANT_A,
        callSid: CALL_SID,
        sessionId: SESSION_1,
        turnIndex: 0,
        speaker: 'agent',
        text: 'Hello',
      });
      expect(turn.voiceRecordingId).toBeUndefined();
      expect(turn.callSid).toBe(CALL_SID);
      expect(turn.sessionId).toBe(SESSION_1);
    });

    it('rejects negative or non-integer turn_index', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      for (const bad of [-1, -100, 1.5, NaN, Infinity]) {
        await expect(
          repo.recordTurn({
            tenantId: TENANT_A,
            voiceRecordingId: RECORDING_1,
            turnIndex: bad,
            speaker: 'agent',
            text: 'Hello',
          }),
        ).rejects.toThrow(/non-negative integer/);
      }
    });

    it('rejects invalid speaker', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await expect(
        repo.recordTurn({
          tenantId: TENANT_A,
          voiceRecordingId: RECORDING_1,
          turnIndex: 0,
          speaker: 'system' as never,
          text: 'Hello',
        }),
      ).rejects.toThrow(/speaker must be/);
    });

    it('rejects empty text', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await expect(
        repo.recordTurn({
          tenantId: TENANT_A,
          voiceRecordingId: RECORDING_1,
          turnIndex: 0,
          speaker: 'agent',
          text: '',
        }),
      ).rejects.toThrow(/text must be non-empty/);
    });
  });

  describe('idempotency', () => {
    it('upserts on (voice_recording_id, turn_index) collision — last write wins', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      const first = await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_1,
        turnIndex: 3,
        speaker: 'caller',
        text: 'interim',
      });
      const second = await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_1,
        turnIndex: 3,
        speaker: 'caller',
        text: 'final transcript',
      });
      expect(second.id).toBe(first.id);
      expect(second.text).toBe('final transcript');
    });

    it('treats different turn_index as distinct rows', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      const a = await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_1,
        turnIndex: 0,
        speaker: 'agent',
        text: 'greeting',
      });
      const b = await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_1,
        turnIndex: 1,
        speaker: 'caller',
        text: 'hello',
      });
      expect(a.id).not.toBe(b.id);
    });

    // Codex P2 on PR #233: interim→final replacement must NOT rewrite
    // started_at when the caller doesn't supply one. Otherwise repeated
    // writes corrupt turn timing/order metadata.
    it('preserves the original started_at when re-emitted without an explicit startedAt', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      const explicit = new Date('2026-04-21T10:00:00.000Z');
      const first = await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_1,
        turnIndex: 3,
        speaker: 'caller',
        text: 'interim',
        startedAt: explicit,
      });
      // Allow real wall time to advance so a buggy implementation that
      // stamps NOW() on conflict would produce a different timestamp.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_1,
        turnIndex: 3,
        speaker: 'caller',
        text: 'final',
      });
      expect(second.id).toBe(first.id);
      expect(second.startedAt.toISOString()).toBe(explicit.toISOString());
    });

    it('respects an explicit startedAt on re-emission when the caller supplies one', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      const original = new Date('2026-04-21T10:00:00.000Z');
      const corrected = new Date('2026-04-21T10:00:01.500Z');
      await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_1,
        turnIndex: 3,
        speaker: 'caller',
        text: 'interim',
        startedAt: original,
      });
      const second = await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_1,
        turnIndex: 3,
        speaker: 'caller',
        text: 'final',
        startedAt: corrected,
      });
      expect(second.startedAt.toISOString()).toBe(corrected.toISOString());
    });
  });

  describe('listByRecording', () => {
    it('returns turns for the recording in ascending turn_index order', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      // Insert out of order on purpose.
      await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_1,
        turnIndex: 2,
        speaker: 'agent',
        text: 'third',
      });
      await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_1,
        turnIndex: 0,
        speaker: 'agent',
        text: 'first',
      });
      await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_1,
        turnIndex: 1,
        speaker: 'caller',
        text: 'second',
      });

      const turns = await repo.listByRecording(TENANT_A, RECORDING_1);
      expect(turns.map((t) => t.text)).toEqual(['first', 'second', 'third']);
    });

    it('does not return another tenant\'s turns', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_1,
        turnIndex: 0,
        speaker: 'agent',
        text: 'tenantA',
      });
      const turns = await repo.listByRecording(TENANT_B, RECORDING_1);
      expect(turns).toEqual([]);
    });

    it('does not return turns from another recording', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_1,
        turnIndex: 0,
        speaker: 'agent',
        text: 'r1',
      });
      await repo.recordTurn({
        tenantId: TENANT_A,
        voiceRecordingId: RECORDING_2,
        turnIndex: 0,
        speaker: 'agent',
        text: 'r2',
      });
      const r1 = await repo.listByRecording(TENANT_A, RECORDING_1);
      expect(r1.map((t) => t.text)).toEqual(['r1']);
    });
  });

  // ── U8: mid-call persistence keyed by call SID + session leg ─────────────

  describe('mid-call key idempotency', () => {
    it('upserts on (tenant, callSid, sessionId, turnIndex) — same index, same leg → same row', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      const first = await repo.recordTurn({
        tenantId: TENANT_A, callSid: CALL_SID, sessionId: SESSION_1, turnIndex: 0,
        speaker: 'caller', text: 'interim',
      });
      const second = await repo.recordTurn({
        tenantId: TENANT_A, callSid: CALL_SID, sessionId: SESSION_1, turnIndex: 0,
        speaker: 'caller', text: 'final',
      });
      expect(second.id).toBe(first.id);
      expect(second.text).toBe('final');
    });

    it('a second session leg for the same CallSid restarting at index 0 does NOT overwrite the first', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await seedLeg(repo, SESSION_1, [['agent', 'leg1-0']]);
      await seedLeg(repo, SESSION_2, [['agent', 'leg2-0']]);
      const rows = await repo.listByCallSid(TENANT_A, CALL_SID);
      expect(rows.map((r) => r.text)).toEqual(['leg1-0', 'leg2-0']);
    });
  });

  describe('listByCallSid', () => {
    it('orders legs by first-seen time and turns within a leg by index', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await seedLeg(repo, SESSION_1, [['agent', 'a0'], ['caller', 'a1'], ['agent', 'a2']]);
      await seedLeg(repo, SESSION_2, [['agent', 'b0'], ['caller', 'b1']]);
      const rows = await repo.listByCallSid(TENANT_A, CALL_SID);
      expect(rows.map((r) => r.text)).toEqual(['a0', 'a1', 'a2', 'b0', 'b1']);
    });

    it("does not return another tenant's turns", async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await seedLeg(repo, SESSION_1, [['agent', 'a0']]);
      expect(await repo.listByCallSid(TENANT_B, CALL_SID)).toEqual([]);
    });
  });

  describe('attachRecording', () => {
    it('renumbers two legs into one 0-based sequence and points them at the recording', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await seedLeg(repo, SESSION_1, [['agent', 'a0'], ['caller', 'a1'], ['agent', 'a2']]);
      await seedLeg(repo, SESSION_2, [['agent', 'b0'], ['caller', 'b1']]);

      const attached = await repo.attachRecording(TENANT_A, CALL_SID, RECORDING_1);
      expect(attached).toBe(5);

      const byRecording = await repo.listByRecording(TENANT_A, RECORDING_1);
      expect(byRecording.map((r) => [r.turnIndex, r.text])).toEqual([
        [0, 'a0'], [1, 'a1'], [2, 'a2'], [3, 'b0'], [4, 'b1'],
      ]);
      // The mid-call key survives attach so a late leg write still lands on its row.
      expect(byRecording.every((r) => r.callSid === CALL_SID)).toBe(true);
      expect(byRecording.map((r) => r.sessionId)).toEqual([
        SESSION_1, SESSION_1, SESSION_1, SESSION_2, SESSION_2,
      ]);
    });

    it('is first-writer-wins: a second recording id never re-points attached rows', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await seedLeg(repo, SESSION_1, [['agent', 'a0'], ['caller', 'a1']]);
      expect(await repo.attachRecording(TENANT_A, CALL_SID, RECORDING_1)).toBe(2);

      // Voicemail leg's webhook: a second voice_recordings row for the same call.
      expect(await repo.attachRecording(TENANT_A, CALL_SID, RECORDING_2)).toBe(0);
      expect(await repo.listByRecording(TENANT_A, RECORDING_2)).toEqual([]);
      const still = await repo.listByRecording(TENANT_A, RECORDING_1);
      expect(still.map((r) => [r.turnIndex, r.text])).toEqual([[0, 'a0'], [1, 'a1']]);
    });

    it('attaches only rows persisted after the first attach on a later attach', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await seedLeg(repo, SESSION_1, [['agent', 'a0']]);
      await repo.attachRecording(TENANT_A, CALL_SID, RECORDING_1);
      // A late fire-and-forget write that lost the race with the webhook.
      await repo.recordTurn({
        tenantId: TENANT_A, callSid: CALL_SID, sessionId: SESSION_1, turnIndex: 1,
        speaker: 'caller', text: 'late',
      });
      expect(await repo.attachRecording(TENANT_A, CALL_SID, RECORDING_2)).toBe(1);
      expect((await repo.listByRecording(TENANT_A, RECORDING_1)).map((r) => r.text)).toEqual(['a0']);
      expect((await repo.listByRecording(TENANT_A, RECORDING_2)).map((r) => r.text)).toEqual(['late']);
    });

    it('is tenant-scoped: attaching under another tenant touches nothing', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await seedLeg(repo, SESSION_1, [['agent', 'a0']]);
      expect(await repo.attachRecording(TENANT_B, CALL_SID, RECORDING_1)).toBe(0);
      const rows = await repo.listByCallSid(TENANT_A, CALL_SID);
      expect(rows[0].voiceRecordingId).toBeUndefined();
    });

    it('returns 0 when the call has no persisted turns', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      expect(await repo.attachRecording(TENANT_A, CALL_SID, RECORDING_1)).toBe(0);
    });
  });

  describe('parseTranscriptLine', () => {
    it('parses agent:/caller: prefixes and falls back to caller for unprefixed lines', () => {
      expect(parseTranscriptLine('agent: hi there')).toEqual({ speaker: 'agent', text: 'hi there' });
      expect(parseTranscriptLine('Caller:  my AC is broken ')).toEqual({
        speaker: 'caller',
        text: 'my AC is broken',
      });
      expect(parseTranscriptLine('unprefixed thing')).toEqual({
        speaker: 'caller',
        text: 'unprefixed thing',
      });
      expect(parseTranscriptLine('caller:   ')).toEqual({ speaker: 'caller', text: '' });
    });
  });
});
