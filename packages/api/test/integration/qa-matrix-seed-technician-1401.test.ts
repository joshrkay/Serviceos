/**
 * #1401 (harness) — the QA matrix seed (e2e/qa-matrix/fixtures/seed.ts)
 * created no technician user, so §3 conflict detection and reassign could
 * not be exercised. The seed must now provision exactly one technician per
 * matrix tenant, idempotently, WITHIN the product's seat rules
 * (users/seat-limit.ts: Starter = 2 users, Growth = 5; every non-deleted
 * user and unexpired invitation counts). Matrix tenants carry ~4 QA logins,
 * so the seed puts them on Growth (the plan that grants the seats) rather
 * than bypassing the limit — and when even Growth is full it fails loudly
 * with SEAT_LIMIT_REACHED instead of inserting a user past the limit.
 *
 * Runs the seed's exported ensureTenantFixture at real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { ensureTenantFixture } from '../../../../e2e/qa-matrix/fixtures/seed';

describe('Postgres integration — QA matrix seed provisions a technician within seat rules (#1401)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function technicians(tenantId: string): Promise<Array<{ id: string; status: string }>> {
    const { rows } = await pool.query(
      `SELECT id, status FROM users WHERE tenant_id = $1 AND role = 'technician' AND deleted_at IS NULL`,
      [tenantId]
    );
    return rows;
  }

  it('seeds one active technician on a Growth tenant, and a re-run changes nothing', async () => {
    const slug = `qa-matrix-t1401-${randomUUID().slice(0, 8)}-A`;

    const first = await ensureTenantFixture(pool, slug);
    const second = await ensureTenantFixture(pool, slug);

    expect(second).toEqual(first);
    expect(first.technicianUserId).toEqual(expect.any(String));
    const techs = await technicians(first.tenantId);
    expect(techs).toEqual([{ id: first.technicianUserId, status: 'active' }]);

    const { rows } = await pool.query(`SELECT plan_id FROM tenants WHERE id = $1`, [first.tenantId]);
    expect(rows[0].plan_id).toBe('growth');
  });

  it('refuses to seat a technician past the Growth limit (SEAT_LIMIT_REACHED, nothing inserted)', async () => {
    const slug = `qa-matrix-t1401-${randomUUID().slice(0, 8)}-B`;
    // Pre-create the tenant with the seed's own owner_id handle and fill all
    // five Growth seats with non-technician logins.
    const tenantId = randomUUID();
    await pool.query(
      `INSERT INTO tenants (id, owner_id, owner_email, name, plan_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'growth', now(), now())`,
      [tenantId, `qa:${slug}`, `${slug}@qa.serviceos.local`, `QA Matrix ${slug}`]
    );
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'dispatcher', 'active', now(), now())`,
        [randomUUID(), tenantId, `qa-seat-filler-${i}-${slug}`, `filler-${i}-${slug}@qa.serviceos.local`]
      );
    }

    await expect(ensureTenantFixture(pool, slug)).rejects.toMatchObject({ code: 'SEAT_LIMIT_REACHED' });
    expect(await technicians(tenantId)).toEqual([]);
  });
});
