import { describe, it, expect } from 'vitest';
import { InMemoryRetrievalEvalRunRepository } from '../../../src/ai/training/retrieval-eval-run';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const CHUNK_1 = '33333333-3333-3333-3333-333333333333';
const CHUNK_2 = '44444444-4444-4444-4444-444444444444';
const PROPOSAL_1 = '55555555-5555-5555-5555-555555555555';

describe('InMemoryRetrievalEvalRunRepository', () => {
  describe('recordRun validation', () => {
    it('rejects empty tenantId', async () => {
      const repo = new InMemoryRetrievalEvalRunRepository();
      await expect(
        repo.recordRun({
          tenantId: '',
          queryText: 'q',
          retrievedChunkIds: [],
          retrievedScores: [],
        }),
      ).rejects.toThrow(/tenantId is required/);
    });

    it('rejects empty queryText', async () => {
      const repo = new InMemoryRetrievalEvalRunRepository();
      await expect(
        repo.recordRun({
          tenantId: TENANT_A,
          queryText: '',
          retrievedChunkIds: [],
          retrievedScores: [],
        }),
      ).rejects.toThrow(/queryText must be non-empty/);
    });

    it('rejects mismatched chunk-id / score arrays', async () => {
      const repo = new InMemoryRetrievalEvalRunRepository();
      await expect(
        repo.recordRun({
          tenantId: TENANT_A,
          queryText: 'q',
          retrievedChunkIds: [CHUNK_1, CHUNK_2],
          retrievedScores: [0.9],
        }),
      ).rejects.toThrow(/length mismatch/);
    });

    it('rejects scores outside [0, 1]', async () => {
      const repo = new InMemoryRetrievalEvalRunRepository();
      for (const bad of [-0.01, 1.01, NaN]) {
        await expect(
          repo.recordRun({
            tenantId: TENANT_A,
            queryText: 'q',
            retrievedChunkIds: [CHUNK_1],
            retrievedScores: [bad],
          }),
        ).rejects.toThrow(/scores must be in \[0, 1\]/);
      }
    });
  });

  describe('happy path', () => {
    it('persists a run with chunk ids + scores', async () => {
      const repo = new InMemoryRetrievalEvalRunRepository();
      const run = await repo.recordRun({
        tenantId: TENANT_A,
        queryText: 'find available slots tuesday afternoon',
        retrievedChunkIds: [CHUNK_1, CHUNK_2],
        retrievedScores: [0.93, 0.81],
      });
      expect(run.id).toBeDefined();
      expect(run.tenantId).toBe(TENANT_A);
      expect(run.retrievedChunkIds).toEqual([CHUNK_1, CHUNK_2]);
      expect(run.retrievedScores).toEqual([0.93, 0.81]);
      expect(run.downstreamProposalId).toBeUndefined();
    });

    it('persists empty chunk arrays (zero-hit retrieval still gets recorded for analytics)', async () => {
      const repo = new InMemoryRetrievalEvalRunRepository();
      const run = await repo.recordRun({
        tenantId: TENANT_A,
        queryText: 'q',
        retrievedChunkIds: [],
        retrievedScores: [],
      });
      expect(run.retrievedChunkIds).toEqual([]);
      expect(run.retrievedScores).toEqual([]);
    });
  });

  describe('attachOutcome', () => {
    it('attaches a downstream proposal + outcome to an existing run', async () => {
      const repo = new InMemoryRetrievalEvalRunRepository();
      const run = await repo.recordRun({
        tenantId: TENANT_A,
        queryText: 'q',
        retrievedChunkIds: [CHUNK_1],
        retrievedScores: [0.9],
      });
      const updated = await repo.attachOutcome({
        tenantId: TENANT_A,
        evalRunId: run.id,
        downstreamProposalId: PROPOSAL_1,
        downstreamOutcome: 'approved',
      });
      expect(updated?.downstreamProposalId).toBe(PROPOSAL_1);
      expect(updated?.downstreamOutcome).toBe('approved');
    });

    it('preserves the prior outcome when only the proposal id is updated', async () => {
      const repo = new InMemoryRetrievalEvalRunRepository();
      const run = await repo.recordRun({
        tenantId: TENANT_A,
        queryText: 'q',
        retrievedChunkIds: [CHUNK_1],
        retrievedScores: [0.9],
        downstreamOutcome: 'approved',
      });
      const updated = await repo.attachOutcome({
        tenantId: TENANT_A,
        evalRunId: run.id,
        downstreamProposalId: PROPOSAL_1,
      });
      expect(updated?.downstreamProposalId).toBe(PROPOSAL_1);
      expect(updated?.downstreamOutcome).toBe('approved');
    });

    it('returns null when the run does not exist', async () => {
      const repo = new InMemoryRetrievalEvalRunRepository();
      const updated = await repo.attachOutcome({
        tenantId: TENANT_A,
        evalRunId: '00000000-0000-0000-0000-000000000000',
        downstreamOutcome: 'approved',
      });
      expect(updated).toBeNull();
    });

    it('does not allow tenant B to attach outcome to tenant A\'s run', async () => {
      const repo = new InMemoryRetrievalEvalRunRepository();
      const run = await repo.recordRun({
        tenantId: TENANT_A,
        queryText: 'q',
        retrievedChunkIds: [CHUNK_1],
        retrievedScores: [0.9],
      });
      const updated = await repo.attachOutcome({
        tenantId: TENANT_B,
        evalRunId: run.id,
        downstreamOutcome: 'approved',
      });
      expect(updated).toBeNull();
    });
  });

  describe('findById', () => {
    it('returns the row when tenant matches', async () => {
      const repo = new InMemoryRetrievalEvalRunRepository();
      const run = await repo.recordRun({
        tenantId: TENANT_A,
        queryText: 'q',
        retrievedChunkIds: [],
        retrievedScores: [],
      });
      const fetched = await repo.findById(TENANT_A, run.id);
      expect(fetched?.id).toBe(run.id);
    });

    it('returns null when tenant mismatches (RLS-style)', async () => {
      const repo = new InMemoryRetrievalEvalRunRepository();
      const run = await repo.recordRun({
        tenantId: TENANT_A,
        queryText: 'q',
        retrievedChunkIds: [],
        retrievedScores: [],
      });
      expect(await repo.findById(TENANT_B, run.id)).toBeNull();
    });
  });
});
