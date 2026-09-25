/**
 * The tenant's plan is mirrored from the Stripe subscription's price on
 * every customer.subscription.* webhook, so a portal upgrade (which changes
 * the price, not our checkout metadata) is reflected.
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

const SECRET = 'whsec_subscription_plan';

describe('Postgres integration — tenant plan mirrored from Stripe subscriptions', () => {
  let pool: Pool;
  let app: express.Express;
  let billingService: BillingService;
  let tenantId: string;
  const customerId = `cus_plan_${randomUUID().slice(0, 8)}`;

  function subscriptionEvent(
    type: 'customer.subscription.created' | 'customer.subscription.updated',
    priceId: string,
  ) {
    const raw = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type,
      data: {
        object: {
          id: 'sub_plan_test',
          customer: customerId,
          status: 'active',
          trial_end: null,
          metadata: { tenant_id: tenantId },
          items: { data: [{ price: { id: priceId } }] },
        },
      },
    });
    return request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(raw, SECRET))
      .set('content-type', 'application/json')
      .send(raw);
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    process.env.STRIPE_STARTER_PRICE_ID = 'price_starter_plan_test';
    process.env.STRIPE_GROWTH_PRICE_ID = 'price_growth_plan_test';
    billingService = new BillingService({ pool, config: { apiKey: 'sk_test_mock' } });
    tenantId = (await createTestTenant(pool)).tenantId;
    await pool.query('UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1', [tenantId, customerId]);
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
  }, 120_000);

  afterAll(async () => {
    delete process.env.STRIPE_STARTER_PRICE_ID;
    delete process.env.STRIPE_GROWTH_PRICE_ID;
    await closeSharedTestDb();
  });

  it('records Starter on subscription.created and Growth after a portal upgrade', async () => {
    expect((await subscriptionEvent('customer.subscription.created', 'price_starter_plan_test')).status).toBe(200);
    expect((await billingService.getSubscription(tenantId)).planId).toBe('starter');

    expect((await subscriptionEvent('customer.subscription.updated', 'price_growth_plan_test')).status).toBe(200);
    expect((await billingService.getSubscription(tenantId)).planId).toBe('growth');
  });

  it('keeps the recorded plan when an event carries an unknown price', async () => {
    expect((await subscriptionEvent('customer.subscription.updated', 'price_legacy_unknown')).status).toBe(200);
    expect((await billingService.getSubscription(tenantId)).planId).toBe('growth');
  });
});
