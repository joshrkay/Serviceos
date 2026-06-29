/**
 * Postgres integration — named cross-tenant sweep role (U2/U3/U4).
 *
 * With RLS_RUNTIME_ROLE=true, intentional cross-tenant sweeps run under the
 * named, auditable rls_cross_tenant (BYPASSRLS) role instead of an anonymous
 * privileged query. Proves: the helper actually assumes the role (current_user),
 * the role resets on release (no pool leak), and the proposal execution sweep
 * still reads/writes across tenants under it. Flag-off behaves like today.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { applyCrossTenantRole, clearTenantContext } from '../../src/db/rls-runtime-role';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';

let pool: Pool;
const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;

beforeAll(async () => {
  pool = await getSharedTestDb();
  process.env.RLS_RUNTIME_ROLE = 'true';
});
afterAll(async () => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
  await closeSharedTestDb();
});

async function seedApprovedProposal(tenantId: string, userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO proposals (id, tenant_id, proposal_type, created_by, status, approved_at)
     VALUES ($1, $2, 'reschedule_appointment', $3, 'approved', NOW() - INTERVAL '1 minute')`,
    [id, tenantId, userId]
  );
  return id;
}

describe('rls_cross_tenant sweep role (real Postgres, RLS_RUNTIME_ROLE=true)', () => {
  it('the helper actually assumes rls_cross_tenant, and resets it on clear (no pool leak)', async () => {
    const client = await pool.connect();
    try {
      await applyCrossTenantRole(client);
      const inRole = await client.query('SELECT current_user AS u');
      expect(inRole.rows[0].u).toBe('rls_cross_tenant');

      await clearTenantContext(client);
      const afterReset = await client.query('SELECT current_user AS u');
      expect(afterReset.rows[0].u).not.toBe('rls_cross_tenant'); // back to the connection principal
    } finally {
      client.release();
    }
  });

  it('the proposal execution sweep reads + claims across tenants under the role', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    const propA = await seedApprovedProposal(a.tenantId, a.userId);
    const propB = await seedApprovedProposal(b.tenantId, b.userId);

    const repo = new PgProposalRepository(pool);

    // No tenant GUC is set; the sweep must span tenants (would 0-row / error
    // under a tenant-scoped non-bypass role).
    const ready = await repo.findReadyForExecution(5000);
    const ids = new Set(ready.map((p) => p.id));
    expect(ids.has(propA)).toBe(true);
    expect(ids.has(propB)).toBe(true);

    // Claim across tenants (UPDATE works → role has write grant + BYPASSRLS).
    const claimed = await repo.claimForExecution(propB, 'execution-worker');
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('executing');
  });

  it('pool hygiene: after a sweep, the next checkout is back on the principal', async () => {
    const repo = new PgProposalRepository(pool);
    await repo.findReadyForExecution(5000); // runs under rls_cross_tenant, resets on release
    const client = await pool.connect();
    try {
      const who = await client.query('SELECT current_user AS u');
      expect(who.rows[0].u).not.toBe('rls_cross_tenant');
    } finally {
      client.release();
    }
  });

  it('flag OFF: the sweep still works on the connection principal', async () => {
    delete process.env.RLS_RUNTIME_ROLE;
    try {
      const a = await createTestTenant(pool);
      const propA = await seedApprovedProposal(a.tenantId, a.userId);
      const repo = new PgProposalRepository(pool);
      const ready = await repo.findReadyForExecution(5000);
      expect(ready.some((p) => p.id === propA)).toBe(true);
    } finally {
      process.env.RLS_RUNTIME_ROLE = 'true';
    }
  });
});
