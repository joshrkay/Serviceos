import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgUserRepository } from '../../src/users/pg-user';
import { createLocation } from '../../src/locations/location';
import { RepoSkillMatcher } from '../../src/scheduling/skill-matcher';
import type { Customer } from '../../src/customers/customer';
import type { Job } from '../../src/jobs/job';

/**
 * Dispatch FR-2 phase 2 — pins the real columns of migration 328
 * (users.skills, jobs.required_skills) through the Pg repositories the wired
 * RepoSkillMatcher reads.
 */
describe('Postgres integration — skill tags (migration 328)', () => {
  let pool: Pool;
  let users: PgUserRepository;
  let jobs: PgJobRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    users = new PgUserRepository(pool);
    jobs = new PgJobRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function newTechnician(): Promise<string> {
    const id = crypto.randomUUID();
    await users.create({ id, tenantId: tenant.tenantId, clerkUserId: id, email: `${id}@example.com`, role: 'technician' });
    return id;
  }

  async function newJob(): Promise<string> {
    const now = new Date();
    const customer: Customer = {
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      firstName: 'Skill',
      lastName: 'Tags',
      displayName: 'Skill Tags',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: now,
      updatedAt: now,
    };
    const customerId = (await new PgCustomerRepository(pool).create(customer)).id;
    const location = await createLocation(
      { tenantId: tenant.tenantId, customerId, street1: '1 Skill St', city: 'Phoenix', state: 'AZ', postalCode: '85004' },
      new PgLocationRepository(pool),
    );
    const job: Job = {
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      customerId,
      locationId: location.id,
      jobNumber: `JOB-${crypto.randomUUID().slice(0, 8)}`,
      summary: 'Gas furnace swap',
      status: 'new',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: now,
      updatedAt: now,
    };
    return (await jobs.create(job)).id;
  }

  it('new rows read back with empty tag lists (column defaults)', async () => {
    const techId = await newTechnician();
    const jobId = await newJob();
    expect((await users.findById(tenant.tenantId, techId))!.skills).toEqual([]);
    expect((await jobs.findById(tenant.tenantId, jobId))!.requiredSkills).toEqual([]);
  });

  it('users.skills round-trips through update, findById and findByTenant', async () => {
    const techId = await newTechnician();
    const updated = await users.update(tenant.tenantId, techId, { skills: ['gas_certified', 'hvac'] });
    expect(updated!.skills).toEqual(['gas_certified', 'hvac']);
    expect((await users.findById(tenant.tenantId, techId))!.skills).toEqual(['gas_certified', 'hvac']);
    const listed = (await users.findByTenant(tenant.tenantId, { role: 'technician' })).find((u) => u.id === techId);
    expect(listed!.skills).toEqual(['gas_certified', 'hvac']);

    await users.update(tenant.tenantId, techId, { skills: [] });
    expect((await users.findById(tenant.tenantId, techId))!.skills).toEqual([]);
  });

  it('jobs.required_skills round-trips through update and findById', async () => {
    const jobId = await newJob();
    const updated = await jobs.update(tenant.tenantId, jobId, { requiredSkills: ['gas_certified'] });
    expect(updated!.requiredSkills).toEqual(['gas_certified']);
    expect((await jobs.findById(tenant.tenantId, jobId))!.requiredSkills).toEqual(['gas_certified']);
  });

  it('RepoSkillMatcher reads both columns, and another tenant sees nothing', async () => {
    const techId = await newTechnician();
    const jobId = await newJob();
    await users.update(tenant.tenantId, techId, { skills: ['hvac'] });
    await jobs.update(tenant.tenantId, jobId, { requiredSkills: ['gas_certified', 'hvac'] });

    const matcher = new RepoSkillMatcher(jobs, users);
    expect(await matcher.requiredSkillsForJob(tenant.tenantId, jobId)).toEqual(['gas_certified', 'hvac']);
    expect(await matcher.skillsForTechnician(tenant.tenantId, techId)).toEqual(['hvac']);

    const other = await createTestTenant(pool);
    expect(await matcher.requiredSkillsForJob(other.tenantId, jobId)).toEqual([]);
    expect(await matcher.skillsForTechnician(other.tenantId, techId)).toEqual([]);
  });
});
