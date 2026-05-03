import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  PublicEstimateService,
  PublicEstimateView,
} from '../../src/estimates/public-estimate-service';
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

const TENANT = 'tenant-test-1';

function makeEstimate(jobId: string, overrides: Partial<Estimate> = {}): Estimate {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    jobId,
    estimateNumber: 'EST-1042',
    status: 'sent',
    lineItems: [
      {
        id: uuidv4(),
        description: 'AC tune-up',
        quantity: 1,
        unitPriceCents: 12500,
        totalCents: 12500,
        sortOrder: 0,
        taxable: true,
      },
    ],
    totals: {
      subtotalCents: 12500,
      taxableSubtotalCents: 12500,
      discountCents: 0,
      taxRateBps: 0,
      taxCents: 0,
      totalCents: 12500,
    },
    viewToken: 'a-very-long-and-unguessable-token-1234',
    sentAt: new Date(),
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface Harness {
  service: PublicEstimateService;
  estimate: InMemoryEstimateRepository;
  customer: InMemoryCustomerRepository;
  job: InMemoryJobRepository;
  settings: InMemorySettingsRepository;
}

async function buildHarness(): Promise<Harness> {
  const estimate = new InMemoryEstimateRepository();
  const customer = new InMemoryCustomerRepository();
  const job = new InMemoryJobRepository();
  const settings = new InMemorySettingsRepository();

  await settings.create({
    id: uuidv4(),
    tenantId: TENANT,
    businessName: 'Acme HVAC',
    businessPhone: '+15551112222',
    businessEmail: 'team@acmehvac.com',
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

  return { service, estimate, customer, job, settings };
}

describe('PublicEstimateService.getByToken', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('returns the public view with business + customer details', async () => {
    const j = (await h.job.findByTenant(TENANT))[0];
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    const view = await h.service.getByToken(est.viewToken!);
    expect(view.estimateNumber).toBe('EST-1042');
    expect(view.customerName).toBe('Sarah Johnson');
    expect(view.businessName).toBe('Acme HVAC');
    expect(view.businessPhone).toBe('+15551112222');
    expect(view.lineItems).toHaveLength(1);
    expect(view.totalCents).toBe(12500);
    expect(view.isActionable).toBe(true);
  });

  it('throws NotFoundError for unknown token', async () => {
    await expect(
      h.service.getByToken('not-a-real-token-just-padding-here')
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects suspiciously short tokens with a 400', async () => {
    await expect(h.service.getByToken('short')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('marks the view expired when viewTokenExpiresAt is in the past', async () => {
    const j = (await h.job.findByTenant(TENANT))[0];
    const est = makeEstimate(j.id, {
      viewTokenExpiresAt: new Date(Date.now() - 60_000),
    });
    await h.estimate.create(est);
    const view = await h.service.getByToken(est.viewToken!);
    expect(view.isExpired).toBe(true);
    expect(view.isActionable).toBe(false);
  });
});

describe('PublicEstimateService.recordView', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('increments viewCount and sets firstViewedAt on first view', async () => {
    const j = (await h.job.findByTenant(TENANT))[0];
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    await h.service.recordView(est.viewToken!, {});
    const persisted = await h.estimate.findById(TENANT, est.id);
    expect(persisted?.viewCount).toBe(1);
    expect(persisted?.firstViewedAt).toBeInstanceOf(Date);

    const before = persisted!.firstViewedAt;
    await h.service.recordView(est.viewToken!, {});
    const after = await h.estimate.findById(TENANT, est.id);
    expect(after?.viewCount).toBe(2);
    expect(after?.firstViewedAt?.getTime()).toBe(before!.getTime());
  });
});

describe('PublicEstimateService.approve', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  async function seedEstimate(overrides: Partial<Estimate> = {}): Promise<Estimate> {
    const j = (await h.job.findByTenant(TENANT))[0];
    const est = makeEstimate(j.id, overrides);
    await h.estimate.create(est);
    return est;
  }

  it('transitions estimate to accepted with metadata', async () => {
    const est = await seedEstimate();
    const view = await h.service.approve({
      token: est.viewToken!,
      acceptedByName: 'Sarah J',
      ip: '203.0.113.5',
      userAgent: 'Mozilla/5.0 test',
    });
    expect(view.status).toBe('accepted');
    expect(view.acceptedByName).toBe('Sarah J');
    expect(view.isActionable).toBe(false);

    const persisted = await h.estimate.findById(TENANT, est.id);
    expect(persisted?.status).toBe('accepted');
    expect(persisted?.acceptedByIp).toBe('203.0.113.5');
    expect(persisted?.acceptedUserAgent).toBe('Mozilla/5.0 test');
    expect(persisted?.acceptedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — second approve returns current view, no error', async () => {
    const est = await seedEstimate();
    const first = await h.service.approve({
      token: est.viewToken!,
      acceptedByName: 'Sarah J',
    });
    const second = await h.service.approve({
      token: est.viewToken!,
      acceptedByName: 'Sarah J again',
    });
    expect(second.status).toBe('accepted');
    // First approval wins — name from first call is what's persisted.
    expect(second.acceptedByName).toBe(first.acceptedByName);
  });

  it('rejects acceptance when the token has expired', async () => {
    const est = await seedEstimate({
      viewTokenExpiresAt: new Date(Date.now() - 60_000),
    });
    await expect(
      h.service.approve({
        token: est.viewToken!,
        acceptedByName: 'Sarah J',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects acceptance when status is rejected', async () => {
    const est = await seedEstimate({ status: 'rejected' });
    await expect(
      h.service.approve({
        token: est.viewToken!,
        acceptedByName: 'Sarah J',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('validates acceptedByName length', async () => {
    const est = await seedEstimate();
    await expect(
      h.service.approve({
        token: est.viewToken!,
        acceptedByName: 'A',
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('PublicEstimateService.decline', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('transitions to rejected with reason and metadata', async () => {
    const j = (await h.job.findByTenant(TENANT))[0];
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    const view = await h.service.decline({
      token: est.viewToken!,
      reason: 'Going with another quote',
    });
    expect(view.status).toBe('rejected');
    expect(view.rejectedReason).toBe('Going with another quote');

    const persisted = await h.estimate.findById(TENANT, est.id);
    expect(persisted?.status).toBe('rejected');
    expect(persisted?.rejectedAt).toBeInstanceOf(Date);
  });

  it('idempotent on double decline', async () => {
    const j = (await h.job.findByTenant(TENANT))[0];
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    const first = await h.service.decline({ token: est.viewToken!, reason: 'first' });
    const second = await h.service.decline({ token: est.viewToken!, reason: 'second' });
    expect(second.status).toBe('rejected');
    // First reason wins.
    expect(second.rejectedReason).toBe(first.rejectedReason);
  });

  it('rejects decline after the estimate was already accepted', async () => {
    const j = (await h.job.findByTenant(TENANT))[0];
    const est = makeEstimate(j.id, { status: 'accepted' });
    await h.estimate.create(est);

    await expect(
      h.service.decline({ token: est.viewToken!, reason: 'oops' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
