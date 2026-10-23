/**
 * R2-1 — editProposal decides "did the row change since my read?" against
 * the row AS READ, never against objects its own work can change.
 *
 * The edited payload and sourceContext are built with shallow spreads of the
 * read row, so their nested objects are the read row's own. The #1405
 * estimate pick's re-draft once deleted keys from the shared `_meta` in
 * place; updateIfUnchanged then compared the altered read with the stored
 * row, saw a change nobody wrote, and refused every such pick as raced.
 * That re-draft now works on a copy (test/ai/tasks/invoice-task-from-
 * estimate.test.ts); this pins the comparison itself, so the next helper
 * that changes something in place cannot bring the false refusal back.
 *
 * Seam: editProposal with the re-draft replaced by one that changes the
 * nested objects it is handed in place, and the in-memory repository, whose
 * reads are deep copies like a Postgres read.
 */
import { describe, expect, it, vi } from 'vitest';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';
import { editProposal } from '../../src/proposals/actions';

vi.mock('../../src/ai/tasks/invoice-task', () => ({
  redraftInvoiceOnEstimatePick: vi.fn(
    async (
      _estimateRepo: unknown,
      _tenantId: string,
      proposal: { payload: Record<string, unknown>; sourceContext?: Record<string, unknown> },
    ) => {
      delete (proposal.payload._meta as Record<string, unknown>).markers;
      (proposal.payload.lineItems as Array<Record<string, unknown>>)[0].description = 'Repipe kitchen';
    },
  ),
}));

const TENANT = 'tenant-r2-1';
const EST = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

const asDrafted = () => ({
  customerId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  lineItems: [{ description: 'Service as per accepted estimate', quantity: 1, unitPriceCents: 1000, totalCents: 1000 }],
  _meta: { overallConfidence: 'low', markers: [{ path: 'lineItems[0].unitPriceCents', reason: 'x' }] },
});

describe('R2-1 — an in-place change made while editing never reads as a race', () => {
  it('the pick is written, not refused, and the payload as first proposed is the row as read', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = await repo.create(
      createProposal({
        tenantId: TENANT,
        proposalType: 'draft_invoice',
        payload: asDrafted(),
        summary: 'Invoice the accepted estimate',
        createdBy: 'owner-1',
        missingFields: ['estimateId'],
        sourceContext: {
          pendingEntityAmbiguity: {
            entityKind: 'estimate',
            reference: 'the accepted estimate',
            refKey: 'estimateId',
            candidates: [{ id: EST, name: 'EST-0002', hint: 'accepted · $1,082.50', score: 1 }],
            partialRefs: {},
            attemptCount: 0,
          },
        },
      }),
    );

    const { proposal: updated } = await editProposal(repo, TENANT, proposal.id, 'owner-1', 'owner', { estimateId: EST });

    expect(updated.payload.estimateId).toBe(EST);
    const stored = (await repo.findById(TENANT, proposal.id))!;
    expect(stored.payload.estimateId).toBe(EST);
    expect(stored.originalPayload).toEqual(asDrafted());
  });
});
