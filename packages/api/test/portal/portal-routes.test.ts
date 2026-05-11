/**
 * P10-001 — portal route integration tests (in-memory repositories).
 *
 * Covers:
 *   - Authed POST /api/portal-sessions
 *   - Token middleware (resolution, expiry, revocation, rate-limit)
 *   - Public read endpoints (customer/estimates/invoices/jobs/agreements/appointments)
 *   - Public POST /:token/request-service creates a lead with source='web_form'
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryPortalSessionRepository } from '../../src/portal/portal-session';
import {
  InMemoryCustomerRepository,
  Customer,
} from '../../src/customers/customer';
import {
  InMemoryEstimateRepository,
  Estimate,
} from '../../src/estimates/estimate';
import {
  InMemoryInvoiceRepository,
  Invoice,
} from '../../src/invoices/invoice';
import { InMemoryJobRepository, Job } from '../../src/jobs/job';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';
import {
  InMemoryAppointmentRepository,
  Appointment,
} from '../../src/appointments/appointment';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createPortalRouter } from '../../src/routes/portal';
import { createPublicPortalRouter } from '../../src/routes/public-portal';

const TENANT = uuidv4();
const ACTOR = 'user-test';

interface Harness {
  app: express.Express;
  portalRepo: InMemoryPortalSessionRepository;
  customerRepo: InMemoryCustomerRepository;
  estimateRepo: InMemoryEstimateRepository;
  invoiceRepo: InMemoryInvoiceRepository;
  jobRepo: InMemoryJobRepository;
  agreementRepo: InMemoryAgreementRepository;
  appointmentRepo: InMemoryAppointmentRepository;
  leadRepo: InMemoryLeadRepository;
  auditRepo: InMemoryAuditRepository;
  customer: Customer;
}

async function build(opts: {
  paymentLinkProvider?: import('../../src/payments/payment-link-provider').PaymentLinkProvider;
  invoiceRepoOverride?: import('../../src/invoices/invoice').InvoiceRepository;
} = {}): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const portalRepo = new InMemoryPortalSessionRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const invoiceRepo = (opts.invoiceRepoOverride ?? new InMemoryInvoiceRepository()) as InMemoryInvoiceRepository;
  const jobRepo = new InMemoryJobRepository();
  const agreementRepo = new InMemoryAgreementRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const leadRepo = new InMemoryLeadRepository();
  const auditRepo = new InMemoryAuditRepository();

  const customer = await customerRepo.create({
    id: uuidv4(),
    tenantId: TENANT,
    firstName: 'Pat',
    lastName: 'Customer',
    displayName: 'Pat Customer',
    email: 'pat@example.com',
    primaryPhone: '+15555550100',
    preferredChannel: 'email',
    smsConsent: false,
    isArchived: false,
    createdBy: ACTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Mount public portal BEFORE the fake auth middleware so it stays
  // unauthenticated (mirrors the real app.ts wiring order).
  app.use(
    '/api/public/portal',
    createPublicPortalRouter({
      portalRepo,
      customerRepo,
      estimateRepo,
      invoiceRepo,
      jobRepo,
      agreementRepo,
      appointmentRepo,
      leadRepo,
      auditRepo,
      paymentLinkProvider: opts.paymentLinkProvider,
    }),
  );

  // Fake auth — owner role for everything else.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: ACTOR,
      sessionId: 'session-1',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });

  app.use(
    '/api/portal-sessions',
    createPortalRouter({ portalRepo, customerRepo }),
  );

  return {
    app,
    portalRepo,
    customerRepo,
    estimateRepo,
    invoiceRepo,
    jobRepo,
    agreementRepo,
    appointmentRepo,
    leadRepo,
    auditRepo,
    customer,
  };
}

async function mintToken(h: Harness): Promise<string> {
  const res = await request(h.app)
    .post('/api/portal-sessions')
    .send({ customerId: h.customer.id });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

describe('P10-001 POST /api/portal-sessions (authed)', () => {
  it('issues a token + URL for a known customer', async () => {
    const h = await build();
    const res = await request(h.app)
      .post('/api/portal-sessions')
      .send({ customerId: h.customer.id });
    expect(res.status).toBe(201);
    expect(res.body.token).toHaveLength(64);
    expect(res.body.url).toMatch(/\/portal\/[0-9a-f]{64}$/);
    expect(res.body.expiresAt).toBeTruthy();
  });

  it('rejects unknown customer with 404', async () => {
    const h = await build();
    const res = await request(h.app)
      .post('/api/portal-sessions')
      .send({ customerId: uuidv4() });
    expect(res.status).toBe(404);
  });

  it('rejects invalid customerId shape with 400', async () => {
    const h = await build();
    const res = await request(h.app)
      .post('/api/portal-sessions')
      .send({ customerId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });
});

describe('P10-001 DELETE /api/portal-sessions/:id', () => {
  it('revokes a session and the token can no longer resolve', async () => {
    const h = await build();
    const created = await request(h.app)
      .post('/api/portal-sessions')
      .send({ customerId: h.customer.id });
    const sessionId = created.body.id as string;
    const token = created.body.token as string;

    const del = await request(h.app).delete(`/api/portal-sessions/${sessionId}`);
    expect(del.status).toBe(200);
    expect(del.body.revokedAt).toBeTruthy();

    const get = await request(h.app).get(`/api/public/portal/${token}/customer`);
    expect(get.status).toBe(401);
  });
});

describe('P10-001 GET /api/public/portal/:token/customer', () => {
  it('returns the customer for a valid token', async () => {
    const h = await build();
    const token = await mintToken(h);
    const res = await request(h.app).get(`/api/public/portal/${token}/customer`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(h.customer.id);
    expect(res.body.email).toBe('pat@example.com');
  });

  it('rejects invalid tokens with 401', async () => {
    const h = await build();
    const res = await request(h.app).get(
      `/api/public/portal/${'a'.repeat(64)}/customer`,
    );
    expect(res.status).toBe(401);
  });

  it('rejects archived customers with 404', async () => {
    const h = await build();
    const token = await mintToken(h);
    await h.customerRepo.update(TENANT, h.customer.id, {
      isArchived: true,
      archivedAt: new Date(),
    });
    const res = await request(h.app).get(`/api/public/portal/${token}/customer`);
    expect(res.status).toBe(404);
  });
});

describe('P10-001 GET /api/public/portal/:token/estimates|invoices|jobs', () => {
  async function seedJobAndDocs(h: Harness): Promise<{ jobId: string; estimateId: string; invoiceId: string }> {
    const job: Job = {
      id: uuidv4(),
      tenantId: TENANT,
      customerId: h.customer.id,
      locationId: uuidv4(),
      jobNumber: 'JOB-0001',
      summary: 'Service call',
      status: 'new',
      priority: 'normal',
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await h.jobRepo.create(job);
    const estimate: Estimate = {
      id: uuidv4(),
      tenantId: TENANT,
      jobId: job.id,
      estimateNumber: 'EST-1000',
      status: 'sent',
      lineItems: [],
      totals: {
        subtotalCents: 10000,
        discountCents: 0,
        taxableSubtotalCents: 10000,
        taxCents: 0,
        totalCents: 10000,
        taxRateBps: 0,
      },
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await h.estimateRepo.create(estimate);
    const invoice: Invoice = {
      id: uuidv4(),
      tenantId: TENANT,
      jobId: job.id,
      invoiceNumber: 'INV-2000',
      status: 'open',
      lineItems: [],
      totals: {
        subtotalCents: 10000,
        discountCents: 0,
        taxableSubtotalCents: 10000,
        taxCents: 0,
        totalCents: 10000,
        taxRateBps: 0,
      },
      amountPaidCents: 0,
      amountDueCents: 10000,
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await h.invoiceRepo.create(invoice);
    return { jobId: job.id, estimateId: estimate.id, invoiceId: invoice.id };
  }

  it('lists estimates scoped to the customer', async () => {
    const h = await build();
    const token = await mintToken(h);
    const { estimateId } = await seedJobAndDocs(h);
    const res = await request(h.app).get(`/api/public/portal/${token}/estimates`);
    expect(res.status).toBe(200);
    expect(res.body.estimates).toHaveLength(1);
    expect(res.body.estimates[0].id).toBe(estimateId);
  });

  it('lists invoices scoped to the customer (without payNowUrl when no provider)', async () => {
    const h = await build();
    const token = await mintToken(h);
    const { invoiceId } = await seedJobAndDocs(h);
    const res = await request(h.app).get(`/api/public/portal/${token}/invoices`);
    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0].id).toBe(invoiceId);
    expect(res.body.invoices[0].payNowUrl).toBeNull();
    expect(res.body.invoices[0].amountDueCents).toBe(10000);
  });

  it('rolls back the Stripe link when persisting the URL to the invoice fails', async () => {
    const generated: string[] = [];
    const deactivated: string[] = [];
    const provider = {
      async generateLink() {
        const linkId = `plink_test_${generated.length + 1}`;
        generated.push(linkId);
        return {
          linkId,
          linkUrl: `https://checkout.stripe.com/pay/${linkId}`,
          providerReference: `stripe_${linkId}`,
        };
      },
      async deactivateLink(linkId: string) {
        deactivated.push(linkId);
      },
    };

    const failingInvoiceRepo = new InMemoryInvoiceRepository();
    failingInvoiceRepo.update = async () => {
      throw new Error('simulated DB outage');
    };

    const h = await build({ paymentLinkProvider: provider, invoiceRepoOverride: failingInvoiceRepo });
    const token = await mintToken(h);
    await seedJobAndDocs(h);
    const res = await request(h.app).get(`/api/public/portal/${token}/invoices`);

    expect(res.status).toBe(200);
    expect(res.body.invoices[0].payNowUrl).toBeNull();
    expect(generated).toHaveLength(1);
    expect(deactivated).toEqual(generated);
  });

  it('does NOT deactivate when update throws but the invoice actually has the URL persisted (commit-but-response-timeout)', async () => {
    const generated: string[] = [];
    const deactivated: string[] = [];
    const provider = {
      async generateLink() {
        const linkId = 'plink_committed_then_threw';
        generated.push(linkId);
        return {
          linkId,
          linkUrl: `https://checkout.stripe.com/pay/${linkId}`,
          providerReference: `stripe_${linkId}`,
        };
      },
      async deactivateLink(linkId: string) {
        deactivated.push(linkId);
      },
    };

    const repo = new InMemoryInvoiceRepository();
    let updateCalls = 0;
    const originalUpdate = repo.update.bind(repo);
    repo.update = async (tenantId, id, updates) => {
      updateCalls += 1;
      await originalUpdate(tenantId, id, updates);
      throw new Error('response timed out after commit');
    };

    const h = await build({ paymentLinkProvider: provider, invoiceRepoOverride: repo });
    const token = await mintToken(h);
    await seedJobAndDocs(h);
    const res = await request(h.app).get(`/api/public/portal/${token}/invoices`);

    expect(res.status).toBe(200);
    expect(updateCalls).toBe(1);
    expect(res.body.invoices[0].payNowUrl).toContain('plink_committed_then_threw');
    expect(deactivated).toEqual([]);
  });

  it('does NOT deactivate when both update and the re-read throw (DB genuinely degraded)', async () => {
    const generated: string[] = [];
    const deactivated: string[] = [];
    const provider = {
      async generateLink() {
        const linkId = 'plink_db_down';
        generated.push(linkId);
        return {
          linkId,
          linkUrl: `https://checkout.stripe.com/pay/${linkId}`,
          providerReference: `stripe_${linkId}`,
        };
      },
      async deactivateLink(linkId: string) {
        deactivated.push(linkId);
      },
    };

    const repo = new InMemoryInvoiceRepository();
    repo.update = async () => {
      throw new Error('DB write failed');
    };
    repo.findById = async () => {
      throw new Error('DB read also failed');
    };

    const h = await build({ paymentLinkProvider: provider, invoiceRepoOverride: repo });
    const token = await mintToken(h);
    await seedJobAndDocs(h);
    let findByIdCalls = 0;
    repo.findById = async () => {
      findByIdCalls += 1;
      if (findByIdCalls === 1) {
        return null;
      }
      throw new Error('DB read failed during rollback');
    };
    repo.findById = async () => {
      throw new Error('DB read failed during rollback');
    };

    const res = await request(h.app).get(`/api/public/portal/${token}/invoices`);
    expect(res.status).toBe(200);
    expect(res.body.invoices[0].payNowUrl).toBeNull();
    expect(deactivated).toEqual([]);
  });

  it('lists jobs scoped to the customer', async () => {
    const h = await build();
    const token = await mintToken(h);
    const { jobId } = await seedJobAndDocs(h);
    const res = await request(h.app).get(`/api/public/portal/${token}/jobs`);
    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j: { id: string }) => j.id)).toContain(jobId);
  });

  it('does not leak documents from a different customer', async () => {
    const h = await build();
    const token = await mintToken(h);
    const otherCustomer = await h.customerRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      firstName: 'Other',
      lastName: 'Person',
      displayName: 'Other Person',
      preferredChannel: 'none',
      smsConsent: false,
      isArchived: false,
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const otherJob: Job = {
      id: uuidv4(),
      tenantId: TENANT,
      customerId: otherCustomer.id,
      locationId: uuidv4(),
      jobNumber: 'JOB-0099',
      summary: 'Unrelated',
      status: 'new',
      priority: 'normal',
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await h.jobRepo.create(otherJob);
    const otherInvoice: Invoice = {
      id: uuidv4(),
      tenantId: TENANT,
      jobId: otherJob.id,
      invoiceNumber: 'INV-9999',
      status: 'open',
      lineItems: [],
      totals: {
        subtotalCents: 5000,
        discountCents: 0,
        taxableSubtotalCents: 5000,
        taxCents: 0,
        totalCents: 5000,
        taxRateBps: 0,
      },
      amountPaidCents: 0,
      amountDueCents: 5000,
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await h.invoiceRepo.create(otherInvoice);

    const res = await request(h.app).get(`/api/public/portal/${token}/invoices`);
    expect(res.status).toBe(200);
    expect(res.body.invoices.map((i: { invoiceNumber: string }) => i.invoiceNumber)).not.toContain('INV-9999');
  });
});

describe('P10-001 GET /api/public/portal/:token/agreements', () => {
  it('lists agreements for the customer', async () => {
    const h = await build();
    const token = await mintToken(h);
    await h.agreementRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      customerId: h.customer.id,
      name: 'Quarterly tune-up',
      recurrenceRule: 'FREQ=QUARTERLY',
      priceCents: 19900,
      autoGenerateInvoice: false,
      autoGenerateJob: true,
      nextRunAt: new Date(),
      status: 'active',
      startsOn: '2026-06-15',
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await request(h.app).get(`/api/public/portal/${token}/agreements`);
    expect(res.status).toBe(200);
    expect(res.body.agreements).toHaveLength(1);
    expect(res.body.agreements[0].name).toBe('Quarterly tune-up');
  });
});

describe('P10-001 GET /api/public/portal/:token/appointments?upcoming=true', () => {
  it('only returns appointments scheduled in the future', async () => {
    const h = await build();
    const token = await mintToken(h);
    const job: Job = {
      id: uuidv4(),
      tenantId: TENANT,
      customerId: h.customer.id,
      locationId: uuidv4(),
      jobNumber: 'JOB-0002',
      summary: 'Visit',
      status: 'scheduled',
      priority: 'normal',
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await h.jobRepo.create(job);
    const past: Appointment = {
      id: uuidv4(),
      tenantId: TENANT,
      jobId: job.id,
      scheduledStart: new Date(Date.now() - 60_000),
      scheduledEnd: new Date(Date.now() - 30_000),
      timezone: 'UTC',
      status: 'completed',
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const future: Appointment = {
      id: uuidv4(),
      tenantId: TENANT,
      jobId: job.id,
      scheduledStart: new Date(Date.now() + 60_000),
      scheduledEnd: new Date(Date.now() + 120_000),
      timezone: 'UTC',
      status: 'scheduled',
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await h.appointmentRepo.create(past);
    await h.appointmentRepo.create(future);

    const res = await request(h.app).get(
      `/api/public/portal/${token}/appointments?upcoming=true`,
    );
    expect(res.status).toBe(200);
    const ids = res.body.appointments.map((a: { id: string }) => a.id);
    expect(ids).toContain(future.id);
    expect(ids).not.toContain(past.id);
  });
});

describe('P10-001 POST /api/public/portal/:token/request-service', () => {
  it('creates a lead with source=web_form and sourceDetail=Customer Portal', async () => {
    const h = await build();
    const token = await mintToken(h);
    const res = await request(h.app)
      .post(`/api/public/portal/${token}/request-service`)
      .send({ summary: 'Need a quote for a new water heater install.' });
    expect(res.status).toBe(201);
    expect(res.body.leadId).toBeTruthy();

    const leads = h.leadRepo.getAll();
    expect(leads).toHaveLength(1);
    // P12-005: portal leads now use the dedicated 'customer_portal' source
    // instead of the prior `'web_form' + sourceDetail='Customer Portal'`
    // workaround.
    expect(leads[0].source).toBe('customer_portal');
    expect(leads[0].sourceDetail).toBeUndefined();
    expect(leads[0].tenantId).toBe(TENANT);
    // tenantId/customerId in body must be ignored — pinned from req.portal.
    expect(leads[0].notes).toContain('Need a quote');
  });

  it('rejects body that omits required summary', async () => {
    const h = await build();
    const token = await mintToken(h);
    const res = await request(h.app)
      .post(`/api/public/portal/${token}/request-service`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('does NOT honour user-supplied tenantId / customerId in body', async () => {
    const h = await build();
    const token = await mintToken(h);
    const evilTenant = uuidv4();
    const res = await request(h.app)
      .post(`/api/public/portal/${token}/request-service`)
      .send({
        summary: 'evil request',
        tenantId: evilTenant,
        customerId: uuidv4(),
      });
    expect(res.status).toBe(201);
    const leads = h.leadRepo.getAll();
    expect(leads[0].tenantId).toBe(TENANT);
    expect(leads[0].tenantId).not.toBe(evilTenant);
  });
});

describe('P10-001 portal token middleware: rate limiting', () => {
  it('returns 429 after the per-token limit is exhausted', async () => {
    const portalRepo = new InMemoryPortalSessionRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const customer = await customerRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      firstName: 'A',
      lastName: 'B',
      displayName: 'A B',
      preferredChannel: 'none',
      smsConsent: false,
      isArchived: false,
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const estimateRepo = new InMemoryEstimateRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const jobRepo = new InMemoryJobRepository();
    const agreementRepo = new InMemoryAgreementRepository();
    const appointmentRepo = new InMemoryAppointmentRepository();
    const leadRepo = new InMemoryLeadRepository();

    const app = express();
    app.use(express.json());
    app.use(
      '/api/public/portal',
      createPublicPortalRouter({
        portalRepo,
        customerRepo,
        estimateRepo,
        invoiceRepo,
        jobRepo,
        agreementRepo,
        appointmentRepo,
        leadRepo,
        middlewareOptions: { rateLimit: { max: 2, windowMs: 60_000 } },
      }),
    );

    const { createPortalSession } = await import('../../src/portal/portal-service');
    const created = await createPortalSession(TENANT, customer.id, ACTOR, portalRepo);
    const token = created.token;

    const r1 = await request(app).get(`/api/public/portal/${token}/customer`);
    const r2 = await request(app).get(`/api/public/portal/${token}/customer`);
    const r3 = await request(app).get(`/api/public/portal/${token}/customer`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
  });
});

beforeEach(() => {
  // Each test rebuilds its harness; nothing global to reset.
});
