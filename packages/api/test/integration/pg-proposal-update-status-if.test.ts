/**
 * Postgres integration — `PgProposalRepository.updateStatusIf` (ANS-001).
 *
 * The E1 booking revocation depends on the precondition living INSIDE the
 * UPDATE (`status = ANY($3::text[])`), not in a prior read: the execution
 * worker can move a proposal approved → executing → executed between a read
 * and a write. `test/proposals/update-status-if.test.ts` pins the semantics
 * against the in-memory repo, but per CLAUDE.md a mocked DB is never the only
 * proof a query works — this pins the real columns, the real `$3::text[]` cast
 * against the TEXT status column, and real atomicity under a concurrent writer.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import type { ProposalStatus } from '../../src/proposals/proposal';

const LIVE: ProposalStatus[] = ['draft', 'ready_for_review', 'approved'];

async function seedProposal(
  pool: Pool,
  tenantId: string,
  status: string,
  idempotencyKey: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO proposals
       (id, tenant_id, proposal_type, status, payload, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [id, tenantId, 'create_appointment', status, '{}', idempotencyKey, 'voice'],
  );
  return id;
}

async function statusOf(pool: Pool, id: string): Promise<string> {
  const r = await pool.query('SELECT status FROM proposals WHERE id = $1', [id]);
  return r.rows[0].status as string;
}

describe('Postgres integration — PgProposalRepository.updateStatusIf (ANS-001)', () => {
  let pool: Pool;
  let repo: PgProposalRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgProposalRepository(pool);
  });

  it('writes when the row is still in a precondition status', async () => {
    const tenant = await createTestTenant(pool);
    const id = await seedProposal(pool, tenant.tenantId, 'draft', 'usi-1');

    const updated = await repo.updateStatusIf(tenant.tenantId, id, LIVE, 'rejected', {
      rejectionReason: 'life_safety_emergency',
      rejectionDetails: 'E1 life-safety signal during the call',
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('rejected');
    // Rejection metadata really landed in the real columns.
    expect(updated!.rejectionReason).toBe('life_safety_emergency');
    expect(updated!.rejectionDetails).toBe('E1 life-safety signal during the call');
    expect(await statusOf(pool, id)).toBe('rejected');
  });

  it('returns null and leaves an executed row untouched', async () => {
    const tenant = await createTestTenant(pool);
    const id = await seedProposal(pool, tenant.tenantId, 'executed', 'usi-2');

    const updated = await repo.updateStatusIf(tenant.tenantId, id, LIVE, 'rejected');

    expect(updated).toBeNull();
    // The whole point: a live booking's terminal status survives the revoke.
    expect(await statusOf(pool, id)).toBe('executed');
  });

  it('never crosses tenants', async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    const id = await seedProposal(pool, tenantA.tenantId, 'draft', 'usi-3');

    const updated = await repo.updateStatusIf(tenantB.tenantId, id, LIVE, 'rejected');

    expect(updated).toBeNull();
    expect(await statusOf(pool, id)).toBe('draft');
  });

  it('is atomic under a concurrent revoke — exactly one writer wins', async () => {
    const tenant = await createTestTenant(pool);
    const id = await seedProposal(pool, tenant.tenantId, 'approved', 'usi-4');

    // Both racers see 'approved' and both try to revoke. The precondition is
    // part of the UPDATE, so the loser matches zero rows rather than
    // re-rejecting a row the winner already moved.
    const [a, b] = await Promise.all([
      repo.updateStatusIf(tenant.tenantId, id, LIVE, 'rejected'),
      repo.updateStatusIf(tenant.tenantId, id, LIVE, 'rejected'),
    ]);

    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect(await statusOf(pool, id)).toBe('rejected');
  });

  it('loses to a concurrent execution rather than clobbering it', async () => {
    // The exact race the E1 revocation must not lose destructively: the
    // execution worker moves approved → executed while the revoke is deciding.
    const tenant = await createTestTenant(pool);
    const id = await seedProposal(pool, tenant.tenantId, 'approved', 'usi-5');
    await pool.query(`UPDATE proposals SET status = 'executed' WHERE id = $1`, [id]);

    const revoked = await repo.updateStatusIf(tenant.tenantId, id, LIVE, 'rejected');

    expect(revoked).toBeNull();
    expect(await statusOf(pool, id)).toBe('executed');
  });
});
