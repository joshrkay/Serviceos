/**
 * B1 — WHO an approval phone approves as.
 *
 * The SMS reply transport, the voice owner line and the one-tap link all
 * recognised an approver by phone (tenant_settings.owner_phone, or the
 * backup supervisor's mobile) and then approved as 'owner' regardless. A
 * backup dispatcher's texted Y therefore cleared the owner-only gates
 * (settings:update for config-writing cards) and stamped executedByRole
 * 'owner', so their price edits rewrote the price book and labor rate as
 * correction lessons. `resolveApproverRole` returns the real identity:
 *   - owner_phone → 'owner' (the channel's synthetic actor, no user id);
 *   - the ACTIVE backup supervisor's mobile → that user's DB role + subject;
 *   - anything else (a stranger, a deactivated backup, an unknown role) →
 *     null. Fail closed.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveApproverRole,
  resolveBackupSupervisorApprover,
  isApproverPhone,
} from '../../src/proposals/approver-identity';
import type { SettingsRepository, TenantSettings } from '../../src/settings/settings';
import type { User, UserRepository } from '../../src/users/user';

const TENANT = 't-approver-role';
const OWNER_PHONE = '+15125550100';
const BACKUP_MOBILE = '+15125550111';
const BACKUP_ID = 'user-backup';

function settings(overrides: Partial<TenantSettings> = {}): SettingsRepository {
  return {
    findByTenant: async () => ({ ownerPhone: OWNER_PHONE, backupSupervisorUserId: BACKUP_ID, ...overrides }),
  } as unknown as SettingsRepository;
}

function users(row: Partial<User> | null): Pick<UserRepository, 'findById'> {
  return {
    findById: async (tenantId: string, id: string) =>
      row && tenantId === TENANT && id === BACKUP_ID
        ? ({ id: BACKUP_ID, tenantId: TENANT, mobileNumber: BACKUP_MOBILE, ...row } as User)
        : null,
  };
}

describe('resolveApproverRole', () => {
  it('the owner phone approves as owner, with no user id (the channel actor stands in)', async () => {
    const approver = await resolveApproverRole(
      { settingsRepo: settings(), userRepo: users({ role: 'dispatcher' }) },
      TENANT,
      '(512) 555-0100',
    );
    expect(approver).toEqual({ role: 'owner', via: 'owner_phone' });
  });

  it("the backup supervisor approves as their real role, under their Clerk subject", async () => {
    const approver = await resolveApproverRole(
      { settingsRepo: settings(), userRepo: users({ role: 'dispatcher', clerkUserId: 'clerk-backup' }) },
      TENANT,
      '15125550111',
    );
    expect(approver).toEqual({ role: 'dispatcher', userId: 'clerk-backup', via: 'backup_supervisor' });
  });

  it('a backup with no Clerk subject yet is identified by the users row id', async () => {
    const approver = await resolveApproverRole(
      { settingsRepo: settings(), userRepo: users({ role: 'technician' }) },
      TENANT,
      BACKUP_MOBILE,
    );
    expect(approver).toEqual({ role: 'technician', userId: BACKUP_ID, via: 'backup_supervisor' });
  });

  it('the owner phone wins when the backup shares it', async () => {
    const approver = await resolveApproverRole(
      { settingsRepo: settings(), userRepo: users({ role: 'dispatcher', mobileNumber: OWNER_PHONE }) },
      TENANT,
      OWNER_PHONE,
    );
    expect(approver?.role).toBe('owner');
  });

  it.each([
    ['a stranger', users({ role: 'dispatcher' }), '+15125559999'],
    ['a deactivated backup', users({ role: 'dispatcher', status: 'suspended' }), BACKUP_MOBILE],
    ['a soft-deleted backup', users({ role: 'dispatcher', deletedAt: new Date() }), BACKUP_MOBILE],
    ['a backup whose role is not one we know', users({ role: 'superuser' as User['role'] }), BACKUP_MOBILE],
    ['a backup with no row', users(null), BACKUP_MOBILE],
    ['a backup row of another tenant', users({ role: 'dispatcher', tenantId: 't-other' }), BACKUP_MOBILE],
    ['an empty caller-ID', users({ role: 'dispatcher' }), ''],
  ])('fails closed for %s', async (_label, userRepo, from) => {
    await expect(resolveApproverRole({ settingsRepo: settings(), userRepo }, TENANT, from)).resolves.toBeNull();
  });

  it('ignores the backup when no userRepo is wired (owner_phone still works)', async () => {
    const deps = { settingsRepo: settings() };
    await expect(resolveApproverRole(deps, TENANT, BACKUP_MOBILE)).resolves.toBeNull();
    await expect(resolveApproverRole(deps, TENANT, OWNER_PHONE)).resolves.toMatchObject({ role: 'owner' });
  });

  it('a tenant with no owner phone still resolves its backup', async () => {
    const approver = await resolveApproverRole(
      { settingsRepo: settings({ ownerPhone: null }), userRepo: users({ role: 'dispatcher' }) },
      TENANT,
      BACKUP_MOBILE,
    );
    expect(approver).toMatchObject({ role: 'dispatcher', via: 'backup_supervisor' });
  });
});

describe('isApproverPhone (voicemail routing) agrees with resolveApproverRole', () => {
  it('is true exactly when an approver resolves', async () => {
    const deps = { settingsRepo: settings(), userRepo: users({ role: 'dispatcher', status: 'suspended' }) };
    await expect(isApproverPhone(deps, TENANT, OWNER_PHONE)).resolves.toBe(true);
    await expect(isApproverPhone(deps, TENANT, BACKUP_MOBILE)).resolves.toBe(false);
    await expect(isApproverPhone(deps, TENANT, undefined)).resolves.toBe(false);
  });
});

// The one-tap route re-checks a link minted for the backup against who the
// backup is when the link is tapped — phone-independent.
describe('resolveBackupSupervisorApprover', () => {
  it('is the active backup, as their real role and subject', async () => {
    await expect(
      resolveBackupSupervisorApprover(
        { settingsRepo: settings(), userRepo: users({ role: 'dispatcher', clerkUserId: 'clerk-backup' }) },
        TENANT,
      ),
    ).resolves.toEqual({ role: 'dispatcher', userId: 'clerk-backup', via: 'backup_supervisor' });
  });

  it.each([
    ['no backup is configured', settings({ backupSupervisorUserId: null }), users({ role: 'dispatcher' })],
    ['the backup is deactivated', settings(), users({ role: 'dispatcher', status: 'suspended' })],
    ['the backup row is gone', settings(), users(null)],
    ['the backup role is not one we know', settings(), users({ role: 'superuser' as User['role'] })],
  ])('is null when %s', async (_label, settingsRepo, userRepo) => {
    await expect(resolveBackupSupervisorApprover({ settingsRepo, userRepo }, TENANT)).resolves.toBeNull();
  });
});
