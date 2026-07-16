/**
 * Postgres integration — PgTechnicianLocationAuthorizer (U3).
 *
 * Pins the real authz query against real columns: an owner/dispatcher may submit
 * a technician's location ping using the CANONICAL users.id (the id the dispatch
 * board + appointment_assignments expose) as well as the legacy clerk_user_id.
 * The beta-verification run hit a 403 here because the query only matched
 * clerk_user_id while the caller naturally had the users.id UUID. A mocked Pool
 * could not have caught it — the `id::text = $2 OR clerk_user_id = $2` predicate
 * has to run against real rows.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgTechnicianLocationAuthorizer } from '../../src/telemetry/technician-location-authz';

let pool: Pool;
beforeAll(async () => {
  pool = await getSharedTestDb();
});
afterAll(async () => {
  await closeSharedTestDb();
});

function auth(
  tenantId: string,
  role: 'owner' | 'dispatcher' | 'technician',
  userId: string,
  canonicalUserId?: string,
) {
  return { tenantId, role, userId, canonicalUserId, sessionId: 'sess-test' };
}

async function seedTechnician(tenantId: string): Promise<{ id: string; clerkId: string }> {
  const id = crypto.randomUUID();
  const clerkId = `clerk_${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO users (id, tenant_id, clerk_user_id, email, role)
     VALUES ($1, $2, $3, $4, 'technician')`,
    [id, tenantId, clerkId, `tech_${id}@example.com`]
  );
  return { id, clerkId };
}

describe('PgTechnicianLocationAuthorizer (real Postgres)', () => {
  it('owner may submit for a technician by canonical users.id', async () => {
    const { tenantId, userId: ownerId } = await createTestTenant(pool);
    const tech = await seedTechnician(tenantId);
    const authz = new PgTechnicianLocationAuthorizer(pool);
    expect(await authz.canSubmitForTechnician(auth(tenantId, 'owner', ownerId), tech.id)).toBe(true);
  });

  it('owner may also submit by the legacy clerk_user_id (back-compat)', async () => {
    const { tenantId, userId: ownerId } = await createTestTenant(pool);
    const tech = await seedTechnician(tenantId);
    const authz = new PgTechnicianLocationAuthorizer(pool);
    expect(await authz.canSubmitForTechnician(auth(tenantId, 'owner', ownerId), tech.clerkId)).toBe(true);
  });

  it('rejects an id that is not a technician (e.g. the owner themselves)', async () => {
    const { tenantId, userId: ownerId } = await createTestTenant(pool);
    const authz = new PgTechnicianLocationAuthorizer(pool);
    // ownerId is a real user row but role=owner, so the role filter excludes it.
    expect(await authz.canSubmitForTechnician(auth(tenantId, 'dispatcher', ownerId), ownerId)).toBe(false);
  });

  it('rejects an unknown id', async () => {
    const { tenantId, userId: ownerId } = await createTestTenant(pool);
    const authz = new PgTechnicianLocationAuthorizer(pool);
    expect(
      await authz.canSubmitForTechnician(auth(tenantId, 'owner', ownerId), crypto.randomUUID())
    ).toBe(false);
  });

  it('does not leak across tenants — a technician of tenant B is not submittable by tenant A', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    const techB = await seedTechnician(b.tenantId);
    const authz = new PgTechnicianLocationAuthorizer(pool);
    expect(await authz.canSubmitForTechnician(auth(a.tenantId, 'owner', a.userId), techB.id)).toBe(false);
  });

  it('technician self-submit uses their canonical users.id (no DB needed)', async () => {
    const { tenantId } = await createTestTenant(pool);
    const authz = new PgTechnicianLocationAuthorizer(pool);
    const clerkId = 'user_clerk_self_123';
    const canonicalId = crypto.randomUUID();
    expect(
      await authz.canSubmitForTechnician(
        auth(tenantId, 'technician', clerkId, canonicalId),
        canonicalId,
      ),
    ).toBe(true);
    expect(
      await authz.canSubmitForTechnician(
        auth(tenantId, 'technician', clerkId, canonicalId),
        crypto.randomUUID(),
      ),
    ).toBe(false);
  });
});
