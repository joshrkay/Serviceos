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

  it('ignores undone executions (only returns succeeded)', async () => {
    const tenant = await createTestTenant(pool);
    const proposalId = await createProposal(pool, tenant.tenantId, 'prop-undone-only');
    await repo.recordExecution({
      tenantId: tenant.tenantId,
      proposalId,
      executedPayload: {},
      executedBy: tenant.userId,
      status: 'undone',
      idempotencyKey: 'k-undone-only',
    });
    const result = await repo.findByIdempotencyKey(tenant.tenantId, 'k-undone-only');
    expect(result).toBeNull();
  });
});

/**
 * A retried proposal (onboarding POST /draft/retry: execution_failed -> draft ->
 * approved) re-runs under the SAME idempotency key as its failed attempt. The
 * upsert must let the new outcome replace a prior failure, and must keep
 * preserving a succeeded row.
 */
describe('PgProposalExecutionRepository.recordExecution — retry after a failed attempt', () => {
  let pool: Pool;
  let repo: PgProposalExecutionRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgProposalExecutionRepository(pool);
  });

  const input = (t: { tenantId: string; userId: string }, proposalId: string, key: string, extra: Record<string, unknown>) =>
    ({ tenantId: t.tenantId, proposalId, executedPayload: {}, executedBy: t.userId, idempotencyKey: key, ...extra }) as Parameters<
      PgProposalExecutionRepository['recordExecution']
    >[0];

  it('promotes the failed row to succeeded: one row, no error, and the idempotency marker now exists', async () => {
    const t = await createTestTenant(pool);
    const proposalId = await createProposal(pool, t.tenantId, 'prop-retry-1');
    const failed = await repo.recordExecution(input(t, proposalId, 'k-retry-1', { status: 'failed', errorMessage: 'PACK_ACTIVATION_IN_PROGRESS', executedPayload: { v: 1 } }));
    expect(await repo.findByIdempotencyKey(t.tenantId, 'k-retry-1')).toBeNull();

    const ok = await repo.recordExecution(input(t, proposalId, 'k-retry-1', { status: 'succeeded', executedPayload: { v: 2 } }));
    expect(ok.id).toBe(failed.id);
    expect(ok).toMatchObject({ status: 'succeeded', errorMessage: undefined, executedPayload: { v: 2 } });
    expect(await repo.listByProposal(t.tenantId, proposalId)).toHaveLength(1);
    expect((await repo.findLatestByProposal(t.tenantId, proposalId))?.status).toBe('succeeded');
    expect((await repo.findByIdempotencyKey(t.tenantId, 'k-retry-1'))?.id).toBe(failed.id);
  });

  it('a second failure refreshes the recorded error instead of keeping the first one', async () => {
    const t = await createTestTenant(pool);
    const proposalId = await createProposal(pool, t.tenantId, 'prop-retry-2');
    await repo.recordExecution(input(t, proposalId, 'k-retry-2', { status: 'failed', errorMessage: 'first' }));
    const again = await repo.recordExecution(input(t, proposalId, 'k-retry-2', { status: 'failed', errorMessage: 'second' }));
    expect(again).toMatchObject({ status: 'failed', errorMessage: 'second' });
    expect(await repo.listByProposal(t.tenantId, proposalId)).toHaveLength(1);
  });

  it('never overwrites a succeeded row (the original execution is preserved)', async () => {
    const t = await createTestTenant(pool);
    const proposalId = await createProposal(pool, t.tenantId, 'prop-retry-3');
    const first = await repo.recordExecution(input(t, proposalId, 'k-retry-3', { status: 'succeeded', executedPayload: { v: 1 } }));
    const replay = await repo.recordExecution(input(t, proposalId, 'k-retry-3', { status: 'failed', errorMessage: 'late', executedPayload: { v: 2 } }));
    expect(replay).toMatchObject({ id: first.id, status: 'succeeded', executedPayload: { v: 1 } });
    expect(replay.errorMessage).toBeUndefined();
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
       (id, tenant_id, proposal_type, status, payload, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [id, tenantId, 'test_proposal', 'draft', '{}', idempotencyKey, 'test'],
  );
  return id;
}
