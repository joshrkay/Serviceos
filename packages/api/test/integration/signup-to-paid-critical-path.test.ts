import express from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

import { getSharedTestDb, closeSharedTestDb } from './shared';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { createEstimate, transitionEstimateStatus } from '../../src/estimates/estimate';
import { createInvoice, issueInvoice } from '../../src/invoices/invoice';
import { buildLineItem } from '../../src/shared/billing-engine';
import type { AppConfig } from '../../src/shared/config';

/**
 * TEST-04 — critical-path substitute for e2e/journeys/signup-to-first-estimate.spec.ts.
 *
 * e2e/README.md documents why the Playwright journey stays `test.skip()`:
 * the signup HALF needs live Clerk testing-token credentials
 * (E2E_CLERK_PUBLISHABLE_KEY / E2E_CLERK_SECRET_KEY — external secrets not
 * available in this sandbox or in CI without repo secrets configured), and
 * the estimate-drafting HALF needs the ephemeral seeded test DB
 * (E2E_USE_TEST_DB). Neither blocker is trivially satisfiable in-repo, so
 * per the TEST-04 instructions this test does NOT force-unskip the e2e
 * spec — it instead proves the equivalent CRITICAL PATH end-to-end against
 * a REAL Postgres, driven through the actual webhook route + repos/handlers
 * (no mocked pool):
 *
 *   1. A signed Clerk `user.created` webhook hits the REAL /webhooks/clerk
 *      route and `bootstrapTenant()` creates the tenant + seeds settings
 *      via PgTenantRepository/PgSettingsRepository (proves the exact
 *      server-side effect e2e step 6 checks via `/api/me`).
 *   2. A customer/location/job graph is created under that tenant via the
 *      real Pg repos.
 *   3. An estimate is drafted and walked through its real status lifecycle
 *      (draft -> sent -> accepted) via `createEstimate`/`transitionEstimateStatus`.
 *   4. An invoice is created from the job and issued (draft -> open) via
 *      `createInvoice`/`issueInvoice`.
 *   5. A signed Stripe `checkout.session.completed` webhook hits the REAL
 *      /webhooks/stripe route, which calls `recordPayment` and marks the
 *      invoice paid — closing the loop signup -> tenant -> estimate ->
 *      approve -> invoice -> paid.
 *
 * invoice-to-payment (Journey 3) is NOT re-covered here: e2e/README.md
 * already documents its hermetic continuous proof
 * (e2e/money-loop/invoice-webhook-paid.spec.ts +
 * packages/api/test/webhooks/invoice-webhook-paid.test.ts +
 * packages/api/test/integration/invoice-webhook-paid.test.ts), which this
 * file intentionally does not duplicate — it only reuses the same
 * checkout.session.completed mechanism as the FINAL link in the signup
 * chain above.
 */

const CLERK_SECRET = 'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA=='; // base64
const STRIPE_SECRET = 'whsec_test_signup_critical_path';

function signSvixPayload(body: object, svixId: string, svixTimestamp: string) {
  const rawBody = JSON.stringify(body);
  const secretBytes = Buffer.from(CLERK_SECRET.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

describe('Postgres integration — signup to first paid invoice (TEST-04 critical-path substitute)', () => {
  let pool: Pool;
  let tenantRepo: PgTenantRepository;
  let settingsRepo: PgSettingsRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let jobRepo: PgJobRepository;
  let estimateRepo: PgEstimateRepository;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let clerkApp: express.Express;
  let stripeApp: express.Express;

  const clerkUserId = `user_${crypto.randomUUID()}`;
  const ownerEmail = `owner-${crypto.randomUUID()}@example.com`;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantRepo = new PgTenantRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    jobRepo = new PgJobRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);

    clerkApp = express();
    clerkApp.use(express.json());
    const clerkConfig = { CLERK_WEBHOOK_SECRET: CLERK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
    clerkApp.use('/webhooks', createWebhookRouter(clerkConfig, { tenantRepo, settingsRepo }));

    stripeApp = express();
    stripeApp.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    stripeApp.use(
      '/webhooks',
      createWebhookRouter({} as AppConfig, {
        invoiceRepo,
        paymentRepo,
        stripeWebhookSecret: STRIPE_SECRET,
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('walks signup -> tenant bootstrap -> estimate -> approve -> invoice -> paid, end to end against real Postgres', async () => {
    // ── 1. Signup: real signed Clerk webhook bootstraps the tenant ──────
    const svixId = `evt_signup_${crypto.randomUUID()}`;
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const clerkPayload = {
      type: 'user.created',
      data: {
        id: clerkUserId,
        email_addresses: [{ email_address: ownerEmail }],
      },
    };
    const signature = signSvixPayload(clerkPayload, svixId, svixTimestamp);

    const clerkRes = await request(clerkApp)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', signature)
      .send(clerkPayload);
    expect(clerkRes.status).toBe(200);

    const tenant = await tenantRepo.findByOwner(clerkUserId);
    expect(tenant).toBeTruthy();
    const tenantId = tenant!.id;

    // Settings were seeded by bootstrapTenant (ensureTenantSettings) — proves
    // the real server-side effect the e2e journey's `/api/me` check depends on.
    const settings = await settingsRepo.findByTenant(tenantId);
    expect(settings).toBeTruthy();

    // ── 2. Customer / location / job graph ───────────────────────────────
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'First',
      lastName: 'Estimate',
      displayName: 'First Estimate',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: clerkUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1 Critical Path Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-SIGNUP-${jobId.slice(0, 8)}`,
      summary: 'First job from signup',
      status: 'scheduled',
      priority: 'normal',
      createdBy: clerkUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // ── 3. Estimate: draft -> sent -> accepted ───────────────────────────
    const lineItems = [buildLineItem('li-1', 'Diagnostic visit', 1, 10000, 1, false)];
    const estimate = await createEstimate(
      {
        tenantId,
        jobId,
        estimateNumber: `EST-SIGNUP-${jobId.slice(0, 8)}`,
        lineItems,
        createdBy: clerkUserId,
      },
      estimateRepo,
    );
    expect(estimate.status).toBe('draft');

    await transitionEstimateStatus(tenantId, estimate.id, 'sent', estimateRepo);
    const accepted = await transitionEstimateStatus(tenantId, estimate.id, 'accepted', estimateRepo);
    expect(accepted?.status).toBe('accepted');

    // ── 4. Invoice: create from the job, issue draft -> open ─────────────
    const invoice = await createInvoice(
      {
        tenantId,
        jobId,
        estimateId: estimate.id,
        invoiceNumber: `INV-SIGNUP-${jobId.slice(0, 8)}`,
        lineItems,
        createdBy: clerkUserId,
      },
      invoiceRepo,
    );
    expect(invoice.status).toBe('draft');
    expect(invoice.amountDueCents).toBe(10000);

    const issued = await issueInvoice(tenantId, invoice.id, 30, invoiceRepo);
    expect(issued?.status).toBe('open');

    // ── 5. Payment: real signed Stripe checkout.session.completed webhook ──
    const piId = `pi_signup_${crypto.randomUUID()}`;
    const stripeEvent = {
      id: `evt_stripe_${crypto.randomUUID()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenant_id: tenantId, invoice_id: invoice.id },
          amount_total: 10000,
          payment_status: 'paid',
          payment_intent: piId,
        },
      },
    };
    const stripeRawBody = JSON.stringify(stripeEvent);
    const stripeRes = await request(stripeApp)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(stripeRawBody, STRIPE_SECRET))
      .set('content-type', 'application/json')
      .send(stripeRawBody);
    expect(stripeRes.status).toBe(200);

    const paidInvoice = await invoiceRepo.findById(tenantId, invoice.id);
    expect(paidInvoice?.status).toBe('paid');
    expect(paidInvoice?.amountPaidCents).toBe(10000);
    expect(paidInvoice?.amountDueCents).toBe(0);

    const payments = await paymentRepo.findByInvoice(tenantId, invoice.id);
    expect(payments).toHaveLength(1);
    expect(payments[0].providerReference).toBe(piId);
    expect(payments[0].status).toBe('completed');
  });
});
