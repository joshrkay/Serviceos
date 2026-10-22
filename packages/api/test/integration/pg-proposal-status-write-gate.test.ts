/**
 * Postgres integration — the status-write gate in `PgProposalRepository`.
 *
 * `updateStatus` reads the row's status under its `FOR UPDATE` lock and runs
 * it through the lifecycle table before writing, so a caller cannot move a
 * proposal along an unlisted edge (e.g. reopen an executed one). The unit test
 * (`test/proposals/status-write-gate.test.ts`) pins the in-memory repo; this
 * pins the real locked read of the `status` column.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { ConflictError } from '../../src/shared/errors';

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

describe('Postgres integration — proposal status-write gate', () => {
  let pool: Pool;
  let repo: PgProposalRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgProposalRepository(pool);
  });

  it('applies a listed move', async () => {
    const tenant = await createTestTenant(pool);
    const id = await seedProposal(pool, tenant.tenantId, 'draft', 'swg-1');

    const updated = await repo.updateStatus(tenant.tenantId, id, 'ready_for_review');

    expect(updated?.status).toBe('ready_for_review');
    expect(await statusOf(pool, id)).toBe('ready_for_review');
  });

  it('refuses to reopen an executed proposal and leaves the row unchanged', async () => {
    const tenant = await createTestTenant(pool);
    const id = await seedProposal(pool, tenant.tenantId, 'executed', 'swg-2');

    await expect(repo.updateStatus(tenant.tenantId, id, 'ready_for_review')).rejects.toThrow(
      ConflictError,
    );
    expect(await statusOf(pool, id)).toBe('executed');
  });

  it('lets a supervisor hold pull a queued card back to draft', async () => {
    const tenant = await createTestTenant(pool);
    const id = await seedProposal(pool, tenant.tenantId, 'ready_for_review', 'swg-3');

    const updated = await repo.updateStatus(tenant.tenantId, id, 'draft');

    expect(updated?.status).toBe('draft');
  });
});
