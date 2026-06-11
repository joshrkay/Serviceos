/**
 * D2-1d — audit-coverage smoke test for the portal + calendar +
 * public-surface canaries called out in the ticket.
 *
 * We exercise the four canary mutations and assert that an audit row
 * lands in the in-memory repository:
 *
 *   1. POST /api/portal-sessions               → portal_session.created
 *   2. POST /public/estimates/:token/approve   → public_estimate.approved
 *                                                (synthetic public:<hash> actor)
 *   3. POST /public/feedback/:token            → feedback_response.submitted
 *   4. POST /public/invoices/:token/checkout   → public_invoice.checkout_created
 *
 * Each scenario stands up the narrowest possible Express harness so the
 * assertions stay close to the wire — no full app.ts boot.
 */
import { describe, it, expect } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryAuditRepository } from '../../src/audit/audit';

import { createPortalRouter } from '../../src/routes/portal';
import { InMemoryPortalSessionRepository } from '../../src/portal/portal-session';
import { InMemoryCustomerRepository, Customer } from '../../src/customers/customer';

import { createPublicEstimatesRouter } from '../../src/routes/public-estimates';
import { PublicEstimateService } from '../../src/estimates/public-estimate-service';
import {
  Estimate,
  InMemoryEstimateRepository,
} from '../../src/estimates/estimate';
import { InMemoryJobRepository, Job } from '../../src/jobs/job';
import { InMemorySettingsRepository } from '../../src/settings/settings';

import { createPublicFeedbackRouter } from '../../src/routes/public-feedback';
import {
  InMemoryFeedbackRequestRepository,
  createFeedbackRequest,
} from '../../src/feedback/feedback-request';
import { InMemoryFeedbackResponseRepository } from '../../src/feedback/feedback-response';

import { createPublicInvoicesRouter } from '../../src/routes/public-invoices';
import { PublicInvoiceService } from '../../src/invoices/public-invoice-service';
import {
  Invoice,
  InMemoryInvoiceRepository,
} from '../../src/invoices/invoice';

const TENANT = uuidv4();
const ACTOR = 'user-d2-1d-test';

/** Stripe stub returning a single payment_links response. */
function stripeFetchStub(): typeof fetch {
  return (async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'plink_d2_1d', url: 'https://checkout.stripe.com/pay/plink_d2_1d' }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('D2-1d — audit coverage smoke (portal + public surfaces)', () => {
  it('POST /api/portal-sessions writes portal_session.created', async () => {
    const portalRepo = new InMemoryPortalSessionRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const auditRepo = new InMemoryAuditRepository();

    const customer: Customer = {
      id: uuidv4(),
      tenantId: TENANT,
      firstName: 'Audit',
      lastName: 'Canary',
      displayName: 'Audit Canary',
      email: 'audit@example.com',
      primaryPhone: '+15555550100',
      preferredChannel: 'email',
      smsConsent: false,
      isArchived: false,
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await customerRepo.create(customer);

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: ACTOR,
        sessionId: 'sess-d2-1d',
        tenantId: TENANT,
        role: 'owner',
      };
      next();
    });
    app.use(
      '/api/portal-sessions',
      createPortalRouter({ portalRepo, customerRepo, auditRepo }),
    );

    const res = await request(app)
      .post('/api/portal-sessions')
      .send({ customerId: customer.id });
    expect(res.status).toBe(201);

    const events = auditRepo.getAll().filter((e) => e.eventType === 'portal_session.created');
    expect(events).toHaveLength(1);
    expect(events[0].tenantId).toBe(TENANT);
    // Mint is performed by the authenticated operator (not the bearer).
    expect(events[0].actorId).toBe(ACTOR);
    expect(events[0].actorRole).toBe('owner');
    expect((events[0].metadata as Record<string, unknown>).customerId).toBe(customer.id);
  });

  it('POST /public/estimates/:token/approve writes public_estimate.approved with synthetic public:<hash> actor', async () => {
    const estimateRepo = new InMemoryEstimateRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const jobRepo = new InMemoryJobRepository();
    const settingsRepo = new InMemorySettingsRepository();
    const auditRepo = new InMemoryAuditRepository();

    await settingsRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      businessName: 'Acme HVAC',
      timezone: 'America/Los_Angeles',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1000,
      nextInvoiceNumber: 2000,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const customer: Customer = {
      id: uuidv4(),
      tenantId: TENANT,
      firstName: 'Sarah',
      lastName: 'Johnson',
      displayName: 'Sarah Johnson',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await customerRepo.create(customer);

    const job: Job = {
      id: uuidv4(),
      tenantId: TENANT,
      customerId: customer.id,
      locationId: 'loc-1',
      jobNumber: 'JOB-1',
      summary: 'AC tune-up',
      status: 'scheduled',
      priority: 'normal',
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await jobRepo.create(job);

    const token = `tok_${uuidv4().replace(/-/g, '')}${uuidv4().replace(/-/g, '')}`;
    const estimate: Estimate = {
      id: uuidv4(),
      tenantId: TENANT,
      jobId: job.id,
      estimateNumber: 'EST-2042',
      status: 'sent',
      lineItems: [
        {
          id: uuidv4(),
          description: 'Furnace repair',
          quantity: 1,
          unitPriceCents: 45000,
          totalCents: 45000,
          sortOrder: 0,
          taxable: true,
        },
      ],
      totals: {
        subtotalCents: 45000,
        taxableSubtotalCents: 45000,
        discountCents: 0,
        taxRateBps: 0,
        taxCents: 0,
        totalCents: 45000,
      },
      viewToken: token,
      sentAt: new Date(),
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await estimateRepo.create(estimate);

    const service = new PublicEstimateService({
      estimateRepo,
      customerRepo,
      jobRepo,
      settingsRepo,
      auditRepo,
    });

    const app = express();
    app.use(express.json());
    app.use('/public/estimates', createPublicEstimatesRouter(service));

    const res = await request(app)
      .post(`/public/estimates/${token}/approve`)
      .send({ acceptedByName: 'Sarah Johnson' });
    expect(res.status).toBe(200);

    const events = auditRepo.getAll().filter((e) => e.eventType === 'public_estimate.approved');
    expect(events).toHaveLength(1);
    expect(events[0].tenantId).toBe(TENANT);
    // Synthetic actor per the D2-1d contract: public:<sha256(token)[0..12]>.
    expect(events[0].actorId).toMatch(/^public:[0-9a-f]{12}$/);
    expect(events[0].actorRole).toBe('customer');
    expect(events[0].entityType).toBe('estimate');
    expect(events[0].entityId).toBe(estimate.id);
  });

  it('POST /public/feedback/:token writes feedback_response.submitted', async () => {
    const requestRepo = new InMemoryFeedbackRequestRepository();
    const responseRepo = new InMemoryFeedbackResponseRepository();
    const settingsRepo = new InMemorySettingsRepository();
    const auditRepo = new InMemoryAuditRepository();

    const fr = createFeedbackRequest({
      tenantId: TENANT,
      jobId: uuidv4(),
    });
    await requestRepo.create(fr);

    const app = express();
    app.use(express.json());
    app.use(
      '/public/feedback',
      createPublicFeedbackRouter(requestRepo, responseRepo, settingsRepo, auditRepo),
    );

    const res = await request(app)
      .post(`/public/feedback/${fr.token}`)
      .send({ rating: 5, comment: 'Excellent service' });
    expect(res.status).toBe(201);

    const events = auditRepo.getAll().filter((e) => e.eventType === 'feedback_response.submitted');
    expect(events).toHaveLength(1);
    expect(events[0].tenantId).toBe(TENANT);
    expect(events[0].actorId).toMatch(/^public:[0-9a-f]{12}$/);
    expect(events[0].actorRole).toBe('customer');
    expect((events[0].metadata as Record<string, unknown>).rating).toBe(5);
  });

  it('POST /public/invoices/:token/checkout writes public_invoice.checkout_created on first mint', async () => {
    const invoiceRepo = new InMemoryInvoiceRepository();
    const jobRepo = new InMemoryJobRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const settingsRepo = new InMemorySettingsRepository();
    const auditRepo = new InMemoryAuditRepository();

    await settingsRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      businessName: 'Acme HVAC',
      timezone: 'America/Los_Angeles',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const customer: Customer = {
      id: uuidv4(),
      tenantId: TENANT,
      firstName: 'Pat',
      lastName: 'Customer',
      displayName: 'Pat Customer',
      preferredChannel: 'email',
      smsConsent: false,
      isArchived: false,
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await customerRepo.create(customer);

    await jobRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      customerId: customer.id,
      locationId: uuidv4(),
      jobNumber: 'JOB-INV',
      summary: 'Service',
      status: 'completed',
      priority: 'normal',
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const job = (await jobRepo.findByTenant(TENANT))[0];

    const viewToken = `inv_${uuidv4().replace(/-/g, '')}${uuidv4().replace(/-/g, '')}`;
    const invoice: Invoice = {
      id: uuidv4(),
      tenantId: TENANT,
      jobId: job.id,
      invoiceNumber: 'INV-0001',
      status: 'open',
      lineItems: [
        {
          id: uuidv4(),
          description: 'Service',
          quantity: 1,
          unitPriceCents: 50000,
          totalCents: 50000,
          sortOrder: 0,
          taxable: true,
        },
      ],
      totals: {
        subtotalCents: 50000,
        taxableSubtotalCents: 50000,
        discountCents: 0,
        taxRateBps: 0,
        taxCents: 0,
        totalCents: 50000,
      },
      amountPaidCents: 0,
      amountDueCents: 50000,
      viewToken,
      createdBy: ACTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await invoiceRepo.create(invoice);

    const service = new PublicInvoiceService({
      invoiceRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      stripeConfig: { apiKey: 'sk_test_d2_1d' },
      stripeFetch: stripeFetchStub(),
      auditRepo,
    });

    const app = express();
    app.use(express.json());
    app.use('/public/invoices', createPublicInvoicesRouter(service));

    const res = await request(app)
      .post(`/public/invoices/${viewToken}/checkout`)
      .send({});
    expect(res.status).toBe(200);

    const events = auditRepo.getAll().filter((e) => e.eventType === 'public_invoice.checkout_created');
    expect(events).toHaveLength(1);
    expect(events[0].tenantId).toBe(TENANT);
    expect(events[0].actorId).toMatch(/^public:[0-9a-f]{12}$/);
    expect(events[0].actorRole).toBe('customer');
    expect(events[0].entityId).toBe(invoice.id);
    expect((events[0].metadata as Record<string, unknown>).stripePaymentLinkId).toBe('plink_d2_1d');

    // Idempotent re-mint: cached URL path MUST NOT re-emit the event.
    const res2 = await request(app)
      .post(`/public/invoices/${viewToken}/checkout`)
      .send({});
    expect(res2.status).toBe(200);
    const eventsAfter = auditRepo.getAll().filter(
      (e) => e.eventType === 'public_invoice.checkout_created',
    );
    expect(eventsAfter).toHaveLength(1);
  });
});
