/**
 * #1406 D4 — the jobs list search box promises "customer, address, job #"
 * but PgJobRepository only searched summary and job_number.
 *
 * #1416 — the behaviour now lives in ONE shared contract
 * (test/jobs/job-search.contract.ts) that also runs against the in-memory
 * repository (test/jobs/job-search.in-memory.test.ts), so the two cannot
 * drift apart again.
 *
 * Seam: PgJobRepository.listWithMeta({ search }) against real Postgres.
 */
import { afterAll } from 'vitest';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { describeJobSearchContract } from '../jobs/job-search.contract';

describeJobSearchContract('PgJobRepository', async () => {
  const pool = await getSharedTestDb();
  return {
    jobRepo: new PgJobRepository(pool),
    customerRepo: new PgCustomerRepository(pool),
    locationRepo: new PgLocationRepository(pool),
    tenant: await createTestTenant(pool),
    otherTenant: await createTestTenant(pool),
  };
});

afterAll(async () => {
  await closeSharedTestDb();
});
