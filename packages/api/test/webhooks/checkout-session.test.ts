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

  function invoiceEvent(paymentIntent: unknown): Record<string, unknown> {
    return {
      id: `evt_${uuidv4()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenant_id: TENANT, invoice_id: INVOICE_ID },
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

  it('falls back to the stripe_checkout literal when payment_intent is null', async () => {
    await postSigned(app, invoiceEvent(null));
    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments[0].providerReference).toBe('stripe_checkout');
  });
});
