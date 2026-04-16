/**
 * UpdateInvoiceExecutionHandler tests.
 *
 * Verifies the handler: loads the invoice, applies edits via
 * applyInvoiceEdits, writes back via invoiceRepo.update, respects
 * tenant isolation, and returns a descriptive failure rather than
 * throwing when the invoice is missing, the wrong tenant, or the
 * wrong status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateInvoiceExecutionHandler } from '../../src/proposals/execution/update-invoice-handler';
import {
  Invoice,
  InvoiceRepository,
  InMemoryInvoiceRepository,
} from '../../src/invoices/invoice';
import { Proposal } from '../../src/proposals/proposal';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const lineItems: LineItem[] = [
    buildLineItem('li-1', 'Diagnostic visit', 1, 12500, 0, true, 'labor'),
    buildLineItem('li-2', 'Replacement filter', 2, 3500, 1, true, 'material'),
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
    proposalType: 'update_invoice',
    status: 'approved',
    payload: {
      invoiceId: 'inv-1',
      editActions: [
        {
          type: 'add_line_item',
          lineItem: { description: 'Emergency surcharge', quantity: 1, unitPrice: 5000 },
        },
      ],
    },
    summary: 'Add emergency surcharge',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('UpdateInvoiceExecutionHandler', () => {
  let invoiceRepo: InvoiceRepository;
  let handler: UpdateInvoiceExecutionHandler;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(makeInvoice());
    handler = new UpdateInvoiceExecutionHandler(invoiceRepo);
  });

  it('applies edits and returns success with the invoice id', async () => {
    const result = await handler.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe('inv-1');

    const updated = await invoiceRepo.findById('t-1', 'inv-1');
    expect(updated).not.toBeNull();
    expect(updated!.lineItems).toHaveLength(3);
    expect(updated!.lineItems[2].description).toBe('Emergency surcharge');
    expect(updated!.totals.subtotalCents).toBe(12500 + 7000 + 5000);
  });

  it('supports a chain of edits in a single proposal', async () => {
    const proposal = makeProposal({
      payload: {
        invoiceId: 'inv-1',
        editActions: [
          { type: 'remove_line_item', index: 0 },
          {
            type: 'add_line_item',
            lineItem: { description: 'Premium service', quantity: 1, unitPrice: 20000 },
          },
        ],
      },
    });
    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(true);
    const updated = await invoiceRepo.findById('t-1', 'inv-1');
    expect(updated!.lineItems).toHaveLength(2);
    expect(updated!.lineItems.map((l) => l.description)).toEqual([
      'Replacement filter',
      'Premium service',
    ]);
  });

  it('returns failure when the invoice is missing', async () => {
    const proposal = makeProposal({
      payload: {
        invoiceId: 'does-not-exist',
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: 'anything', quantity: 1, unitPrice: 100 },
          },
        ],
      },
    });
    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('returns failure when the invoice belongs to a different tenant', async () => {
    const result = await handler.execute(makeProposal({ tenantId: 't-other' }), {
      tenantId: 't-other',
      executedBy: 'u-1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('returns failure when the invoice is not in draft status', async () => {
    await invoiceRepo.update('t-1', 'inv-1', { status: 'open' });
    const result = await handler.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/draft/i);
  });

  it('returns failure when payload is missing invoiceId', async () => {
    const proposal = makeProposal({
      payload: {
        editActions: [
          { type: 'add_line_item', lineItem: { description: 'x', quantity: 1, unitPrice: 1 } },
        ],
      },
    });
    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invoiceId/i);
  });

  it('returns failure when payload editActions array is empty', async () => {
    const proposal = makeProposal({
      payload: { invoiceId: 'inv-1', editActions: [] },
    });
    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/action/i);
  });

  it('surfaces ValidationError from the editor as a handler failure', async () => {
    const proposal = makeProposal({
      payload: {
        invoiceId: 'inv-1',
        editActions: [{ type: 'remove_line_item', index: 99 }],
      },
    });
    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/out of range/i);
  });

  it('propagates repo errors as thrown exceptions for the executor to retry', async () => {
    const failingRepo = {
      findById: vi.fn(async () => makeInvoice()),
      update: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as InvoiceRepository;
    const failingHandler = new UpdateInvoiceExecutionHandler(failingRepo);
    await expect(
      failingHandler.execute(makeProposal(), { tenantId: 't-1', executedBy: 'u-1' })
    ).rejects.toThrow(/db down/);
  });
});
