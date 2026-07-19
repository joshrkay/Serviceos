/**
 * Flow 2 end-to-end runthrough — tenant charges an end customer.
 *
 * Walks the COMPLETE money loop against the mock API: real Postgres, but
 * Stripe is mocked (stubbed fetch for Connect account/link creation + signed
 * webhooks standing in for Stripe's deliveries). No live Stripe, no real money.
 *
 *   1. Tenant starts Connect onboarding      → StripeConnectService (mock Stripe)
 *   2. Stripe finishes KYC → account.updated  → tenant becomes charges_enabled
 *   3. Tenant issues an invoice               → open invoice in real Postgres
 *   4. Customer pays → payment_intent.succeeded (connected) → invoice paid
 *   5. Idempotent replay                       → no double-credit
 *
 * Run: cd packages/api && npm run test:integration -- flow2-money-loop-runthrough
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { StripeConnectService } from '../../src/billing/stripe-connect';
import { PgWebhookRepository } from '../../src/webhooks/pg-webhook';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const SECRET = 'whsec_flow2_runthrough';
const CONNECT_ACCOUNT_ID = 'acct_mock_flow2';
const AMOUNT_CENTS = 42_500;

// Mock Stripe for the Connect service: account creation + account-link minting.
const mockConnectFetch = (async (url: string | URL | Request) => {
  const u = String(url);
  if (u.endsWith('/v1/accounts')) {
    return { ok: true, status: 200, json: async () => ({ id: CONNECT_ACCOUNT_ID }), text: async () => '' } as unknown as Response;
  }
  if (u.endsWith('/v1/account_links')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://connect.stripe.com/setup/mock' }),
      text: async () => '',
    } as unknown as Response;
  }
  throw new Error(`unexpected Stripe fetch: ${u}`);
}) as unknown as typeof fetch;

describe('Flow 2 runthrough — tenant charges end customer (mock Stripe, real Postgres)', () => {
  let pool: Pool;
  let app: express.Express;
  let connectService: StripeConnectService;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let tenant: { tenantId: string; userId: string };
  let invoiceId: string;

  function signed(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    return request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(raw, SECRET))
      .set('content-type', 'application/json')
      .send(raw);
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    connectService = new StripeConnectService({
      pool,
      config: { apiKey: 'sk_test_mock' },
      fetchFn: mockConnectFetch,
    });
    tenant = await createTestTenant(pool);
    app = express();
    app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    app.use(
      '/webhooks',
      createWebhookRouter({} as never, {
        invoiceRepo,
        paymentRepo,
        auditRepo: new PgAuditRepository(pool),
        webhookRepo: new PgWebhookRepository(pool),
        connectService,
        stripeWebhookSecret: SECRET,
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('STEP 1 — tenant starts Connect onboarding (mock Stripe mints account + link)', async () => {
    const before = await connectService.getAccount(tenant.tenantId);
    expect(before.accountId).toBeNull();

    const link = await connectService.createOnboardingLink({
      tenantId: tenant.tenantId,
      ownerEmail: 'owner@rivet.test',
      returnUrl: 'https://app.therivetapp.com/settings?stripe_connect=1',
      refreshUrl: 'https://app.therivetapp.com/settings?stripe_connect=1',
    });
    expect(link.url).toBe('https://connect.stripe.com/setup/mock');
    expect(link.accountId).toBe(CONNECT_ACCOUNT_ID);

    const after = await connectService.getAccount(tenant.tenantId);
    expect(after.accountId).toBe(CONNECT_ACCOUNT_ID);
    expect(after.status).toBe('pending'); // not enabled until account.updated
    expect(after.chargesEnabled).toBe(false);
    // eslint-disable-next-line no-console
    console.log('  ✓ onboarding link minted; tenant account pending, chargesEnabled=false');
  });

  it('STEP 2 — Stripe finishes KYC: signed account.updated flips tenant to charges_enabled', async () => {
    const res = await signed({
      id: `evt_${randomUUID()}`,
      type: 'account.updated',
      account: CONNECT_ACCOUNT_ID, // connected-account-scoped delivery
      data: {
        object: {
          id: CONNECT_ACCOUNT_ID,
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          requirements: { disabled_reason: null },
        },
      },
    });
    expect(res.status).toBe(200);

    const view = await connectService.getAccount(tenant.tenantId);
    expect(view.status).toBe('active');
    expect(view.chargesEnabled).toBe(true);
    expect(view.payoutsEnabled).toBe(true);
    // eslint-disable-next-line no-console
    console.log('  ✓ account.updated webhook mirrored → status=active, chargesEnabled=true');
  });

  it('STEP 3 — Connect routing: the tenant now resolves for direct-charge routing', async () => {
    // This is exactly what app.ts wires as connectAccountResolver: a
    // charges_enabled tenant returns its acct_… so charges carry Stripe-Account.
    const view = await connectService.getAccount(tenant.tenantId);
    const routed = view.accountId && view.chargesEnabled ? view.accountId : undefined;
    expect(routed).toBe(CONNECT_ACCOUNT_ID);
    // eslint-disable-next-line no-console
    console.log('  ✓ charges for this tenant would route to acct_mock_flow2 (direct charge)');
  });

  it('STEP 4 — tenant issues an invoice to a customer (open, real Postgres)', async () => {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    const customerId = randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'End',
      lastName: 'Customer',
      displayName: 'End Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '5 Flow Two Ave',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: 'Flow 2 runthrough',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lineItems = [buildLineItem(randomUUID(), 'Service call', 1, AMOUNT_CENTS, 1, false)];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    invoiceId = randomUUID();
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const inv = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(inv?.status).toBe('open');
    expect(inv?.amountDueCents).toBe(AMOUNT_CENTS);
    // eslint-disable-next-line no-console
    console.log(`  ✓ invoice ${invoiceId.slice(0, 8)} open, $${(AMOUNT_CENTS / 100).toFixed(2)} due`);
  });

  it('STEP 5 — customer pays: signed payment_intent.succeeded (connected) settles the invoice', async () => {
    const eventId = `evt_${randomUUID()}`;
    const event = {
      id: eventId,
      type: 'payment_intent.succeeded',
      account: CONNECT_ACCOUNT_ID, // delivered from the Connected accounts destination
      data: {
        object: {
          id: `pi_${eventId}`,
          amount: AMOUNT_CENTS,
          amount_received: AMOUNT_CENTS,
          metadata: { tenant_id: tenant.tenantId, invoice_id: invoiceId },
          charges: { data: [{ payment_method_details: { type: 'card' } }] },
        },
      },
    };

    const res = await signed(event);
    expect(res.status).toBe(200);

    const paid = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(paid?.status).toBe('paid');
    expect(paid?.amountPaidCents).toBe(AMOUNT_CENTS);
    expect(paid?.amountDueCents).toBe(0);

    const payments = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0].method).toBe('credit_card');
    expect(payments[0].providerReference).toBe(`pi_${eventId}`);
    // eslint-disable-next-line no-console
    console.log('  ✓ payment settled → invoice PAID, $0 due, one payment recorded');

    // Idempotent replay — Stripe redelivery must not double-credit.
    const replay = await signed(event);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ received: true, duplicate: true });
    const afterReplay = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(afterReplay).toHaveLength(1);
    // eslint-disable-next-line no-console
    console.log('  ✓ replay ignored (duplicate) → still one payment, no double-charge');
  });
});
