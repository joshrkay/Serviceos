import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';

/**
 * §11 H1 — Migration 099 adds a partial unique index on
 * proposal_executions(tenant_id, idempotency_key) so the IdempotencyGuard
 * can resolve previous executions by (tenant, key) with an indexed lookup
 * instead of the current O(n) in-process scan over all proposals per
 * tenant.
 *
 * The existing migration 064 (inline inside the proposal_executions
 * CREATE TABLE block in schema.ts ~line 1553) already has a UNIQUE INDEX
 * on (tenant_id, proposal_id, idempotency_key) — but that's keyed by
 * proposal_id, which the guard does not know up-front when resolving a
 * replay. This new index drops proposal_id from the key.
 */
describe('migration 099: proposal_executions idempotency index (§11 H1)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  it('creates the partial unique index on (tenant_id, idempotency_key)', async () => {
    const { rows } = await pool.query(`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'proposal_executions'
         AND indexname = 'proposal_executions_tenant_idempotency_uniq'`);
    expect(rows).toHaveLength(1);
    const def: string = rows[0].indexdef;
    expect(def).toMatch(/UNIQUE/);
    expect(def).toMatch(/tenant_id/);
    expect(def).toMatch(/idempotency_key/);
    // Must NOT reference proposal_id — that's the existing wider index's job.
    expect(def).not.toMatch(/proposal_id/);
    // Partial index — NULL idempotency_key rows should be excluded.
    expect(def).toMatch(/WHERE/);
  });

  it('blocks duplicate (tenant_id, idempotency_key) inserts within a tenant', async () => {
    // Use two distinct parent proposals so the pre-existing wider index
    // on (tenant_id, proposal_id, idempotency_key) cannot fire — this
    // isolates the new (tenant_id, idempotency_key) index as the only
    // uniqueness constraint capable of rejecting the second insert,
    // matching how IdempotencyGuard.findPreviousExecution looks up
    // replays by (tenant, key) alone without knowing proposal_id.
    const tenant = await createTestTenant(pool);
    const proposalA = await createProposal(pool, tenant.tenantId, 'prop-key-A1');
    const proposalB = await createProposal(pool, tenant.tenantId, 'prop-key-A2');

    await insertExecution(pool, tenant.tenantId, proposalA, 'k-cross-proposal');
    await expect(
      insertExecution(pool, tenant.tenantId, proposalB, 'k-cross-proposal'),
    ).rejects.toThrow(/duplicate key/);
  });

  it('allows the same idempotency_key across different tenants', async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    const propA = await createProposal(pool, tenantA.tenantId, 'prop-xtenant-A');
    const propB = await createProposal(pool, tenantB.tenantId, 'prop-xtenant-B');

    await insertExecution(pool, tenantA.tenantId, propA, 'exec-key-shared');
    await insertExecution(pool, tenantB.tenantId, propB, 'exec-key-shared');

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM proposal_executions WHERE idempotency_key = $1`,
      ['exec-key-shared'],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('allows multiple NULL idempotency_key rows per tenant (partial index excludes NULLs)', async () => {
    const tenant = await createTestTenant(pool);
    const propId = await createProposal(pool, tenant.tenantId, 'prop-null-key');

    await insertExecution(pool, tenant.tenantId, propId, null);
    await insertExecution(pool, tenant.tenantId, propId, null);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM proposal_executions
        WHERE tenant_id = $1 AND idempotency_key IS NULL`,
      [tenant.tenantId],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Insert a parent proposals row. proposals.idempotency_key is NOT NULL with
 * its own UNIQUE INDEX on (tenant_id, idempotency_key), so each call needs
 * a unique key per tenant.
 */
async function createProposal(
  pool: Pool,
  tenantId: string,
  idempotencyKey: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO proposals
       (id, tenant_id, proposal_type, status, payload, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [id, tenantId, 'test_proposal', 'draft', '{}', idempotencyKey, 'test'],
  );
  return id;
}

async function insertExecution(
  pool: Pool,
  tenantId: string,
  proposalId: string,
  idempotencyKey: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO proposal_executions
       (id, tenant_id, proposal_id, executed_payload, executed_by, status, idempotency_key)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [id, tenantId, proposalId, '{}', 'test', 'succeeded', idempotencyKey],
  );
  return id;
}
