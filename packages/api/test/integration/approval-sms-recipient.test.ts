import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { resolveApprovalSmsPhone, resolveApproverRole } from '../../src/proposals/approver-identity';
import { routeUnsupervisedProposal } from '../../src/proposals/auto-approve';

/**
 * B1 follow-up — where an approval SMS goes, against real Postgres.
 *
 * With no tenant_settings.owner_phone the unsupervised routing SMS (and the
 * voice one-tap fallback, and the owner close chain) goes to the backup
 * supervisor's users.mobile_number. The resolver read the users row by id and
 * texted it whatever its state, so a backup who had been deactivated (users.status
 * 'suspended') or removed (deleted_at) was still sent job details. It now
 * texts the backup only while they are an active member of this tenant.
 *
 * Pins the real columns: tenant_settings.owner_phone /
 * backup_supervisor_user_id, users.mobile_number / status / deleted_at.
 */
describe('Postgres integration — B1 follow-up: an approval SMS reaches only an active backup', () => {
  const BACKUP_PHONE = '+15125550122';

  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let backupId: string;
  let settingsRepo: PgSettingsRepository;
  let userRepo: PgUserRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    settingsRepo = new PgSettingsRepository(pool);
    userRepo = new PgUserRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    backupId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, mobile_number)
       VALUES ($1, $2, $3, $4, 'dispatcher', $5)`,
      [backupId, tenant.tenantId, `clerk-backup-${backupId}`, `backup-${backupId}@example.com`, BACKUP_PHONE],
    );
    const now = new Date();
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'No Owner Phone Co',
      timezone: 'America/New_York',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });
    await settingsRepo.update(tenant.tenantId, { backupSupervisorUserId: backupId });
    const stored = await settingsRepo.findByTenant(tenant.tenantId);
    expect(stored?.ownerPhone ?? null).toBeNull();
    expect(stored?.backupSupervisorUserId).toBe(backupId);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  const setBackup = (sql: string) => pool.query(sql, [tenant.tenantId, backupId]);

  /** The routing SMS exactly as app.ts wires it, and what it sent. */
  async function routeOneCard() {
    const sent: { to: string; body: string }[] = [];
    const proposalId = crypto.randomUUID();
    const ownerPhone = await resolveApprovalSmsPhone({ settingsRepo, userRepo }, tenant.tenantId);
    const result = await routeUnsupervisedProposal(
      {
        auditRepo,
        secret: 'approval-sms-recipient-secret',
        sendSms: async (to, body) => {
          sent.push({ to, body });
        },
        resolveLinkApprover: (tenantId, phone) => resolveApproverRole({ settingsRepo, userRepo }, tenantId, phone),
      },
      {
        tenantId: tenant.tenantId,
        proposalId,
        channel: 'other',
        ...(ownerPhone ? { ownerPhone } : {}),
        summaryText: 'Book Mrs Lee Tuesday 2pm',
      },
    );
    return { sent, result, ownerPhone };
  }

  it('an active backup is the recipient and gets the text', async () => {
    const { sent, result, ownerPhone } = await routeOneCard();
    expect(ownerPhone).toBe(BACKUP_PHONE);
    expect(result.smsSent).toBe(true);
    expect(sent.map((s) => s.to)).toEqual([BACKUP_PHONE]);
  });

  it('a deactivated (suspended) backup is texted nothing', async () => {
    await setBackup(`UPDATE users SET status = 'suspended' WHERE tenant_id = $1 AND id = $2`);
    try {
      const { sent, result, ownerPhone } = await routeOneCard();
      expect(ownerPhone).toBeNull();
      expect(result.smsSent).toBe(false);
      expect(sent).toEqual([]);
    } finally {
      await setBackup(`UPDATE users SET status = 'active' WHERE tenant_id = $1 AND id = $2`);
    }
  });

  it('a removed (soft-deleted) backup is texted nothing', async () => {
    await setBackup(`UPDATE users SET deleted_at = NOW() WHERE tenant_id = $1 AND id = $2`);
    try {
      const { sent, ownerPhone } = await routeOneCard();
      expect(ownerPhone).toBeNull();
      expect(sent).toEqual([]);
    } finally {
      await setBackup(`UPDATE users SET deleted_at = NULL WHERE tenant_id = $1 AND id = $2`);
    }
  });
});
