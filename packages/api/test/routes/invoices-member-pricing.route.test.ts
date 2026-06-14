import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, TestApp, TEST_TENANT_ID, TEST_USER_ID } from './test-app';
import { createJob } from '../../src/jobs/job';
import { createAgreement } from '../../src/agreements/agreement-service';

/**
 * POST /api/invoices — membership member pricing (#6 phase 2).
 *
 * A DIRECT invoice for a member gets the membership discount folded in.
 * A converted-from-estimate invoice does NOT (the estimate already carried
 * it — re-applying would double-discount).
 */
const LINE_ITEMS = [
  { id: 'li-1', description: 'Repair', quantity: 1, unitPriceCents: 30_000, totalCents: 30_000, sortOrder: 0, taxable: true },
  { id: 'li-2', description: 'Parts', quantity: 1, unitPriceCents: 10_000, totalCents: 10_000, sortOrder: 1, taxable: true },
];
const SUBTOTAL = 40_000;

describe('POST /api/invoices — member pricing', () => {
  let h: TestApp;

  beforeEach(async () => {
    h = await buildTestApp();
  });

  async function seedJob(customerId: string): Promise<string> {
    const job = await createJob(
      { tenantId: TEST_TENANT_ID, customerId, locationId: 'loc-1', summary: 'Service', createdBy: TEST_USER_ID },
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

  it('folds a member discount into a direct invoice', async () => {
    const customerId = 'cust-member';
    await seedMembership(customerId, 1_500); // 15%
    const jobId = await seedJob(customerId);

    const res = await request(h.app)
      .post('/api/invoices')
      .send({ jobId, lineItems: LINE_ITEMS, taxRateBps: 0 });

    expect(res.status).toBe(201);
    expect(res.body.totals.discountCents).toBe(6_000); // 15% of 40,000

    const events = await h.auditRepo.findByEntity(TEST_TENANT_ID, 'invoice', res.body.id);
    expect(events.find((e) => e.eventType === 'invoice.member_discount_applied')).toBeDefined();
  });

  it('does NOT re-apply the discount when converting from an estimate', async () => {
    const customerId = 'cust-member-2';
    await seedMembership(customerId, 1_500);
    const jobId = await seedJob(customerId);

    const res = await request(h.app)
      .post('/api/invoices')
      .send({ jobId, estimateId: 'est-already-discounted', lineItems: LINE_ITEMS, taxRateBps: 0 });

    expect(res.status).toBe(201);
    // estimateId present → member discount skipped (estimate carried it).
    expect(res.body.totals.discountCents).toBe(0);
    const events = await h.auditRepo.findByEntity(TEST_TENANT_ID, 'invoice', res.body.id);
    expect(events.find((e) => e.eventType === 'invoice.member_discount_applied')).toBeUndefined();
  });

  it('applies no discount for a customer without a membership', async () => {
    const jobId = await seedJob('cust-plain');

    const res = await request(h.app)
      .post('/api/invoices')
      .send({ jobId, lineItems: LINE_ITEMS, taxRateBps: 0 });

    expect(res.status).toBe(201);
    expect(res.body.totals.discountCents).toBe(0);
  });
});
