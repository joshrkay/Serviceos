/**
 * Postgres integration — two distinct deposit checkouts for the same job must
 * both credit it (no lost update), and the credit clamps at the required amount.
 *
 * Regression for the deposit double-credit race: the Stripe webhook handler read
 * job.depositPaidCents into a snapshot then blind-set snapshot+delta, so two
 * distinct `checkout.session.completed` events for the same job (e.g. a
 * double-tapped "Pay Deposit" minting two Checkout Sessions) both read the same
 * paid value and the second write clobbered the first. creditDepositAtomic
 * derives the new balance from the row's own value in a single UPDATE.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';

describe('Postgres integration — concurrent deposit credits both apply + clamp', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let tenant: { tenantId: string; userId: string };

  async function seedJob(depositRequiredCents: number): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Dep',
      lastName: 'Osit',
      displayName: 'Dep Osit',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 Dep St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-DEP-${jobId.slice(0, 6)}`,
      summary: 'Deposit job',
      status: 'scheduled',
      priority: 'normal',
      depositPaidCents: 0,
      depositStatus: 'pending',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // create() doesn't persist deposit columns; production sets them via update.
    await jobRepo.update(tenant.tenantId, jobId, {
      depositRequiredCents,
      depositStatus: depositRequiredCents > 0 ? 'pending' : 'not_required',
    });
    return jobId;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('two concurrent partial deposits both credit the job (no lost update)', async () => {
    const jobId = await seedJob(30000);
    const now = new Date();

    await Promise.all([
      jobRepo.creditDepositAtomic(tenant.tenantId, jobId, 10000, now),
      jobRepo.creditDepositAtomic(tenant.tenantId, jobId, 15000, now),
    ]);

    const job = await jobRepo.findById(tenant.tenantId, jobId);
    expect(job!.depositPaidCents).toBe(25000); // 10000 + 15000, both applied
    expect(job!.depositStatus).toBe('pending'); // still short of 30000
  });

  it('credits clamp at the required amount and flip status to paid', async () => {
    const jobId = await seedJob(20000);
    const now = new Date();

    // Two credits that together exceed the requirement → clamp at 20000, paid.
    await Promise.all([
      jobRepo.creditDepositAtomic(tenant.tenantId, jobId, 15000, now),
      jobRepo.creditDepositAtomic(tenant.tenantId, jobId, 15000, now),
    ]);

    const job = await jobRepo.findById(tenant.tenantId, jobId);
    expect(job!.depositPaidCents).toBe(20000); // clamped, not 30000
    expect(job!.depositStatus).toBe('paid');
  });

  it('returns null for a job with no required deposit', async () => {
    const jobId = await seedJob(0);
    const res = await jobRepo.creditDepositAtomic(tenant.tenantId, jobId, 5000, new Date());
    expect(res).toBeNull();
  });
});
