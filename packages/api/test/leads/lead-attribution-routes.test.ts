/**
 * Route-level integration test for source attribution propagation.
 *
 * Uses real `createTenantOwnership` (not the permissive stub) so the
 * jobs route reads the customer row via `requireExistsAndLoad` and the
 * invoices route reads the job row the same way — proving:
 *
 *   1. POST /api/jobs auto-inherits originatingLeadId from the customer
 *      WITHOUT a second findById round-trip.
 *   2. POST /api/invoices auto-inherits originatingLeadId from the job
 *      WITHOUT a second findById round-trip.
 *   3. Explicit body override on POST /api/jobs is validated for tenant
 *      ownership against the lead repo.
 *
 * The "no second round-trip" assertion is enforced by wrapping the
 * customer/job repos in a counting proxy that tallies findById calls.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { Express, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createJobRouter } from '../../src/routes/jobs';
import { createInvoiceRouter } from '../../src/routes/invoices';
import {
  InMemoryCustomerRepository,
  Customer,
} from '../../src/customers/customer';
import {
  InMemoryJobRepository,
  Job,
  JobRepository,
} from '../../src/jobs/job';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import { InMemoryJobTimelineRepository } from '../../src/jobs/job-lifecycle';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { InMemoryQueue } from '../../src/queues/queue';
import { NoopFeedbackDispatcher } from '../../src/feedback/dispatcher';
import { createTenantOwnership } from '../../src/shared/tenant-ownership';

const TENANT = 'tenant-attr-1';
const USER = 'user-attr-1';

interface Counters {
  customerFindById: number;
  jobFindById: number;
}

function buildApp(): { app: Express; counters: Counters; repos: {
  customerRepo: InMemoryCustomerRepository;
  jobRepo: InMemoryJobRepository;
  invoiceRepo: InMemoryInvoiceRepository;
  leadRepo: InMemoryLeadRepository;
  locationRepo: InMemoryLocationRepository;
  settingsRepo: InMemorySettingsRepository;
}; } {
  const counters: Counters = { customerFindById: 0, jobFindById: 0 };

  const customerRepo = new InMemoryCustomerRepository();
  const jobRepo = new InMemoryJobRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const locationRepo = new InMemoryLocationRepository();
  const leadRepo = new InMemoryLeadRepository();
  const timelineRepo = new InMemoryJobTimelineRepository();
  const auditRepo = new InMemoryAuditRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const paymentRepo = new InMemoryPaymentRepository();

  // Wrap findById on customer + job to count calls. Proves the routes
  // do not refetch the row after `requireExistsAndLoad`.
  const realCustomerFindById = customerRepo.findById.bind(customerRepo);
  customerRepo.findById = async (...args) => {
    counters.customerFindById++;
    return realCustomerFindById(...args);
  };
  const realJobFindById = jobRepo.findById.bind(jobRepo);
  (jobRepo as JobRepository).findById = async (...args) => {
    counters.jobFindById++;
    return realJobFindById(...args);
  };

  const ownership = createTenantOwnership({
    customerRepo,
    locationRepo,
    jobRepo,
    estimateRepo,
    invoiceRepo,
    appointmentRepo,
    leadRepo,
  });

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER,
      sessionId: 'session-attr',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/jobs',
    createJobRouter(jobRepo, timelineRepo, auditRepo, ownership, new InMemoryQueue(), new NoopFeedbackDispatcher())
  );
  app.use(
    '/api/invoices',
    createInvoiceRouter(invoiceRepo, settingsRepo, auditRepo, ownership, paymentRepo)
  );

  return {
    app,
    counters,
    repos: { customerRepo, jobRepo, invoiceRepo, leadRepo, locationRepo, settingsRepo },
  };
}

async function seedSettings(repo: InMemorySettingsRepository): Promise<void> {
  await repo.create({
    id: `settings-${TENANT}`,
    tenantId: TENANT,
    businessName: 'Test',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedCustomerWithLead(
  customerRepo: InMemoryCustomerRepository,
  leadRepo: InMemoryLeadRepository,
  utmCampaign: string,
): Promise<{ customer: Customer; leadId: string }> {
  const leadId = '00000000-0000-4000-8000-00000000aaaa';
  await leadRepo.create({
    id: leadId,
    tenantId: TENANT,
    firstName: 'Sandra',
    lastName: 'Wu',
    source: 'web_form',
    utmCampaign,
    stage: 'won',
    createdBy: 'public_intake',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const customer = await customerRepo.create({
    id: 'cust-1',
    tenantId: TENANT,
    firstName: 'Sandra',
    lastName: 'Wu',
    displayName: 'Sandra Wu',
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    originatingLeadId: leadId,
    createdBy: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { customer, leadId };
}

describe('attribution propagation through API routes', () => {
  let setup: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    setup = buildApp();
    await seedSettings(setup.repos.settingsRepo);
    await setup.repos.locationRepo.create({
      id: 'loc-1',
      tenantId: TENANT,
      customerId: 'cust-1',
      street1: '4821 Burnet Rd',
      city: 'Austin',
      state: 'TX',
      postalCode: '78756',
      country: 'US',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('POST /api/jobs inherits originatingLeadId from customer with a single findById', async () => {
    const { customer, leadId } = await seedCustomerWithLead(
      setup.repos.customerRepo,
      setup.repos.leadRepo,
      'spring_promo',
    );
    setup.counters.customerFindById = 0;

    const res = await request(setup.app)
      .post('/api/jobs')
      .send({
        customerId: customer.id,
        locationId: 'loc-1',
        summary: 'Replace AC',
      });

    expect(res.status).toBe(201);
    expect(res.body.originatingLeadId).toBe(leadId);
    // Exactly one customer fetch — proves we did NOT round-trip twice.
    expect(setup.counters.customerFindById).toBe(1);
  });

  it('POST /api/invoices inherits originatingLeadId from job with a single findById', async () => {
    const { customer, leadId } = await seedCustomerWithLead(
      setup.repos.customerRepo,
      setup.repos.leadRepo,
      'spring_promo',
    );
    const job: Job = await setup.repos.jobRepo.create({
      id: 'job-1',
      tenantId: TENANT,
      customerId: customer.id,
      locationId: 'loc-1',
      jobNumber: 'JOB-0001',
      summary: 'AC',
      status: 'new',
      priority: 'normal',
      originatingLeadId: leadId,
      createdBy: USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    setup.counters.jobFindById = 0;

    const res = await request(setup.app)
      .post('/api/invoices')
      .send({
        jobId: job.id,
        lineItems: [
          {
            id: 'li-1',
            description: 'AC unit',
            category: 'equipment',
            quantity: 1,
            unitPriceCents: 250000,
            totalCents: 250000,
            sortOrder: 0,
            taxable: true,
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.originatingLeadId).toBe(leadId);
    // One job lookup, not two.
    expect(setup.counters.jobFindById).toBe(1);
  });

  it('POST /api/jobs with explicit originatingLeadId override validates tenant ownership of the lead', async () => {
    const { customer } = await seedCustomerWithLead(
      setup.repos.customerRepo,
      setup.repos.leadRepo,
      'spring_promo',
    );
    const fakeLeadId = '00000000-0000-4000-8000-0000000000ff';

    const res = await request(setup.app)
      .post('/api/jobs')
      .send({
        customerId: customer.id,
        locationId: 'loc-1',
        summary: 'Replace AC',
        originatingLeadId: fakeLeadId,
      });

    expect(res.status).toBe(404);
  });
});
