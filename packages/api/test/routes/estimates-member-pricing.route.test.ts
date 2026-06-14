import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, TestApp, TEST_TENANT_ID, TEST_USER_ID } from './test-app';
import { createJob } from '../../src/jobs/job';
import { createAgreement } from '../../src/agreements/agreement-service';

/**
 * POST /api/estimates — membership member pricing (#6 phase 2).
 *
 * A new estimate for a customer with an active discounting membership has that
 * discount folded into the estimate's discount, additive to any manual one.
 * Resolved server-side from the job's customer (never trusts the client).
 */
const LINE_ITEMS = [
  { id: 'li-1', description: 'AC tune-up', quantity: 1, unitPriceCents: 20_000, totalCents: 20_000, sortOrder: 0, taxable: true },
  { id: 'li-2', description: 'Filter', quantity: 2, unitPriceCents: 2_500, totalCents: 5_000, sortOrder: 1, taxable: true },
];
const SUBTOTAL = 25_000;

describe('POST /api/estimates — member pricing', () => {
  let h: TestApp;

  beforeEach(async () => {
    h = await buildTestApp();
  });

  async function seedJob(customerId: string): Promise<string> {
    const job = await createJob(
      {
        tenantId: TEST_TENANT_ID,
        customerId,
        locationId: 'loc-1',
        summary: 'Service call',
        createdBy: TEST_USER_ID,
      },
      h.jobRepo,
      h.auditRepo,
    );
    return job.id;
  }

  async function seedMembership(customerId: string, memberDiscountBps: number): Promise<void> {
    await createAgreement(
      {
        tenantId: TEST_TENANT_ID,
        customerId,
        name: 'Gold membership',
        recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        priceCents: 1_500,
        startsOn: '2020-01-01',
        memberDiscountBps,
        createdBy: TEST_USER_ID,
      },
      h.agreementRepo,
    );
  }

  it('folds a member discount into a new estimate (10% of subtotal)', async () => {
    const customerId = 'cust-member';
    await seedMembership(customerId, 1_000); // 10%
    const jobId = await seedJob(customerId);

    const res = await request(h.app)
      .post('/api/estimates')
      .send({ jobId, lineItems: LINE_ITEMS, taxRateBps: 0 });

    expect(res.status).toBe(201);
    expect(res.body.totals.discountCents).toBe(2_500); // 10% of 25,000
    expect(res.body.totals.totalCents).toBe(SUBTOTAL - 2_500);

    // Provenance recorded distinctly from a manual discount.
    const events = await h.auditRepo.findByEntity(TEST_TENANT_ID, 'estimate', res.body.id);
    const applied = events.find((e) => e.eventType === 'estimate.member_discount_applied');
    expect(applied?.metadata).toMatchObject({ memberDiscountBps: 1_000, memberDiscountCents: 2_500 });
  });

  it('adds the member discount on top of a manual discount', async () => {
    const customerId = 'cust-member-2';
    await seedMembership(customerId, 2_000); // 20% → 5,000
    const jobId = await seedJob(customerId);

    const res = await request(h.app)
      .post('/api/estimates')
      .send({ jobId, lineItems: LINE_ITEMS, discountCents: 1_000, taxRateBps: 0 });

    expect(res.status).toBe(201);
    expect(res.body.totals.discountCents).toBe(6_000); // 1,000 manual + 5,000 member
  });

  it('applies no member discount for a customer without a membership', async () => {
    const jobId = await seedJob('cust-plain');

    const res = await request(h.app)
      .post('/api/estimates')
      .send({ jobId, lineItems: LINE_ITEMS, taxRateBps: 0 });

    expect(res.status).toBe(201);
    expect(res.body.totals.discountCents).toBe(0);
    const events = await h.auditRepo.findByEntity(TEST_TENANT_ID, 'estimate', res.body.id);
    expect(events.find((e) => e.eventType === 'estimate.member_discount_applied')).toBeUndefined();
  });

  it('ignores a paused membership', async () => {
    const customerId = 'cust-paused';
    await seedMembership(customerId, 1_500);
    // Pause it: the resolver only counts active memberships.
    const [agreement] = await h.agreementRepo.findByTenant(TEST_TENANT_ID, { customerId });
    await h.agreementRepo.update(TEST_TENANT_ID, agreement.id, { status: 'paused' });
    const jobId = await seedJob(customerId);

    const res = await request(h.app)
      .post('/api/estimates')
      .send({ jobId, lineItems: LINE_ITEMS, taxRateBps: 0 });

    expect(res.status).toBe(201);
    expect(res.body.totals.discountCents).toBe(0);
  });
});
