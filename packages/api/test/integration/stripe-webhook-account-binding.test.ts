/**
 * SECURITY #1102 — Stripe settlements must be bound to the tenant's OWN
 * connected account.
 *
 * Docker-gated proof at real Postgres that every settlement branch in
 * `src/webhooks/routes.ts` compares `event.account` (the connected account the
 * money actually landed in) against the named tenant's own
 * `tenants.stripe_connect_account_id` BEFORE it touches an invoice or a
 * payment.
 *
 * THE DEFECT this file closes: the branches settled from the intent's metadata
 * alone (`pi.metadata.tenant_id` / `.invoice_id`). Stripe's signature attests
 * that STRIPE sent the event — not whose account earned the money — so any
 * tenant holding a connected account could mint a PaymentIntent on their OWN
 * account carrying a neighbour's tenant_id + invoice_id, and this handler would
 * mark the neighbour's invoice paid while the cash sat in the attacker's
 * balance.
 *
 * Four cases, repeated for each of the three settlement branches
 * (`payment_intent.succeeded`, `checkout.session.completed`,
 * `payment_intent.processing`):
 *
 *   1. MISMATCH, victim HAS its own account  → refused, nothing credited.
 *   2. MISMATCH, victim never enabled Connect → refused, nothing credited.
 *   3. MATCH (the tenant's own account)       → settles exactly as before.
 *   4. PLATFORM-ORIGIN (no `event.account`)   → settles exactly as before.
 *      This is the control: the fix must not touch platform payments.
 *
 * Nothing is stubbed: real Postgres, the real `createWebhookRouter`, the real
 * `StripeConnectService` reading the real `tenants` columns, real Pg
 * invoice/payment/audit/webhook repositories, and real HMAC-signed bodies.
 *
 * Run:
 *   cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.ts --reporter=verbose \
 *     test/integration/stripe-webhook-account-binding.test.ts
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
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { TestTenant } from './shared';

const STRIPE_SECRET = 'whsec_test_account_binding_1102';
const STRIPE_API_KEY = 'sk_test_binding_never_dialled';
const AMOUNT_CENTS = 31_900;

/** Tenant A's own connected account. */
const ACCOUNT_A = 'acct_binding_tenant_a';
/** Tenant B's own connected account — the attacker's, in the mismatch cases. */
const ACCOUNT_B = 'acct_binding_tenant_b';

describe('Postgres integration — #1102 Stripe settlement is bound to the tenant\'s own connected account', () => {
  let pool: Pool;
  let app: express.Express;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let auditRepo: PgAuditRepository;
  let webhookRepo: PgWebhookRepository;
  let connectService: StripeConnectService;

  /** Connect live — the tenant whose own events must still settle. */
  let tenantA: TestTenant;
  /** Connect live — the neighbour whose account appears on the forged events. */
  let tenantB: TestTenant;
  /** Never enabled Connect — the victim of the original #1102 report. */
  let noConnect: TestTenant;

  async function seedOpenInvoice(t: TestTenant): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    const customerId = randomUUID();
    await customerRepo.create({
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

    const locationId = randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '1102 Binding Way',
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
    await jobRepo.create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: '#1102 account-binding proof',
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

  async function postSigned(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    return request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(raw, STRIPE_SECRET))
      .set('content-type', 'application/json')
      .send(raw);
  }

  /** Raw `webhook_events` row for a Stripe event id — status is the assertion. */
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

  async function countPayments(tenantId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows[0].n;
  }

  /** Every audit row a tenant has, by raw SQL — nothing is filtered out. */
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

  // ───────────────────────── event builders ─────────────────────────
  //
  // `account` is omitted entirely when undefined — Stripe only puts a
  // top-level `account` on deliveries from a Connected-accounts destination.

  function piSucceeded(
    eventId: string,
    piId: string,
    tenantId: string,
    invoiceId: string,
    account?: string,
  ): Record<string, unknown> {
    return {
      id: eventId,
      type: 'payment_intent.succeeded',
      ...(account ? { account } : {}),
      data: {
        object: {
          id: piId,
          amount: AMOUNT_CENTS,
          amount_received: AMOUNT_CENTS,
          metadata: { tenant_id: tenantId, invoice_id: invoiceId },
          charges: { data: [{ payment_method_details: { type: 'card' } }] },
        },
      },
    };
  }

  function checkoutCompleted(
    eventId: string,
    tenantId: string,
    invoiceId: string,
    account?: string,
  ): Record<string, unknown> {
    return {
      id: eventId,
      type: 'checkout.session.completed',
      ...(account ? { account } : {}),
      data: {
        object: {
          id: `cs_${eventId}`,
          metadata: { tenant_id: tenantId, invoice_id: invoiceId },
          amount_total: AMOUNT_CENTS,
          payment_status: 'paid',
          payment_intent: `pi_${eventId}`,
        },
      },
    };
  }

  function piProcessing(
    eventId: string,
    piId: string,
    tenantId: string,
    invoiceId: string,
    account?: string,
  ): Record<string, unknown> {
    return {
      id: eventId,
      type: 'payment_intent.processing',
      ...(account ? { account } : {}),
      data: {
        object: {
          id: piId,
          amount: AMOUNT_CENTS,
          metadata: { tenant_id: tenantId, invoice_id: invoiceId },
          charges: { data: [{ payment_method_details: { type: 'us_bank_account' } }] },
        },
      },
    };
  }

  /**
   * The shared refusal assertion: the delivery is refused 4xx (never 500),
   * nothing is credited anywhere, an audit row on the NAMED tenant says why,
   * and the `webhook_events` row is NOT marked processed — it carries the
   * existing vocabulary's 'failed' status (the CHECK allows only
   * received/processing/processed/failed) with processed_at still null, so no
   * reader can mistake a refusal for a settlement.
   */
  async function expectRefused(params: {
    res: request.Response;
    stripeEventId: string;
    namedTenant: TestTenant;
    invoiceId: string;
    paymentsBefore: number;
    auditRowsBefore: number;
    eventAccount: string;
    expectedAccountId: string | null;
  }): Promise<void> {
    const {
      res, stripeEventId, namedTenant, invoiceId,
      paymentsBefore, auditRowsBefore, eventAccount, expectedAccountId,
    } = params;

    // 4xx-class, never a 500 — a 500 would be indistinguishable from a real
    // outage and would make Stripe retry an event that can never succeed.
    expect(res.status).toBe(403);
    expect(res.status).toBeLessThan(500);
    expect(res.body).toEqual({ error: 'Forbidden', reason: 'stripe_account_mismatch' });

    // Nothing credited.
    const invoice = await invoiceRepo.findById(namedTenant.tenantId, invoiceId);
    expect(invoice?.status).toBe('open');
    expect(invoice?.amountPaidCents).toBe(0);
    expect(invoice?.amountDueCents).toBe(AMOUNT_CENTS);
    expect(await paymentRepo.findByInvoice(namedTenant.tenantId, invoiceId)).toHaveLength(0);
    expect(await countPayments(namedTenant.tenantId)).toBe(paymentsBefore);

    // An audit row on the named tenant saying exactly why.
    const rows = await auditRows(namedTenant.tenantId);
    expect(rows).toHaveLength(auditRowsBefore + 1);
    const rejected = rows[rows.length - 1];
    expect(rejected.event_type).toBe('webhook.auth_failed');
    expect(rejected.entity_id).toBe('stripe_account_mismatch');
    expect(rejected.metadata.reason).toBe('stripe_account_mismatch');
    expect(rejected.metadata.eventAccount).toBe(eventAccount);
    expect(rejected.metadata.tenantConnectAccountId).toBe(expectedAccountId);
    expect(rejected.metadata.stripeEventId).toBe(stripeEventId);
    expect(rejected.metadata.invoiceId).toBe(invoiceId);

    // The webhook_events row must not read as settled.
    const row = await webhookRow(stripeEventId);
    expect(row).not.toBeNull();
    expect(row?.status).not.toBe('processed');
    expect(row?.status).toBe('failed');
    expect(row?.processed_at).toBeNull();
    expect(row?.error_message).toContain('stripe_account_mismatch');
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    webhookRepo = new PgWebhookRepository(pool);
    connectService = new StripeConnectService({ pool, config: { apiKey: STRIPE_API_KEY } });

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    noConnect = await createTestTenant(pool);

    // A and B finish Connect for real — the same columns
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

    app = express();
    app.use('/webhooks/stripe', express.raw({ type: '*/*' }));

    // Wired exactly as app.ts:1108-1124 wires production: the real
    // StripeConnectService behind the production connectAccountResolver shape.
    app.use(
      '/webhooks',
      createWebhookRouter({} as never, {
        invoiceRepo,
        paymentRepo,
        auditRepo,
        webhookRepo,
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
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  // ═════════════════ payment_intent.succeeded ═════════════════

  describe('payment_intent.succeeded', () => {
    it('#1110 — REFUSES (403, not 500) a connected-account delivery whose metadata tenant_id is not a UUID', async () => {
      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        piSucceeded(eventId, `pi_${eventId}`, 'not-a-tenant', randomUUID(), ACCOUNT_B),
      );
      expect(res.status).toBe(403);
      expect((await webhookRow(eventId))?.status).toBe('failed');
    });

    it('REFUSES a delivery whose event.account is another tenant\'s, when the named tenant HAS its own account', async () => {
      const invoiceId = await seedOpenInvoice(tenantA);
      const paymentsBefore = await countPayments(tenantA.tenantId);
      const auditBefore = (await auditRows(tenantA.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      // The money landed in B's account; the metadata names A and A's invoice.
      const res = await postSigned(
        piSucceeded(eventId, `pi_${eventId}`, tenantA.tenantId, invoiceId, ACCOUNT_B),
      );

      await expectRefused({
        res, stripeEventId: eventId, namedTenant: tenantA, invoiceId,
        paymentsBefore, auditRowsBefore: auditBefore,
        eventAccount: ACCOUNT_B, expectedAccountId: ACCOUNT_A,
      });
    });

    it('REFUSES a delivery on a connected account when the named tenant never enabled Connect', async () => {
      const invoiceId = await seedOpenInvoice(noConnect);
      expect((await connectService.getAccount(noConnect.tenantId)).accountId).toBeNull();
      const paymentsBefore = await countPayments(noConnect.tenantId);
      const auditBefore = (await auditRows(noConnect.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        piSucceeded(eventId, `pi_${eventId}`, noConnect.tenantId, invoiceId, ACCOUNT_B),
      );

      await expectRefused({
        res, stripeEventId: eventId, namedTenant: noConnect, invoiceId,
        paymentsBefore, auditRowsBefore: auditBefore,
        eventAccount: ACCOUNT_B, expectedAccountId: null,
      });
    });

    it('SETTLES a delivery on the tenant\'s OWN connected account', async () => {
      const invoiceId = await seedOpenInvoice(tenantA);

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        piSucceeded(eventId, `pi_${eventId}`, tenantA.tenantId, invoiceId, ACCOUNT_A),
      );
      expect(res.status).toBe(200);

      const paid = await invoiceRepo.findById(tenantA.tenantId, invoiceId);
      expect(paid?.status).toBe('paid');
      expect(paid?.amountPaidCents).toBe(AMOUNT_CENTS);
      expect(paid?.amountDueCents).toBe(0);
      const payments = await paymentRepo.findByInvoice(tenantA.tenantId, invoiceId);
      expect(payments).toHaveLength(1);
      expect(payments[0].status).toBe('completed');
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });

    it('SETTLES a PLATFORM-ORIGIN delivery with no event.account at all (control)', async () => {
      const invoiceId = await seedOpenInvoice(noConnect);

      const eventId = `evt_${randomUUID()}`;
      const body = piSucceeded(eventId, `pi_${eventId}`, noConnect.tenantId, invoiceId);
      expect(body).not.toHaveProperty('account');
      const res = await postSigned(body);
      expect(res.status).toBe(200);

      const paid = await invoiceRepo.findById(noConnect.tenantId, invoiceId);
      expect(paid?.status).toBe('paid');
      expect(paid?.amountPaidCents).toBe(AMOUNT_CENTS);
      expect(await paymentRepo.findByInvoice(noConnect.tenantId, invoiceId)).toHaveLength(1);
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });
  });

  // ═════════════════ checkout.session.completed ═════════════════

  describe('checkout.session.completed', () => {
    it('REFUSES a delivery whose event.account is another tenant\'s, when the named tenant HAS its own account', async () => {
      const invoiceId = await seedOpenInvoice(tenantA);
      const paymentsBefore = await countPayments(tenantA.tenantId);
      const auditBefore = (await auditRows(tenantA.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        checkoutCompleted(eventId, tenantA.tenantId, invoiceId, ACCOUNT_B),
      );

      await expectRefused({
        res, stripeEventId: eventId, namedTenant: tenantA, invoiceId,
        paymentsBefore, auditRowsBefore: auditBefore,
        eventAccount: ACCOUNT_B, expectedAccountId: ACCOUNT_A,
      });
    });

    it('REFUSES a delivery on a connected account when the named tenant never enabled Connect', async () => {
      const invoiceId = await seedOpenInvoice(noConnect);
      const paymentsBefore = await countPayments(noConnect.tenantId);
      const auditBefore = (await auditRows(noConnect.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        checkoutCompleted(eventId, noConnect.tenantId, invoiceId, ACCOUNT_B),
      );

      await expectRefused({
        res, stripeEventId: eventId, namedTenant: noConnect, invoiceId,
        paymentsBefore, auditRowsBefore: auditBefore,
        eventAccount: ACCOUNT_B, expectedAccountId: null,
      });
    });

    it('SETTLES a delivery on the tenant\'s OWN connected account', async () => {
      const invoiceId = await seedOpenInvoice(tenantA);

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        checkoutCompleted(eventId, tenantA.tenantId, invoiceId, ACCOUNT_A),
      );
      expect(res.status).toBe(200);

      const paid = await invoiceRepo.findById(tenantA.tenantId, invoiceId);
      expect(paid?.status).toBe('paid');
      expect(paid?.amountPaidCents).toBe(AMOUNT_CENTS);
      expect(await paymentRepo.findByInvoice(tenantA.tenantId, invoiceId)).toHaveLength(1);
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });

    it('SETTLES a PLATFORM-ORIGIN delivery with no event.account at all (control)', async () => {
      const invoiceId = await seedOpenInvoice(noConnect);

      const eventId = `evt_${randomUUID()}`;
      const body = checkoutCompleted(eventId, noConnect.tenantId, invoiceId);
      expect(body).not.toHaveProperty('account');
      const res = await postSigned(body);
      expect(res.status).toBe(200);

      const paid = await invoiceRepo.findById(noConnect.tenantId, invoiceId);
      expect(paid?.status).toBe('paid');
      expect(paid?.amountPaidCents).toBe(AMOUNT_CENTS);
      expect(await paymentRepo.findByInvoice(noConnect.tenantId, invoiceId)).toHaveLength(1);
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });
  });

  // ═════════════ payment_intent.processing (ACH in-flight) ═════════════

  describe('payment_intent.processing (ACH in-flight)', () => {
    it('REFUSES a delivery whose event.account is another tenant\'s, when the named tenant HAS its own account', async () => {
      const invoiceId = await seedOpenInvoice(tenantA);
      const paymentsBefore = await countPayments(tenantA.tenantId);
      const auditBefore = (await auditRows(tenantA.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        piProcessing(eventId, `pi_${eventId}`, tenantA.tenantId, invoiceId, ACCOUNT_B),
      );

      await expectRefused({
        res, stripeEventId: eventId, namedTenant: tenantA, invoiceId,
        paymentsBefore, auditRowsBefore: auditBefore,
        eventAccount: ACCOUNT_B, expectedAccountId: ACCOUNT_A,
      });
    });

    it('REFUSES a delivery on a connected account when the named tenant never enabled Connect', async () => {
      const invoiceId = await seedOpenInvoice(noConnect);
      const paymentsBefore = await countPayments(noConnect.tenantId);
      const auditBefore = (await auditRows(noConnect.tenantId)).length;

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        piProcessing(eventId, `pi_${eventId}`, noConnect.tenantId, invoiceId, ACCOUNT_B),
      );

      await expectRefused({
        res, stripeEventId: eventId, namedTenant: noConnect, invoiceId,
        paymentsBefore, auditRowsBefore: auditBefore,
        eventAccount: ACCOUNT_B, expectedAccountId: null,
      });
    });

    it('CREDITS an in-flight debit on the tenant\'s OWN connected account', async () => {
      const invoiceId = await seedOpenInvoice(tenantA);

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned(
        piProcessing(eventId, `pi_${eventId}`, tenantA.tenantId, invoiceId, ACCOUNT_A),
      );
      expect(res.status).toBe(200);

      const payments = await paymentRepo.findByInvoice(tenantA.tenantId, invoiceId);
      expect(payments).toHaveLength(1);
      expect(payments[0].status).toBe('processing');
      expect(payments[0].amountCents).toBe(AMOUNT_CENTS);
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });

    it('CREDITS a PLATFORM-ORIGIN in-flight debit with no event.account at all (control)', async () => {
      const invoiceId = await seedOpenInvoice(noConnect);

      const eventId = `evt_${randomUUID()}`;
      const body = piProcessing(eventId, `pi_${eventId}`, noConnect.tenantId, invoiceId);
      expect(body).not.toHaveProperty('account');
      const res = await postSigned(body);
      expect(res.status).toBe(200);

      const payments = await paymentRepo.findByInvoice(noConnect.tenantId, invoiceId);
      expect(payments).toHaveLength(1);
      expect(payments[0].status).toBe('processing');
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });
  });

  // ═════════════ payment_intent.payment_failed (reversal path) ═════════════
  //
  // The failure branch is money-touching too: a `payment_failed` on a
  // previously-settled intent REVERSES the payment and reopens the invoice, so
  // an unbound delivery is a vandalism vector, not just a mis-credit.

  describe('payment_intent.payment_failed', () => {
    it('REFUSES an unbound delivery instead of reversing the tenant\'s settled payment', async () => {
      const invoiceId = await seedOpenInvoice(tenantA);

      // Settle it legitimately first, on the tenant's OWN account.
      const settleId = `evt_${randomUUID()}`;
      const piId = `pi_${settleId}`;
      expect(
        (await postSigned(piSucceeded(settleId, piId, tenantA.tenantId, invoiceId, ACCOUNT_A)))
          .status,
      ).toBe(200);
      expect((await invoiceRepo.findById(tenantA.tenantId, invoiceId))?.status).toBe('paid');

      const auditBefore = (await auditRows(tenantA.tenantId)).length;

      // Now an ACH-return shaped event for the SAME intent, delivered from the
      // neighbour's account. Reversing here would reopen a paid invoice.
      const failId = `evt_${randomUUID()}`;
      const res = await postSigned({
        id: failId,
        type: 'payment_intent.payment_failed',
        account: ACCOUNT_B,
        data: {
          object: {
            id: piId,
            amount: AMOUNT_CENTS,
            metadata: { tenant_id: tenantA.tenantId, invoice_id: invoiceId },
            charges: { data: [{ payment_method_details: { type: 'us_bank_account' } }] },
            last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' },
          },
        },
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden', reason: 'stripe_account_mismatch' });

      // The settled payment is untouched — still paid, still one completed row.
      const stillPaid = await invoiceRepo.findById(tenantA.tenantId, invoiceId);
      expect(stillPaid?.status).toBe('paid');
      expect(stillPaid?.amountPaidCents).toBe(AMOUNT_CENTS);
      const payments = await paymentRepo.findByInvoice(tenantA.tenantId, invoiceId);
      expect(payments).toHaveLength(1);
      expect(payments[0].status).toBe('completed');
      expect(payments[0].reversedAt).toBeFalsy();

      const rows = await auditRows(tenantA.tenantId);
      expect(rows).toHaveLength(auditBefore + 1);
      expect(rows[rows.length - 1].event_type).toBe('webhook.auth_failed');
      expect((await webhookRow(failId))?.status).toBe('failed');
    });

    it('still records a PLATFORM-ORIGIN decline with no event.account (control)', async () => {
      const invoiceId = await seedOpenInvoice(noConnect);

      const eventId = `evt_${randomUUID()}`;
      const res = await postSigned({
        id: eventId,
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: `pi_${eventId}`,
            amount: AMOUNT_CENTS,
            metadata: { tenant_id: noConnect.tenantId, invoice_id: invoiceId },
            charges: { data: [{ payment_method_details: { type: 'card' } }] },
            last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' },
          },
        },
      });
      expect(res.status).toBe(200);

      // A plain decline records a failed attempt; the invoice balance is
      // untouched (it was never paid).
      const payments = await paymentRepo.findByInvoice(noConnect.tenantId, invoiceId);
      expect(payments).toHaveLength(1);
      expect(payments[0].status).toBe('failed');
      expect((await invoiceRepo.findById(noConnect.tenantId, invoiceId))?.status).toBe('open');
      expect((await webhookRow(eventId))?.status).toBe('processed');
    });
  });

  // ═══════════════════════ the seam is one place ═══════════════════════

  it('audits the refusal under the NAMED tenant, not the account owner — the victim can see the attempt', async () => {
    const invoiceId = await seedOpenInvoice(noConnect);
    const bAuditBefore = (await auditRows(tenantB.tenantId)).length;

    const eventId = `evt_${randomUUID()}`;
    await postSigned(piSucceeded(eventId, `pi_${eventId}`, noConnect.tenantId, invoiceId, ACCOUNT_B));

    // The refusal is recorded on the victim's tenant …
    const victimRows = await auditRows(noConnect.tenantId);
    expect(victimRows[victimRows.length - 1].event_type).toBe('webhook.auth_failed');
    // … and nothing is written to the account owner's tenant.
    expect(await auditRows(tenantB.tenantId)).toHaveLength(bAuditBefore);
  });

  it('a refused delivery is retried-and-refused deterministically — never settled on the retry', async () => {
    const invoiceId = await seedOpenInvoice(tenantA);

    const eventId = `evt_${randomUUID()}`;
    const body = piSucceeded(eventId, `pi_${eventId}`, tenantA.tenantId, invoiceId, ACCOUNT_B);

    const first = await postSigned(body);
    expect(first.status).toBe(403);
    // Stripe retries a non-2xx. The row is 'failed', so the dedup lets the
    // retry through — and it must be refused again, not settled.
    const second = await postSigned(body);
    expect(second.status).toBe(403);

    const invoice = await invoiceRepo.findById(tenantA.tenantId, invoiceId);
    expect(invoice?.status).toBe('open');
    expect(await paymentRepo.findByInvoice(tenantA.tenantId, invoiceId)).toHaveLength(0);
    expect((await webhookRow(eventId))?.status).toBe('failed');
  });
});
