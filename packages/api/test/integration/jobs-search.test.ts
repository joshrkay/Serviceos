/**
 * #1406 D4 — the jobs list search box promises "customer, address, job #"
 * but PgJobRepository only searched summary and job_number.
 *
 * Seam: PgJobRepository.listWithMeta({ search }) against real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';

describe('Postgres integration — jobs search (#1406 D4)', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let tenant: { tenantId: string; userId: string };
  let other: { tenantId: string; userId: string };
  let targetJobId: string;

  async function seedJob(t: { tenantId: string; userId: string }, name: string, street: string, summary: string) {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const customerId = crypto.randomUUID();
    const [firstName, lastName] = name.split(' ');
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName,
      lastName,
      displayName: name,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: street,
      city: 'Mesa',
      state: 'AZ',
      postalCode: '85201',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const id = crypto.randomUUID();
    await jobRepo.create({
      id,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${id.slice(0, 6)}`,
      summary,
      status: 'new',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Parameters<PgJobRepository['create']>[0]);
    return id;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
    targetJobId = await seedJob(tenant, 'Priya Raman', '910 Ocotillo Dr', 'AC tune-up');
    await seedJob(tenant, 'Glen Hardy', '12 Mesquite Ct', 'Water heater flush');
    await seedJob(other, 'Priya Raman', '910 Ocotillo Dr', 'Other tenant job');
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('finds a job by its customer name', async () => {
    const result = await jobRepo.listWithMeta(tenant.tenantId, { search: 'raman' });
    expect(result.data.map((j) => j.id)).toEqual([targetJobId]);
    expect(result.total).toBe(1);
  });

  it('finds a job by its service address', async () => {
    const result = await jobRepo.listWithMeta(tenant.tenantId, { search: 'Ocotillo' });
    expect(result.data.map((j) => j.id)).toEqual([targetJobId]);
    expect(result.total).toBe(1);
  });
});
