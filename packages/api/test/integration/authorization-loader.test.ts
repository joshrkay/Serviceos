/**
 * Postgres integration — DB-authoritative authorization loader
 * (QUALITY-2026-07-12 WS4).
 *
 * The auth middleware resolves each request's role + access state from the
 * `users` table via `createAuthorizationLoader`. This pins that query against
 * the REAL migrated schema — the exact columns it reads (`id`, `role`, `status`,
 * `deleted_at`) and the `(tenant_id, clerk_user_id)` lookup — so a column rename
 * can't ship green behind a mocked Pool (the failure mode CLAUDE.md calls out).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createAuthorizationLoader } from '../../src/auth/authorization-loader';

describe('Postgres integration — createAuthorizationLoader', () => {
  let pool: Pool;
  let load: ReturnType<typeof createAuthorizationLoader>;
  let tenantA: string;
  let ownerACanonicalId: string;
  let ownerAClerkId: string;
  let tenantB: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    load = createAuthorizationLoader(pool);
    const a = await createTestTenant(pool);
    tenantA = a.tenantId;
    ownerACanonicalId = a.userId;
    ownerAClerkId = `user_${crypto.randomUUID()}`;
    await pool.query(
      `UPDATE users SET clerk_user_id = $1 WHERE tenant_id = $2 AND id = $3`,
      [ownerAClerkId, tenantA, ownerACanonicalId],
    );
    tenantB = (await createTestTenant(pool)).tenantId;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('resolves a distinct Clerk subject to its canonical users.id and DB role', async () => {
    const rec = await load(ownerAClerkId, tenantA);
    expect(rec).not.toBeNull();
    expect(rec!.userId).toBe(ownerACanonicalId);
    expect(rec!.userId).not.toBe(ownerAClerkId);
    expect(rec!.role).toBe('owner');
    expect(rec!.status).toBe('active');
    expect(rec!.deleted).toBe(false);
  });

  it('role is authoritative from the DB — a demoted user resolves the new role', async () => {
    await pool.query(
      `UPDATE users SET role = 'technician' WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantA, ownerAClerkId],
    );
    const rec = await load(ownerAClerkId, tenantA);
    expect(rec!.role).toBe('technician');
    // Restore for later assertions.
    await pool.query(
      `UPDATE users SET role = 'owner' WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantA, ownerAClerkId],
    );
  });

  it('reflects a suspended status', async () => {
    await pool.query(
      `UPDATE users SET status = 'suspended' WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantA, ownerAClerkId],
    );
    const rec = await load(ownerAClerkId, tenantA);
    expect(rec!.status).toBe('suspended');
    await pool.query(
      `UPDATE users SET status = 'active' WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantA, ownerAClerkId],
    );
  });

  it('reflects a soft-deleted (deleted_at) user', async () => {
    await pool.query(
      `UPDATE users SET deleted_at = NOW() WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantA, ownerAClerkId],
    );
    const rec = await load(ownerAClerkId, tenantA);
    expect(rec!.deleted).toBe(true);
    await pool.query(
      `UPDATE users SET deleted_at = NULL WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantA, ownerAClerkId],
    );
  });

  it('returns null for an unknown user and never crosses tenants', async () => {
    expect(await load('user_does_not_exist', tenantA)).toBeNull();
    // Owner A is not a member of tenant B — must not resolve there.
    expect(await load(ownerAClerkId, tenantB)).toBeNull();
  });
});
