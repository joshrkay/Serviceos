import { describe, it, expect, beforeEach, vi } from 'vitest';
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

function jsonOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

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
    version: 1,
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
    jobNumber: 'JOB-001',
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

  it('surfaces version on the public view', async () => {
    const est = await seedEstimate({ version: 3 });
    const view = await h.service.getByToken(est.viewToken!);
    expect(view.version).toBe(3);
  });

  it('rejects a stale accept when expectedVersion no longer matches', async () => {
    const est = await seedEstimate({ version: 2 });
    await expect(
      h.service.approve({
        token: est.viewToken!,
        acceptedByName: 'Sarah J',
        expectedVersion: 1,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('accepts when expectedVersion matches the current version', async () => {
    const est = await seedEstimate({ version: 2 });
    const view = await h.service.approve({
      token: est.viewToken!,
      acceptedByName: 'Sarah J',
      expectedVersion: 2,
    });
    expect(view.status).toBe('accepted');
  });

  it('requires expectedVersion once an estimate has been revised', async () => {
    const est = await seedEstimate({ version: 2, lastRevisedAt: new Date() });
    await expect(
      h.service.approve({ token: est.viewToken!, acceptedByName: 'Sarah J' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('still accepts a never-revised (v1) estimate without expectedVersion', async () => {
    const est = await seedEstimate({ version: 1 });
    const view = await h.service.approve({ token: est.viewToken!, acceptedByName: 'Sarah J' });
    expect(view.status).toBe('accepted');
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

describe('PublicEstimateService.approve — Tier 4 deposit hook (PR 2)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  async function seedEstimateWithTotal(totalCents: number): Promise<Estimate> {
    const j = (await h.job.findByTenant(TENANT))[0];
    const est = makeEstimate(j.id, {
      totals: {
        subtotalCents: totalCents,
        taxableSubtotalCents: totalCents,
        discountCents: 0,
        taxRateBps: 0,
        taxCents: 0,
        totalCents,
      },
      lineItems: [
        {
          id: uuidv4(),
          description: 'Service',
          quantity: 1,
          unitPriceCents: totalCents,
          totalCents,
          sortOrder: 0,
          taxable: true,
        },
      ],
    });
    await h.estimate.create(est);
    return est;
  }

  it('writes the computed deposit onto the linked job for a percentage rule', async () => {
    await h.settings.update(TENANT, {
      depositStrategy: 'percentage',
      depositPercentageBps: 2500, // 25%
    });
    const est = await seedEstimateWithTotal(100000); // $1,000
    await h.service.approve({
      token: est.viewToken!,
      acceptedByName: 'Sarah J',
      ip: '203.0.113.5',
      userAgent: 'test',
    });
    const job = (await h.job.findByTenant(TENANT))[0];
    expect(job.depositRequiredCents).toBe(25000); // $250 = 25% of $1000
    expect(job.depositPaidCents).toBe(0);
    expect(job.depositStatus).toBe('pending');
  });

  it('writes the computed deposit for a fixed-amount rule', async () => {
    await h.settings.update(TENANT, {
      depositStrategy: 'fixed',
      depositFixedCents: 50000, // $500
    });
    const est = await seedEstimateWithTotal(100000);
    await h.service.approve({
      token: est.viewToken!,
      acceptedByName: 'Sarah J',
      ip: '203.0.113.5',
      userAgent: 'test',
    });
    const job = (await h.job.findByTenant(TENANT))[0];
    expect(job.depositRequiredCents).toBe(50000);
    expect(job.depositStatus).toBe('pending');
  });

  it('leaves the job at default deposit (0) when no rule is configured', async () => {
    const est = await seedEstimateWithTotal(100000);
    await h.service.approve({
      token: est.viewToken!,
      acceptedByName: 'Sarah J',
      ip: '203.0.113.5',
      userAgent: 'test',
    });
    const job = (await h.job.findByTenant(TENANT))[0];
    expect(job.depositRequiredCents ?? 0).toBe(0);
    // Status defaults to 'not_required' (or undefined for legacy rows).
    expect(job.depositStatus ?? 'not_required').toBe('not_required');
  });

  it('skips the deposit write when total is below the threshold', async () => {
    await h.settings.update(TENANT, {
      depositStrategy: 'percentage',
      depositPercentageBps: 2500,
      depositRequiredAboveCents: 200000, // $2,000 threshold
    });
    const est = await seedEstimateWithTotal(100000); // below threshold
    await h.service.approve({
      token: est.viewToken!,
      acceptedByName: 'Sarah J',
      ip: '203.0.113.5',
      userAgent: 'test',
    });
    const job = (await h.job.findByTenant(TENANT))[0];
    expect(job.depositRequiredCents ?? 0).toBe(0);
  });

  it('does not block approval if the deposit hook throws', async () => {
    // Force jobRepo.update to throw — approval must still succeed.
    const originalUpdate = h.job.update.bind(h.job);
    h.job.update = async () => {
      throw new Error('simulated DB outage');
    };
    await h.settings.update(TENANT, {
      depositStrategy: 'percentage',
      depositPercentageBps: 2500,
    });
    const est = await seedEstimateWithTotal(100000);

    const view = await h.service.approve({
      token: est.viewToken!,
      acceptedByName: 'Sarah J',
      ip: '203.0.113.5',
      userAgent: 'test',
    });
    expect(view.status).toBe('accepted');
    h.job.update = originalUpdate;
  });

  it('PR 3a — surfaces the deposit context on the public view after approval', async () => {
    await h.settings.update(TENANT, {
      depositStrategy: 'percentage',
      depositPercentageBps: 2500,
    });
    const est = await seedEstimateWithTotal(100000);
    const view = await h.service.approve({
      token: est.viewToken!,
      acceptedByName: 'Sarah J',
      ip: '203.0.113.5',
      userAgent: 'test',
    });
    expect(view.depositRequiredCents).toBe(25000);
    expect(view.depositPaidCents).toBe(0);
    expect(view.depositStatus).toBe('pending');
  });

  it('PR 3a — surfaces zero deposit on a getByToken view when no rule applies', async () => {
    const est = await seedEstimateWithTotal(100000);
    const view = await h.service.getByToken(est.viewToken!);
    expect(view.depositRequiredCents).toBe(0);
    expect(view.depositPaidCents).toBe(0);
    expect(view.depositStatus).toBe('not_required');
  });
});

describe('PublicEstimateService — Tier 4 deposit (PR 3b: before_approval gate + Stripe link)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  async function seedEstimateWithTotal(totalCents: number): Promise<Estimate> {
    const j = (await h.job.findByTenant(TENANT))[0];
    const est = makeEstimate(j.id, {
      totals: {
        subtotalCents: totalCents,
        taxableSubtotalCents: totalCents,
        discountCents: 0,
        taxRateBps: 0,
        taxCents: 0,
        totalCents,
      },
      lineItems: [
        {
          id: uuidv4(),
          description: 'Service',
          quantity: 1,
          unitPriceCents: totalCents,
          totalCents,
          sortOrder: 0,
          taxable: true,
        },
      ],
    });
    await h.estimate.create(est);
    return est;
  }

  it('surfaces depositTimingPolicy and computed required on getByToken for before_approval', async () => {
    await h.settings.update(TENANT, {
      depositStrategy: 'percentage',
      depositPercentageBps: 2500,
      depositTimingPolicy: 'before_approval',
    });
    const est = await seedEstimateWithTotal(100000);

    const view = await h.service.getByToken(est.viewToken!);
    expect(view.depositTimingPolicy).toBe('before_approval');
    expect(view.depositRequiredCents).toBe(25000);
    expect(view.depositStatus).toBe('pending');
    // Approve gate: page should disable Approve.
    expect(view.isActionable).toBe(false);
  });

  it('blocks approve() when before_approval and deposit unpaid', async () => {
    await h.settings.update(TENANT, {
      depositStrategy: 'percentage',
      depositPercentageBps: 2500,
      depositTimingPolicy: 'before_approval',
    });
    const est = await seedEstimateWithTotal(100000);
    await expect(
      h.service.approve({
        token: est.viewToken!,
        acceptedByName: 'Sarah J',
        ip: '203.0.113.5',
        userAgent: 'test',
      }),
    ).rejects.toThrow(/Deposit must be paid/);
  });

  it('allows approve() once the deposit has been paid (before_approval)', async () => {
    await h.settings.update(TENANT, {
      depositStrategy: 'percentage',
      depositPercentageBps: 2500,
      depositTimingPolicy: 'before_approval',
    });
    const est = await seedEstimateWithTotal(100000);
    // Simulate a paid deposit on the linked job.
    const j = (await h.job.findByTenant(TENANT))[0];
    await h.job.update(TENANT, j.id, {
      depositRequiredCents: 25000,
      depositPaidCents: 25000,
      depositStatus: 'paid',
    });

    const view = await h.service.approve({
      token: est.viewToken!,
      acceptedByName: 'Sarah J',
      ip: '203.0.113.5',
      userAgent: 'test',
    });
    expect(view.status).toBe('accepted');
    const after = (await h.job.findByTenant(TENANT))[0];
    expect(after.depositPaidCents).toBe(25000);
    expect(after.depositStatus).toBe('paid');
  });

  it('after_approval policy permits approve before any deposit is paid', async () => {
    await h.settings.update(TENANT, {
      depositStrategy: 'percentage',
      depositPercentageBps: 2500,
      depositTimingPolicy: 'after_approval',
    });
    const est = await seedEstimateWithTotal(100000);
    const view = await h.service.approve({
      token: est.viewToken!,
      acceptedByName: 'Sarah J',
      ip: '203.0.113.5',
      userAgent: 'test',
    });
    expect(view.status).toBe('accepted');
    expect(view.depositRequiredCents).toBe(25000);
    expect(view.depositStatus).toBe('pending');
  });

  it('mints a Stripe Payment Link on getOrCreateDepositCheckoutUrl and persists it', async () => {
    await h.settings.update(TENANT, {
      depositStrategy: 'percentage',
      depositPercentageBps: 2500,
      depositTimingPolicy: 'before_approval',
    });
    const est = await seedEstimateWithTotal(100000);

    const stripeFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonOk({ id: 'plink_test_123', url: 'https://checkout.stripe.com/c/plink_test_123' }),
    );
    const service = new PublicEstimateService({
      estimateRepo: h.estimate,
      customerRepo: h.customer,
      jobRepo: h.job,
      settingsRepo: h.settings,
      stripeConfig: { apiKey: 'sk_test_xxx' },
      stripeFetch: stripeFetch as unknown as typeof fetch,
    });

    const result = await service.getOrCreateDepositCheckoutUrl(est.viewToken!);
    expect(result.url).toBe('https://checkout.stripe.com/c/plink_test_123');
    expect(stripeFetch).toHaveBeenCalledTimes(1);
    const callBody = stripeFetch.mock.calls[0][1] as RequestInit;
    const params = new URLSearchParams(callBody.body as string);
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe('25000');
    expect(params.get('metadata[deposit_for_job_id]')).toBeTruthy();

    const job = (await h.job.findByTenant(TENANT))[0];
    expect(job.depositStripePaymentLinkId).toBe('plink_test_123');
    expect(job.depositStripePaymentLinkUrl).toBe(
      'https://checkout.stripe.com/c/plink_test_123',
    );
    // Required is now locked onto the job from the rule eval.
    expect(job.depositRequiredCents).toBe(25000);
  });

  it('returns the existing link on a second call (idempotent mint)', async () => {
    await h.settings.update(TENANT, {
      depositStrategy: 'fixed',
      depositFixedCents: 50000,
      depositTimingPolicy: 'before_approval',
    });
    const est = await seedEstimateWithTotal(100000);
    const stripeFetch = vi.fn(async () =>
      jsonOk({ id: 'plink_a', url: 'https://checkout.stripe.com/c/plink_a' }),
    );
    const service = new PublicEstimateService({
      estimateRepo: h.estimate,
      customerRepo: h.customer,
      jobRepo: h.job,
      settingsRepo: h.settings,
      stripeConfig: { apiKey: 'sk_test_xxx' },
      stripeFetch: stripeFetch as unknown as typeof fetch,
    });
    await service.getOrCreateDepositCheckoutUrl(est.viewToken!);
    await service.getOrCreateDepositCheckoutUrl(est.viewToken!);
    expect(stripeFetch).toHaveBeenCalledTimes(1); // second call hits the cache
  });

  it('rejects mint when no deposit is required', async () => {
    const est = await seedEstimateWithTotal(100000);
    const stripeFetch = vi.fn(async () => jsonOk({ id: 'x', url: 'x' }));
    const service = new PublicEstimateService({
      estimateRepo: h.estimate,
      customerRepo: h.customer,
      jobRepo: h.job,
      settingsRepo: h.settings,
      stripeConfig: { apiKey: 'sk_test_xxx' },
      stripeFetch: stripeFetch as unknown as typeof fetch,
    });
    await expect(service.getOrCreateDepositCheckoutUrl(est.viewToken!)).rejects.toThrow(
      /No deposit is required/,
    );
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it('rejects mint when the deposit has already been paid in full', async () => {
    await h.settings.update(TENANT, {
      depositStrategy: 'fixed',
      depositFixedCents: 50000,
    });
    const est = await seedEstimateWithTotal(100000);
    const j = (await h.job.findByTenant(TENANT))[0];
    await h.job.update(TENANT, j.id, {
      depositRequiredCents: 50000,
      depositPaidCents: 50000,
      depositStatus: 'paid',
    });
    const service = new PublicEstimateService({
      estimateRepo: h.estimate,
      customerRepo: h.customer,
      jobRepo: h.job,
      settingsRepo: h.settings,
      stripeConfig: { apiKey: 'sk_test_xxx' },
      stripeFetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(service.getOrCreateDepositCheckoutUrl(est.viewToken!)).rejects.toThrow(
      /already been paid/,
    );
  });

  it('rejects mint when Stripe is not configured', async () => {
    await h.settings.update(TENANT, {
      depositStrategy: 'percentage',
      depositPercentageBps: 2500,
      depositTimingPolicy: 'before_approval',
    });
    const est = await seedEstimateWithTotal(100000);
    // Default harness has no stripeConfig — service must surface a clean
    // ValidationError rather than crashing on a missing apiKey.
    await expect(h.service.getOrCreateDepositCheckoutUrl(est.viewToken!)).rejects.toThrow(
      /not configured/,
    );
  });
});

describe('PublicEstimateService — good-better-best selection', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  function tieredEstimate(jobId: string): Estimate {
    return makeEstimate(jobId, {
      lineItems: [
        { id: 'base', description: 'Diagnostic', quantity: 1, unitPriceCents: 5000, totalCents: 5000, sortOrder: 0, taxable: true },
        { id: 'good', description: 'Good', quantity: 1, unitPriceCents: 10000, totalCents: 10000, sortOrder: 1, taxable: true, groupKey: 'tier', groupLabel: 'Plan', isOptional: true, isDefaultSelected: true },
        { id: 'better', description: 'Better', quantity: 1, unitPriceCents: 20000, totalCents: 20000, sortOrder: 2, taxable: true, groupKey: 'tier', groupLabel: 'Plan', isOptional: true },
      ],
    });
  }

  it('surfaces selectable items and ids in the view', async () => {
    const j = (await h.job.findByTenant(TENANT))[0];
    const est = tieredEstimate(j.id);
    await h.estimate.create(est);
    const view = await h.service.getByToken(est.viewToken!);
    expect(view.hasSelectableItems).toBe(true);
    expect(view.lineItems.map((li) => li.id)).toContain('better');
  });

  it('requires a selection and recomputes the accepted total from it', async () => {
    const j = (await h.job.findByTenant(TENANT))[0];
    const est = tieredEstimate(j.id);
    await h.estimate.create(est);

    // Missing selection -> rejected.
    await expect(
      h.service.approve({ token: est.viewToken!, acceptedByName: 'Sarah' }),
    ).rejects.toThrow(/selection is required/i);

    // Multiple tier options -> rejected.
    await expect(
      h.service.approve({ token: est.viewToken!, acceptedByName: 'Sarah', selectedLineItemIds: ['good', 'better'] }),
    ).rejects.toThrow(/exactly one/i);

    // Valid selection: base always billed + chosen tier.
    const view = await h.service.approve({
      token: est.viewToken!,
      acceptedByName: 'Sarah',
      selectedLineItemIds: ['better'],
    });
    expect(view.status).toBe('accepted');
    expect(view.totalCents).toBe(25000); // 5000 + 20000

    const stored = await h.estimate.findById(TENANT, est.id);
    expect(stored?.acceptedSelection?.sort()).toEqual(['base', 'better']);
  });
});

describe('PublicEstimateService — validity expiry precedence', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('expires (and refuses) a sent estimate past valid_until on decline', async () => {
    const j = (await h.job.findByTenant(TENANT))[0];
    const est = makeEstimate(j.id, { validUntil: new Date(Date.now() - 60_000) });
    await h.estimate.create(est);

    await expect(
      h.service.decline({ token: est.viewToken! }),
    ).rejects.toThrow(/expired/i);

    const stored = await h.estimate.findById(TENANT, est.id);
    expect(stored?.status).toBe('expired');
  });
});

describe('PublicEstimateService — one accepted estimate per job', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('refuses to accept when another estimate on the job is already accepted', async () => {
    const j = (await h.job.findByTenant(TENANT))[0];
    // First estimate already accepted on this job.
    await h.estimate.create(makeEstimate(j.id, { status: 'accepted', estimateNumber: 'EST-A', viewToken: 'token-accepted-aaaaaaaaaaaa' }));
    // Second, still-sent estimate on the SAME job.
    const second = makeEstimate(j.id, { estimateNumber: 'EST-B', viewToken: 'token-second-bbbbbbbbbbbbbb' });
    await h.estimate.create(second);

    await expect(
      h.service.approve({ token: second.viewToken!, acceptedByName: 'Sarah' }),
    ).rejects.toThrow(/already been accepted/i);
  });

  it('allows acceptance when the job has no other accepted estimate', async () => {
    const j = (await h.job.findByTenant(TENANT))[0];
    const only = makeEstimate(j.id, { estimateNumber: 'EST-ONLY', viewToken: 'token-only-cccccccccccccc' });
    await h.estimate.create(only);
    const view = await h.service.approve({ token: only.viewToken!, acceptedByName: 'Sarah' });
    expect(view.status).toBe('accepted');
  });
});

describe('PublicEstimateService — accepted view narrows to selection', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('shows only the billed rows (and no picker) after a tiered approval', async () => {
    const j = (await h.job.findByTenant(TENANT))[0];
    const token = 'token-tier-view-dddddddddddd';
    const est = makeEstimate(j.id, {
      viewToken: token,
      lineItems: [
        { id: 'base', description: 'Diagnostic', quantity: 1, unitPriceCents: 5000, totalCents: 5000, sortOrder: 0, taxable: true },
        { id: 'good', description: 'Good', quantity: 1, unitPriceCents: 10000, totalCents: 10000, sortOrder: 1, taxable: true, groupKey: 'tier', groupLabel: 'Plan', isOptional: true, isDefaultSelected: true },
        { id: 'better', description: 'Better', quantity: 1, unitPriceCents: 20000, totalCents: 20000, sortOrder: 2, taxable: true, groupKey: 'tier', groupLabel: 'Plan', isOptional: true },
      ],
    });
    await h.estimate.create(est);

    await h.service.approve({ token, acceptedByName: 'Sarah', selectedLineItemIds: ['better'] });
    const view = await h.service.getByToken(token);

    expect(view.status).toBe('accepted');
    expect(view.hasSelectableItems).toBe(false);
    expect(view.lineItems.map((li) => li.description).sort()).toEqual(['Better', 'Diagnostic']);
    expect(view.totalCents).toBe(25000);
  });
});
