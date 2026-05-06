import { describe, it, expect } from 'vitest';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const PROPOSAL_1 = '33333333-3333-3333-3333-333333333333';
const PROPOSAL_2 = '44444444-4444-4444-4444-444444444444';

describe('InMemoryProposalExecutionRepository', () => {
  describe('recordExecution validation', () => {
    it('rejects empty tenantId', async () => {
      const repo = new InMemoryProposalExecutionRepository();
      await expect(
        repo.recordExecution({
          tenantId: '',
          proposalId: PROPOSAL_1,
          executedPayload: {},
          executedBy: 'user-1',
          status: 'succeeded',
        }),
      ).rejects.toThrow(/tenantId is required/);
    });

    it('rejects empty proposalId', async () => {
      const repo = new InMemoryProposalExecutionRepository();
      await expect(
        repo.recordExecution({
          tenantId: TENANT_A,
          proposalId: '',
          executedPayload: {},
          executedBy: 'user-1',
          status: 'succeeded',
        }),
      ).rejects.toThrow(/proposalId is required/);
    });

    it('rejects empty executedBy', async () => {
      const repo = new InMemoryProposalExecutionRepository();
      await expect(
        repo.recordExecution({
          tenantId: TENANT_A,
          proposalId: PROPOSAL_1,
          executedPayload: {},
          executedBy: '',
          status: 'succeeded',
        }),
      ).rejects.toThrow(/executedBy is required/);
    });

    it('rejects unknown status', async () => {
      const repo = new InMemoryProposalExecutionRepository();
      await expect(
        repo.recordExecution({
          tenantId: TENANT_A,
          proposalId: PROPOSAL_1,
          executedPayload: {},
          executedBy: 'user-1',
          status: 'pending' as never,
        }),
      ).rejects.toThrow(/invalid status/);
    });

    it('requires errorMessage when status=failed', async () => {
      const repo = new InMemoryProposalExecutionRepository();
      await expect(
        repo.recordExecution({
          tenantId: TENANT_A,
          proposalId: PROPOSAL_1,
          executedPayload: {},
          executedBy: 'user-1',
          status: 'failed',
        }),
      ).rejects.toThrow(/errorMessage is required when status=failed/);
    });

    it('accepts succeeded without errorMessage', async () => {
      const repo = new InMemoryProposalExecutionRepository();
      const exec = await repo.recordExecution({
        tenantId: TENANT_A,
        proposalId: PROPOSAL_1,
        executedPayload: { foo: 'bar' },
        executedBy: 'user-1',
        status: 'succeeded',
      });
      expect(exec.status).toBe('succeeded');
      expect(exec.errorMessage).toBeUndefined();
    });
  });

  describe('idempotency', () => {
    it('with idempotencyKey: same key returns the original row', async () => {
      const repo = new InMemoryProposalExecutionRepository();
      const first = await repo.recordExecution({
        tenantId: TENANT_A,
        proposalId: PROPOSAL_1,
        executedPayload: { v: 1 },
        executedBy: 'user-1',
        status: 'succeeded',
        idempotencyKey: 'k-1',
      });
      const second = await repo.recordExecution({
        tenantId: TENANT_A,
        proposalId: PROPOSAL_1,
        executedPayload: { v: 999 },
        executedBy: 'user-1',
        status: 'succeeded',
        idempotencyKey: 'k-1',
      });
      expect(second.id).toBe(first.id);
      // Original payload preserved on collision.
      expect(second.executedPayload).toEqual({ v: 1 });
    });

    it('without idempotencyKey: each call inserts a new row (retry / undo / redo)', async () => {
      const repo = new InMemoryProposalExecutionRepository();
      const a = await repo.recordExecution({
        tenantId: TENANT_A,
        proposalId: PROPOSAL_1,
        executedPayload: { v: 1 },
        executedBy: 'user-1',
        status: 'succeeded',
      });
      const b = await repo.recordExecution({
        tenantId: TENANT_A,
        proposalId: PROPOSAL_1,
        executedPayload: { v: 1 },
        executedBy: 'user-1',
        status: 'undone',
      });
      const c = await repo.recordExecution({
        tenantId: TENANT_A,
        proposalId: PROPOSAL_1,
        executedPayload: { v: 2 },
        executedBy: 'user-1',
        status: 'succeeded',
      });
      expect(a.id).not.toBe(b.id);
      expect(b.id).not.toBe(c.id);
    });

    it('idempotencyKey scoped per (tenant, proposal): same key is a different row across proposals', async () => {
      const repo = new InMemoryProposalExecutionRepository();
      const a = await repo.recordExecution({
        tenantId: TENANT_A,
        proposalId: PROPOSAL_1,
        executedPayload: { v: 1 },
        executedBy: 'user-1',
        status: 'succeeded',
        idempotencyKey: 'shared',
      });
      const b = await repo.recordExecution({
        tenantId: TENANT_A,
        proposalId: PROPOSAL_2,
        executedPayload: { v: 2 },
        executedBy: 'user-1',
        status: 'succeeded',
        idempotencyKey: 'shared',
      });
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('findLatestByProposal', () => {
    it('returns the most-recent row by executed_at DESC', async () => {
      const repo = new InMemoryProposalExecutionRepository();
      const old = await repo.recordExecution({
        tenantId: TENANT_A,
        proposalId: PROPOSAL_1,
        executedPayload: { v: 1 },
        executedBy: 'user-1',
        status: 'succeeded',
        executedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const fresh = await repo.recordExecution({
        tenantId: TENANT_A,
        proposalId: PROPOSAL_1,
        executedPayload: { v: 2 },
        executedBy: 'user-1',
        status: 'succeeded',
        executedAt: new Date('2026-05-01T00:00:00Z'),
      });

      const latest = await repo.findLatestByProposal(TENANT_A, PROPOSAL_1);
      expect(latest?.id).toBe(fresh.id);
      // sanity: the older row is reachable via listByProposal
      const all = await repo.listByProposal(TENANT_A, PROPOSAL_1);
      expect(all.map((r) => r.id)).toContain(old.id);
    });

    it('returns null when no executions exist', async () => {
      const repo = new InMemoryProposalExecutionRepository();
      expect(await repo.findLatestByProposal(TENANT_A, PROPOSAL_1)).toBeNull();
    });

    it('does not return another tenant\'s execution', async () => {
      const repo = new InMemoryProposalExecutionRepository();
      await repo.recordExecution({
        tenantId: TENANT_B,
        proposalId: PROPOSAL_1,
        executedPayload: {},
        executedBy: 'tenantB',
        status: 'succeeded',
      });
      expect(await repo.findLatestByProposal(TENANT_A, PROPOSAL_1)).toBeNull();
    });
  });
});
