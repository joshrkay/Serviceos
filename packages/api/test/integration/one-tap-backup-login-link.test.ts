/**
 * B4-2 parity — a one-tap link minted for the backup supervisor names them by
 * users row id, against real Postgres users and tenant_settings rows.
 *
 * The tap re-checks who the backup is now (resolveBackupSupervisorApprover,
 * the production wiring) and compared subjects: users.clerk_user_id. A backup
 * whose login changed after the text went out was refused as if replaced.
 * The link now carries the users row id, so the same row still approves (as
 * the login it holds now); another teammate made backup on the same mobile,
 * or a suspended backup, approves nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import express from 'express';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgUserRepository } from '../../src/users/pg-user';
import { resolveBackupSupervisorApprover } from '../../src/proposals/approver-identity';
import { createOneTapApproveRouter } from '../../src/routes/one-tap-approve';
import { createOneTapApproveToken, createInMemoryNonceStore } from '../../src/proposals/auto-approve';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const SECRET = 'b4-2-one-tap-secret';
const BACKUP_MOBILE = '+15125550111';

describe('Postgres integration — a backup one-tap link names the backup by users row id (B4-2 parity)', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let userRepo: PgUserRepository;

  async function insertMember(tenantId: string, mobile: string | null): Promise<{ id: string; subject: string }> {
    const id = crypto.randomUUID();
    const subject = `clerk_${id}`;
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, mobile_number)
       VALUES ($1, $2, $3, $4, 'dispatcher', $5)`,
      [id, tenantId, subject, `backup_${id}@example.com`, mobile],
    );
    return { id, subject };
  }

  /** A tenant whose backup was sent a link, as the text router mints it. */
  async function linkSentToBackup() {
    const { tenantId } = await createTestTenant(pool);
    const backup = await insertMember(tenantId, BACKUP_MOBILE);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region, backup_supervisor_user_id)
       VALUES ($1, $2, 'Backup Link Co', 'America/Chicago', 'TX', $3)`,
      [crypto.randomUUID(), tenantId, backup.id],
    );
    const deps = { settingsRepo, userRepo };
    const atSend = (await resolveBackupSupervisorApprover(deps, tenantId))!;
    expect(atSend).toMatchObject({ userId: backup.subject, userRowId: backup.id, role: 'dispatcher' });

    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const proposal = await proposalRepo.create({
      ...createProposal({
        tenantId,
        proposalType: 'draft_estimate',
        payload: {
          customerId: '7a1b2c3d-1111-4111-8111-111111111111',
          lineItems: [{ description: 'Labor', quantity: 1, unitPrice: 11500 }],
        },
        summary: 'Estimate for Mrs Lee',
        confidenceScore: 0.97,
        createdBy: 'voice',
      }),
      status: 'ready_for_review',
    });
    const app = express();
    app.use(
      '/public/proposals',
      createOneTapApproveRouter({
        proposalRepo,
        auditRepo,
        secret: SECRET,
        consumeNonce: createInMemoryNonceStore(),
        resolveBackupApprover: (t) => resolveBackupSupervisorApprover(deps, t),
      }),
    );
    const { token } = createOneTapApproveToken({
      proposalId: proposal.id,
      tenantId,
      secret: SECRET,
      approver: { userId: atSend.userId!, role: atSend.role, userRowId: atSend.userRowId! },
    });
    return {
      tenantId,
      backup,
      tap: () => request(app).get('/public/proposals/one-tap-approve').query({ token }),
      stored: async () => (await proposalRepo.findById(tenantId, proposal.id))!,
    };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    userRepo = new PgUserRepository(pool);
  });

  it('a backup whose login changed after the link went out still approves with it, as that login', async () => {
    const t = await linkSentToBackup();
    await pool.query(`UPDATE users SET clerk_user_id = $1 WHERE tenant_id = $2 AND id = $3`, [
      `clerk_linked_${t.backup.id}`,
      t.tenantId,
      t.backup.id,
    ]);

    const res = await t.tap();

    expect(res.status).toBe(200);
    expect(await t.stored()).toMatchObject({
      status: 'approved',
      executedBy: `clerk_linked_${t.backup.id}`,
      executedByRole: 'dispatcher',
    });
  });

  it('a different teammate made backup on the same mobile is refused', async () => {
    const t = await linkSentToBackup();
    // One mobile per tenant member (users_mobile_unique): the number moves to
    // the teammate, who is made the backup.
    await pool.query(`UPDATE users SET mobile_number = NULL WHERE tenant_id = $1 AND id = $2`, [
      t.tenantId,
      t.backup.id,
    ]);
    const teammate = await insertMember(t.tenantId, BACKUP_MOBILE);
    await pool.query(`UPDATE tenant_settings SET backup_supervisor_user_id = $1 WHERE tenant_id = $2`, [
      teammate.id,
      t.tenantId,
    ]);

    const res = await t.tap();

    expect(res.status).toBe(403);
    expect((await t.stored()).status).toBe('ready_for_review');
  });

  it('a backup suspended after the link went out is refused', async () => {
    const t = await linkSentToBackup();
    await pool.query(`UPDATE users SET status = 'suspended' WHERE tenant_id = $1 AND id = $2`, [
      t.tenantId,
      t.backup.id,
    ]);

    const res = await t.tap();

    expect(res.status).toBe(403);
    expect((await t.stored()).status).toBe('ready_for_review');
  });
});
