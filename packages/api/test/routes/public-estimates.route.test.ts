import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { createPublicEstimatesRouter } from '../../src/routes/public-estimates';
import { PublicEstimateService } from '../../src/estimates/public-estimate-service';
import {
  Estimate,
  InMemoryEstimateRepository,
} from '../../src/estimates/estimate';
import {
  Customer,
  InMemoryCustomerRepository,
} from '../../src/customers/customer';
import {
  Job,
  InMemoryJobRepository,
} from '../../src/jobs/job';
import { InMemorySettingsRepository } from '../../src/settings/settings';

const TENANT = 'tenant-test-2';

interface Harness {
  app: express.Express;
  estimate: InMemoryEstimateRepository;
  job: InMemoryJobRepository;
  customer: InMemoryCustomerRepository;
}

async function build(): Promise<Harness> {
  const estimate = new InMemoryEstimateRepository();
  const customer = new InMemoryCustomerRepository();
  const job = new InMemoryJobRepository();
  const settings = new InMemorySettingsRepository();

  await settings.create({
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

  const c: Customer = {
    id: uuidv4(),
    tenantId: TENANT,
    firstName: 'Sarah',
    lastName: 'Johnson',
    displayName: 'Sarah Johnson',
    primaryPhone: '+15555550199',
    email: 'sarah@example.com',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await customer.create(c);

  const j: Job = {
    id: uuidv4(),
    tenantId: TENANT,
    customerId: c.id,
    locationId: 'loc-1',
    jobNumber: 'JOB-0001',
    summary: 'AC tune-up',
    status: 'scheduled',
    priority: 'normal',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await job.create(j);

  const service = new PublicEstimateService({
    estimateRepo: estimate,
    customerRepo: customer,
    jobRepo: job,
    settingsRepo: settings,
  });

  const app = express();
  app.use(express.json());
  app.use('/public/estimates', createPublicEstimatesRouter(service));

  return { app, estimate, job, customer };
}

async function seedEstimate(
  h: Harness,
  overrides: Partial<Estimate> = {}
): Promise<Estimate> {
  const j = (await h.job.findByTenant(TENANT))[0];
  const est: Estimate = {
    id: uuidv4(),
    tenantId: TENANT,
    jobId: j.id,
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
    viewToken: `tok_${uuidv4().replace(/-/g, '')}`,
    sentAt: new Date(),
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  await h.estimate.create(est);
  return est;
}

describe('GET /public/estimates/:token', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await build();
  });

  it('returns 200 with the public view', async () => {
    const est = await seedEstimate(h);
    const res = await request(h.app).get(`/public/estimates/${est.viewToken}`);
    expect(res.status).toBe(200);
    expect(res.body.estimateNumber).toBe('EST-2042');
    expect(res.body.businessName).toBe('Acme HVAC');
    expect(res.body.totalCents).toBe(45000);
    expect(res.body.isActionable).toBe(true);
  });

  it('returns 404 for unknown token', async () => {
    const res = await request(h.app).get('/public/estimates/no-such-token-1234567');
    expect(res.status).toBe(404);
  });

  it('returns 400 for short tokens', async () => {
    const res = await request(h.app).get('/public/estimates/short');
    expect(res.status).toBe(400);
  });
});

describe('POST /public/estimates/:token/view', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await build();
  });

  it('records the view and increments count', async () => {
    const est = await seedEstimate(h);
    const res = await request(h.app)
      .post(`/public/estimates/${est.viewToken}/view`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.recorded).toBe(true);

    const persisted = await h.estimate.findById(TENANT, est.id);
    expect(persisted?.viewCount).toBe(1);
  });
});

describe('POST /public/estimates/:token/approve', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await build();
  });

  it('approves the estimate and returns the updated view', async () => {
    const est = await seedEstimate(h);
    const res = await request(h.app)
      .post(`/public/estimates/${est.viewToken}/approve`)
      .set('User-Agent', 'PublicEstimateTestRunner/1.0')
      .send({ acceptedByName: 'Sarah Johnson' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(res.body.acceptedByName).toBe('Sarah Johnson');
    expect(res.body.isActionable).toBe(false);

    const persisted = await h.estimate.findById(TENANT, est.id);
    expect(persisted?.status).toBe('accepted');
    expect(persisted?.acceptedUserAgent).toBe('PublicEstimateTestRunner/1.0');
  });

  it('returns 400 when acceptedByName is missing or too short', async () => {
    const est = await seedEstimate(h);
    const res = await request(h.app)
      .post(`/public/estimates/${est.viewToken}/approve`)
      .send({ acceptedByName: 'A' });
    expect(res.status).toBe(400);
  });

  it('returns 409 when the estimate was already declined', async () => {
    const est = await seedEstimate(h, { status: 'rejected' });
    const res = await request(h.app)
      .post(`/public/estimates/${est.viewToken}/approve`)
      .send({ acceptedByName: 'Sarah Johnson' });
    expect(res.status).toBe(409);
  });

  it('returns 409 when the token is expired', async () => {
    const est = await seedEstimate(h, {
      viewTokenExpiresAt: new Date(Date.now() - 60_000),
    });
    const res = await request(h.app)
      .post(`/public/estimates/${est.viewToken}/approve`)
      .send({ acceptedByName: 'Sarah Johnson' });
    expect(res.status).toBe(409);
  });

  it('rejects oversized signature payload', async () => {
    const est = await seedEstimate(h);
    const huge = 'x'.repeat(200_001);
    const res = await request(h.app)
      .post(`/public/estimates/${est.viewToken}/approve`)
      .send({ acceptedByName: 'Sarah Johnson', signatureData: huge });
    // Either express's body-size cap (413) or zod's max (400) — both are
    // valid. The point is the request does NOT succeed.
    expect([400, 413]).toContain(res.status);
  });
});

describe('POST /public/estimates/:token/decline', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await build();
  });

  it('declines with optional reason', async () => {
    const est = await seedEstimate(h);
    const res = await request(h.app)
      .post(`/public/estimates/${est.viewToken}/decline`)
      .send({ reason: 'Got a cheaper quote' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.rejectedReason).toBe('Got a cheaper quote');
  });

  it('declines without a reason', async () => {
    const est = await seedEstimate(h);
    const res = await request(h.app)
      .post(`/public/estimates/${est.viewToken}/decline`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.rejectedReason).toBeUndefined();
  });
});
