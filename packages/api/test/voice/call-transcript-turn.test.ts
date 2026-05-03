import { describe, it, expect } from 'vitest';
import { InMemoryCallTranscriptTurnRepository } from '../../src/voice/call-transcript-turn';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const RECORDING_1 = '33333333-3333-3333-3333-333333333333';
const RECORDING_2 = '44444444-4444-4444-4444-444444444444';

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

    it('rejects empty voiceRecordingId', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      await expect(
        repo.recordTurn({
          tenantId: TENANT_A,
          voiceRecordingId: '',
          turnIndex: 0,
          speaker: 'agent',
          text: 'Hello',
        }),
      ).rejects.toThrow(/voiceRecordingId is required/);
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
});
