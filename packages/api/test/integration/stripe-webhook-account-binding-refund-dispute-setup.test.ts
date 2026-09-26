/**
 * SECURITY #1109 — follow-up to #1102 / PR #1107: the refund, dispute and
 * saved-card Stripe webhook branches must be bound to the RESOLVED tenant's
 * OWN connected account too.
 *
 * PR #1107 closed the four settlement branches with
 * `assertEventAccountBelongsToTenant` + `refuseUnboundStripeEvent`
 * (test/integration/stripe-webhook-account-binding.test.ts). Four more
 * money-touching branches in `src/webhooks/routes.ts` still trusted the event
 * without that binding:
 *
 *   setup_intent.succeeded  — saves a payment method against the tenant named
 *                             in metadata (the dues sweep later charges it)
 *   charge.refunded         — records a refund against the named tenant's payment
 *   charge.refund.updated   — records a refund against a payment resolved by a
 *                             CROSS-TENANT payment_intent lookup (or metadata)
 *   charge.dispute.created  — reverses a payment resolved by the same
 *                             cross-tenant lookup, reopening the invoice
 *
 * Stripe's signature attests that STRIPE sent the event, not whose account it
 * happened on. Every case below is a correctly-signed delivery.
 *
 * For each branch:
 *   • MISMATCH (another tenant's `event.account`) → 403 `stripe_account_mismatch`,
 *     a `webhook.auth_failed` audit row on the named / RESOLVED tenant,
 *     `webhook_events.status='failed'`, and NOTHING written.
 *   • MATCH (the tenant's own account)            → behaves exactly as before.
 *   • PLATFORM-ORIGIN (no `event.account`)        → behaves exactly as before.
 *
 * SECURITY #1177 — binding the ACCOUNT is not enough for the saved-card branch:
 * a delivery on tenant A's own account naming tenant A in metadata could still
 * carry a `customer_id` that belongs to tenant B, and the row was stored under A
 * pointing at B's customer. The `#1177` block below proves the metadata customer
 * is resolved through the tenant-scoped customer repository first, and a foreign
 * customer is refused through the same refusal path (403, audited on the named
 * tenant, webhook row 'failed', nothing written).
 *
 * Tenant grade: tenant B (whose connected account appears on every forged
 * event) has its own settled payment and saved card; the last test proves
 * none of the refusals touched B's rows or B's audit trail.
 *
 * Nothing in the product is stubbed: real Postgres, the real
 * `createWebhookRouter`, the real `StripeConnectService` reading the real
 * `tenants` columns (wired through the production `connectAccountResolver`
 * shape), real Pg invoice/payment/customer-payment-method/audit/webhook
 * repositories, real HMAC-signed bodies. Only the outbound Stripe HTTP call
 * the saved-card branch makes for display metadata (`stripeFetch`) is a fake.
 *
 * Run:
 *   cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.ts --reporter=verbose \
 *     test/integration/stripe-webhook-account-binding-refund-dispute-setup.test.ts
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
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgWebhookRepository } from '../../src/webhooks/pg-webhook';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerPaymentMethodRepository } from '../../src/payments/pg-customer-payment-method';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { StripeFetch } from '../../src/payments/stripe-payment-intent';
import type { TestTenant } from './shared';

const STRIPE_SECRET = 'whsec_test_account_binding_1109';
const STRIPE_API_KEY = 'sk_test_binding_1109_never_dialled';
const AMOUNT_CENTS = 42_500;
const REFUND_CENTS = 12_500;

/** Tenant A's own connected account. */
const ACCOUNT_A = 'acct_binding_1109_tenant_a';
/** Tenant B's own connected account — the attacker's, in the mismatch cases. */
const ACCOUNT_B = 'acct_binding_1109_tenant_b';

const REFUSED = { error: 'Forbidden', reason: 'stripe_account_mismatch' };

describe('Postgres integration — #1109 refund, dispute and saved-card Stripe events are bound to the tenant\'s own connected account', () => {
  let pool: Pool;
  let app: express.Express;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let auditRepo: PgAuditRepository;
  let webhookRepo: PgWebhookRepository;
  let cpmRepo: PgCustomerPaymentMethodRepository;
  let connectService: StripeConnectService;

  /** Connect live — the tenant whose own events must still apply. */
  let tenantA: TestTenant;
  /** Connect live — the neighbour whose account appears on the forged events. */
  let tenantB: TestTenant;
  /** Never enabled Connect — platform payments only. */
  let noConnect: TestTenant;

  /** Tenant B's divergent data, snapshotted after seeding. */
  let bPaymentId: string;
  let bCustomerId: string;
  let bPaymentSnapshot: Record<string, unknown>;
  let bCardCount: number;
  let bAuditCount: number;

  // ───────────────────────── seeding (real repos) ─────────────────────────

  async function seedCustomer(t: TestTenant): Promise<string> {
    const customerId = randomUUID();
    await new PgCustomerRepository(pool).create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Bind',
      lastName: 'Ing',
      displayName: 'Bind Ing',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return customerId;
  }

  async function seedOpenInvoice(t: TestTenant): Promise<string> {
    const customerId = await seedCustomer(t);

    const locationId = randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '1109 Binding Way',
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

    const jobId = randomUUID();
    await new PgJobRepository(pool).create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: '#1109 account-binding proof',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lineItems = [buildLineItem(randomUUID(), 'Service call', 1, AMOUNT_CENTS, 1, false)];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const invoiceId = randomUUID();
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: t.tenantId,
      jobId,
      invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return invoiceId;
  }

  /**
   * A legitimately SETTLED payment, produced by the product itself: a signed
   * `payment_intent.succeeded` on the tenant's own account (or platform-origin
   * when `account` is undefined). The payment row carries the intent id as its
   * provider reference — exactly what the refund/dispute lookups resolve by.
   */
  async function settle(
    t: TestTenant,
    account?: string,
  ): Promise<{ invoiceId: string; piId: string; paymentId: string }> {
    const invoiceId = await seedOpenInvoice(t);
    const eventId = `evt_${randomUUID()}`;
    const piId = `pi_${eventId}`;
    const res = await postSigned({
      id: eventId,
      type: 'payment_intent.succeeded',
      ...(account ? { account } : {}),
      data: {
        object: {
          id: piId,
          amount: AMOUNT_CENTS,
          amount_received: AMOUNT_CENTS,
          metadata: { tenant_id: t.tenantId, invoice_id: invoiceId },
          charges: { data: [{ payment_method_details: { type: 'card' } }] },
        },
      },
    });
    expect(res.status).toBe(200);
    const payments = await paymentRepo.findByInvoice(t.tenantId, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('completed');
    expect(payments[0].providerReference).toBe(piId);
    return { invoiceId, piId, paymentId: payments[0].id };
  }

  async function postSigned(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    return request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(raw, STRIPE_SECRET))
      .set('content-type', 'application/json')
      .send(raw);
  }

  // ───────────────────────── raw-SQL read-backs ─────────────────────────

  async function webhookRow(
    stripeEventId: string,
  ): Promise<{ status: string; processed_at: Date | null; error_message: string | null } | null> {
    const { rows } = await pool.query<{
      status: string;
      processed_at: Date | null;
      error_message: string | null;
    }>(
      `SELECT status, processed_at, error_message
         FROM webhook_events
        WHERE source = 'stripe' AND idempotency_key = $1`,
      [stripeEventId],
    );
    return rows[0] ?? null;
  }

  async function auditRows(
    tenantId: string,
  ): Promise<Array<{ event_type: string; entity_id: string; metadata: Record<string, unknown> }>> {
    const { rows } = await pool.query<{
      event_type: string;
      entity_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT event_type, entity_id, metadata
         FROM audit_events WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return rows;
  }

  /** Every money column the refund / reversal paths can touch, plus its invoice. */
  async function paymentSnapshot(paymentId: string): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
      `SELECT p.status, p.amount_cents::int AS amount_cents,
              p.refunded_amount_cents::int AS refunded_amount_cents,
              p.refunded_at, p.last_refund_stripe_id, p.reversed_at, p.reversal_reason,
              i.status AS invoice_status,
              i.amount_paid_cents::int AS invoice_amount_paid_cents,
              i.amount_due_cents::int AS invoice_amount_due_cents,
              (SELECT count(*)::int FROM payment_refunds r WHERE r.payment_id = p.id) AS refund_claims
         FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.id = $1`,
      [paymentId],
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function savedCards(tenantId: string, customerId: string): Promise<
    Array<{ stripe_payment_method_id: string; stripe_account_id: string | null; is_default: boolean }>
  > {
    const { rows } = await pool.query(
      `SELECT stripe_payment_method_id, stripe_account_id, is_default
         FROM customer_payment_methods WHERE tenant_id = $1 AND customer_id = $2`,
      [tenantId, customerId],
    );
    return rows;
  }

  // ───────────────────────── event builders ─────────────────────────
  //
  // `account` is omitted entirely when undefined — Stripe only puts a
  // top-level `account` on deliveries from a Connected-accounts destination.

  function setupIntentSucceeded(
    eventId: string,
    tenantId: string,
    customerId: string,
    paymentMethodId: string,
    account?: string,
  ): Record<string, unknown> {
    return {
      id: eventId,
      type: 'setup_intent.succeeded',
      ...(account ? { account } : {}),
      data: {
        object: {
          id: `seti_${eventId}`,
          customer: `cus_${eventId}`,
          payment_method: paymentMethodId,
          metadata: { tenant_id: tenantId, customer_id: customerId },
        },
      },
    };
  }

  /** A Charge carrying its newest refund at refunds.data[0], as Stripe sends it. */
  function chargeRefunded(
    eventId: string,
    opts: { tenantId: string; piId: string; refundId: string; account?: string },
  ): Record<string, unknown> {
    return {
      id: eventId,
      type: 'charge.refunded',
      ...(opts.account ? { account: opts.account } : {}),
      data: {
        object: {
          id: `ch_${eventId}`,
          payment_intent: opts.piId,
          metadata: { tenant_id: opts.tenantId },
          refunds: {
            data: [
              {
                id: opts.refundId,
                amount: REFUND_CENTS,
                created: Math.floor(Date.now() / 1000),
                status: 'succeeded',
                payment_intent: opts.piId,
              },
            ],
          },
        },
      },
    };
  }

  /** The Refund object itself (no parent charge metadata), as Stripe sends it. */
  function refundUpdated(
    eventId: string,
    opts: {
      piId: string;
      refundId: string;
      account?: string;
      metadata?: { tenant_id: string; payment_id: string };
    },
  ): Record<string, unknown> {
    return {
      id: eventId,
      type: 'charge.refund.updated',
      ...(opts.account ? { account: opts.account } : {}),
      data: {
        object: {
          id: opts.refundId,
          amount: REFUND_CENTS,
          created: Math.floor(Date.now() / 1000),
          status: 'succeeded',
          payment_intent: opts.piId,
          ...(opts.metadata ? { metadata: opts.metadata } : {}),
        },
      },
    };
  }

  function disputeCreated(
    eventId: string,
    opts: { piId: string; account?: string },
  ): Record<string, unknown> {
    return {
      id: eventId,
      type: 'charge.dispute.created',
      ...(opts.account ? { account: opts.account } : {}),
      data: {
        object: {
          id: `dp_${eventId}`,
          amount: AMOUNT_CENTS,
          reason: 'fraudulent',
          payment_intent: opts.piId,
        },
      },
    };
  }

  /**
   * The shared refusal assertion (the #1107 refusal contract): 403, never a
   * 500; one `webhook.auth_failed` row on the named/resolved tenant saying
   * exactly why; the `webhook_events` row at 'failed' with processed_at null;
   * and nothing written to the account owner's (tenant B's) audit trail.
   */
  async function expectRefusal(params: {
    res: request.Response;
    stripeEventId: string;
    stripeEventType: string;
    namedTenant: TestTenant;
    auditRowsBefore: number;
    expectedAccountId: string | null;
    paymentId?: string;
    invoiceId?: string;
  }): Promise<void> {
    const { res, stripeEventId, stripeEventType, namedTenant, auditRowsBefore, expectedAccountId } =
      params;

    expect(res.status).toBe(403);
    expect(res.body).toEqual(REFUSED);

    const rows = await auditRows(namedTenant.tenantId);
    expect(rows).toHaveLength(auditRowsBefore + 1);
    const rejected = rows[rows.length - 1];
    expect(rejected.event_type).toBe('webhook.auth_failed');
    expect(rejected.entity_id).toBe('stripe_account_mismatch');
    expect(rejected.metadata.reason).toBe('stripe_account_mismatch');
    expect(rejected.metadata.eventAccount).toBe(ACCOUNT_B);
    expect(rejected.metadata.tenantConnectAccountId).toBe(expectedAccountId);
    expect(rejected.metadata.stripeEventId).toBe(stripeEventId);
    expect(rejected.metadata.stripeEventType).toBe(stripeEventType);
    expect(rejected.metadata.invoiceId).toBe(params.invoiceId ?? null);
    if (params.paymentId) expect(rejected.metadata.paymentId).toBe(params.paymentId);

    const row = await webhookRow(stripeEventId);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('failed');
    expect(row?.processed_at).toBeNull();
    expect(row?.error_message).toContain('stripe_account_mismatch');

    // The account owner's tenant gets nothing.
    expect(await auditRows(tenantB.tenantId)).toHaveLength(bAuditCount);
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    webhookRepo = new PgWebhookRepository(pool);
    cpmRepo = new PgCustomerPaymentMethodRepository(pool);
    connectService = new StripeConnectService({ pool, config: { apiKey: STRIPE_API_KEY } });

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    noConnect = await createTestTenant(pool);

    // A and B finish Connect — the same columns
    // StripeConnectService.applyAccountUpdated writes from `account.updated`.
    for (const [t, acct] of [
      [tenantA, ACCOUNT_A],
      [tenantB, ACCOUNT_B],
    ] as const) {
      await pool.query(
        `UPDATE tenants
            SET stripe_connect_account_id = $2,
                stripe_connect_charges_enabled = TRUE,
                stripe_connect_payouts_enabled = TRUE,
                stripe_connect_status = 'active'
          WHERE id = $1`,
        [t.tenantId, acct],
      );
    }

    // The saved-card branch retrieves display metadata from Stripe; this is
    // the only fake — the outbound HTTP call, never the product under test.
    const stripeFetch: StripeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ card: { brand: 'visa', last4: '4242', exp_month: 9, exp_year: 2031 } }),
      json: async () => ({ card: { brand: 'visa', last4: '4242', exp_month: 9, exp_year: 2031 } }),
    });

    app = express();
    app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    // Wired as app.ts wires production: the real StripeConnectService behind
    // the production connectAccountResolver shape.
    app.use(
      '/webhooks',
      createWebhookRouter({} as never, {
        invoiceRepo,
        paymentRepo,
        auditRepo,
        webhookRepo,
        customerPaymentMethodRepo: cpmRepo,
        // #1177 — the tenant-scoped customer lookup the saved-card branch binds
        // the metadata customer_id through (app.ts wires the same repo).
        customerRepo: new PgCustomerRepository(pool),
        stripeConfig: { apiKey: STRIPE_API_KEY },
        stripeFetch,
        stripeWebhookSecret: STRIPE_SECRET,
        connectAccountResolver: {
          resolveTenantConnectAccount: async (tenantId: string) => {
            const view = await connectService.getAccount(tenantId);
            if (!view.accountId) return null;
            return { accountId: view.accountId, chargesEnabled: view.chargesEnabled };
          },
        },
      }),
    );

    // Tenant B's own, divergent data — a settled payment on its own account and
    // a saved card — which no refused delivery may touch.
    ({ paymentId: bPaymentId } = await settle(tenantB, ACCOUNT_B));
    bCustomerId = await seedCustomer(tenantB);
    expect(
      (
        await postSigned(
          setupIntentSucceeded(`evt_${randomUUID()}`, tenantB.tenantId, bCustomerId, `pm_b_${randomUUID()}`, ACCOUNT_B),
        )
      ).status,
    ).toBe(200);
    bPaymentSnapshot = await paymentSnapshot(bPaymentId);
    bCardCount = (await savedCards(tenantB.tenantId, bCustomerId)).length;
    expect(bCardCount).toBe(1);
    bAuditCount = (await auditRows(tenantB.tenantId)).length;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  // ═════════════════ setup_intent.succeeded (saved card) ═════════════════

  describe('setup_intent.succeeded', () => {
    it('REFUSES to save a card when event.account is another tenant\'s and the named tenant HAS its own account', async () => {
      const customerId = await seedCustomer(tenantA);
      const auditBefore = (await auditRows(tenantA.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        setupIntentSucceeded(eventId, tenantA.tenantId, customerId, `pm_${eventId}`, ACCOUNT_B),
      );

      await expectRefusal({
        res, stripeEventId: eventId, stripeEventType: 'setup_intent.succeeded',
        namedTenant: tenantA, auditRowsBefore: auditBefore, expectedAccountId: ACCOUNT_A,
      });
      expect(await savedCards(tenantA.tenantId, customerId)).toHaveLength(0);
    });

    it('REFUSES to save a card on a connected account when the named tenant never enabled Connect', async () => {
      const customerId = await seedCustomer(noConnect);
      const auditBefore = (await auditRows(noConnect.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        setupIntentSucceeded(eventId, noConnect.tenantId, customerId, `pm_${eventId}`, ACCOUNT_B),
      );

      await expectRefusal({
        res, stripeEventId: eventId, stripeEventType: 'setup_intent.succeeded',
        namedTenant: noConnect, auditRowsBefore: auditBefore, expectedAccountId: null,
      });
      expect(await savedCards(noConnect.tenantId, customerId)).toHaveLength(0);
    });

    it('SAVES the card on the tenant\'s OWN connected account', async () => {
      const customerId = await seedCustomer(tenantA);
      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        setupIntentSucceeded(eventId, tenantA.tenantId, customerId, `pm_${eventId}`, ACCOUNT_A),
      );
      expect(res.status).toBe(200);

      const cards = await savedCards(tenantA.tenantId, customerId);
      expect(cards).toEqual([
        { stripe_payment_method_id: `pm_${eventId}`, stripe_account_id: ACCOUNT_A, is_default: true },
      ]);
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });

    it('SAVES a PLATFORM-ORIGIN card with no event.account at all (control)', async () => {
      const customerId = await seedCustomer(noConnect);
      const eventId = `evt_${randomUUID()}`;
      const body = setupIntentSucceeded(eventId, noConnect.tenantId, customerId, `pm_${eventId}`);
      expect(body).not.toHaveProperty('account');
      const res = await postSigned(body);
      expect(res.status).toBe(200);

      const cards = await savedCards(noConnect.tenantId, customerId);
      expect(cards).toEqual([
        { stripe_payment_method_id: `pm_${eventId}`, stripe_account_id: null, is_default: true },
      ]);
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });
  });

  // ═══════ #1177 — setup_intent.succeeded: the metadata customer is the named tenant's ═══════

  describe('setup_intent.succeeded — #1177 the metadata customer_id must belong to the metadata tenant', () => {
    const CUSTOMER_REFUSED = { error: 'Forbidden', reason: 'stripe_customer_tenant_mismatch' };

    /** Every saved-card row for a payment method, in ANY tenant (raw pool read). */
    async function cardsForPaymentMethod(
      paymentMethodId: string,
    ): Promise<Array<{ tenant_id: string; customer_id: string }>> {
      const { rows } = await pool.query<{ tenant_id: string; customer_id: string }>(
        `SELECT tenant_id, customer_id FROM customer_payment_methods WHERE stripe_payment_method_id = $1`,
        [paymentMethodId],
      );
      return rows;
    }

    /** The #1177 refusal contract: 403, one audit row on the NAMED tenant, webhook row failed. */
    async function expectCustomerRefusal(params: {
      res: request.Response;
      stripeEventId: string;
      namedTenant: TestTenant;
      auditRowsBefore: number;
      foreignCustomerId: string;
      eventAccount: string | null;
    }): Promise<void> {
      const { res, stripeEventId, namedTenant, auditRowsBefore, foreignCustomerId, eventAccount } = params;
      expect(res.status).toBe(403);
      expect(res.body).toEqual(CUSTOMER_REFUSED);

      const rows = await auditRows(namedTenant.tenantId);
      expect(rows).toHaveLength(auditRowsBefore + 1);
      const refused = rows[rows.length - 1];
      expect(refused.event_type).toBe('webhook.auth_failed');
      expect(refused.entity_id).toBe('stripe_customer_tenant_mismatch');
      expect(refused.metadata.reason).toBe('stripe_customer_tenant_mismatch');
      expect(refused.metadata.stripeEventId).toBe(stripeEventId);
      expect(refused.metadata.stripeEventType).toBe('setup_intent.succeeded');
      expect(refused.metadata.customerId).toBe(foreignCustomerId);
      expect(refused.metadata.eventAccount).toBe(eventAccount);

      const row = await webhookRow(stripeEventId);
      expect(row?.status).toBe('failed');
      expect(row?.processed_at).toBeNull();
      expect(row?.error_message).toContain('stripe_customer_tenant_mismatch');

      // The customer's owner (tenant B) gets nothing in its audit trail.
      expect(await auditRows(tenantB.tenantId)).toHaveLength(bAuditCount);
    }

    it('REFUSES — and stores no row in EITHER tenant — when tenant A\'s own account names tenant A but a customer_id of tenant B', async () => {
      const bCardsBefore = await savedCards(tenantB.tenantId, bCustomerId);
      expect(bCardsBefore).toHaveLength(1);
      const auditBefore = (await auditRows(tenantA.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const paymentMethodId = `pm_${eventId}`;
      const res = await postSigned(
        setupIntentSucceeded(eventId, tenantA.tenantId, bCustomerId, paymentMethodId, ACCOUNT_A),
      );

      await expectCustomerRefusal({
        res, stripeEventId: eventId, namedTenant: tenantA, auditRowsBefore: auditBefore,
        foreignCustomerId: bCustomerId, eventAccount: ACCOUNT_A,
      });
      // No saved-card row for this payment method anywhere — not under A, not under B.
      expect(await cardsForPaymentMethod(paymentMethodId)).toEqual([]);
      expect(await savedCards(tenantA.tenantId, bCustomerId)).toHaveLength(0);
      // Tenant B's own card on that customer is exactly as it was.
      expect(await savedCards(tenantB.tenantId, bCustomerId)).toEqual(bCardsBefore);
    });

    it('REFUSES a PLATFORM-ORIGIN delivery (no event.account) naming tenant A with a customer_id of tenant B', async () => {
      const bCardsBefore = await savedCards(tenantB.tenantId, bCustomerId);
      const auditBefore = (await auditRows(tenantA.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const paymentMethodId = `pm_${eventId}`;
      const body = setupIntentSucceeded(eventId, tenantA.tenantId, bCustomerId, paymentMethodId);
      expect(body).not.toHaveProperty('account');
      const res = await postSigned(body);

      await expectCustomerRefusal({
        res, stripeEventId: eventId, namedTenant: tenantA, auditRowsBefore: auditBefore,
        foreignCustomerId: bCustomerId, eventAccount: null,
      });
      expect(await cardsForPaymentMethod(paymentMethodId)).toEqual([]);
      expect(await savedCards(tenantB.tenantId, bCustomerId)).toEqual(bCardsBefore);
    });

    it('SAVES exactly one row when tenant A\'s own account names tenant A and A\'s OWN customer (legit case)', async () => {
      const customerId = await seedCustomer(tenantA);
      const auditBefore = (await auditRows(tenantA.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const paymentMethodId = `pm_${eventId}`;
      const res = await postSigned(
        setupIntentSucceeded(eventId, tenantA.tenantId, customerId, paymentMethodId, ACCOUNT_A),
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });

      expect(await cardsForPaymentMethod(paymentMethodId)).toEqual([
        { tenant_id: tenantA.tenantId, customer_id: customerId },
      ]);
      expect((await webhookRow(eventId))?.status).toBe('processed');
      // No refusal was audited for the legit delivery — but #1057 the save
      // itself now leaves exactly one durable, tenant-scoped audit row (a
      // stored card arms later off-session charging).
      const { rows: pmRows } = await pool.query<{ id: string }>(
        `SELECT id FROM customer_payment_methods WHERE stripe_payment_method_id = $1`,
        [paymentMethodId],
      );
      const rows = await auditRows(tenantA.tenantId);
      expect(rows).toHaveLength(auditBefore + 1);
      const savedEvent = rows[rows.length - 1];
      expect(savedEvent.event_type).toBe('payment_method.saved');
      expect(savedEvent.entity_id).toBe(pmRows[0].id);
      expect(savedEvent.metadata.customerId).toBe(customerId);
      expect(savedEvent.metadata.brand).toBe('visa');
      expect(savedEvent.metadata.isDefault).toBe(true);
    });
  });

  // ═════════════════ charge.refunded ═════════════════

  describe('charge.refunded', () => {
    it('REFUSES to record a refund when event.account is another tenant\'s and the named tenant HAS its own account', async () => {
      const { invoiceId, piId, paymentId } = await settle(tenantA, ACCOUNT_A);
      const before = await paymentSnapshot(paymentId);
      const auditBefore = (await auditRows(tenantA.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        chargeRefunded(eventId, {
          tenantId: tenantA.tenantId, piId, refundId: `re_${eventId}`, account: ACCOUNT_B,
        }),
      );

      await expectRefusal({
        res, stripeEventId: eventId, stripeEventType: 'charge.refunded',
        namedTenant: tenantA, auditRowsBefore: auditBefore, expectedAccountId: ACCOUNT_A,
        paymentId,
      });
      // Not one money column moved, and no refund claim was taken.
      const after = await paymentSnapshot(paymentId);
      expect(after).toEqual(before);
      expect(after.refunded_amount_cents).toBe(0);
      expect(after.refund_claims).toBe(0);
      expect(after.invoice_status).toBe('paid');
      expect(invoiceId).toBeTruthy();
    });

    it('REFUSES to record a refund on a connected account when the named tenant never enabled Connect', async () => {
      const { piId, paymentId } = await settle(noConnect);
      const before = await paymentSnapshot(paymentId);
      const auditBefore = (await auditRows(noConnect.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        chargeRefunded(eventId, {
          tenantId: noConnect.tenantId, piId, refundId: `re_${eventId}`, account: ACCOUNT_B,
        }),
      );

      await expectRefusal({
        res, stripeEventId: eventId, stripeEventType: 'charge.refunded',
        namedTenant: noConnect, auditRowsBefore: auditBefore, expectedAccountId: null,
        paymentId,
      });
      expect(await paymentSnapshot(paymentId)).toEqual(before);
    });

    it('RECORDS a refund on the tenant\'s OWN connected account', async () => {
      const { piId, paymentId } = await settle(tenantA, ACCOUNT_A);
      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        chargeRefunded(eventId, {
          tenantId: tenantA.tenantId, piId, refundId: `re_${eventId}`, account: ACCOUNT_A,
        }),
      );
      expect(res.status).toBe(200);

      const after = await paymentSnapshot(paymentId);
      expect(after.refunded_amount_cents).toBe(REFUND_CENTS);
      expect(after.last_refund_stripe_id).toBe(`re_${eventId}`);
      expect(after.refund_claims).toBe(1);
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });

    it('RECORDS a PLATFORM-ORIGIN refund with no event.account at all (control)', async () => {
      const { piId, paymentId } = await settle(noConnect);
      const eventId = `evt_${randomUUID()}`;
      const body = chargeRefunded(eventId, {
        tenantId: noConnect.tenantId, piId, refundId: `re_${eventId}`,
      });
      expect(body).not.toHaveProperty('account');
      const res = await postSigned(body);
      expect(res.status).toBe(200);

      const after = await paymentSnapshot(paymentId);
      expect(after.refunded_amount_cents).toBe(REFUND_CENTS);
      expect(after.refund_claims).toBe(1);
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });
  });

  // ═════════════════ charge.refund.updated ═════════════════

  describe('charge.refund.updated', () => {
    it('REFUSES when the CROSS-TENANT payment_intent lookup resolves a tenant whose account is not event.account', async () => {
      const { piId, paymentId } = await settle(tenantA, ACCOUNT_A);
      const before = await paymentSnapshot(paymentId);
      const auditBefore = (await auditRows(tenantA.tenantId)).length;

      // No metadata at all — the tenant is resolved from the payments row.
      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        refundUpdated(eventId, { piId, refundId: `re_${eventId}`, account: ACCOUNT_B }),
      );

      await expectRefusal({
        res, stripeEventId: eventId, stripeEventType: 'charge.refund.updated',
        namedTenant: tenantA, auditRowsBefore: auditBefore, expectedAccountId: ACCOUNT_A,
        paymentId,
      });
      const after = await paymentSnapshot(paymentId);
      expect(after).toEqual(before);
      expect(after.refund_claims).toBe(0);
    });

    it('REFUSES a refund whose forged metadata names another tenant\'s payment', async () => {
      const { piId, paymentId } = await settle(tenantA, ACCOUNT_A);
      const before = await paymentSnapshot(paymentId);
      const auditBefore = (await auditRows(tenantA.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        refundUpdated(eventId, {
          piId: `pi_attacker_${eventId}`,
          refundId: `re_${eventId}`,
          account: ACCOUNT_B,
          metadata: { tenant_id: tenantA.tenantId, payment_id: paymentId },
        }),
      );

      await expectRefusal({
        res, stripeEventId: eventId, stripeEventType: 'charge.refund.updated',
        namedTenant: tenantA, auditRowsBefore: auditBefore, expectedAccountId: ACCOUNT_A,
        paymentId,
      });
      expect(await paymentSnapshot(paymentId)).toEqual(before);
      expect(piId).toBeTruthy();
    });

    it('RECORDS a refund on the tenant\'s OWN connected account', async () => {
      const { piId, paymentId } = await settle(tenantA, ACCOUNT_A);
      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        refundUpdated(eventId, { piId, refundId: `re_${eventId}`, account: ACCOUNT_A }),
      );
      expect(res.status).toBe(200);

      const after = await paymentSnapshot(paymentId);
      expect(after.refunded_amount_cents).toBe(REFUND_CENTS);
      expect(after.refund_claims).toBe(1);
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });

    it('RECORDS a PLATFORM-ORIGIN refund with no event.account at all (control)', async () => {
      const { piId, paymentId } = await settle(noConnect);
      const eventId = `evt_${randomUUID()}`;
      const body = refundUpdated(eventId, { piId, refundId: `re_${eventId}` });
      expect(body).not.toHaveProperty('account');
      const res = await postSigned(body);
      expect(res.status).toBe(200);

      const after = await paymentSnapshot(paymentId);
      expect(after.refunded_amount_cents).toBe(REFUND_CENTS);
      expect(after.refund_claims).toBe(1);
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });
  });

  // ═════════════════ charge.dispute.created (chargeback) ═════════════════

  describe('charge.dispute.created', () => {
    it('REFUSES to reverse the resolved tenant\'s payment when event.account is another tenant\'s', async () => {
      const { invoiceId, piId, paymentId } = await settle(tenantA, ACCOUNT_A);
      const before = await paymentSnapshot(paymentId);
      const auditBefore = (await auditRows(tenantA.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(disputeCreated(eventId, { piId, account: ACCOUNT_B }));

      await expectRefusal({
        res, stripeEventId: eventId, stripeEventType: 'charge.dispute.created',
        namedTenant: tenantA, auditRowsBefore: auditBefore, expectedAccountId: ACCOUNT_A,
        paymentId, invoiceId,
      });
      // Still settled: not reversed, invoice not reopened.
      const after = await paymentSnapshot(paymentId);
      expect(after).toEqual(before);
      expect(after.status).toBe('completed');
      expect(after.reversed_at).toBeNull();
      expect(after.invoice_status).toBe('paid');
    });

    it('REFUSES a dispute on a connected account against a tenant that never enabled Connect', async () => {
      const { invoiceId, piId, paymentId } = await settle(noConnect);
      const before = await paymentSnapshot(paymentId);
      const auditBefore = (await auditRows(noConnect.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(disputeCreated(eventId, { piId, account: ACCOUNT_B }));

      await expectRefusal({
        res, stripeEventId: eventId, stripeEventType: 'charge.dispute.created',
        namedTenant: noConnect, auditRowsBefore: auditBefore, expectedAccountId: null,
        paymentId, invoiceId,
      });
      expect(await paymentSnapshot(paymentId)).toEqual(before);
    });

    it('REVERSES the payment on the tenant\'s OWN connected account', async () => {
      const { piId, paymentId } = await settle(tenantA, ACCOUNT_A);
      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(disputeCreated(eventId, { piId, account: ACCOUNT_A }));
      expect(res.status).toBe(200);

      const after = await paymentSnapshot(paymentId);
      expect(after.reversed_at).not.toBeNull();
      expect(after.reversal_reason).toBe('dispute');
      expect(after.invoice_status).not.toBe('paid');
      expect(after.invoice_amount_paid_cents).toBe(0);
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });

    it('REVERSES a PLATFORM-ORIGIN dispute with no event.account at all (control)', async () => {
      const { piId, paymentId } = await settle(noConnect);
      const eventId = `evt_${randomUUID()}`;
      const body = disputeCreated(eventId, { piId });
      expect(body).not.toHaveProperty('account');
      const res = await postSigned(body);
      expect(res.status).toBe(200);

      const after = await paymentSnapshot(paymentId);
      expect(after.reversed_at).not.toBeNull();
      expect(after.reversal_reason).toBe('dispute');
      expect(after.invoice_amount_paid_cents).toBe(0);
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });
  });

  // ═══════════════════════ tenant grade ═══════════════════════

  it('tenant B — whose account is on every forged event — keeps its own payment, card and audit trail untouched', async () => {
    expect(await paymentSnapshot(bPaymentId)).toEqual(bPaymentSnapshot);
    expect(await savedCards(tenantB.tenantId, bCustomerId)).toHaveLength(bCardCount);
    expect(await auditRows(tenantB.tenantId)).toHaveLength(bAuditCount);
  });
});
