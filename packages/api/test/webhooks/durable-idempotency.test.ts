/**
 * Blocker 1 — durable idempotency for the Stripe/Clerk webhook handlers.
 *
 * The defect: a per-process in-memory dedup map is wiped on restart and not
 * shared across instances, so Stripe retries double-record payments and
 * Clerk retries re-bootstrap tenants. The fix routes both handlers through
 * the INJECTED `deps.webhookRepo` (PgWebhookRepository in production —
 * atomic INSERT … ON CONFLICT on (source, idempotency_key)).
 *
 * These route-level tests prove the dedup state lives in the injected
 * repository, not in module/router-local memory, by sharing ONE repository
 * across TWO independently constructed routers (simulating a restart or a
 * second instance behind the load balancer):
 *
 *   (a) duplicate Stripe checkout.session.completed (same event id)
 *       records the payment exactly once, even across "instances";
 *   (b) duplicate Clerk user.created (same svix-id) bootstraps exactly
 *       one tenant, even across "instances";
 *   (c) a processing failure marks the event 'failed' (NOT stuck at
 *       received/processing), so the provider's retry re-executes the
 *       handler and recovers.
 */
import express from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { describe, it, expect, beforeEach } from 'vitest';

import { createWebhookRouter, WebhookRouterDeps } from '../../src/webhooks/routes';
import {
  createWebhookSignature,
  InMemoryWebhookRepository,
} from '../../src/webhooks/webhook-handler';
import { Tenant, TenantRepository } from '../../src/auth/clerk';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { AppConfig } from '../../src/shared/config';

const STRIPE_SECRET = 'whsec_test_durable';
const CLERK_SECRET = 'whsec_dGVzdC1zZWNyZXQ='; // base64("test-secret")
const TENANT = '11111111-1111-1111-1111-111111111111';
const INVOICE_ID = 'inv-durable-001';

// ── Stripe helpers (mirrors checkout-session.test.ts) ──────────────────────

function buildStripeApp(deps: WebhookRouterDeps) {
  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
  app.use('/webhooks', createWebhookRouter({} as never, deps));
  return app;
}

async function postStripe(app: express.Express, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', createWebhookSignature(rawBody, STRIPE_SECRET))
    .set('content-type', 'application/json')
    .send(rawBody);
}

function makeInvoice(): Invoice {
  const lineItems = [buildLineItem('li-1', 'Service', 1, 10000, 1, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: INVOICE_ID,
    tenantId: TENANT,
    jobId: 'job-001',
    invoiceNumber: 'INV-001',
    status: 'open',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function checkoutEvent(eventId: string): Record<string, unknown> {
  return {
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        metadata: { tenant_id: TENANT, invoice_id: INVOICE_ID },
        amount_total: 10000,
        payment_status: 'paid',
        payment_intent: 'pi_durable_123',
      },
    },
  };
}

// ── Clerk helpers (mirrors clerk-webhook-integration.test.ts) ──────────────

class FakeTenantRepository implements TenantRepository {
  public created: Array<{ ownerId: string; ownerEmail: string; name: string }> = [];
  private byOwner = new Map<string, Tenant>();

  async findByOwner(ownerId: string): Promise<Tenant | null> {
    return this.byOwner.get(ownerId) ?? null;
  }

  async findById(id: string): Promise<Tenant | null> {
    for (const t of this.byOwner.values()) {
      if (t.id === id) return t;
    }
    return null;
  }

  async create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant> {
    this.created.push(data);
    const tenant: Tenant = {
      id: `tenant-${this.byOwner.size + 1}`,
      ownerId: data.ownerId,
      ownerEmail: data.ownerEmail,
      name: data.name,
      createdAt: new Date(),
    };
    this.byOwner.set(data.ownerId, tenant);
    return tenant;
  }
}

function buildClerkApp(deps: WebhookRouterDeps) {
  const app = express();
  app.use(express.json());
  const config = {
    CLERK_WEBHOOK_SECRET: CLERK_SECRET,
    CLERK_SECRET_KEY: undefined,
  } as unknown as AppConfig;
  app.use('/webhooks', createWebhookRouter(config, deps));
  return app;
}

function signSvixPayload(body: object, svixId: string, svixTimestamp: string) {
  const rawBody = JSON.stringify(body);
  const secretBytes = Buffer.from(CLERK_SECRET.replace(/^whsec_/, ''), 'base64');
  const hexKey = secretBytes.toString('hex');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto
    .createHmac('sha256', hexKey)
    .update(`${svixTimestamp}.${signedContent}`)
    .digest('hex');
  return { rawBody, signature: `v1,${sig}` };
}

async function postClerk(
  app: express.Express,
  payload: object,
  svixId: string,
  svixTimestamp: string,
) {
  const { signature } = signSvixPayload(payload, svixId, svixTimestamp);
  return request(app)
    .post('/webhooks/clerk')
    .set('svix-id', svixId)
    .set('svix-timestamp', svixTimestamp)
    .set('svix-signature', signature)
    .send(payload);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('B1 — Stripe checkout dedup through the injected durable repo', () => {
  let sharedRepo: InMemoryWebhookRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;

  function deps(): WebhookRouterDeps {
    return {
      invoiceRepo,
      paymentRepo,
      auditRepo: new InMemoryAuditRepository(),
      stripeWebhookSecret: STRIPE_SECRET,
      webhookRepo: sharedRepo,
    };
  }

  beforeEach(async () => {
    sharedRepo = new InMemoryWebhookRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    await invoiceRepo.create(makeInvoice());
  });

  it('records the payment exactly once for duplicate deliveries of the same event id', async () => {
    const app = buildStripeApp(deps());
    const event = checkoutEvent('evt_dup_checkout_1');

    const first = await postStripe(app, event);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });

    const second = await postStripe(app, event);
    // Stripe MUST still get a 2xx on duplicate delivery or it retries forever.
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: true });

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].amountCents).toBe(10000);

    const row = await sharedRepo.findByIdempotencyKey('stripe', 'evt_dup_checkout_1');
    expect(row?.status).toBe('processed');
  });

  it('dedups across router instances (restart / multi-instance) because state lives in the injected repo', async () => {
    // Two independently constructed routers sharing ONE repository —
    // exactly the production topology with PgWebhookRepository.
    const instanceA = buildStripeApp(deps());
    const instanceB = buildStripeApp(deps());
    const event = checkoutEvent('evt_cross_instance_1');

    const first = await postStripe(instanceA, event);
    expect(first.status).toBe(200);

    const retryOnOtherInstance = await postStripe(instanceB, event);
    expect(retryOnOtherInstance.status).toBe(200);
    expect(retryOnOtherInstance.body).toEqual({ received: true, duplicate: true });

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
  });

  it('marks a failed delivery re-processable: failure → failed (not stuck), retry succeeds and records once', async () => {
    // First delivery fails: the invoice doesn't exist yet (out-of-order
    // delivery), recordPayment throws, the route 500s and the row is
    // marked 'failed' — NOT left at received/processing.
    invoiceRepo = new InMemoryInvoiceRepository(); // empty — no invoice
    const app = buildStripeApp(deps());
    const event = checkoutEvent('evt_fail_then_retry_1');

    const first = await postStripe(app, event);
    expect(first.status).toBe(500);

    const afterFailure = await sharedRepo.findByIdempotencyKey('stripe', 'evt_fail_then_retry_1');
    expect(afterFailure?.status).toBe('failed');

    // The invoice now exists; Stripe's retry of the SAME event id must
    // re-execute (failed rows are not duplicates) and record the payment.
    await invoiceRepo.create(makeInvoice());
    const retry = await postStripe(app, event);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ received: true });

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);

    const afterRetry = await sharedRepo.findByIdempotencyKey('stripe', 'evt_fail_then_retry_1');
    expect(afterRetry?.status).toBe('processed');
  });
});

describe('B1 — Clerk user.created dedup through the injected durable repo', () => {
  let sharedRepo: InMemoryWebhookRepository;
  let tenantRepo: FakeTenantRepository;

  function deps(): WebhookRouterDeps {
    return { tenantRepo, webhookRepo: sharedRepo };
  }

  beforeEach(() => {
    sharedRepo = new InMemoryWebhookRepository();
    tenantRepo = new FakeTenantRepository();
  });

  it('bootstraps exactly one tenant for duplicate user.created deliveries, even across instances', async () => {
    const instanceA = buildClerkApp(deps());
    const instanceB = buildClerkApp(deps());

    const svixId = 'evt_clerk_dup_1';
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = {
      type: 'user.created',
      data: { id: 'user_durable_1', email_addresses: [{ email_address: 'durable@example.com' }] },
    };

    const first = await postClerk(instanceA, payload, svixId, ts);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });

    // Clerk retry lands on a different instance — dedup must still hold.
    const second = await postClerk(instanceB, payload, svixId, ts);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: true });

    expect(tenantRepo.created).toHaveLength(1);

    const row = await sharedRepo.findByIdempotencyKey('clerk', svixId);
    expect(row?.status).toBe('processed');
  });

  it('marks a failed user.created re-processable and the retry recovers', async () => {
    // bootstrapTenant throws on the first delivery → route 500s and the
    // row must be 'failed' so the Clerk retry re-executes the handler.
    let failNext = true;
    const flakyTenantRepo: TenantRepository = {
      findByOwner: async (ownerId) => {
        if (failNext) {
          failNext = false;
          throw new Error('transient db outage');
        }
        return tenantRepo.findByOwner(ownerId);
      },
      findById: (id) => tenantRepo.findById(id),
      create: (data) => tenantRepo.create(data),
    };
    const app = buildClerkApp({ tenantRepo: flakyTenantRepo, webhookRepo: sharedRepo });

    const svixId = 'evt_clerk_fail_retry_1';
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = {
      type: 'user.created',
      data: { id: 'user_durable_2', email_addresses: [{ email_address: 'retry@example.com' }] },
    };

    const first = await postClerk(app, payload, svixId, ts);
    expect(first.status).toBe(500);

    const afterFailure = await sharedRepo.findByIdempotencyKey('clerk', svixId);
    expect(afterFailure?.status).toBe('failed');
    expect(tenantRepo.created).toHaveLength(0);

    const retry = await postClerk(app, payload, svixId, ts);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ received: true });
    expect(tenantRepo.created).toHaveLength(1);

    const afterRetry = await sharedRepo.findByIdempotencyKey('clerk', svixId);
    expect(afterRetry?.status).toBe('processed');
  });
});
