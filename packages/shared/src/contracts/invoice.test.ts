import { describe, expect, it } from 'vitest';
import { invoiceSchema, invoiceResponseSchema } from './invoice.js';

const baseInvoice = {
  id: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  jobId: '33333333-3333-3333-3333-333333333333',
  invoiceNumber: 'INV-3001',
  status: 'open',
  lineItems: [
    {
      id: 'li-1',
      description: 'Furnace tune-up',
      quantity: 1,
      unitPriceCents: 14900,
      totalCents: 14900,
      sortOrder: 0,
      taxable: true,
    },
  ],
  totals: {
    subtotalCents: 14900,
    discountCents: 0,
    taxRateBps: 0,
    taxableSubtotalCents: 14900,
    taxCents: 0,
    totalCents: 14900,
  },
  amountPaidCents: 0,
  amountDueCents: 14900,
  createdBy: 'user_abc',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

describe('invoiceSchema', () => {
  it('parses a representative invoice with line items + totals', () => {
    const parsed = invoiceSchema.parse(baseInvoice);
    expect(parsed.amountDueCents).toBe(14900);
    expect(parsed.lineItems).toHaveLength(1);
  });

  it('reuses the canonical invoice status set', () => {
    expect(invoiceSchema.safeParse({ ...baseInvoice, status: 'partially_paid' }).success).toBe(true);
    // 'sent' / 'accepted' are estimate statuses, not invoice statuses.
    expect(invoiceSchema.safeParse({ ...baseInvoice, status: 'sent' }).success).toBe(false);
  });

  it('keeps paid/due amounts integer cents', () => {
    expect(invoiceSchema.safeParse({ ...baseInvoice, amountDueCents: 149.0 + 0.5 }).success).toBe(false);
  });
});

describe('invoiceResponseSchema', () => {
  it('validates an unenriched invoice (no customer)', () => {
    expect(invoiceResponseSchema.safeParse(baseInvoice).success).toBe(true);
  });

  it('accepts an optional embedded customer summary', () => {
    const parsed = invoiceResponseSchema.parse({
      ...baseInvoice,
      customer: { id: 'cust-1', displayName: 'Acme Co', email: 'ap@acme.test' },
    });
    expect(parsed.customer?.displayName).toBe('Acme Co');
  });
});
