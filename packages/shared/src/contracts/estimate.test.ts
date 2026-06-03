import { describe, expect, it } from 'vitest';
import { estimateSchema, estimateResponseSchema } from './estimate.js';

const baseEstimate = {
  id: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  jobId: '33333333-3333-3333-3333-333333333333',
  estimateNumber: 'E-2001',
  status: 'draft',
  lineItems: [
    {
      id: 'li-1',
      description: 'Compressor replacement',
      quantity: 1,
      unitPriceCents: 85000,
      totalCents: 85000,
      sortOrder: 0,
      taxable: true,
    },
  ],
  totals: {
    subtotalCents: 85000,
    discountCents: 0,
    taxRateBps: 0,
    taxableSubtotalCents: 85000,
    taxCents: 0,
    totalCents: 85000,
  },
  version: 1,
  createdBy: 'user_abc',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

describe('estimateSchema', () => {
  it('parses a representative estimate with line items + totals', () => {
    const parsed = estimateSchema.parse(baseEstimate);
    expect(parsed.totals.totalCents).toBe(85000);
    expect(parsed.lineItems).toHaveLength(1);
  });

  it('reuses the canonical estimate status set', () => {
    expect(estimateSchema.safeParse({ ...baseEstimate, status: 'sent' }).success).toBe(true);
    // 'open' is an invoice status, not an estimate status.
    expect(estimateSchema.safeParse({ ...baseEstimate, status: 'open' }).success).toBe(false);
  });

  it('requires totals and the version lock', () => {
    const { version, ...withoutVersion } = baseEstimate;
    void version;
    expect(estimateSchema.safeParse(withoutVersion).success).toBe(false);
  });
});

describe('estimateResponseSchema', () => {
  it('validates an unenriched estimate (no customer)', () => {
    expect(estimateResponseSchema.safeParse(baseEstimate).success).toBe(true);
  });

  it('accepts an optional embedded customer summary', () => {
    const parsed = estimateResponseSchema.parse({
      ...baseEstimate,
      customer: { id: 'cust-1', firstName: 'Dana', lastName: 'Lee' },
    });
    expect(parsed.customer?.firstName).toBe('Dana');
  });
});
