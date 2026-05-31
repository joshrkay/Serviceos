import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { BatchInvoiceExecutionHandler } from '../../src/proposals/execution/batch-invoice-handler';
import { actionClassForProposalType, Proposal, InMemoryProposalRepository } from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';
import { batchInvoicePayloadSchema } from '../../src/proposals/contracts/batch-invoice';

const TENANT = 'tenant-batch-handler';

function batchJob() {
  return {
    jobId: uuidv4(),
    customerId: uuidv4(),
    estimateId: uuidv4(),
    amountCents: 20000,
    lineItems: [{ id: 'i1', description: 'Repair', quantity: 1, unitPriceCents: 20000 }],
  };
}

function makeProposal(jobs: unknown[], overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'batch-1',
    tenantId: TENANT,
    proposalType: 'batch_invoice',
    status: 'approved',
    payload: { batchDate: '2026-05-31', totalCents: 20000, jobs },
    summary: 'Batch invoice',
    createdBy: 'system:batch_invoice',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('P21-003 — batch_invoice', () => {
  it('is classified capture-class', () => {
    expect(actionClassForProposalType('batch_invoice')).toBe('capture');
  });

  it('Zod contract is registered and validates the payload shape', () => {
    const ok = { batchDate: '2026-05-31', totalCents: 20000, jobs: [batchJob()] };
    expect(batchInvoicePayloadSchema.safeParse(ok).success).toBe(true);
    expect(validateProposalPayload('batch_invoice', ok).valid).toBe(true);
    // Empty jobs is rejected.
    expect(validateProposalPayload('batch_invoice', { batchDate: '2026-05-31', totalCents: 0, jobs: [] }).valid).toBe(false);
  });

  describe('execution fan-out', () => {
    let proposalRepo: InMemoryProposalRepository;
    let handler: BatchInvoiceExecutionHandler;

    beforeEach(() => {
      proposalRepo = new InMemoryProposalRepository();
      handler = new BatchInvoiceExecutionHandler(proposalRepo);
    });

    it('fans out one draft_invoice proposal per job on approval', async () => {
      const jobs = [batchJob(), batchJob(), batchJob()];
      const result = await handler.execute(makeProposal(jobs), { tenantId: TENANT, executedBy: 'u1' });
      expect(result.success).toBe(true);

      const created = await proposalRepo.findByTenant(TENANT);
      const drafts = created.filter((p) => p.proposalType === 'draft_invoice');
      expect(drafts).toHaveLength(3);
      // Each draft carries the unitPrice alias the draft_invoice contract needs,
      // alongside the original unitPriceCents.
      const li = (drafts[0].payload as { lineItems: Array<{ unitPrice: number; unitPriceCents: number }> }).lineItems[0];
      expect(li.unitPrice).toBe(20000);
      expect(li.unitPriceCents).toBe(20000);
      // Linked back to its job.
      expect(drafts.map((d) => (d.payload as { jobId: string }).jobId).sort()).toEqual(jobs.map((j) => j.jobId).sort());
    });

    it('preserves estimate discount + tax in each fanned-out draft', async () => {
      const job = { ...batchJob(), discountCents: 500, taxRateBps: 1000 };
      await handler.execute(makeProposal([job]), { tenantId: TENANT, executedBy: 'u1' });
      const draft = (await proposalRepo.findByTenant(TENANT)).find((p) => p.proposalType === 'draft_invoice')!;
      const payload = draft.payload as { discountCents: number; taxRateBps: number };
      expect(payload.discountCents).toBe(500);
      expect(payload.taxRateBps).toBe(1000);
    });

    it('errors on an empty job list', async () => {
      const result = await handler.execute(makeProposal([]), { tenantId: TENANT, executedBy: 'u1' });
      expect(result.success).toBe(false);
    });

    it('is idempotent on a prior resultEntityId (no re-fan-out)', async () => {
      const result = await handler.execute(
        makeProposal([batchJob()], { resultEntityId: 'already-done' }),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      expect(result.resultEntityId).toBe('already-done');
      expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    });

    it('degrades to a synthetic-id passthrough without a proposal repo', async () => {
      const bare = new BatchInvoiceExecutionHandler();
      const result = await bare.execute(makeProposal([batchJob()]), { tenantId: TENANT, executedBy: 'u1' });
      expect(result.success).toBe(true);
      expect(result.resultEntityId).toBeTruthy();
    });
  });
});
