/**
 * P5-018 — Public payments status endpoint tests.
 *
 * Covers:
 *   - happy path returns the lean status shape
 *   - view-token mismatch returns 404
 *   - invoice-id mismatch returns 404 (same 404 as token mismatch so the
 *     endpoint can't be used to enumerate ids)
 *   - already-paid invoices short-circuit with 200 + status: 'paid'
 *   - too-short tokens are rejected with 400
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { createPublicPaymentsRouter } from '../../src/routes/public-payments';
import { Invoice, InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { calculateDocumentTotals } from '../../src/shared/billing-engine';

const TENANT = 'tenant-public-payments-status';
const VIEW_TOKEN = 'b'.repeat(32);

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const lineItems = [{
    id: 'li-1',
    description: 'Service call',
    quantity: 1,
    unitPriceCents: 12500,
    totalCents: 12500,
    sortOrder: 0,
    taxable: false,
  }];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: uuidv4(),
    tenantId: TENANT,
    jobId: uuidv4(),
    invoiceNumber: 'INV-099',
    status: 'open',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    viewToken: VIEW_TOKEN,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface Harness {
  app: express.Express;
  invoiceRepo: InMemoryInvoiceRepository;
  invoice: Invoice;
}

async function build(opts: { invoiceOverrides?: Partial<Invoice> } = {}): Promise<Harness> {
  const invoiceRepo = new InMemoryInvoiceRepository();
  const invoice = makeInvoice(opts.invoiceOverrides);
  await invoiceRepo.create(invoice);

  const app = express();
  app.use(express.json());
  app.use(
    '/api/public-payments',
    createPublicPaymentsRouter({
      invoiceRepo,
      stripeConfig: { apiKey: 'sk_test' },
    }),
  );

  return { app, invoiceRepo, invoice };
}

describe('P5-018 routes/public-payments-status — GET /status/:invoiceId', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the lean status shape on the happy path', async () => {
    const { app, invoice } = await build();
    const res = await request(app)
      .get(`/api/public-payments/status/${invoice.id}`)
      .query({ token: VIEW_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'open',
      amountDueCents: invoice.amountDueCents,
      amountPaidCents: 0,
      paidAt: null,
    });
  });

  it('does NOT include sensitive fields like line items or customer PII', async () => {
    const { app, invoice } = await build();
    const res = await request(app)
      .get(`/api/public-payments/status/${invoice.id}`)
      .query({ token: VIEW_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('lineItems');
    expect(res.body).not.toHaveProperty('totals');
    expect(res.body).not.toHaveProperty('createdBy');
    expect(res.body).not.toHaveProperty('jobId');
  });

  it('404s when the viewToken does not match any invoice', async () => {
    const { app, invoice } = await build();
    const res = await request(app)
      .get(`/api/public-payments/status/${invoice.id}`)
      .query({ token: 'c'.repeat(32) });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('404s when the invoiceId in the path does not match the token-resolved invoice', async () => {
    const { app } = await build();
    const res = await request(app)
      .get('/api/public-payments/status/some-other-id')
      .query({ token: VIEW_TOKEN });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('400s on a too-short token', async () => {
    const { app, invoice } = await build();
    const res = await request(app)
      .get(`/api/public-payments/status/${invoice.id}`)
      .query({ token: 'short' });

    expect(res.status).toBe(400);
  });

  it('returns 200 + status: paid for already-paid invoices (so the page can short-circuit)', async () => {
    const { app, invoice } = await build({
      invoiceOverrides: {
        status: 'paid',
        amountPaidCents: 12500,
        amountDueCents: 0,
      },
    });
    const res = await request(app)
      .get(`/api/public-payments/status/${invoice.id}`)
      .query({ token: VIEW_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
    expect(res.body.amountDueCents).toBe(0);
    expect(res.body.amountPaidCents).toBe(12500);
  });

  it('returns partially_paid status with remaining balance', async () => {
    const { app, invoice } = await build({
      invoiceOverrides: {
        status: 'partially_paid',
        amountPaidCents: 5000,
        amountDueCents: 7500,
      },
    });
    const res = await request(app)
      .get(`/api/public-payments/status/${invoice.id}`)
      .query({ token: VIEW_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('partially_paid');
    expect(res.body.amountDueCents).toBe(7500);
    expect(res.body.amountPaidCents).toBe(5000);
  });

  it('returns 400 when the token query param is missing', async () => {
    const { app, invoice } = await build();
    const res = await request(app).get(
      `/api/public-payments/status/${invoice.id}`,
    );
    expect(res.status).toBe(400);
  });
});
