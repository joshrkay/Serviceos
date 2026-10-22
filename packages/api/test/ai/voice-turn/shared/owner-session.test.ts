/**
 * #1601 step 2 — RV-070 owner-line recognition has ONE home.
 *
 * The Gather adapter and the Layer 1 text-mode driver each resolved "is this
 * caller-ID an approver line?" on their own. The contract (RV-070, the SMS
 * approval transport's trust model via `proposals/approver-identity.ts`):
 *   - true when the caller-ID normalises to `tenant_settings.owner_phone`
 *     or the backup supervisor's mobile (the latter only when a userRepo is
 *     wired to read it);
 *   - best effort and FAIL-CLOSED: no settings repo, no caller-ID, or a
 *     failed lookup is never an owner session.
 */
import { describe, it, expect } from 'vitest';
import { resolveOwnerSession } from '../../../../src/ai/voice-turn/shared/owner-session';
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
  const row = { id: BACKUP_USER_ID, tenantId: TENANT, mobileNumber: BACKUP_MOBILE };
  return {
    findById: async (tenantId: string, id: string) =>
      tenantId === TENANT && id === BACKUP_USER_ID ? row : null,
  } as unknown as UserRepository;
}

describe('resolveOwnerSession (shared)', () => {
  it('recognises the owner phone across normalisation variants', async () => {
    const deps = { settingsRepo: settings() };
    await expect(resolveOwnerSession(deps, TENANT, OWNER_PHONE)).resolves.toBe(true);
    await expect(resolveOwnerSession(deps, TENANT, '(512) 555-0100')).resolves.toBe(true);
  });

  it('a customer phone is not an owner line', async () => {
    await expect(resolveOwnerSession({ settingsRepo: settings() }, TENANT, CUSTOMER_PHONE)).resolves.toBe(false);
  });

  it('recognises the backup supervisor mobile only when a userRepo is wired', async () => {
    const withBackup = settings({ backupSupervisorUserId: BACKUP_USER_ID });
    await expect(
      resolveOwnerSession({ settingsRepo: withBackup, userRepo: users() }, TENANT, BACKUP_MOBILE),
    ).resolves.toBe(true);
    await expect(resolveOwnerSession({ settingsRepo: withBackup }, TENANT, BACKUP_MOBILE)).resolves.toBe(false);
  });

  it('fails closed: no settings repo, no caller-ID, or a failed lookup is never an owner', async () => {
    await expect(resolveOwnerSession({}, TENANT, OWNER_PHONE)).resolves.toBe(false);
    await expect(resolveOwnerSession({ settingsRepo: settings() }, TENANT, undefined)).resolves.toBe(false);
    await expect(resolveOwnerSession({ settingsRepo: settings() }, TENANT, '')).resolves.toBe(false);
    const broken = {
      findByTenant: async () => {
        throw new Error('pg down');
      },
    } as unknown as SettingsRepository;
    await expect(resolveOwnerSession({ settingsRepo: broken }, TENANT, OWNER_PHONE)).resolves.toBe(false);
  });
});
