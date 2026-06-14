/**
 * Route-level tests for the Stripe `setup_intent.succeeded` branch in
 * src/webhooks/routes.ts (#6 phase 4): a saved card is persisted with its
 * retrieved display metadata, as the default when it's the customer's first.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter, WebhookRouterDeps } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryCustomerPaymentMethodRepository } from '../../src/payments/customer-payment-method';
import { StripeFetch } from '../../src/payments/stripe-payment-intent';

const STRIPE_SECRET = 'whsec_test_setup_intent';
const TENANT = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';

function jsonRes(ok: boolean, status: number, body: unknown) {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body };
}

function buildApp(deps: WebhookRouterDeps) {
  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
  app.use('/webhooks', createWebhookRouter({} as never, deps));
  return app;
}

async function postSigned(app: express.Express, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', createWebhookSignature(rawBody, STRIPE_SECRET))
    .set('content-type', 'application/json')
    .send(rawBody);
}

function setupIntentSucceeded(
  opts: { paymentMethod?: string; metadata?: Record<string, string> } = {},
): Record<string, unknown> {
  return {
    id: `evt_${uuidv4()}`,
    type: 'setup_intent.succeeded',
    account: 'acct_tenant',
    data: {
      object: {
        id: `seti_${uuidv4()}`,
        customer: 'cus_123',
        payment_method: opts.paymentMethod ?? 'pm_123',
        metadata: opts.metadata ?? { tenant_id: TENANT, customer_id: CUSTOMER },
      },
    },
  };
}

describe('webhook: setup_intent.succeeded', () => {
  it('persists the card with retrieved metadata, default for the first card', async () => {
    const cpmRepo = new InMemoryCustomerPaymentMethodRepository();
    const stripeFetch: StripeFetch = async () =>
      jsonRes(true, 200, {
        id: 'pm_123',
        card: { brand: 'visa', last4: '4242', exp_month: 9, exp_year: 2030 },
      });
    const app = buildApp({
      stripeWebhookSecret: STRIPE_SECRET,
      customerPaymentMethodRepo: cpmRepo,
      stripeConfig: { apiKey: 'sk_test' },
      stripeFetch,
    });

    const res = await postSigned(app, setupIntentSucceeded());
    expect(res.status).toBe(200);

    const saved = await cpmRepo.findByCustomer(TENANT, CUSTOMER);
    expect(saved).toHaveLength(1);
    expect(saved[0].stripePaymentMethodId).toBe('pm_123');
    expect(saved[0].stripeCustomerId).toBe('cus_123');
    // The account the SetupIntent ran on (event.account) is pinned to the card.
    expect(saved[0].stripeAccountId).toBe('acct_tenant');
    expect(saved[0].brand).toBe('visa');
    expect(saved[0].last4).toBe('4242');
    expect(saved[0].isDefault).toBe(true);
  });

  it('does not double-store the same payment method across distinct events', async () => {
    const cpmRepo = new InMemoryCustomerPaymentMethodRepository();
    const stripeFetch: StripeFetch = async () =>
      jsonRes(true, 200, { id: 'pm_dup', card: { brand: 'visa', last4: '4242' } });
    const app = buildApp({
      stripeWebhookSecret: STRIPE_SECRET,
      customerPaymentMethodRepo: cpmRepo,
      stripeConfig: { apiKey: 'sk' },
      stripeFetch,
    });
    await postSigned(app, setupIntentSucceeded({ paymentMethod: 'pm_dup' }));
    await postSigned(app, setupIntentSucceeded({ paymentMethod: 'pm_dup' }));
    expect(await cpmRepo.findByCustomer(TENANT, CUSTOMER)).toHaveLength(1);
  });

  it('skips when the setup intent has no tenant/customer metadata', async () => {
    const cpmRepo = new InMemoryCustomerPaymentMethodRepository();
    const app = buildApp({
      stripeWebhookSecret: STRIPE_SECRET,
      customerPaymentMethodRepo: cpmRepo,
      stripeConfig: { apiKey: 'sk' },
      stripeFetch: async () => jsonRes(true, 200, {}),
    });
    const res = await postSigned(app, setupIntentSucceeded({ metadata: {} }));
    expect(res.status).toBe(200);
    expect(await cpmRepo.findByCustomer(TENANT, CUSTOMER)).toHaveLength(0);
  });

  it('still stores the card (ids only) when the metadata retrieve fails', async () => {
    const cpmRepo = new InMemoryCustomerPaymentMethodRepository();
    const stripeFetch: StripeFetch = async () => jsonRes(false, 500, { error: { message: 'boom' } });
    const app = buildApp({
      stripeWebhookSecret: STRIPE_SECRET,
      customerPaymentMethodRepo: cpmRepo,
      stripeConfig: { apiKey: 'sk' },
      stripeFetch,
    });
    const res = await postSigned(app, setupIntentSucceeded({ paymentMethod: 'pm_nofetch' }));
    expect(res.status).toBe(200);
    const saved = await cpmRepo.findByCustomer(TENANT, CUSTOMER);
    expect(saved).toHaveLength(1);
    expect(saved[0].stripePaymentMethodId).toBe('pm_nofetch');
    expect(saved[0].brand).toBeUndefined();
  });
});
