/**
 * Pins the estimate/invoice create line-item contract against the REAL Zod
 * schema (not a mocked client). The mobile create clients
 * (packages/mobile/src/api/{estimates,invoices}.ts) previously POSTed line
 * items as {description, quantity, unitPriceCents, catalogItemId}, omitting the
 * id/totalCents/sortOrder/taxable that `lineItemSchema` requires — so every
 * mobile estimate/invoice create 400'd. The mobile unit tests asserted the
 * SENT shape and passed, masking the server rejection (CLAUDE.md: "Tests that
 * mock the DB are never the only proof a query works").
 *
 * This test fails if the required fields are ever dropped again, and documents
 * exactly which fields the mobile `toServerLineItems` mapper must synthesize.
 */
import { describe, expect, it } from 'vitest';
import { createEstimateSchema, createInvoiceSchema } from '../../src/shared/contracts';

// The shape mobile's toServerLineItems() now produces.
const completeLineItem = {
  id: 'li-1',
  description: 'Labor',
  quantity: 2,
  unitPriceCents: 5000,
  totalCents: 10000,
  sortOrder: 0,
  taxable: false,
};

// The shape the mobile clients used to send (the bug).
const incompleteLineItem = {
  description: 'Labor',
  quantity: 2,
  unitPriceCents: 5000,
  catalogItemId: 'cat-1',
};

describe('estimate/invoice create line-item contract', () => {
  it('accepts the complete mobile line-item shape (id/totalCents/sortOrder/taxable present)', () => {
    expect(() =>
      createEstimateSchema.parse({ jobId: 'job-1', lineItems: [completeLineItem] }),
    ).not.toThrow();
    expect(() =>
      createInvoiceSchema.parse({ jobId: 'job-1', lineItems: [completeLineItem] }),
    ).not.toThrow();
  });

  it('rejects the old incomplete shape that omitted required fields (the original 400)', () => {
    expect(() =>
      createEstimateSchema.parse({ jobId: 'job-1', lineItems: [incompleteLineItem] }),
    ).toThrow();
    expect(() =>
      createInvoiceSchema.parse({ jobId: 'job-1', lineItems: [incompleteLineItem] }),
    ).toThrow();
  });

  it('keeps totalCents an integer (cents, never float math on money)', () => {
    const parsed = createEstimateSchema.parse({
      jobId: 'job-1',
      lineItems: [completeLineItem],
    });
    expect(Number.isInteger(parsed.lineItems[0].totalCents)).toBe(true);
  });
});
