/**
 * QA 2026-09-16 (matrix row AST-04) — belt and braces under the drafting
 * gates. approveProposal blocked ONLY on missingFields, so a proposal whose
 * invoiceId named a JOB (a real UUID, wrong entity) approved and then died at
 * execution with "Invoice not found". The drafting handler now checks what a
 * UUID names, but approval is the last human-visible seam: an approvable
 * proposal must also be an executable one (D-029). A reference check that
 * finds no such record refuses approval the same way an unfilled gate does,
 * so the review card's edit path takes over instead of a dead end.
 */
import { describe, it, expect } from 'vitest';
import { approveProposal } from '../../src/proposals/actions';
import {
  InMemoryProposalRepository,
  createProposal,
  type CreateProposalInput,
} from '../../src/proposals/proposal';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { buildInvoice } from '../factories/invoice.factory';
import { invoiceReferenceCheck } from '../../src/proposals/approval-reference-checks';
import { ValidationError } from '../../src/shared/errors';

const tenantId = 'tenant-ast04';
const actorId = 'user-ast04';
const JOB_ID = 'c73844bd-4928-4d1f-b8c5-f669ceb10018';
const INVOICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function sendInvoiceInput(invoiceId: string): CreateProposalInput {
  return {
    tenantId,
    proposalType: 'send_invoice',
    payload: { channel: 'sms', invoiceId },
    summary: 'Send the invoice by text',
    createdBy: actorId,
  };
}

describe('approveProposal — approval-time reference check (AST-04 belt and braces)', () => {
  it('refuses a send_invoice whose invoiceId names no invoice for the tenant, as an unfilled invoiceId gate', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = createProposal(sendInvoiceInput(JOB_ID));
    await repo.create(proposal);
    const invoiceRepo = new InMemoryInvoiceRepository(); // the "invoice" is a job id — nothing here

    const attempt = approveProposal(repo, tenantId, proposal.id, actorId, 'owner', undefined, 'ui', {
      referenceChecks: [invoiceReferenceCheck(invoiceRepo)],
    });
    await expect(attempt).rejects.toThrow(ValidationError);
    await expect(attempt).rejects.toMatchObject({ details: { missingFields: ['invoiceId'] } });
    // Untouched — still draft, still editable.
    expect((await repo.findById(tenantId, proposal.id))!.status).toBe('draft');
  });

  it('approves when the invoice exists for the tenant', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = createProposal(sendInvoiceInput(INVOICE_ID));
    await repo.create(proposal);
    const invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(buildInvoice({ id: INVOICE_ID, tenantId, jobId: JOB_ID }));

    const approved = await approveProposal(repo, tenantId, proposal.id, actorId, 'owner', undefined, 'ui', {
      referenceChecks: [invoiceReferenceCheck(invoiceRepo)],
    });
    expect(approved.status).toBe('approved');
  });
});
