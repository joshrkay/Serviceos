/**
 * Customer portal — save a card on file (#6 phase 4). The SetupIntent is
 * created via the injectable Stripe fetcher; the resulting card is persisted
 * by the setup_intent.succeeded webhook (covered separately).
 */
import { describe, it, expect } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryPortalSessionRepository } from '../../src/portal/portal-session';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import { InMemoryCustomerPaymentMethodRepository } from '../../src/payments/customer-payment-method';
import { createPortalRouter } from '../../src/routes/portal';
import { createPublicPortalRouter } from '../../src/routes/public-portal';
import { StripeFetch } from '../../src/payments/stripe-payment-intent';

const TENANT = uuidv4();

function jsonRes(ok: boolean, status: number, body: unknown) {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body };
}

async function build(opts: { withStripe?: boolean; stripeFetch?: StripeFetch } = {}) {
  const app = express();
  app.use(express.json());

  const portalRepo = new InMemoryPortalSessionRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const customerPaymentMethodRepo = new InMemoryCustomerPaymentMethodRepository();

  const customer = await customerRepo.create({
    id: uuidv4(),
    tenantId: TENANT,
    firstName: 'Pat',
    lastName: 'Customer',
    displayName: 'Pat Customer',
    email: 'pat@example.com',
    primaryPhone: '+15555550100',
    preferredChannel: 'email',
    smsConsent: false,
    isArchived: false,
    createdBy: 'u',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  app.use(
    '/api/public/portal',
    createPublicPortalRouter({
      portalRepo,
      customerRepo,
      estimateRepo: new InMemoryEstimateRepository(),
      invoiceRepo: new InMemoryInvoiceRepository(),
      jobRepo: new InMemoryJobRepository(),
      agreementRepo: new InMemoryAgreementRepository(),
      appointmentRepo: new InMemoryAppointmentRepository(),
      leadRepo: new InMemoryLeadRepository(),
      customerPaymentMethodRepo,
      stripeConfig: opts.withStripe === false ? undefined : { apiKey: 'sk_test' },
      stripeFetch: opts.stripeFetch,
    }),
  );
  // Owner context for the token-minting route (mounted after the public
  // portal so it doesn't gate the token-authed portal routes).
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'owner-1',
      sessionId: 'session-1',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use('/api/portal-sessions', createPortalRouter({ portalRepo, customerRepo }));

  return { app, customer, customerPaymentMethodRepo };
}

async function mintToken(app: express.Express, customerId: string): Promise<string> {
  const res = await request(app).post('/api/portal-sessions').send({ customerId });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

describe('POST /:token/payment-methods/setup', () => {
  it('returns a SetupIntent client secret and creates a Stripe customer', async () => {
    const calls: string[] = [];
    const stripeFetch: StripeFetch = async (url) => {
      calls.push(url);
      if (url.includes('/v1/customers')) return jsonRes(true, 200, { id: 'cus_new' });
      return jsonRes(true, 200, { id: 'seti_1', client_secret: 'seti_secret' });
    };
    const h = await build({ stripeFetch });
    const token = await mintToken(h.app, h.customer.id);

    const res = await request(h.app)
      .post(`/api/public/portal/${token}/payment-methods/setup`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe('seti_secret');
    expect(calls.some((u) => u.includes('/v1/customers'))).toBe(true);
  });

  it('reuses the existing Stripe customer for a returning customer', async () => {
    const calls: string[] = [];
    const stripeFetch: StripeFetch = async (url) => {
      calls.push(url);
      return jsonRes(true, 200, { id: 'seti_2', client_secret: 'sec2' });
    };
    const h = await build({ stripeFetch });
    await h.customerPaymentMethodRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      customerId: h.customer.id,
      stripeCustomerId: 'cus_existing',
      stripePaymentMethodId: 'pm_old',
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const token = await mintToken(h.app, h.customer.id);

    const res = await request(h.app)
      .post(`/api/public/portal/${token}/payment-methods/setup`)
      .send({});

    expect(res.status).toBe(200);
    expect(calls.some((u) => u.includes('/v1/customers'))).toBe(false);
  });

  it('returns 503 when card-on-file is not configured', async () => {
    const h = await build({ withStripe: false });
    const token = await mintToken(h.app, h.customer.id);
    const res = await request(h.app)
      .post(`/api/public/portal/${token}/payment-methods/setup`)
      .send({});
    expect(res.status).toBe(503);
  });
});

describe('GET /:token/payment-methods', () => {
  it('lists saved cards with display metadata only — never the Stripe ids', async () => {
    const h = await build();
    await h.customerPaymentMethodRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      customerId: h.customer.id,
      stripeCustomerId: 'cus_x',
      stripePaymentMethodId: 'pm_secret',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2031,
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const token = await mintToken(h.app, h.customer.id);

    const res = await request(h.app).get(`/api/public/portal/${token}/payment-methods`);

    expect(res.status).toBe(200);
    expect(res.body.paymentMethods).toHaveLength(1);
    const pm = res.body.paymentMethods[0];
    expect(pm.brand).toBe('visa');
    expect(pm.last4).toBe('4242');
    expect(pm.isDefault).toBe(true);
    expect(pm.stripeCustomerId).toBeUndefined();
    expect(pm.stripePaymentMethodId).toBeUndefined();
  });
});
