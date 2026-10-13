/**
 * Postgres integration — a new member's canFieldServe default (migration 309).
 *
 * Owners are field-capable unless the creator says otherwise (the solo
 * owner-operator IS the crew: lookup-crew-schedule counts canFieldServe as
 * sendable); everyone else opts in. Migration 066's owner backfill used to
 * re-run on every deploy and supply this for every owner after the fact; now
 * that it runs once, the insert itself must. The default lives on the users
 * INSERT (trigger) because the production creation paths — the Clerk
 * user.created owner insert and the invitation join in webhooks/routes.ts —
 * write raw SQL and never reach PgUserRepository.create.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb, createTestTenant, type TestTenant } from './shared';
import { PgUserRepository } from '../../src/users/pg-user';
import type { UserRole } from '../../src/users/user';

describe('Postgres integration — new users canFieldServe default', () => {
  let pool: Pool;
  let users: PgUserRepository;
  let tenant: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    users = new PgUserRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function newMember(input: { role: UserRole; canFieldServe?: boolean }) {
    return users.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      clerkUserId: `user_${crypto.randomUUID()}`,
      email: `${crypto.randomUUID()}@example.com`,
      ...input,
    });
  }

  it('an owner created without the flag is field-capable', async () => {
    const owner = await newMember({ role: 'owner' });
    expect((await users.findById(tenant.tenantId, owner.id))?.canFieldServe).toBe(true);
  });

  it('a technician or dispatcher created without the flag is not', async () => {
    const tech = await newMember({ role: 'technician' });
    const dispatcher = await newMember({ role: 'dispatcher' });
    expect((await users.findById(tenant.tenantId, tech.id))?.canFieldServe).toBe(false);
    expect((await users.findById(tenant.tenantId, dispatcher.id))?.canFieldServe).toBe(false);
  });

  it('an explicit value is kept — an owner created office-only stays office-only', async () => {
    const owner = await newMember({ role: 'owner', canFieldServe: false });
    const dispatcher = await newMember({ role: 'dispatcher', canFieldServe: true });
    expect((await users.findById(tenant.tenantId, owner.id))?.canFieldServe).toBe(false);
    expect((await users.findById(tenant.tenantId, dispatcher.id))?.canFieldServe).toBe(true);
  });

  it('a raw INSERT that omits the column — the shape of the Clerk owner insert and the invitation join — gets the same default', async () => {
    const insert = async (role: UserRole) => {
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, NOW(), NOW())`,
        [id, tenant.tenantId, `user_${id}`, `${id}@example.com`, role],
      );
      return (await users.findById(tenant.tenantId, id))?.canFieldServe;
    };
    expect(await insert('owner')).toBe(true);
    expect(await insert('technician')).toBe(false);
  });
});
