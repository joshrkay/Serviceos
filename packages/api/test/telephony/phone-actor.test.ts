/**
 * Caller-ID → actor. The phone has only ever had a boolean (ownerSession);
 * the shared lookup dispatch needs an ACTOR for its RBAC gate and for
 * lookup_my_day's self-scoping. Resolution order, all tenant-scoped:
 *   1. a tenant user whose registered mobile matches the caller-ID (on an
 *      owner line, compared the way the approver lookup compares phones);
 *   2. otherwise, if the caller-ID is the owner phone, the tenant's single
 *      active owner-role user (bridge for owners with no mobile on file);
 *   3. otherwise none. A backup supervisor's line is that backup or nobody.
 *
 * Fixture: `InMemoryUserRepository` (src/users/user.ts), not a hand-rolled
 * mock — so `findByTenant`'s deleted-row filtering is the REAL repository
 * contract (it excludes soft-deleted rows itself), and `resolvePhoneActor`'s
 * own `isActive()` filter is exercised against a repo that behaves like
 * production rather than against assumptions baked into a stub.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolvePhoneActor, type PhoneActorDeps } from '../../src/telephony/phone-actor';
import { InMemoryUserRepository, type User } from '../../src/users/user';

const TENANT = 't-actor';
/** The caller-ID matched `tenant_settings.owner_phone` (resolveOwnerLineApprover). */
const OWNER_PHONE_LINE = { via: 'owner_phone' } as const;

async function seed(
  repo: InMemoryUserRepository,
  over: Partial<User> & Pick<User, 'id' | 'role'>,
): Promise<User> {
  return repo.create!({
    tenantId: TENANT,
    email: `${over.id}@example.com`,
    canFieldServe: true,
    ...over,
  });
}

function deps(repo: InMemoryUserRepository): PhoneActorDeps {
  return { userRepo: repo };
}

describe('resolvePhoneActor', () => {
  it('resolves a technician calling from their registered mobile (clerk subject preferred)', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-tech', role: 'technician', clerkUserId: 'clerk-tech', mobileNumber: '+15125550111' });

    const actor = await resolvePhoneActor(deps(repo), TENANT, '+1 (512) 555-0111', null);

    expect(actor).toEqual({ userId: 'clerk-tech', via: 'mobile' });
  });

  it('falls back to the row id when the user has no clerk subject', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-tech', role: 'technician', mobileNumber: '+15125550111' });

    const actor = await resolvePhoneActor(deps(repo), TENANT, '+15125550111', null);

    expect(actor).toEqual({ userId: 'u-tech', via: 'mobile' });
  });

  it('never resolves a suspended user from a mobile match', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-tech', role: 'technician', mobileNumber: '+15125550111', status: 'suspended' });

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550111', null)).toBeNull();
  });

  it('a suspended user whose mobile matches resolves NO actor even on the owner line (never the bridge)', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' });
    await seed(repo, {
      id: 'u-backup',
      role: 'dispatcher',
      clerkUserId: 'clerk-backup',
      mobileNumber: '+15125550111',
      status: 'suspended',
    });

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550111', OWNER_PHONE_LINE)).toBeNull();
  });

  it('bridges the owner line to the SOLE active owner when no mobile matches', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' });
    await seed(repo, { id: 'u-tech', role: 'technician', mobileNumber: '+15125550111' });

    const actor = await resolvePhoneActor(deps(repo), TENANT, '+15125550100', OWNER_PHONE_LINE);

    expect(actor).toEqual({ userId: 'clerk-owner', via: 'owner_phone' });
  });

  it('refuses the owner-line bridge when there are two active owners (ambiguous → fail closed)', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner-a', role: 'owner' });
    await seed(repo, { id: 'u-owner-b', role: 'owner' });

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550100', OWNER_PHONE_LINE)).toBeNull();
  });

  it('ignores deleted and suspended owners when counting the bridge candidates', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner-live', role: 'owner' });
    await seed(repo, { id: 'u-owner-gone', role: 'owner', deletedAt: new Date() });
    await seed(repo, { id: 'u-owner-susp', role: 'owner', status: 'suspended' });

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550100', OWNER_PHONE_LINE)).toEqual({
      userId: 'u-owner-live',
      via: 'owner_phone',
    });
  });

  it('resolves nothing when the owner line matches but the tenant has no active owner user (the zero-owner branch)', async () => {
    const repo = new InMemoryUserRepository();

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550100', OWNER_PHONE_LINE)).toBeNull();
  });

  it('does NOT bridge a non-owner line: a customer number with no mobile match resolves nothing', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner', role: 'owner' });
    const findByTenantSpy = vi.spyOn(repo, 'findByTenant');

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125559999', null)).toBeNull();
    expect(findByTenantSpy).not.toHaveBeenCalled();
  });

  it('is fail-soft: a repository error resolves nothing and never throws', async () => {
    const d: PhoneActorDeps = {
      userRepo: {
        findByMobileNumber: vi.fn(async () => { throw new Error('pg down'); }),
        findByTenant: vi.fn(async () => []),
      },
    };

    await expect(resolvePhoneActor(d, TENANT, '+15125550111', OWNER_PHONE_LINE)).resolves.toBeNull();
  });

  it('resolves nothing for a withheld / unparseable caller-ID or a missing userRepo', async () => {
    const repo = new InMemoryUserRepository();
    expect(await resolvePhoneActor(deps(repo), TENANT, undefined, OWNER_PHONE_LINE)).toBeNull();
    expect(await resolvePhoneActor(deps(repo), TENANT, '', OWNER_PHONE_LINE)).toBeNull();
    expect(await resolvePhoneActor(deps(repo), TENANT, 'anonymous', OWNER_PHONE_LINE)).toBeNull();
    expect(await resolvePhoneActor({}, TENANT, '+15125550111', OWNER_PHONE_LINE)).toBeNull();
  });
});

// B4-1 — the approver lookup (resolveApproverRole) recognises the owner line
// comparing phones with normalizePhone; the actor lookup matched E.164
// exactly. A backup whose stored mobile was formatted differently was
// recognised as the backup, missed here, and bridged to the OWNER's actor.
describe('resolvePhoneActor — on an owner line, phones compare the way the approver lookup compares them', () => {
  const BACKUP_LINE = { via: 'backup_supervisor', userId: 'clerk-backup' } as const;

  it.each(['(512) 555-0111', '15125550111', '512.555.0111', '+1 512 555 0111'])(
    'a backup stored as %s resolves to the backup, not the owner',
    async (stored) => {
      const repo = new InMemoryUserRepository();
      await seed(repo, { id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' });
      await seed(repo, { id: 'u-backup', role: 'technician', clerkUserId: 'clerk-backup', mobileNumber: stored });

      expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550111', BACKUP_LINE)).toEqual({
        userId: 'clerk-backup',
        via: 'mobile',
      });
    },
  );

  it('an owner whose own profile mobile is formatted differently resolves directly (no bridge needed)', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner-a', role: 'owner', clerkUserId: 'clerk-owner-a', mobileNumber: '(512) 555-0100' });
    await seed(repo, { id: 'u-owner-b', role: 'owner', clerkUserId: 'clerk-owner-b' });

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550100', OWNER_PHONE_LINE)).toEqual({
      userId: 'clerk-owner-a',
      via: 'mobile',
    });
  });

  it('a suspended teammate matched that way resolves nobody (never the bridge)', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' });
    await seed(repo, { id: 'u-tech', role: 'technician', mobileNumber: '(512) 555-0100', status: 'suspended' });

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550100', OWNER_PHONE_LINE)).toBeNull();
  });

  it('two teammates whose stored mobiles both read as the caller-ID resolve nobody (ambiguous → fail closed)', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' });
    await seed(repo, { id: 'u-a', role: 'technician', mobileNumber: '(512) 555-0100' });
    await seed(repo, { id: 'u-b', role: 'technician', mobileNumber: '512.555.0100' });

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550100', OWNER_PHONE_LINE)).toBeNull();
  });

  it('a caller who is no owner line keeps the exact match: no roster read', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-tech', role: 'technician', mobileNumber: '(512) 555-0111' });
    const findByTenantSpy = vi.spyOn(repo, 'findByTenant');

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550111', null)).toBeNull();
    expect(findByTenantSpy).not.toHaveBeenCalled();
  });
});

describe("resolvePhoneActor — a backup's line is that backup or nobody", () => {
  const BACKUP_LINE = { via: 'backup_supervisor', userId: 'clerk-backup' } as const;

  it('never bridges to the owner when no teammate matches the caller-ID', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' });

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550111', BACKUP_LINE)).toBeNull();
  });

  it('never resolves another teammate whose mobile matches the caller-ID exactly', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' });
    await seed(repo, { id: 'u-backup', role: 'technician', clerkUserId: 'clerk-backup', mobileNumber: '(512) 555-0111' });
    await seed(repo, { id: 'u-other', role: 'dispatcher', clerkUserId: 'clerk-other', mobileNumber: '+15125550111' });

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550111', BACKUP_LINE)).toBeNull();
  });

  it('the backup matched exactly resolves as before', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' });
    await seed(repo, { id: 'u-backup', role: 'dispatcher', clerkUserId: 'clerk-backup', mobileNumber: '+15125550111' });

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550111', BACKUP_LINE)).toEqual({
      userId: 'clerk-backup',
      via: 'mobile',
    });
  });
});
