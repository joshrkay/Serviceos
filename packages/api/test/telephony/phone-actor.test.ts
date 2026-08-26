/**
 * Caller-ID → actor. The phone has only ever had a boolean (ownerSession);
 * the shared lookup dispatch needs an ACTOR for its RBAC gate and for
 * lookup_my_day's self-scoping. Resolution order, all tenant-scoped:
 *   1. a tenant user whose registered mobile matches the caller-ID;
 *   2. otherwise, if the caller-ID is the owner line, the tenant's single
 *      active owner-role user (bridge for owners with no mobile on file);
 *   3. otherwise none.
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

    const actor = await resolvePhoneActor(deps(repo), TENANT, '+1 (512) 555-0111', false);

    expect(actor).toEqual({ userId: 'clerk-tech', via: 'mobile' });
  });

  it('falls back to the row id when the user has no clerk subject', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-tech', role: 'technician', mobileNumber: '+15125550111' });

    const actor = await resolvePhoneActor(deps(repo), TENANT, '+15125550111', false);

    expect(actor).toEqual({ userId: 'u-tech', via: 'mobile' });
  });

  it('never resolves a suspended user from a mobile match', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-tech', role: 'technician', mobileNumber: '+15125550111', status: 'suspended' });

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550111', false)).toBeNull();
  });

  it('bridges the owner line to the SOLE active owner when no mobile matches', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' });
    await seed(repo, { id: 'u-tech', role: 'technician', mobileNumber: '+15125550111' });

    const actor = await resolvePhoneActor(deps(repo), TENANT, '+15125550100', true);

    expect(actor).toEqual({ userId: 'clerk-owner', via: 'owner_phone' });
  });

  it('refuses the owner-line bridge when there are two active owners (ambiguous → fail closed)', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner-a', role: 'owner' });
    await seed(repo, { id: 'u-owner-b', role: 'owner' });

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550100', true)).toBeNull();
  });

  it('ignores deleted and suspended owners when counting the bridge candidates', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner-live', role: 'owner' });
    await seed(repo, { id: 'u-owner-gone', role: 'owner', deletedAt: new Date() });
    await seed(repo, { id: 'u-owner-susp', role: 'owner', status: 'suspended' });

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125550100', true)).toEqual({
      userId: 'u-owner-live',
      via: 'owner_phone',
    });
  });

  it('does NOT bridge a non-owner line: a customer number with no mobile match resolves nothing', async () => {
    const repo = new InMemoryUserRepository();
    await seed(repo, { id: 'u-owner', role: 'owner' });
    const findByTenantSpy = vi.spyOn(repo, 'findByTenant');

    expect(await resolvePhoneActor(deps(repo), TENANT, '+15125559999', false)).toBeNull();
    expect(findByTenantSpy).not.toHaveBeenCalled();
  });

  it('is fail-soft: a repository error resolves nothing and never throws', async () => {
    const d: PhoneActorDeps = {
      userRepo: {
        findByMobileNumber: vi.fn(async () => { throw new Error('pg down'); }),
        findByTenant: vi.fn(async () => []),
      },
    };

    await expect(resolvePhoneActor(d, TENANT, '+15125550111', true)).resolves.toBeNull();
  });

  it('resolves nothing for a withheld / unparseable caller-ID or a missing userRepo', async () => {
    const repo = new InMemoryUserRepository();
    expect(await resolvePhoneActor(deps(repo), TENANT, undefined, true)).toBeNull();
    expect(await resolvePhoneActor(deps(repo), TENANT, '', true)).toBeNull();
    expect(await resolvePhoneActor(deps(repo), TENANT, 'anonymous', true)).toBeNull();
    expect(await resolvePhoneActor({}, TENANT, '+15125550111', true)).toBeNull();
  });
});
