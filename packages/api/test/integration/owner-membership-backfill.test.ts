/**
 * Postgres integration — migration 249 owner-membership backfill
 * (QUALITY-2026-07-12 WS4 follow-up, PR #669 review).
 *
 * Authorization is DB-authoritative (resolveAuthorization): a caller with no
 * `users` row is rejected 403. Tenants bootstrapped BEFORE the Clerk
 * user.created handler started inserting owner rows have exactly that shape —
 * a `tenants` row (owner_id = Clerk user id, owner_email) and NO users row —
 * so without the backfill every pre-existing owner is locked out the moment
 * the middleware ships. This test creates that legacy shape against the real
 * migrated schema, re-applies migration 249's SQL, and proves:
 *   1. the owner membership row is synthesized (role owner, active, email),
 *   2. the authorization loader now resolves the owner,
 *   3. the backfill is idempotent (re-run inserts nothing),
 *   4. tenants whose owner already has a row are untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createAuthorizationLoader } from '../../src/auth/authorization-loader';
import { MIGRATIONS } from '../../src/db/schema';

const BACKFILL_SQL = MIGRATIONS['249_backfill_owner_memberships'];

describe('Postgres integration — 249_backfill_owner_memberships', () => {
  let pool: Pool;
  let load: ReturnType<typeof createAuthorizationLoader>;
  /** Legacy-shaped tenant: tenants row only, no users row. */
  let legacyTenantId: string;
  const legacyOwnerId = `user_legacy_${Date.now()}`;
  const legacyOwnerEmail = 'legacy-owner@example.com';

  beforeAll(async () => {
    pool = await getSharedTestDb();
    load = createAuthorizationLoader(pool);
    const inserted = await pool.query(
      `INSERT INTO tenants (owner_id, owner_email, name)
       VALUES ($1, $2, 'Legacy Backfill Co') RETURNING id`,
      [legacyOwnerId, legacyOwnerEmail],
    );
    legacyTenantId = inserted.rows[0].id as string;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('synthesizes the owner membership row for a pre-existing tenant', async () => {
    const before = await load(legacyOwnerId, legacyTenantId);
    expect(before).toBeNull(); // the lockout shape the backfill fixes

    await pool.query(BACKFILL_SQL);

    const rows = await pool.query(
      `SELECT role, status, email, deleted_at FROM users
       WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [legacyTenantId, legacyOwnerId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].role).toBe('owner');
    expect(rows.rows[0].status).toBe('active');
    expect(rows.rows[0].email).toBe(legacyOwnerEmail);
    expect(rows.rows[0].deleted_at).toBeNull();

    const after = await load(legacyOwnerId, legacyTenantId);
    expect(after).toEqual({ role: 'owner', status: 'active', deleted: false });
  });

  it('is idempotent — re-running the backfill inserts nothing new', async () => {
    await pool.query(BACKFILL_SQL);
    await pool.query(BACKFILL_SQL);
    const rows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [legacyTenantId, legacyOwnerId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('leaves tenants whose owner already has a membership row untouched', async () => {
    const modern = await createTestTenant(pool); // creates tenant + users row
    const before = await pool.query(
      `SELECT id, role FROM users WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [modern.tenantId, modern.userId],
    );
    expect(before.rowCount).toBe(1);

    await pool.query(BACKFILL_SQL);

    const after = await pool.query(
      `SELECT id, role FROM users WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [modern.tenantId, modern.userId],
    );
    expect(after.rowCount).toBe(1);
    expect(after.rows[0].id).toBe(before.rows[0].id);
  });
});
