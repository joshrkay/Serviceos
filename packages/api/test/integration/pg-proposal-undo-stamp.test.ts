/**
 * Postgres integration — the undo stamp (`undone_at` / `undone_by`) written by
 * `PgProposalRepository.updateStatus` and `updateStatusIf`.
 *
 * Both methods build their SET list dynamically with a running `$n` counter and
 * `undoneBy` is the last optional clause. This pins that the placeholder
 * numbering still lines up with the params array against the real columns, so
 * a refactor of the counter cannot silently shift a value into the wrong column.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';

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

async function undoStampOf(pool: Pool, id: string) {
  const r = await pool.query(
    'SELECT status, undone_at, undone_by, rejection_reason FROM proposals WHERE id = $1',
    [id],
  );
  return r.rows[0] as {
    status: string;
    undone_at: Date | null;
    undone_by: string | null;
    rejection_reason: string | null;
  };
}

describe('Postgres integration — PgProposalRepository undo stamp', () => {
  let pool: Pool;
  let repo: PgProposalRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgProposalRepository(pool);
  });

  it('updateStatus writes undone_at and undone_by to their own columns', async () => {
    const tenant = await createTestTenant(pool);
    const id = await seedProposal(pool, tenant.tenantId, 'approved', 'undo-stamp-1');
    const undoneAt = new Date('2026-10-18T12:00:00.000Z');

    const updated = await repo.updateStatus(tenant.tenantId, id, 'undone', {
      rejectionReason: 'owner_undo',
      undoneAt,
      undoneBy: 'owner-user-1',
    });

    expect(updated?.status).toBe('undone');
    expect(updated?.undoneBy).toBe('owner-user-1');
    const row = await undoStampOf(pool, id);
    expect(row.status).toBe('undone');
    expect(row.rejection_reason).toBe('owner_undo');
    expect(row.undone_by).toBe('owner-user-1');
    expect(row.undone_at?.toISOString()).toBe(undoneAt.toISOString());
  });

  it('updateStatusIf writes undone_at and undone_by to their own columns', async () => {
    const tenant = await createTestTenant(pool);
    const id = await seedProposal(pool, tenant.tenantId, 'approved', 'undo-stamp-2');
    const undoneAt = new Date('2026-10-18T13:30:00.000Z');

    const updated = await repo.updateStatusIf(tenant.tenantId, id, ['approved'], 'undone', {
      rejectionReason: 'owner_undo',
      undoneAt,
      undoneBy: 'owner-user-2',
    });

    expect(updated?.status).toBe('undone');
    expect(updated?.undoneBy).toBe('owner-user-2');
    const row = await undoStampOf(pool, id);
    expect(row.status).toBe('undone');
    expect(row.rejection_reason).toBe('owner_undo');
    expect(row.undone_by).toBe('owner-user-2');
    expect(row.undone_at?.toISOString()).toBe(undoneAt.toISOString());
  });
});
