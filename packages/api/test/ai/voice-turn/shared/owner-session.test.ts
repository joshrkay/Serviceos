/**
 * #1601 step 2 — RV-070 owner-line recognition has ONE home.
 *
 * The Gather adapter and the Layer 1 text-mode driver each resolved "is this
 * caller-ID an approver line?" on their own. The contract (RV-070, the SMS
 * approval transport's trust model via `proposals/approver-identity.ts`):
 *   - an approver when the caller-ID normalises to `tenant_settings.owner_phone`
 *     (the owner) or the backup supervisor's mobile (their own role — only
 *     when a userRepo is wired to read it);
 *   - best effort and FAIL-CLOSED: no settings repo, no caller-ID, or a
 *     failed lookup is never an owner session (null).
 */
import { describe, it, expect } from 'vitest';
import { ownerLineStamp, resolveOwnerLineApprover } from '../../../../src/ai/voice-turn/shared/owner-session';
import type { SettingsRepository, TenantSettings } from '../../../../src/settings/settings';
import type { UserRepository } from '../../../../src/users/user';

const TENANT = 't-1601-owner';
const OWNER_PHONE = '+15125550100';
const CUSTOMER_PHONE = '+15125559999';
const BACKUP_USER_ID = 'user-backup';
const BACKUP_MOBILE = '+15125550111';

function settings(overrides: Partial<TenantSettings> = {}): SettingsRepository {
  return {
    findByTenant: async () => ({ ownerPhone: OWNER_PHONE, ...overrides }),
  } as unknown as SettingsRepository;
}

function users(): UserRepository {
  // B1 — a real users row always carries a role; the backup approves as it.
  const row = { id: BACKUP_USER_ID, tenantId: TENANT, role: 'dispatcher', mobileNumber: BACKUP_MOBILE };
  return {
    findById: async (tenantId: string, id: string) =>
      tenantId === TENANT && id === BACKUP_USER_ID ? row : null,
  } as unknown as UserRepository;
}

describe('resolveOwnerLineApprover (shared)', () => {
  it('recognises the owner phone across normalisation variants', async () => {
    const deps = { settingsRepo: settings() };
    const owner = { role: 'owner', via: 'owner_phone' };
    await expect(resolveOwnerLineApprover(deps, TENANT, OWNER_PHONE)).resolves.toEqual(owner);
    await expect(resolveOwnerLineApprover(deps, TENANT, '(512) 555-0100')).resolves.toEqual(owner);
  });

  it('a customer phone is not an owner line', async () => {
    await expect(resolveOwnerLineApprover({ settingsRepo: settings() }, TENANT, CUSTOMER_PHONE)).resolves.toBeNull();
  });

  it('recognises the backup supervisor mobile only when a userRepo is wired', async () => {
    const withBackup = settings({ backupSupervisorUserId: BACKUP_USER_ID });
    await expect(
      resolveOwnerLineApprover({ settingsRepo: withBackup, userRepo: users() }, TENANT, BACKUP_MOBILE),
    ).resolves.toEqual({ role: 'dispatcher', userId: BACKUP_USER_ID, userRowId: BACKUP_USER_ID, via: 'backup_supervisor' });
    await expect(resolveOwnerLineApprover({ settingsRepo: withBackup }, TENANT, BACKUP_MOBILE)).resolves.toBeNull();
  });

  it('fails closed: no settings repo, no caller-ID, or a failed lookup is never an owner', async () => {
    await expect(resolveOwnerLineApprover({}, TENANT, OWNER_PHONE)).resolves.toBeNull();
    await expect(resolveOwnerLineApprover({ settingsRepo: settings() }, TENANT, undefined)).resolves.toBeNull();
    await expect(resolveOwnerLineApprover({ settingsRepo: settings() }, TENANT, '')).resolves.toBeNull();
    const broken = {
      findByTenant: async () => {
        throw new Error('pg down');
      },
    } as unknown as SettingsRepository;
    await expect(resolveOwnerLineApprover({ settingsRepo: broken }, TENANT, OWNER_PHONE)).resolves.toBeNull();
  });
});

// B1 / B4-2 — what pick-up carries on the session as `ownerLineApprover`.
describe('ownerLineStamp', () => {
  it("a backup's stamp keeps their role, subject and users row; nothing else", () => {
    expect(
      ownerLineStamp({ role: 'dispatcher', userId: 'clerk-backup', userRowId: BACKUP_USER_ID, via: 'backup_supervisor' }),
    ).toEqual({ role: 'dispatcher', userId: 'clerk-backup', userRowId: BACKUP_USER_ID });
  });

  it("the owner phone's stamp is the role alone (no subject, no users row)", () => {
    expect(ownerLineStamp({ role: 'owner', via: 'owner_phone' })).toEqual({ role: 'owner' });
  });
});
