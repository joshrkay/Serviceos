import {
  invoiceResponseSchema,
  estimateResponseSchema,
  type InvoiceResponse,
  type EstimateResponse,
} from '@ai-service-os/shared';

/**
 * #1400 — realistic /api/invoices and /api/estimates payloads for web
 * component tests. Every fixture is parsed through the shared response
 * contract, so a test can never again feed the UI a shape the API does not
 * serialize (the `i.totalCents` vs `totals.totalCents` drift that rendered
 * "$0" / "$NaN" on the dashboard). Money is the API's: tests render these
 * totals and must never recompute them.
 *
 * Default values mirror real QA-sweep payloads (dev, 2026-09-26): an invoice
 * with a $5.00 discount and 8.25% tax (total $93.42) and an estimate with
 * 8.25% tax (subtotal $300.99, total $325.82).
 */

const TENANT = '00000000-0000-4000-8000-000000000001';
const JOB = '00000000-0000-4000-8000-000000000002';

let seq = 0;
function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(100000000000 + seq).slice(-12)}`;
}

type InvoiceOverrides = Partial<Omit<InvoiceResponse, 'totals'>> & {
  totals?: Partial<InvoiceResponse['totals']>;
};

export function apiInvoice(overrides: InvoiceOverrides = {}): InvoiceResponse {
  const { totals, ...rest } = overrides;
  return invoiceResponseSchema.parse({
    id: uuid(),
    tenantId: TENANT,
    jobId: JOB,
    invoiceNumber: 'INV-0026',
    status: 'open',
    lineItems: [
      { id: uuid(), description: 'Labor', category: 'labor', quantity: 2, unitPriceCents: 4550, totalCents: 9100, sortOrder: 0, taxable: true },
      { id: uuid(), description: 'Filter part', category: 'material', quantity: 3, unitPriceCents: 10, totalCents: 30, sortOrder: 1, taxable: true },
    ],
    totals: {
      subtotalCents: 9130,
      taxableSubtotalCents: 9130,
      discountCents: 500,
      taxRateBps: 825,
      taxCents: 712,
      totalCents: 9342,
      ...totals,
    },
    amountPaidCents: 0,
    amountDueCents: 9342,
    issuedAt: '2026-09-27T02:23:19.595Z',
    dueDate: '2026-10-27T02:23:19.595Z',
    createdBy: 'user-1',
    createdAt: '2026-09-27T02:23:19.595Z',
    updatedAt: '2026-09-27T02:23:19.595Z',
    ...rest,
  });
}

type EstimateOverrides = Partial<Omit<EstimateResponse, 'totals'>> & {
  totals?: Partial<EstimateResponse['totals']>;
};

export function apiEstimate(overrides: EstimateOverrides = {}): EstimateResponse {
  const { totals, ...rest } = overrides;
  return estimateResponseSchema.parse({
    id: uuid(),
    tenantId: TENANT,
    jobId: JOB,
    estimateNumber: 'EST-0030',
    status: 'draft',
    lineItems: [
      { id: uuid(), description: 'Labor hour', category: 'labor', quantity: 2, unitPriceCents: 12550, totalCents: 25100, sortOrder: 0, taxable: true },
      { id: uuid(), description: 'Filter part', category: 'material', quantity: 1, unitPriceCents: 4999, totalCents: 4999, sortOrder: 1, taxable: true },
    ],
    totals: {
      subtotalCents: 30099,
      taxableSubtotalCents: 30099,
      discountCents: 0,
      taxRateBps: 825,
      taxCents: 2483,
      totalCents: 32582,
      ...totals,
    },
    version: 1,
    createdBy: 'user-1',
    createdAt: '2026-09-27T02:19:26.176Z',
    updatedAt: '2026-09-27T02:19:26.176Z',
    ...rest,
  });
}
