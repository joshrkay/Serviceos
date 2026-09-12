/**
 * W1-2 — Docker-gated integration proof: signed Stripe webhook → paid.
 *
 * Pins the production path against real Postgres:
 *   PgInvoiceRepository + PgPaymentRepository + PgWebhookRepository
 *   + createWebhookRouter checkout.session.completed branch
 *
 * Proves durable idempotency (webhook_events unique on source+key) so a
 * replay cannot double-credit. No Stripe Elements / Checkout UI / live
 * Stripe network.
 *
 * #1022 row 8.4 additions: the credit's audit rows are read back through the
 * real PgAuditRepository (a replay must add no second `payment.recorded`), and
 * a NEIGHBOUR tenant is present — an event whose metadata names the neighbour
 * but this tenant's invoice credits nothing, and each tenant's own event
 * credits only its own invoice. The embedded-elements half of this story is
 * jsdom-only; the hermetic public-pay browser journey (rung 5) is a separate
 * lane.
 *
 * Run via: cd packages/api && npm run test:integration -- invoice-webhook-paid
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { PgWebhookRepository } from '../../src/webhooks/pg-webhook';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const STRIPE_SECRET = 'whsec_test_w1_2_integration';
const AMOUNT_CENTS = 50_000;

describe('Postgres integration — W1-2 invoice webhook → paid', () => {
  let pool: Pool;
  let app: express.Express;
  let paymentRepo: PgPaymentRepository;
  let invoiceRepo: PgInvoiceRepository;
  let webhookRepo: PgWebhookRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let otherTenant: { tenantId: string; userId: string };

  async function seedOpenInvoice(
    t: { tenantId: string; userId: string } = tenant,
  ): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    const customerId = randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'W1',
      lastName: 'Two',
      displayName: 'W1 Two',
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
      street1: '2 Money Loop Way',
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
      summary: 'W1-2 webhook paid proof',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lineItems = [buildLineItem(randomUUID(), 'Service', 1, AMOUNT_CENTS, 1, false)];
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

  function checkoutEvent(eventId: string, invoiceId: string): Record<string, unknown> {
    return {
      id: eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenant_id: tenant.tenantId, invoice_id: invoiceId },
          amount_total: AMOUNT_CENTS,
          payment_status: 'paid',
          payment_intent: `pi_${eventId}`,
        },
      },
    };
  }

  // U6 — a Connect direct charge (Elements PaymentIntent on the tenant's
  // connected account) is delivered from the "Connected accounts" webhook
  // destination with a top-level `account: acct_…`. The settlement branch keys
  // off data.object.metadata, so a connected-origin event must credit the real
  // Postgres ledger identically to a platform one.
  function connectPaymentIntentEvent(eventId: string, invoiceId: string): Record<string, unknown> {
    return {
      id: eventId,
      type: 'payment_intent.succeeded',
      account: 'acct_connect_w1_2_integration',
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
  }

  async function postSigned(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    return request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(raw, STRIPE_SECRET))
      .set('content-type', 'application/json')
      .send(raw);
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    paymentRepo = new PgPaymentRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    webhookRepo = new PgWebhookRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
    otherTenant = await createTestTenant(pool);
    app = express();
    app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    app.use(
      '/webhooks',
      createWebhookRouter({} as never, {
        invoiceRepo,
        paymentRepo,
        auditRepo,
        webhookRepo,
        stripeWebhookSecret: STRIPE_SECRET,
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('signed checkout.session.completed flips open invoice to paid (real columns)', async () => {
    const invoiceId = await seedOpenInvoice();
    const eventId = `evt_${randomUUID()}`;

    const before = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(before?.status).toBe('open');
    expect(before?.amountDueCents).toBe(AMOUNT_CENTS);

    const res = await postSigned(checkoutEvent(eventId, invoiceId));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const after = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(after?.status).toBe('paid');
    expect(after?.amountPaidCents).toBe(AMOUNT_CENTS);
    expect(after?.amountDueCents).toBe(0);

    const payments = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0].amountCents).toBe(AMOUNT_CENTS);
    expect(payments[0].providerReference).toBe(`pi_${eventId}`);

    const row = await webhookRepo.findByIdempotencyKey('stripe', eventId);
    expect(row?.status).toBe('processed');

    // The credit is on the audit trail, read back through the real repo: the
    // settlement and the status move both, correlated by the intent id.
    const events = await auditRepo.findByEntity(tenant.tenantId, 'invoice', invoiceId);
    const recorded = events.filter((e) => e.eventType === 'payment.recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].metadata!.amountCents).toBe(AMOUNT_CENTS);
    expect(recorded[0].metadata!.paymentId).toBe(payments[0].id);
    expect(recorded[0].correlationId).toBe(`pi_${eventId}`);
    expect(recorded[0].tenantId).toBe(tenant.tenantId);
    const statusChanges = events.filter((e) => e.eventType === 'invoice.status_changed');
    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0].metadata!.oldStatus).toBe('open');
    expect(statusChanges[0].metadata!.newStatus).toBe('paid');
  });

  it('replay of the same Stripe event id does not double-apply (durable idempotency)', async () => {
    const invoiceId = await seedOpenInvoice();
    const eventId = `evt_${randomUUID()}`;
    const event = checkoutEvent(eventId, invoiceId);

    const first = await postSigned(event);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });

    const second = await postSigned(event);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: true });

    const inv = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(inv?.status).toBe('paid');
    expect(inv?.amountPaidCents).toBe(AMOUNT_CENTS);

    const payments = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(payments).toHaveLength(1);

    const row = await webhookRepo.findByIdempotencyKey('stripe', eventId);
    expect(row?.status).toBe('processed');

    // The replay is deduped before the handler runs, so the timeline shows
    // ONE settlement — not two for one payment.
    const recorded = (
      await auditRepo.findByEntity(tenant.tenantId, 'invoice', invoiceId)
    ).filter((e) => e.eventType === 'payment.recorded');
    expect(recorded).toHaveLength(1);
  });

  it('Connect direct charge (payment_intent.succeeded with event.account) settles the real ledger + idempotent', async () => {
    const invoiceId = await seedOpenInvoice();
    const eventId = `evt_${randomUUID()}`;
    const event = connectPaymentIntentEvent(eventId, invoiceId);

    const first = await postSigned(event);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });

    const after = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(after?.status).toBe('paid');
    expect(after?.amountPaidCents).toBe(AMOUNT_CENTS);
    expect(after?.amountDueCents).toBe(0);

    const payments = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0].amountCents).toBe(AMOUNT_CENTS);
    expect(payments[0].method).toBe('credit_card');
    expect(payments[0].providerReference).toBe(`pi_${eventId}`);

    // Re-deliver the same connected-account event id — no double-credit.
    const second = await postSigned(event);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: true });

    const settled = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(settled?.amountPaidCents).toBe(AMOUNT_CENTS);
    expect(await paymentRepo.findByInvoice(tenant.tenantId, invoiceId)).toHaveLength(1);
  });

  it("an event naming a neighbour tenant credits nothing; each tenant's own event credits only its own invoice", async () => {
    const mineInvoiceId = await seedOpenInvoice();
    const theirInvoiceId = await seedOpenInvoice(otherTenant);

    // Metadata forged/mixed: the NEIGHBOUR's tenant_id with THIS tenant's
    // invoice_id. The tenant-scoped read finds no such invoice, so nothing is
    // credited and the delivery is not ACKed as success (Stripe retries).
    const crossEventId = `evt_${randomUUID()}`;
    const cross = await postSigned({
      id: crossEventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenant_id: otherTenant.tenantId, invoice_id: mineInvoiceId },
          amount_total: AMOUNT_CENTS,
          payment_status: 'paid',
          payment_intent: `pi_${crossEventId}`,
        },
      },
    });
    expect(cross.status).toBe(500);

    const untouched = await invoiceRepo.findById(tenant.tenantId, mineInvoiceId);
    expect(untouched?.status).toBe('open');
    expect(untouched?.amountPaidCents).toBe(0);
    expect(await paymentRepo.findByInvoice(tenant.tenantId, mineInvoiceId)).toHaveLength(0);
    const strays = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1 AND reference_number = $2`,
      [otherTenant.tenantId, `pi_${crossEventId}`],
    );
    expect(strays.rows[0].n).toBe(0);
    expect(await auditRepo.findByEntity(tenant.tenantId, 'invoice', mineInvoiceId)).toEqual([]);

    // Each tenant's OWN event lands on its own invoice only.
    const mineEventId = `evt_${randomUUID()}`;
    expect((await postSigned(checkoutEvent(mineEventId, mineInvoiceId))).status).toBe(200);
    const theirEventId = `evt_${randomUUID()}`;
    expect(
      (
        await postSigned({
          id: theirEventId,
          type: 'checkout.session.completed',
          data: {
            object: {
              metadata: { tenant_id: otherTenant.tenantId, invoice_id: theirInvoiceId },
              amount_total: AMOUNT_CENTS,
              payment_status: 'paid',
              payment_intent: `pi_${theirEventId}`,
            },
          },
        })
      ).status,
    ).toBe(200);

    expect((await invoiceRepo.findById(tenant.tenantId, mineInvoiceId))?.amountPaidCents).toBe(
      AMOUNT_CENTS,
    );
    expect(
      (await invoiceRepo.findById(otherTenant.tenantId, theirInvoiceId))?.amountPaidCents,
    ).toBe(AMOUNT_CENTS);
    expect(await paymentRepo.findByInvoice(tenant.tenantId, mineInvoiceId)).toHaveLength(1);
    expect(await paymentRepo.findByInvoice(otherTenant.tenantId, theirInvoiceId)).toHaveLength(1);

    // Neither tenant can read the other's settlement audit.
    expect(
      (await auditRepo.findByEntity(otherTenant.tenantId, 'invoice', theirInvoiceId)).filter(
        (e) => e.eventType === 'payment.recorded',
      ),
    ).toHaveLength(1);
    expect(await auditRepo.findByEntity(otherTenant.tenantId, 'invoice', mineInvoiceId)).toEqual(
      [],
    );
    expect(await auditRepo.findByEntity(tenant.tenantId, 'invoice', theirInvoiceId)).toEqual([]);
  });
});
