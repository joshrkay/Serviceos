/**
 * Route-level tests for the Stripe `setup_intent.succeeded` branch in
 * src/webhooks/routes.ts (#6 phase 4): a saved card is persisted with its
 * retrieved display metadata, as the default when it's the customer's first.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter, WebhookRouterDeps } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryCustomerPaymentMethodRepository } from '../../src/payments/customer-payment-method';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { StripeFetch } from '../../src/payments/stripe-payment-intent';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const STRIPE_SECRET = 'whsec_test_setup_intent';
const TENANT = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';
/** #1177 — a neighbour tenant and ITS customer. */
const OTHER_TENANT = '33333333-3333-3333-3333-333333333333';
const FOREIGN_CUSTOMER = '44444444-4444-4444-4444-444444444444';

/** The tenant-scoped customer lookup, holding TENANT's CUSTOMER and OTHER_TENANT's FOREIGN_CUSTOMER. */
async function seededCustomerRepo(): Promise<InMemoryCustomerRepository> {
  const repo = new InMemoryCustomerRepository();
  for (const [id, tenantId] of [
    [CUSTOMER, TENANT],
    [FOREIGN_CUSTOMER, OTHER_TENANT],
  ]) {
    await repo.create({
      id,
      tenantId,
      firstName: 'Card',
      lastName: 'Holder',
      displayName: 'Card Holder',
      preferredChannel: 'sms',
      smsConsent: false,
      isArchived: false,
      createdBy: 'test',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  return repo;
}

function jsonRes(ok: boolean, status: number, body: unknown) {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body };
}

/**
 * #1109 — the saved-card branch binds `event.account` to the named tenant's
 * own connected account, so the router is wired the way app.ts wires
 * production: a resolver under which TENANT owns `acct_tenant` (the account
 * the fixture events come from). A test can override it.
 */
async function buildApp(deps: WebhookRouterDeps) {
  const customerRepo = await seededCustomerRepo();
  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
  app.use(
    '/webhooks',
    createWebhookRouter({} as never, {
      connectAccountResolver: {
        resolveTenantConnectAccount: async (tenantId: string) =>
          tenantId === TENANT ? { accountId: 'acct_tenant', chargesEnabled: true } : null,
      },
      customerRepo,
      ...deps,
    }),
  );
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
  opts: { paymentMethod?: string; metadata?: Record<string, string>; account?: string } = {},
): Record<string, unknown> {
  return {
    id: `evt_${uuidv4()}`,
    type: 'setup_intent.succeeded',
    account: opts.account ?? 'acct_tenant',
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
    const app = await buildApp({
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
    const app = await buildApp({
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
    const app = await buildApp({
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
    const app = await buildApp({
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

  it('#1109 — refuses (403, nothing stored) a card saved on a connected account the tenant does not own', async () => {
    const cpmRepo = new InMemoryCustomerPaymentMethodRepository();
    const app = await buildApp({
      stripeWebhookSecret: STRIPE_SECRET,
      customerPaymentMethodRepo: cpmRepo,
      stripeConfig: { apiKey: 'sk' },
      stripeFetch: async () => jsonRes(true, 200, { id: 'pm_stranger', card: { brand: 'visa' } }),
    });
    const res = await postSigned(
      app,
      setupIntentSucceeded({ paymentMethod: 'pm_stranger', account: 'acct_somebody_else' }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden', reason: 'stripe_account_mismatch' });
    expect(await cpmRepo.findByCustomer(TENANT, CUSTOMER)).toHaveLength(0);
  });

  it('#1177 — refuses (403, nothing stored) when the metadata names TENANT but a customer_id of another tenant', async () => {
    const cpmRepo = new InMemoryCustomerPaymentMethodRepository();
    const stripeFetch = vi.fn<StripeFetch>(async () => jsonRes(true, 200, { id: 'pm_foreign', card: { brand: 'visa' } }));
    const app = await buildApp({
      stripeWebhookSecret: STRIPE_SECRET,
      customerPaymentMethodRepo: cpmRepo,
      stripeConfig: { apiKey: 'sk' },
      stripeFetch,
    });
    const res = await postSigned(
      app,
      setupIntentSucceeded({
        paymentMethod: 'pm_foreign',
        metadata: { tenant_id: TENANT, customer_id: FOREIGN_CUSTOMER },
      }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden', reason: 'stripe_customer_tenant_mismatch' });
    expect(await cpmRepo.findByCustomer(TENANT, FOREIGN_CUSTOMER)).toHaveLength(0);
    expect(await cpmRepo.findByCustomer(OTHER_TENANT, FOREIGN_CUSTOMER)).toHaveLength(0);
    // Refused before any Stripe call is made for the card's display metadata.
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it('#1177 — refuses a malformed customer_id without querying (403, not a 500 Stripe would retry)', async () => {
    const cpmRepo = new InMemoryCustomerPaymentMethodRepository();
    const app = await buildApp({
      stripeWebhookSecret: STRIPE_SECRET,
      customerPaymentMethodRepo: cpmRepo,
      stripeConfig: { apiKey: 'sk' },
      stripeFetch: async () => jsonRes(true, 200, {}),
    });
    const res = await postSigned(
      app,
      setupIntentSucceeded({ metadata: { tenant_id: TENANT, customer_id: 'not-a-uuid' } }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden', reason: 'stripe_customer_tenant_mismatch' });
  });

  it('#1057 — emits a payment_method.saved audit event, correlated to the setup intent', async () => {
    const cpmRepo = new InMemoryCustomerPaymentMethodRepository();
    const auditRepo = new InMemoryAuditRepository();
    const stripeFetch: StripeFetch = async () =>
      jsonRes(true, 200, {
        id: 'pm_audit',
        card: { brand: 'visa', last4: '4242', exp_month: 9, exp_year: 2030 },
      });
    const app = await buildApp({
      stripeWebhookSecret: STRIPE_SECRET,
      customerPaymentMethodRepo: cpmRepo,
      stripeConfig: { apiKey: 'sk_test' },
      stripeFetch,
      auditRepo,
    });

    const event = setupIntentSucceeded({ paymentMethod: 'pm_audit' });
    const res = await postSigned(app, event);
    expect(res.status).toBe(200);

    const saved = await cpmRepo.findByCustomer(TENANT, CUSTOMER);
    expect(saved).toHaveLength(1);

    const events = await auditRepo.findByEntity(TENANT, 'payment_method', saved[0].id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('payment_method.saved');
    expect(events[0].actorRole).toBe('system');
    expect(events[0].correlationId).toBe(
      ((event.data as { object: { id: string } }).object).id,
    );
    expect(events[0].metadata).toMatchObject({
      customerId: CUSTOMER,
      brand: 'visa',
      last4: '4242',
      isDefault: true,
    });
  });

  it('#1057 — does not double-write the audit row across distinct redeliveries for the same card', async () => {
    const cpmRepo = new InMemoryCustomerPaymentMethodRepository();
    const auditRepo = new InMemoryAuditRepository();
    const stripeFetch: StripeFetch = async () =>
      jsonRes(true, 200, { id: 'pm_audit_dup', card: { brand: 'visa', last4: '4242' } });
    const app = await buildApp({
      stripeWebhookSecret: STRIPE_SECRET,
      customerPaymentMethodRepo: cpmRepo,
      stripeConfig: { apiKey: 'sk' },
      stripeFetch,
      auditRepo,
    });
    await postSigned(app, setupIntentSucceeded({ paymentMethod: 'pm_audit_dup' }));
    await postSigned(app, setupIntentSucceeded({ paymentMethod: 'pm_audit_dup' }));

    const saved = await cpmRepo.findByCustomer(TENANT, CUSTOMER);
    const pm = saved.find((p) => p.stripePaymentMethodId === 'pm_audit_dup')!;
    expect(await auditRepo.findByEntity(TENANT, 'payment_method', pm.id)).toHaveLength(1);
  });
});
