import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';

/**
 * §11 H1 (Task 2) — PgProposalExecutionRepository.findByIdempotencyKey
 *
 * Backed by the partial unique index
 * `proposal_executions_tenant_idempotency_uniq` (migration 099, Task 1).
 * Used by IdempotencyGuard.findPreviousExecution (Task 3) to short-circuit
 * re-execution of a proposal whose side effect already landed, via an
 * indexed (tenant_id, idempotency_key) lookup instead of an O(n)
 * in-process scan over all proposals per tenant.
 *
 * Contract:
 *   - Returns null when no execution exists for the (tenant, key) pair.
 *   - Returns the latest succeeded execution for the key, scoped strictly
 *     to tenantId (no cross-tenant leakage).
 *   - Skips status='failed' and status='undone' rows — only a succeeded
 *     execution satisfies the guard. A failed attempt should be retried.
 */
describe('PgProposalExecutionRepository.findByIdempotencyKey (§11 H1)', () => {
  let pool: Pool;
  let repo: PgProposalExecutionRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgProposalExecutionRepository(pool);
  });

  it('returns null when no execution exists for that key', async () => {
    const tenant = await createTestTenant(pool);
    const result = await repo.findByIdempotencyKey(tenant.tenantId, 'never-used-key');
    expect(result).toBeNull();
  });

  it('returns the prior execution for a matching key with status=succeeded', async () => {
    const tenant = await createTestTenant(pool);
    const proposalId = await createProposal(pool, tenant.tenantId, 'prop-find-1');
    await repo.recordExecution({
      tenantId: tenant.tenantId,
      proposalId,
      executedPayload: { foo: 'bar' },
      executedBy: tenant.userId,
      status: 'succeeded',
      idempotencyKey: 'k-find-1',
    });
    const result = await repo.findByIdempotencyKey(tenant.tenantId, 'k-find-1');
    expect(result).not.toBeNull();
    expect(result?.proposalId).toBe(proposalId);
    expect(result?.idempotencyKey).toBe('k-find-1');
    expect(result?.status).toBe('succeeded');
    expect(result?.executedPayload).toEqual({ foo: 'bar' });
  });

  it('scopes by tenant — does not leak across tenants', async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    const proposalB = await createProposal(pool, tenantB.tenantId, 'prop-tenant-scope');
    await repo.recordExecution({
      tenantId: tenantB.tenantId,
      proposalId: proposalB,
      executedPayload: {},
      executedBy: tenantB.userId,
      status: 'succeeded',
      idempotencyKey: 'k-tenant-scope',
    });
    const result = await repo.findByIdempotencyKey(tenantA.tenantId, 'k-tenant-scope');
    expect(result).toBeNull();
  });

  it('ignores failed executions (only returns succeeded)', async () => {
    const tenant = await createTestTenant(pool);
    const proposalId = await createProposal(pool, tenant.tenantId, 'prop-failed-only');
    await repo.recordExecution({
      tenantId: tenant.tenantId,
      proposalId,
      executedPayload: {},
      executedBy: tenant.userId,
      status: 'failed',
      errorMessage: 'boom',
      idempotencyKey: 'k-failed-only',
    });
    const result = await repo.findByIdempotencyKey(tenant.tenantId, 'k-failed-only');
    expect(result).toBeNull();
  });
});

/**
 * Insert a parent proposals row. proposals.idempotency_key is NOT NULL
 * with its own UNIQUE INDEX on (tenant_id, idempotency_key), so each
 * call needs a unique key per tenant. Mirrors the helper in
 * migration-099-idempotency-index.test.ts.
 */
async function createProposal(
  pool: Pool,
  tenantId: string,
  idempotencyKey: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO proposals
       (id, tenant_id, proposal_type, payload, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [id, tenantId, 'test_proposal', '{}', idempotencyKey, 'test'],
  );
  return id;
}
