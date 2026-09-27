/**
 * #1400 (QA 2026-09-26 §4) — the estimates list tabs and search against the
 * real Postgres list query (PgEstimateRepository via listEstimatesWithMeta).
 *
 * - Sent tab previously queried only `ready_for_review`; Viewed could never
 *   match; Expired never listed past-validity sent estimates. The `stage`
 *   list option owns those derived buckets server-side.
 * - Search matched estimate_number / customer_message only, never the
 *   customer's name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { createEstimate, listEstimatesWithMeta } from '../../src/estimates/estimate';
import type { LineItem } from '../../src/shared/billing-engine';

describe('Postgres integration — estimate list stage + customer search (#1400)', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let tenantId: string;
  let userId: string;
  const ids: Record<string, string> = {};

  const DAY = 24 * 60 * 60 * 1000;
  const line = (): LineItem[] => [
    { id: crypto.randomUUID(), description: 'Labor', quantity: 1, unitPriceCents: 10000, totalCents: 10000, sortOrder: 0, taxable: false },
  ];

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    ({ tenantId, userId } = await createTestTenant(pool));

    const jobFor = async (firstName: string, lastName: string) => {
      const customerId = crypto.randomUUID();
      await customerRepo.create({
        id: customerId, tenantId, firstName, lastName, displayName: `${firstName} ${lastName}`,
        preferredChannel: 'phone', smsConsent: false, isArchived: false,
        createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
      });
      const locationId = crypto.randomUUID();
      await locationRepo.create({
        id: locationId, tenantId, customerId, street1: '1 Main St', city: 'Austin', state: 'TX',
        postalCode: '78701', country: 'USA', isPrimary: true, isArchived: false,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const jobId = crypto.randomUUID();
      await jobRepo.create({
        id: jobId, tenantId, customerId, locationId, jobNumber: `JOB-${firstName}`, summary: 'Work',
        status: 'scheduled', priority: 'normal', createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
      });
      return jobId;
    };
    const goldenJob = await jobFor('Golden', 'Journey');
    const otherJob = await jobFor('Other', 'Person');

    const make = async (key: string, jobId: string, patch: Parameters<PgEstimateRepository['update']>[2]) => {
      const e = await createEstimate(
        { tenantId, jobId, estimateNumber: `EST-${key}`, lineItems: line(), createdBy: userId },
        estimateRepo,
      );
      if (Object.keys(patch).length) await estimateRepo.update(tenantId, e.id, patch);
      ids[key] = e.id;
    };
    const future = new Date(Date.now() + 7 * DAY);
    const past = new Date(Date.now() - 2 * DAY);
    await make('DRAFT', otherJob, {});
    await make('REVIEW', otherJob, { status: 'ready_for_review' });
    await make('SENT', goldenJob, { status: 'sent', sentAt: new Date(), validUntil: future });
    await make('VIEWED', otherJob, { status: 'sent', sentAt: new Date(), firstViewedAt: new Date(), validUntil: future });
    await make('LAPSED', otherJob, { status: 'sent', sentAt: new Date(Date.now() - 40 * DAY), validUntil: past });
    await make('EXPIRED', otherJob, { status: 'expired' });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  const stageIds = async (stage: 'sent' | 'viewed' | 'expired') => {
    const { data, total } = await listEstimatesWithMeta(tenantId, estimateRepo, { stage, limit: 50 });
    expect(total).toBe(data.length);
    return data.map((e) => e.id).sort();
  };

  it('stage=sent lists ready_for_review + sent estimates the customer has not opened and that are still valid', async () => {
    expect(await stageIds('sent')).toEqual([ids.REVIEW, ids.SENT].sort());
  });

  it('stage=viewed lists sent estimates the customer has opened (still valid)', async () => {
    expect(await stageIds('viewed')).toEqual([ids.VIEWED]);
  });

  it('stage=expired lists expired estimates AND sent estimates past their validUntil', async () => {
    expect(await stageIds('expired')).toEqual([ids.LAPSED, ids.EXPIRED].sort());
  });

  it('search matches the customer name (display, first or last) of the estimate\'s job', async () => {
    for (const q of ['Golden Journey', 'golden', 'Journey']) {
      const { data } = await listEstimatesWithMeta(tenantId, estimateRepo, { search: q, limit: 50 });
      expect(data.map((e) => e.id), q).toEqual([ids.SENT]);
    }
  });
});
