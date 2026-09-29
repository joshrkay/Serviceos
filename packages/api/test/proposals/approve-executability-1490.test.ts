/**
 * #1490 — approvable must mean executable (D-029), for the two shapes the
 * 2026-09-29 re-verify found approving and then failing:
 *   item 1: a draft_invoice from an estimate that is already invoiced
 *           (the insert then collides with uq_invoices_estimate);
 *   item 3: issue_invoice (and its send siblings) naming a document that is
 *           not an invoice this tenant owns — `{invoiceId: "EST-0057"}`.
 *
 * Seam: approveProposal with the approval reference checks, as app.ts wires them.
 */
import { describe, it, expect } from 'vitest';
import { approveProposal } from '../../src/proposals/actions';
import {
  InMemoryProposalRepository,
  createProposal,
  type CreateProposalInput,
} from '../../src/proposals/proposal';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { estimateInvoicedReferenceCheck } from '../../src/proposals/approval-reference-checks';
import { buildInvoice } from '../factories/invoice.factory';
import { buildEstimate } from '../factories/estimate.factory';
import { ValidationError } from '../../src/shared/errors';

const tenantId = 'tenant-1490';
const actorId = 'user-1490';
const JOB_ID = 'a1a1a1a1-1111-4111-8111-111111111111';
const ESTIMATE_ID = 'b2b2b2b2-2222-4222-8222-222222222222';

async function approve(input: CreateProposalInput, checks: Parameters<typeof approveProposal>[7]) {
  const repo = new InMemoryProposalRepository();
  const proposal = createProposal(input);
  await repo.create(proposal);
  const attempt = approveProposal(repo, tenantId, proposal.id, actorId, 'owner', undefined, 'ui', checks);
  return { repo, proposal, attempt };
}

describe('#1490 item 1 — a second invoice from an already-invoiced estimate is refused at approval', () => {
  function draftFromEstimate(): CreateProposalInput {
    return {
      tenantId,
      proposalType: 'draft_invoice',
      payload: {
        jobId: JOB_ID,
        estimateId: ESTIMATE_ID,
        lineItems: [{ description: 'Drain cleaning', quantity: 1, unitPriceCents: 50000, totalCents: 50000 }],
      },
      summary: 'Invoice the drain estimate',
      createdBy: actorId,
    };
  }

  async function repos(opts: { invoiced: boolean }) {
    const estimateRepo = new InMemoryEstimateRepository();
    await estimateRepo.create(
      buildEstimate({ id: ESTIMATE_ID, tenantId, jobId: JOB_ID, estimateNumber: 'EST-0057', status: 'accepted' }),
    );
    const invoiceRepo = new InMemoryInvoiceRepository();
    if (opts.invoiced) {
      await invoiceRepo.create(
        buildInvoice({ tenantId, jobId: JOB_ID, estimateId: ESTIMATE_ID, invoiceNumber: 'INV-0031' }),
      );
    }
    return { estimateRepo, invoiceRepo };
  }

  it('refuses it, naming the invoice that already bills the estimate; the proposal stays reviewable', async () => {
    const { repo, proposal, attempt } = await approve(draftFromEstimate(), {
      referenceChecks: [estimateInvoicedReferenceCheck(await repos({ invoiced: true }))],
    });
    await expect(attempt).rejects.toThrow(ValidationError);
    await expect(attempt).rejects.toThrow(/already invoiced/i);
    expect((await repo.findById(tenantId, proposal.id))!.status).toBe('draft');
  });

  it('approves the first invoice from that estimate', async () => {
    const { attempt } = await approve(draftFromEstimate(), {
      referenceChecks: [estimateInvoicedReferenceCheck(await repos({ invoiced: false }))],
    });
    await expect(attempt).resolves.toMatchObject({ status: 'approved' });
  });
});
