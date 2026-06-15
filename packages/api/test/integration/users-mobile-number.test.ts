import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgUserRepository } from '../../src/users/pg-user';

/**
 * Pins the per-technician escalation number against the REAL column:
 * `users.mobile_number` round-trips, the `(tenant_id, mobile_number)` partial
 * unique index is enforced, and the value is tenant-isolated (RLS + the
 * tenant-scoped WHERE). A mocked-DB test cannot prove any of these.
 */
describe('Postgres integration — users.mobile_number (per-tech escalation number)', () => {
  let pool: Pool;
  let userRepo: PgUserRepository;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };
  let secondUserA: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    userRepo = new PgUserRepository(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    // createTestTenant only seeds the owner; add a second teammate in tenant A
    // so the unique-index test has a competitor for the same number.
    secondUserA = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, $5)`,
      [secondUserA, tenantA.tenantId, secondUserA, 'tech-a@example.com', 'technician'],
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('round-trips a set mobile_number on the real column', async () => {
    const updated = await userRepo.setMobileNumber(tenantA.tenantId, tenantA.userId, '+15125550101');
    expect(updated!.mobileNumber).toBe('+15125550101');
    const found = await userRepo.findById(tenantA.tenantId, tenantA.userId);
    expect(found!.mobileNumber).toBe('+15125550101');
  });

  it('clears the number on null', async () => {
    await userRepo.setMobileNumber(tenantA.tenantId, tenantA.userId, '+15125550102');
    const cleared = await userRepo.setMobileNumber(tenantA.tenantId, tenantA.userId, null);
    expect(cleared!.mobileNumber).toBeUndefined();
  });

  it('enforces the (tenant_id, mobile_number) partial-unique index', async () => {
    await userRepo.setMobileNumber(tenantA.tenantId, tenantA.userId, '+15125550103');
    // A second teammate in the SAME tenant cannot claim the same number.
    await expect(
      userRepo.setMobileNumber(tenantA.tenantId, secondUserA, '+15125550103'),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it("is tenant-isolated — tenant B cannot read tenant A's number", async () => {
    await userRepo.setMobileNumber(tenantA.tenantId, tenantA.userId, '+15125550104');
    // RLS + tenant-scoped WHERE: the row is invisible from tenant B's context.
    const fromB = await userRepo.findById(tenantB.tenantId, tenantA.userId);
    expect(fromB).toBeNull();
    // findByMobileNumber is tenant-scoped too: B can't resolve A's number.
    const byNumber = await userRepo.findByMobileNumber(tenantB.tenantId, '+15125550104');
    expect(byNumber).toBeNull();
  });
});
