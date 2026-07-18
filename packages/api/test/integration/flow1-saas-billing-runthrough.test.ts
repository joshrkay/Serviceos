/**
 * Flow 1 end-to-end runthrough — Rivet charges the tenant (SaaS subscription).
 *
 * Walks the platform billing loop against the mock API: real Postgres, Stripe
 * mocked (stubbed fetch for customer + checkout-session creation, signed
 * webhooks standing in for Stripe's subscription deliveries). No live Stripe.
 *
 *   1. Tenant starts the trial checkout       → BillingService (mock Stripe)
 *   2. Checkout completes → subscription.created → tenant becomes 'trialing'
 *   3. Cached subscription view reflects it    → getSubscription()
 *   4. Trial converts → subscription.updated   → tenant becomes 'active'
 *
 * Run: cd packages/api && npm run test:integration -- flow1-saas-billing-runthrough
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { BillingService } from '../../src/billing/subscription';
import { PgWebhookRepository } from '../../src/webhooks/pg-webhook';

const SECRET = 'whsec_flow1_runthrough';
const CUSTOMER_ID = 'cus_mock_flow1';
const SUBSCRIPTION_ID = 'sub_mock_flow1';

// Mock Stripe for the SaaS billing service: customer + checkout-session create.
const mockBillingFetch = (async (url: string | URL | Request) => {
  const u = String(url);
  if (u.endsWith('/v1/customers')) {
    return { ok: true, status: 200, json: async () => ({ id: CUSTOMER_ID }), text: async () => '' } as unknown as Response;
  }
  if (u.endsWith('/v1/checkout/sessions')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'cs_mock_flow1', url: 'https://checkout.stripe.com/pay/mock_flow1' }),
      text: async () => '',
    } as unknown as Response;
  }
  throw new Error(`unexpected Stripe fetch: ${u}`);
}) as unknown as typeof fetch;

describe('Flow 1 runthrough — Rivet charges the tenant (mock Stripe, real Postgres)', () => {
  let pool: Pool;
  let app: express.Express;
  let billingService: BillingService;
  let tenant: { tenantId: string; userId: string };

  function signed(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    return request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(raw, SECRET))
      .set('content-type', 'application/json')
      .send(raw);
  }

  function subscriptionEvent(
    eventId: string,
    type: 'customer.subscription.created' | 'customer.subscription.updated',
    status: string,
    trialEnd: number | null,
  ) {
    return {
      id: eventId,
      type,
      data: {
        object: {
          id: SUBSCRIPTION_ID,
          customer: CUSTOMER_ID,
          status,
          trial_end: trialEnd,
          metadata: { tenant_id: tenant.tenantId },
        },
      },
    };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    process.env.STRIPE_PRICE_ID = 'price_mock_flow1';
    billingService = new BillingService({
      pool,
      config: { apiKey: 'sk_test_mock' },
      fetchFn: mockBillingFetch,
    });
    tenant = await createTestTenant(pool);
    app = express();
    app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    app.use(
      '/webhooks',
      createWebhookRouter({} as never, {
        billingService,
        pool,
        webhookRepo: new PgWebhookRepository(pool),
        stripeWebhookSecret: SECRET,
      }),
    );
  });

  afterAll(async () => {
    delete process.env.STRIPE_PRICE_ID;
    await closeSharedTestDb();
  });

  it('STEP 1 — tenant starts the trial checkout (mock Stripe mints customer + session)', async () => {
    const { url } = await billingService.createTrialCheckoutSession({
      tenantId: tenant.tenantId,
      ownerEmail: 'owner@rivet.test',
      successUrl: 'https://app.therivetapp.com/onboarding?billing=ok',
      cancelUrl: 'https://app.therivetapp.com/onboarding?billing=cancel',
    });
    expect(url).toBe('https://checkout.stripe.com/pay/mock_flow1');

    // getOrCreateStripeCustomer persisted the customer id on the tenant.
    const view = await billingService.getSubscription(tenant.tenantId);
    expect(view.customerId).toBe(CUSTOMER_ID);
    expect(view.status).toBeNull(); // no subscription yet — checkout not completed
    // eslint-disable-next-line no-console
    console.log('  ✓ checkout session minted; tenant customer=cus_mock_flow1, no subscription yet');
  });

  it('STEP 2 — checkout completes: signed customer.subscription.created → trialing', async () => {
    const trialEnd = Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60;
    const res = await signed(
      subscriptionEvent(`evt_${randomUUID()}`, 'customer.subscription.created', 'trialing', trialEnd),
    );
    expect(res.status).toBe(200);

    const view = await billingService.getSubscription(tenant.tenantId);
    expect(view.subscriptionId).toBe(SUBSCRIPTION_ID);
    expect(view.status).toBe('trialing');
    // eslint-disable-next-line no-console
    console.log('  ✓ subscription.created webhook mirrored → status=trialing, sub id set');
  });

  it('STEP 3 — cached subscription view reflects the trial', async () => {
    const view = await billingService.getSubscription(tenant.tenantId);
    expect(view.customerId).toBe(CUSTOMER_ID);
    expect(view.subscriptionId).toBe(SUBSCRIPTION_ID);
    expect(view.status).toBe('trialing');
    // eslint-disable-next-line no-console
    console.log('  ✓ GET /billing/subscription would show the tenant as trialing');
  });

  it('STEP 4 — trial converts: signed customer.subscription.updated → active', async () => {
    const res = await signed(
      subscriptionEvent(`evt_${randomUUID()}`, 'customer.subscription.updated', 'active', null),
    );
    expect(res.status).toBe(200);

    const view = await billingService.getSubscription(tenant.tenantId);
    expect(view.status).toBe('active');
    // eslint-disable-next-line no-console
    console.log('  ✓ subscription.updated webhook mirrored → status=active (trial → paid)');
  });
});
