/**
 * #1402 §13 — deactivating a teammate against the REAL migrated schema.
 *
 * Seams: PgUserRepository.deactivateMember (the write), the authorization
 * loader every request resolves membership through (sign-in effect), and
 * PgSeatUsageReader (the plan seat count the invite path enforces).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgSeatUsageReader } from '../../src/users/seat-limit';
import { createAuthorizationLoader } from '../../src/auth/authorization-loader';

describe('Postgres integration — deactivating a team member', () => {
  let pool: Pool;
  let repo: PgUserRepository;
  let seats: PgSeatUsageReader;

  async function insertUser(
    tenantId: string,
    role: 'owner' | 'dispatcher' | 'technician',
  ): Promise<{ id: string; clerkUserId: string }> {
    const id = crypto.randomUUID();
    const clerkUserId = `user_${id}`;
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, tenantId, clerkUserId, `${id}@example.com`, role],
    );
    return { id, clerkUserId };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgUserRepository(pool);
    seats = new PgSeatUsageReader(pool);
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('suspends the member: still on the roster, but their membership no longer grants access', async () => {
    const { tenantId } = await createTestTenant(pool);
    const tech = await insertUser(tenantId, 'technician');

    const updated = await repo.deactivateMember(tenantId, tech.id);

    expect(updated).toMatchObject({ id: tech.id, status: 'suspended' });
    const roster = await repo.findByTenant(tenantId);
    expect(roster.find((u) => u.id === tech.id)?.status).toBe('suspended');
    const membership = await createAuthorizationLoader(pool)(tech.clerkUserId, tenantId);
    expect(membership).toMatchObject({ status: 'suspended', deleted: false });
  });

  it('frees the seat: a Starter tenant (owner + 1 tech) counts 1 seat after the tech is deactivated', async () => {
    const { tenantId } = await createTestTenant(pool);
    await pool.query(`UPDATE tenants SET plan_id = 'starter' WHERE id = $1`, [tenantId]);
    const tech = await insertUser(tenantId, 'technician');
    expect((await seats.getSeatUsage(tenantId)).seatsUsed).toBe(2);

    await repo.deactivateMember(tenantId, tech.id);

    expect((await seats.getSeatUsage(tenantId)).seatsUsed).toBe(1);
  });

  it('refuses the last active owner atomically', async () => {
    const { tenantId, userId: ownerId } = await createTestTenant(pool);

    expect(await repo.deactivateMember(tenantId, ownerId)).toBeNull();
    expect((await repo.findById(tenantId, ownerId))?.status ?? 'active').toBe('active');
  });

  it('deactivates an owner while another active owner remains', async () => {
    const { tenantId } = await createTestTenant(pool);
    const coOwner = await insertUser(tenantId, 'owner');

    const updated = await repo.deactivateMember(tenantId, coOwner.id);

    expect(updated?.status).toBe('suspended');
  });

  it('never touches another tenant’s row', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    const techInB = await insertUser(b.tenantId, 'technician');

    expect(await repo.deactivateMember(a.tenantId, techInB.id)).toBeNull();
    expect((await repo.findById(b.tenantId, techInB.id))?.status ?? 'active').toBe('active');
  });
});
