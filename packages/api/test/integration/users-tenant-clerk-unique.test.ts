/**
 * Postgres integration — migration 253 users(tenant_id, clerk_user_id) unique.
 *
 * Migration 249 + Clerk user.created both insert owner membership rows; without
 * a unique constraint those races left every owner with 2 rows. This pins:
 *   1. dedupe collapses duplicates (keeping the earliest row),
 *   2. the unique index rejects a second insert for the same pair,
 *   3. re-applying the migration is idempotent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { MIGRATIONS } from '../../src/db/schema';

const DEDUPE_SQL = MIGRATIONS['253_users_tenant_clerk_unique'];

describe('Postgres integration — 253_users_tenant_clerk_unique', () => {
  let pool: Pool;
  let tenantId: string;
  const clerkUserId = `user_dup_${Date.now()}`;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    // Shared test DB may already have run 253 via getMigrationSQL(); drop the
    // unique index so we can seed a deliberate duplicate, then re-apply.
    await pool.query('DROP INDEX IF EXISTS uq_users_tenant_clerk');
    const tenant = await pool.query(
      `INSERT INTO tenants (owner_id, owner_email, name)
       VALUES ($1, $2, 'Dup Membership Co') RETURNING id`,
      [clerkUserId, 'dup-owner@example.com'],
    );
    tenantId = tenant.rows[0].id as string;
    await pool.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role)
       VALUES ($1, $2, 'dup-owner@example.com', 'owner'),
              ($1, $2, 'dup-owner@example.com', 'owner')`,
      [tenantId, clerkUserId],
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('dedupes duplicate memberships and enforces uniqueness', async () => {
    const before = await pool.query(
      `SELECT COUNT(*)::int AS n FROM users
       WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantId, clerkUserId],
    );
    expect(before.rows[0].n).toBe(2);

    await pool.query(DEDUPE_SQL);

    const after = await pool.query(
      `SELECT COUNT(*)::int AS n FROM users
       WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantId, clerkUserId],
    );
    expect(after.rows[0].n).toBe(1);

    await expect(
      pool.query(
        `INSERT INTO users (tenant_id, clerk_user_id, email, role)
         VALUES ($1, $2, 'dup-owner@example.com', 'owner')`,
        [tenantId, clerkUserId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('is idempotent when re-applied', async () => {
    await pool.query(DEDUPE_SQL);
    await pool.query(DEDUPE_SQL);
    const rows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM users
       WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantId, clerkUserId],
    );
    expect(rows.rows[0].n).toBe(1);
  });
});
