/**
 * Route-level tests for the Stripe `checkout.session.completed` branch in
 * src/webhooks/routes.ts. The service-layer invoice math is covered by
 * test/payments/P5-010F.test.ts; this file pins the route-level gaps:
 *   - the deposit branch (deposit_for_job_id) and its ceiling math
 *   - the payment_intent string / object / null → providerReference stamping
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryJobRepository, Job } from '../../src/jobs/job';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const STRIPE_SECRET = 'whsec_test_checkout';
const TENANT = '11111111-1111-1111-1111-111111111111';

function buildApp(deps: Parameters<typeof createWebhookRouter>[1]) {
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

function depositEvent(opts: {
  jobId?: string;
  amountTotal: number;
  paymentStatus?: string;
}): Record<string, unknown> {
  return {
    id: `evt_${uuidv4()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        metadata: { tenant_id: TENANT, deposit_for_job_id: opts.jobId },
        amount_total: opts.amountTotal,
        payment_status: opts.paymentStatus ?? 'paid',
      },
    },
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    customerId: uuidv4(),
    locationId: uuidv4(),
    jobNumber: 'JOB-1',
    summary: 'Deposit job',
    status: 'scheduled',
    priority: 'normal',
    depositRequiredCents: 5000,
    depositPaidCents: 0,
    depositStatus: 'pending',
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('checkout.session.completed — deposit branch', () => {
  let jobRepo: InMemoryJobRepository;
  let app: express.Express;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    app = buildApp({ jobRepo, auditRepo: new InMemoryAuditRepository(), stripeWebhookSecret: STRIPE_SECRET });
  });

  it('caps an over-tap deposit at depositRequiredCents and marks it paid', async () => {
    const job = await jobRepo.create(makeJob({ depositRequiredCents: 5000, depositPaidCents: 0 }));
    const res = await postSigned(app, depositEvent({ jobId: job.id, amountTotal: 5001 }));

    expect(res.status).toBe(200);
    expect(res.body.deposit).toBe(true);
    const updated = await jobRepo.findById(TENANT, job.id);
    expect(updated?.depositPaidCents).toBe(5000); // capped, no overshoot
    expect(updated?.depositStatus).toBe('paid');
  });

  it('credits a partial deposit and leaves status pending', async () => {
    const job = await jobRepo.create(makeJob({ depositRequiredCents: 5000, depositPaidCents: 0 }));
    await postSigned(app, depositEvent({ jobId: job.id, amountTotal: 2000 }));
    const updated = await jobRepo.findById(TENANT, job.id);
    expect(updated?.depositPaidCents).toBe(2000);
    expect(updated?.depositStatus).toBe('pending');
  });

  it('skips when the job requires no deposit (required <= 0)', async () => {
    const job = await jobRepo.create(makeJob({ depositRequiredCents: 0, depositPaidCents: 0 }));
    const res = await postSigned(app, depositEvent({ jobId: job.id, amountTotal: 3000 }));
    expect(res.body.skipped).toBe(true);
    expect((await jobRepo.findById(TENANT, job.id))?.depositPaidCents).toBe(0);
  });

  it('skips when the deposit is for an unknown job', async () => {
    const res = await postSigned(app, depositEvent({ jobId: uuidv4(), amountTotal: 3000 }));
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
  });

  it('returns 500 when jobRepo is not wired', async () => {
    const appNoJob = buildApp({ auditRepo: new InMemoryAuditRepository(), stripeWebhookSecret: STRIPE_SECRET });
    const res = await postSigned(appNoJob, depositEvent({ jobId: uuidv4(), amountTotal: 3000 }));
    expect(res.status).toBe(500);
  });

  it('skips unpaid sessions before touching the job', async () => {
    const job = await jobRepo.create(makeJob());
    const res = await postSigned(app, depositEvent({ jobId: job.id, amountTotal: 3000, paymentStatus: 'unpaid' }));
    expect(res.body.skipped).toBe(true);
    expect((await jobRepo.findById(TENANT, job.id))?.depositPaidCents).toBe(0);
  });
});

describe('checkout.session.completed — payment_intent → providerReference', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let app: express.Express;
  const INVOICE_ID = 'inv-001';

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

  function invoiceEvent(
    paymentIntent: unknown,
    opts?: { sessionId?: string; invoiceId?: string; eventId?: string },
  ): Record<string, unknown> {
    return {
      id: opts?.eventId ?? `evt_${uuidv4()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          ...(opts?.sessionId ? { id: opts.sessionId } : {}),
          metadata: { tenant_id: TENANT, invoice_id: opts?.invoiceId ?? INVOICE_ID },
          amount_total: 10000,
          payment_status: 'paid',
          payment_intent: paymentIntent,
        },
      },
    };
  }

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    await invoiceRepo.create(makeInvoice());
    app = buildApp({ invoiceRepo, paymentRepo, auditRepo: new InMemoryAuditRepository(), stripeWebhookSecret: STRIPE_SECRET });
  });

  it('stamps a string payment_intent as the providerReference', async () => {
    await postSigned(app, invoiceEvent('pi_string_123'));
    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].providerReference).toBe('pi_string_123');
  });

  it('extracts the id from an expanded payment_intent object', async () => {
    await postSigned(app, invoiceEvent({ id: 'pi_object_456' }));
    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments[0].providerReference).toBe('pi_object_456');
  });

  it('P0-5: falls back to the unique SESSION id when payment_intent is null', async () => {
    await postSigned(app, invoiceEvent(null, { sessionId: 'cs_test_789' }));
    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments[0].providerReference).toBe('cs_test_789');
  });

  it('P0-5: falls back to the event id when both payment_intent and session id are absent', async () => {
    const eventId = `evt_${uuidv4()}`;
    await postSigned(app, invoiceEvent(null, { eventId }));
    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments[0].providerReference).toBe(eventId);
  });

  it('P0-5 regression: two intent-less checkouts on DIFFERENT invoices both record (no tenant-wide collision)', async () => {
    // With the old literal 'stripe_checkout' fallback both sessions shared one
    // provider reference: the second hit the (tenant, reference) unique index
    // against a different invoice, recordPayment surfaced a conflict the
    // handler doesn't catch, and Stripe retried the 500 forever.
    const secondInvoiceId = 'inv-002';
    await invoiceRepo.create({ ...makeInvoice(), id: secondInvoiceId, invoiceNumber: 'INV-002' });

    const res1 = await postSigned(app, invoiceEvent(null, { sessionId: 'cs_collide_a' }));
    const res2 = await postSigned(
      app,
      invoiceEvent(null, { sessionId: 'cs_collide_b', invoiceId: secondInvoiceId }),
    );

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect((await paymentRepo.findByInvoice(TENANT, INVOICE_ID))[0]?.providerReference).toBe('cs_collide_a');
    expect((await paymentRepo.findByInvoice(TENANT, secondInvoiceId))[0]?.providerReference).toBe('cs_collide_b');
  });
});

describe('P0-9 — unapplied captures are audited; stale links die on credit', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let deactivated: Array<{ linkId: string; account?: string }>;
  let app: express.Express;
  const INVOICE_ID = 'inv-p09';

  function makeInvoice(over: Partial<Invoice> = {}): Invoice {
    const lineItems = [buildLineItem('li-1', 'Service', 1, 10000, 1, false)];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    return {
      id: INVOICE_ID,
      tenantId: TENANT,
      jobId: 'job-p09',
      invoiceNumber: 'INV-P09',
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      stripePaymentLinkId: 'plink_stale_1',
      stripePaymentLinkUrl: 'https://pay.stripe.com/plink_stale_1',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    };
  }

  function checkoutEvent(amountTotal: number): Record<string, unknown> {
    return {
      id: `evt_${uuidv4()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_${uuidv4()}`,
          metadata: { tenant_id: TENANT, invoice_id: INVOICE_ID },
          amount_total: amountTotal,
          payment_status: 'paid',
          payment_intent: `pi_${uuidv4()}`,
        },
      },
    };
  }

  beforeEach(() => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    deactivated = [];
    app = buildApp({
      invoiceRepo,
      paymentRepo,
      auditRepo,
      stripeWebhookSecret: STRIPE_SECRET,
      paymentLinkProvider: {
        generateLink: async () => { throw new Error('not used'); },
        deactivateLink: async (linkId: string, account?: string) => {
          deactivated.push({ linkId, account });
        },
      },
    });
  });

  it('a capture that must be capped audits the unapplied remainder', async () => {
    // Balance drops to 4000 after the link was minted at 10000.
    await invoiceRepo.create(makeInvoice({ amountPaidCents: 6000, amountDueCents: 4000 }));

    const res = await postSigned(app, checkoutEvent(10000));
    expect(res.status).toBe(200);

    // Credit capped to the remaining balance…
    const invoice = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(invoice!.amountPaidCents).toBe(10000);
    expect(invoice!.status).toBe('paid');

    // …and the 6000-cent excess is on the audit trail, not just a log line.
    const events = auditRepo.getAll().filter((e) => e.eventType === 'payment.unapplied_capture');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      capturedCents: 10000,
      creditedCents: 4000,
      unappliedCents: 6000,
      reason: 'capped_to_balance',
    });
  });

  it('a capture on an unpayable invoice audits the full amount and retries the link kill', async () => {
    await invoiceRepo.create(makeInvoice({ status: 'void' }));

    const res = await postSigned(app, checkoutEvent(10000));
    expect(res.status).toBe(200);

    const events = auditRepo.getAll().filter((e) => e.eventType === 'payment.unapplied_capture');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      capturedCents: 10000,
      creditedCents: 0,
      unappliedCents: 10000,
      reason: 'not_payable',
      invoiceStatus: 'void',
    });
    // The link a failed void-time deactivation left behind dies here.
    expect(deactivated).toEqual([{ linkId: 'plink_stale_1', account: undefined }]);
    const invoice = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(invoice!.stripePaymentLinkId).toBeUndefined();
  });

  it('a clean full payment consumes the link and clears its columns', async () => {
    await invoiceRepo.create(makeInvoice());

    const res = await postSigned(app, checkoutEvent(10000));
    expect(res.status).toBe(200);

    const invoice = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(invoice!.status).toBe('paid');
    expect(invoice!.stripePaymentLinkId).toBeUndefined();
    expect(deactivated).toHaveLength(1);
    // A clean exact-amount settlement leaves no unapplied capture.
    expect(auditRepo.getAll().filter((e) => e.eventType === 'payment.unapplied_capture')).toHaveLength(0);
  });
});
