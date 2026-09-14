/**
 * Postgres integration — #1152. Two concurrent `createJob()` calls for the
 * same (fresh) tenant both compute their job_number via
 * `PgJobRepository.getNextJobNumber` (`SELECT COUNT(*)::int + 1 …`, no lock)
 * OUTSIDE any shared transaction, so both can read the same count and race
 * to insert the same `job_number` — the loser trips `idx_jobs_number`
 * (`UNIQUE (tenant_id, job_number)`) and createJob() rejects with a raw
 * Postgres unique-violation instead of N distinct numbers.
 *
 * `createJob` is exercised directly (not `jobRepo.create`) because that's
 * the production code path behind `POST /api/jobs` (packages/api/src/routes/jobs.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { createJob } from '../../src/jobs/job';

const CONCURRENCY = 8;
const LOOPS = 10;

describe('Postgres integration — #1152 concurrent job_number allocation', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedCustomerAndLocation(tenantId: string, userId: string) {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Race',
      lastName: 'Customer',
      displayName: 'Race Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1 Race St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { customerId, locationId };
  }

  it(`fires ${CONCURRENCY} concurrent creates for a fresh tenant × ${LOOPS} loops — N distinct job numbers, no 500s`, async () => {
    const tenant = await createTestTenant(pool);
    const { customerId, locationId } = await seedCustomerAndLocation(tenant.tenantId, tenant.userId);

    for (let loop = 0; loop < LOOPS; loop++) {
      const results = await Promise.allSettled(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          createJob(
            {
              tenantId: tenant.tenantId,
              customerId,
              locationId,
              summary: `Race job loop ${loop} #${i}`,
              createdBy: tenant.userId,
            },
            jobRepo,
          ),
        ),
      );

      const rejected = results.filter((r) => r.status === 'rejected');
      if (rejected.length > 0) {
        // Surface the raw Postgres error (unmapped 500 per the ticket) for the RED run.
        throw new Error(
          `loop ${loop}: ${rejected.length}/${CONCURRENCY} createJob() calls rejected — ` +
            rejected.map((r) => (r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason)).join(' | '),
        );
      }

      const jobNumbers = (results as PromiseFulfilledResult<Awaited<ReturnType<typeof createJob>>>[]).map(
        (r) => r.value.jobNumber,
      );
      const distinct = new Set(jobNumbers);
      expect(distinct.size).toBe(CONCURRENCY);
    }
  });

  it('T1 — a second tenant created concurrently numbers independently starting at JOB-0001', async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    const a = await seedCustomerAndLocation(tenantA.tenantId, tenantA.userId);
    const b = await seedCustomerAndLocation(tenantB.tenantId, tenantB.userId);

    const [resultsA, resultsB] = await Promise.all([
      Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          createJob(
            {
              tenantId: tenantA.tenantId,
              customerId: a.customerId,
              locationId: a.locationId,
              summary: `Tenant A job ${i}`,
              createdBy: tenantA.userId,
            },
            jobRepo,
          ),
        ),
      ),
      Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          createJob(
            {
              tenantId: tenantB.tenantId,
              customerId: b.customerId,
              locationId: b.locationId,
              summary: `Tenant B job ${i}`,
              createdBy: tenantB.userId,
            },
            jobRepo,
          ),
        ),
      ),
    ]);

    expect(new Set(resultsA.map((j) => j.jobNumber)).size).toBe(CONCURRENCY);
    expect(new Set(resultsB.map((j) => j.jobNumber)).size).toBe(CONCURRENCY);
    // Tenant B's numbering is untouched by tenant A's concurrent activity —
    // both fresh tenants start at JOB-0001.
    expect(resultsA.map((j) => j.jobNumber).sort()).toContain('JOB-0001');
    expect(resultsB.map((j) => j.jobNumber).sort()).toContain('JOB-0001');
  });
});
