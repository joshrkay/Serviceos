import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { createPublicPaymentsRouter } from '../../src/routes/public-payments';
import { Invoice, InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { calculateDocumentTotals } from '../../src/shared/billing-engine';
import { StripeFetch } from '../../src/payments/stripe-payment-intent';

const TENANT = 'tenant-public-payments';
const VIEW_TOKEN = 'a'.repeat(32);

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const lineItems = [{
    id: crypto.randomUUID(),
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
    invoiceNumber: 'INV-001',
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

function makeStripeFetch(impl?: () => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>): StripeFetch {
  return impl
    ? (async () => impl()) as unknown as StripeFetch
    : (async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          id: 'pi_test_123',
          client_secret: 'pi_test_123_secret_abc',
        }),
      })) as unknown as StripeFetch;
}

interface Harness {
  app: express.Express;
  invoiceRepo: InMemoryInvoiceRepository;
  invoice: Invoice;
}

async function build(opts: {
  invoiceOverrides?: Partial<Invoice>;
  stripeConfigured?: boolean;
  stripeFetch?: StripeFetch;
} = {}): Promise<Harness> {
  const invoiceRepo = new InMemoryInvoiceRepository();
  const invoice = makeInvoice(opts.invoiceOverrides);
  await invoiceRepo.create(invoice);

  const app = express();
  app.use(express.json());
  app.use(
    '/api/public-payments',
    createPublicPaymentsRouter({
      invoiceRepo,
      stripeConfig: opts.stripeConfigured === false ? null : { apiKey: 'sk_test' },
      stripeFetch: opts.stripeFetch ?? makeStripeFetch(),
    }),
  );

  return { app, invoiceRepo, invoice };
}

describe('P5-016 routes/public-payments — POST /create-payment-intent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns clientSecret on the happy path', async () => {
    const { app, invoice } = await build();
    const res = await request(app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: invoice.id, viewToken: VIEW_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe('pi_test_123_secret_abc');
    expect(res.body.paymentIntentId).toBe('pi_test_123');
  });

  it('forwards invoice amountDueCents to Stripe', async () => {
    const seenBodies: string[] = [];
    const fetcher: StripeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenBodies.push(init?.body?.toString() ?? '');
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ id: 'pi_1', client_secret: 'pi_1_secret_x' }),
      };
    }) as unknown as StripeFetch;
    const { app, invoice } = await build({ stripeFetch: fetcher });
    await request(app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: invoice.id, viewToken: VIEW_TOKEN });
    expect(seenBodies[0]).toContain(`amount=${invoice.amountDueCents}`);
  });

  it('400s on invalid request body (missing invoiceId)', async () => {
    const { app } = await build();
    const res = await request(app)
      .post('/api/public-payments/create-payment-intent')
      .send({ viewToken: VIEW_TOKEN });
    expect(res.status).toBe(400);
  });

  it('400s on a too-short viewToken', async () => {
    const { app, invoice } = await build();
    const res = await request(app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: invoice.id, viewToken: 'short' });
    expect(res.status).toBe(400);
  });

  it('404s when the viewToken does not match any invoice', async () => {
    const { app, invoice } = await build();
    const res = await request(app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: invoice.id, viewToken: 'b'.repeat(32) });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('404s when the invoiceId in the body does not match the token-resolved invoice', async () => {
    const { app } = await build();
    const res = await request(app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: 'other-invoice-id', viewToken: VIEW_TOKEN });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('409s when the invoice is already paid', async () => {
    const { app, invoice } = await build({
      invoiceOverrides: { status: 'paid', amountDueCents: 0 },
    });
    const res = await request(app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: invoice.id, viewToken: VIEW_TOKEN });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INVALID_STATE');
  });

  it('409s when the invoice is voided', async () => {
    const { app, invoice } = await build({
      invoiceOverrides: { status: 'void' },
    });
    const res = await request(app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: invoice.id, viewToken: VIEW_TOKEN });
    expect(res.status).toBe(409);
  });

  it('409s when the invoice has no outstanding balance even if open', async () => {
    const { app, invoice } = await build({
      invoiceOverrides: { amountDueCents: 0 },
    });
    const res = await request(app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: invoice.id, viewToken: VIEW_TOKEN });
    expect(res.status).toBe(409);
  });

  it('503s when Stripe is not configured', async () => {
    const { app, invoice } = await build({ stripeConfigured: false });
    const res = await request(app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: invoice.id, viewToken: VIEW_TOKEN });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('STRIPE_NOT_CONFIGURED');
  });

  it('500s when Stripe returns a hard error', async () => {
    const fetcher: StripeFetch = (async () => ({
      ok: false,
      status: 502,
      text: async () => 'bad gateway',
      json: async () => ({}),
    })) as unknown as StripeFetch;
    const { app, invoice } = await build({ stripeFetch: fetcher });
    const res = await request(app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: invoice.id, viewToken: VIEW_TOKEN });
    expect(res.status).toBe(500);
  });

  it('accepts partially_paid invoices as payable', async () => {
    const { app, invoice } = await build({
      invoiceOverrides: {
        status: 'partially_paid',
        amountPaidCents: 2500,
        amountDueCents: 10000,
      },
    });
    const res = await request(app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: invoice.id, viewToken: VIEW_TOKEN });
    expect(res.status).toBe(200);
  });
});
