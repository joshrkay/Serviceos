/**
 * AST-04 — IssueInvoiceExecutionHandler tests.
 *
 * Covers: happy path (draft invoice issues successfully), missing invoice
 * reference (no invoiceId in payload), and wrong status (invoice not in draft).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IssueInvoiceExecutionHandler } from '../../src/proposals/handlers/issue-invoice';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import { Proposal } from '../../src/proposals/proposal';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const lineItems: LineItem[] = [
    buildLineItem('li-1', 'Labor', 1, 15000, 0, true, 'labor'),
  ];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: 'inv-1',
    tenantId: 't-1',
    jobId: 'job-1',
    invoiceNumber: 'INV-0001',
    status: 'draft',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'u-1',
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    tenantId: 't-1',
    proposalType: 'issue_invoice',
    status: 'approved',
    payload: { invoiceId: 'inv-1' },
    summary: 'Issue invoice INV-0001',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('AST-04 — IssueInvoiceExecutionHandler', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let handler: IssueInvoiceExecutionHandler;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(makeInvoice());
    handler = new IssueInvoiceExecutionHandler(invoiceRepo);
  });

  describe('happy path', () => {
    it('issues a draft invoice and returns success', async () => {
      const result = await handler.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });

      expect(result.success).toBe(true);
      expect(result.resultEntityId).toBe('inv-1');
    });

    it('transitions the invoice to open status', async () => {
      await handler.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });

      const issued = await invoiceRepo.findById('t-1', 'inv-1');
      expect(issued).not.toBeNull();
      expect(issued!.status).toBe('open');
      expect(issued!.issuedAt).toBeInstanceOf(Date);
      expect(issued!.dueDate).toBeInstanceOf(Date);
    });

    it('uses provided paymentTermDays when set', async () => {
      const proposal = makeProposal({ payload: { invoiceId: 'inv-1', paymentTermDays: 14 } });
      await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });

      const issued = await invoiceRepo.findById('t-1', 'inv-1');
      const diffDays =
        Math.round(
          (issued!.dueDate!.getTime() - issued!.issuedAt!.getTime()) / (1000 * 60 * 60 * 24)
        );
      expect(diffDays).toBe(14);
    });
  });

  describe('missing invoice reference', () => {
    it('returns a validation failure when invoiceId is absent from payload', async () => {
      const proposal = makeProposal({ payload: {} });
      const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invoice/i);
      expect(result.error).toMatch(/specify/i);
    });

    it('returns a validation failure when invoiceId is not a string', async () => {
      const proposal = makeProposal({ payload: { invoiceId: 42 } });
      const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invoice/i);
    });

    it('returns not-found when the invoice does not exist', async () => {
      const proposal = makeProposal({ payload: { invoiceId: 'does-not-exist' } });
      const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });
  });

  describe('wrong status', () => {
    it('returns a friendly error for an already-open invoice', async () => {
      await invoiceRepo.update('t-1', 'inv-1', { status: 'open' });
      const result = await handler.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/INV-0001/);
      expect(result.error).toMatch(/open/);
      expect(result.error).toMatch(/draft/i);
    });

    it('returns a friendly error for a void invoice', async () => {
      await invoiceRepo.update('t-1', 'inv-1', { status: 'void' });
      const result = await handler.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/void/);
      expect(result.error).toMatch(/draft/i);
    });

    it('returns a friendly error for a paid invoice', async () => {
      await invoiceRepo.update('t-1', 'inv-1', { status: 'paid' });
      const result = await handler.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/paid/);
    });
  });
});
