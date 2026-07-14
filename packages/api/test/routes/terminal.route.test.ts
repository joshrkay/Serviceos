import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createTerminalRouter } from '../../src/routes/terminal';
import { Invoice, InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { StripeFetch } from '../../src/payments/stripe-payment-intent';

const TENANT = '11111111-1111-4111-8111-111111111111';
const INVOICE_ID = '22222222-2222-4222-8222-222222222222';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const lineItems = [{
    id: crypto.randomUUID(),
    description: 'Service',
    quantity: 1,
    unitPriceCents: 15000,
    totalCents: 15000,
    sortOrder: 0,
    taxable: false,
  }];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: INVOICE_ID,
    tenantId: TENANT,
    jobId: uuidv4(),
    invoiceNumber: 'INV-T-1',
    status: 'open',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function build(opts: {
  role?: 'owner' | 'dispatcher' | 'technician';
  connect?: { accountId: string; chargesEnabled: boolean } | null;
  stripeConfigured?: boolean;
  invoiceOverrides?: Partial<Invoice>;
  stripeFetch?: StripeFetch;
} = {}) {
  const invoiceRepo = new InMemoryInvoiceRepository();
  await invoiceRepo.create(makeInvoice(opts.invoiceOverrides));

  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const defaultFetch: StripeFetch = async (url, init) => {
    seen.push({
      url,
      headers: init.headers,
      body: init.body,
    });
    if (url.includes('connection_tokens')) {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ secret: 'pst_test' }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ id: 'pi_term', client_secret: 'pi_term_secret' }),
    };
  };

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const r = req as AuthenticatedRequest;
    r.auth = {
      userId: 'user-test',
      sessionId: 'sess-1',
      tenantId: TENANT,
      role: opts.role ?? 'owner',
    };
    next();
  });
  app.use(
    '/api/terminal',
    createTerminalRouter({
      invoiceRepo,
      stripeApiKey: opts.stripeConfigured === false ? null : 'sk_test',
      stripeFetch: opts.stripeFetch ?? defaultFetch,
      connectAccountResolver:
        opts.connect === undefined
          ? {
              resolveTenantConnectAccount: async () => ({
                accountId: 'acct_term_1',
                chargesEnabled: true,
              }),
            }
          : opts.connect === null
            ? {
                resolveTenantConnectAccount: async () => null,
              }
            : {
                resolveTenantConnectAccount: async () => opts.connect,
              },
    }),
  );
  return { app, seen };
}

describe('routes/terminal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('POST /connection-token returns secret on Connect', async () => {
    const { app, seen } = await build();
    const res = await request(app).post('/api/terminal/connection-token').send({});
    expect(res.status).toBe(200);
    expect(res.body.secret).toBe('pst_test');
    expect(res.body.stripeAccountId).toBe('acct_term_1');
    expect(seen[0].headers['Stripe-Account']).toBe('acct_term_1');
  });

  it('POST /payment-intents creates card_present PI for open invoice', async () => {
    const { app, seen } = await build();
    const res = await request(app)
      .post('/api/terminal/payment-intents')
      .send({ invoiceId: INVOICE_ID });
    expect(res.status).toBe(200);
    expect(res.body.paymentIntentId).toBe('pi_term');
    expect(res.body.amountCents).toBe(15000);
    expect(res.body.stripeAccountId).toBe('acct_term_1');
    const piCall = seen.find((s) => s.url.includes('/payment_intents'));
    expect(piCall?.body).toContain('card_present');
    expect(piCall?.headers['Stripe-Account']).toBe('acct_term_1');
  });

  it('returns CONNECT_REQUIRED when Connect is not ready', async () => {
    const { app } = await build({ connect: null });
    const res = await request(app)
      .post('/api/terminal/payment-intents')
      .send({ invoiceId: INVOICE_ID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONNECT_REQUIRED');
  });

  it('rejects draft invoices', async () => {
    const { app } = await build({ invoiceOverrides: { status: 'draft', amountDueCents: 15000 } });
    const res = await request(app)
      .post('/api/terminal/payment-intents')
      .send({ invoiceId: INVOICE_ID });
    expect(res.status).toBe(409);
  });

  it('returns 503 when Stripe is not configured', async () => {
    const { app } = await build({ stripeConfigured: false });
    const res = await request(app).post('/api/terminal/connection-token').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('STRIPE_NOT_CONFIGURED');
  });
});
