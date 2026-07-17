/**
 * invoice-editor unit tests.
 *
 * The invoice-editor applies a list of structured edit actions to an
 * Invoice entity and returns the updated invoice with recomputed totals.
 * Used by UpdateInvoiceExecutionHandler when the operator approves a
 * voice-driven update_invoice proposal.
 *
 * Key invariants covered here:
 *   - Only draft invoices can be edited — anything else throws
 *   - Line item totals and document totals are recomputed after every edit
 *   - Invalid indices and invalid line items fail with ValidationError
 *   - No mutation — input invoice is never modified
 */
import { describe, it, expect } from 'vitest';
import {
  applyInvoiceEdits,
  InvoiceEditAction,
  InvoiceEditLineItemInput,
} from '../../src/invoices/invoice-editor';
import { Invoice } from '../../src/invoices/invoice';
import { LineItem, calculateDocumentTotals, buildLineItem } from '../../src/shared/billing-engine';
import { ValidationError } from '../../src/shared/errors';

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

describe('applyInvoiceEdits — add_line_item', () => {
  it('appends a new line item and recomputes totals', () => {
    const invoice = makeInvoice();
    const action: InvoiceEditAction = {
      type: 'add_line_item',
      lineItem: {
        description: 'Emergency surcharge',
        quantity: 1,
        unitPrice: 5000,
        category: 'other',
      } satisfies InvoiceEditLineItemInput,
    };

    const { updatedInvoice, editedFields } = applyInvoiceEdits(invoice, [action]);

    expect(updatedInvoice.lineItems).toHaveLength(3);
    expect(updatedInvoice.lineItems[2].description).toBe('Emergency surcharge');
    expect(updatedInvoice.lineItems[2].totalCents).toBe(5000);
    expect(updatedInvoice.lineItems[2].id).toMatch(/^[a-z0-9-]+$/i);
    expect(updatedInvoice.lineItems[2].sortOrder).toBe(2);
    expect(updatedInvoice.totals.subtotalCents).toBe(12500 + 7000 + 5000);
    expect(editedFields).toContain('lineItems[2]');
    // Input untouched — immutability.
    expect(invoice.lineItems).toHaveLength(2);
  });

  it('rejects line items with negative unit price', () => {
    const invoice = makeInvoice();
    expect(() =>
      applyInvoiceEdits(invoice, [
        { type: 'add_line_item', lineItem: { description: 'bad', quantity: 1, unitPrice: -1 } },
      ])
    ).toThrow(ValidationError);
  });

  it('rejects line items missing a description', () => {
    const invoice = makeInvoice();
    expect(() =>
      applyInvoiceEdits(invoice, [
        { type: 'add_line_item', lineItem: { description: '', quantity: 1, unitPrice: 100 } },
      ])
    ).toThrow(ValidationError);
  });
});

describe('applyInvoiceEdits — remove_line_item', () => {
  it('removes the targeted item and recomputes totals', () => {
    const invoice = makeInvoice();
    const { updatedInvoice, editedFields } = applyInvoiceEdits(invoice, [
      { type: 'remove_line_item', index: 0 },
    ]);
    expect(updatedInvoice.lineItems).toHaveLength(1);
    expect(updatedInvoice.lineItems[0].description).toBe('Replacement filter');
    expect(updatedInvoice.totals.subtotalCents).toBe(7000);
    expect(editedFields).toContain('lineItems');
  });

  it('rejects a negative index', () => {
    const invoice = makeInvoice();
    expect(() =>
      applyInvoiceEdits(invoice, [{ type: 'remove_line_item', index: -1 }])
    ).toThrow(ValidationError);
  });

  it('rejects an out-of-range index', () => {
    const invoice = makeInvoice();
    expect(() =>
      applyInvoiceEdits(invoice, [{ type: 'remove_line_item', index: 99 }])
    ).toThrow(ValidationError);
  });
});

describe('applyInvoiceEdits — update_line_item', () => {
  it('replaces a line item and keeps its id', () => {
    const invoice = makeInvoice();
    const originalId = invoice.lineItems[1].id;

    const { updatedInvoice } = applyInvoiceEdits(invoice, [
      {
        type: 'update_line_item',
        index: 1,
        lineItem: { description: 'Premium filter', quantity: 2, unitPrice: 5500, category: 'material' },
      },
    ]);

    expect(updatedInvoice.lineItems[1].id).toBe(originalId);
    expect(updatedInvoice.lineItems[1].description).toBe('Premium filter');
    expect(updatedInvoice.lineItems[1].totalCents).toBe(11000);
    expect(updatedInvoice.totals.subtotalCents).toBe(12500 + 11000);
  });
});

describe('applyInvoiceEdits — chaining', () => {
  it('applies multiple edits in order and recomputes once', () => {
    const invoice = makeInvoice();
    const { updatedInvoice, editedFields } = applyInvoiceEdits(invoice, [
      { type: 'remove_line_item', index: 1 },
      {
        type: 'add_line_item',
        lineItem: { description: 'Overnight service', quantity: 1, unitPrice: 25000, category: 'labor' },
      },
    ]);

    expect(updatedInvoice.lineItems).toHaveLength(2);
    expect(updatedInvoice.lineItems.map((l) => l.description)).toEqual([
      'Diagnostic visit',
      'Overnight service',
    ]);
    expect(updatedInvoice.totals.subtotalCents).toBe(12500 + 25000);
    expect(editedFields.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves amountPaidCents and recomputes amountDueCents', () => {
    const invoice = makeInvoice({ amountPaidCents: 1000, amountDueCents: 999999 });
    const { updatedInvoice } = applyInvoiceEdits(invoice, [
      {
        type: 'add_line_item',
        lineItem: { description: 'fee', quantity: 1, unitPrice: 1000 },
      },
    ]);
    expect(updatedInvoice.amountPaidCents).toBe(1000);
    expect(updatedInvoice.amountDueCents).toBe(updatedInvoice.totals.totalCents - 1000);
  });
});

describe('applyInvoiceEdits — status guard', () => {
  it('refuses to edit a non-draft invoice', () => {
    const invoice = makeInvoice({ status: 'open' });
    expect(() =>
      applyInvoiceEdits(invoice, [
        { type: 'add_line_item', lineItem: { description: 'x', quantity: 1, unitPrice: 100 } },
      ])
    ).toThrow(/draft/i);
  });

  it('refuses to edit a paid invoice', () => {
    const invoice = makeInvoice({ status: 'paid' });
    expect(() =>
      applyInvoiceEdits(invoice, [{ type: 'remove_line_item', index: 0 }])
    ).toThrow(/draft/i);
  });
});

describe('applyInvoiceEdits — empty actions', () => {
  it('rejects an empty action list (callers should never ask for a no-op)', () => {
    const invoice = makeInvoice();
    expect(() => applyInvoiceEdits(invoice, [])).toThrow(/at least one/i);
  });
});

describe('applyInvoiceEdits — pricingSource provenance', () => {
  it('carries pricingSource through add_line_item when the grounder stamped one', () => {
    const invoice = makeInvoice();
    const { updatedInvoice } = applyInvoiceEdits(invoice, [
      {
        type: 'add_line_item',
        lineItem: {
          description: 'Catalog-grounded part',
          quantity: 1,
          unitPrice: 4200,
          category: 'material',
          pricingSource: 'catalog',
        } satisfies InvoiceEditLineItemInput,
      },
    ]);

    expect(updatedInvoice.lineItems[2].pricingSource).toBe('catalog');
  });

  it('carries pricingSource through update_line_item when the grounder stamped one', () => {
    const invoice = makeInvoice();
    const { updatedInvoice } = applyInvoiceEdits(invoice, [
      {
        type: 'update_line_item',
        index: 1,
        lineItem: {
          description: 'Premium filter',
          quantity: 2,
          unitPrice: 5500,
          category: 'material',
          pricingSource: 'uncatalogued',
        } satisfies InvoiceEditLineItemInput,
      },
    ]);

    expect(updatedInvoice.lineItems[1].pricingSource).toBe('uncatalogued');
  });

  it('leaves pricingSource undefined when the action carries no grounding signal', () => {
    const invoice = makeInvoice();
    const { updatedInvoice } = applyInvoiceEdits(invoice, [
      {
        type: 'add_line_item',
        lineItem: {
          description: 'Manually entered line',
          quantity: 1,
          unitPrice: 1000,
        } satisfies InvoiceEditLineItemInput,
      },
    ]);

    expect(updatedInvoice.lineItems[2].pricingSource).toBeUndefined();
  });
});
