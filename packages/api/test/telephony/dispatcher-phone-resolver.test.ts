import { describe, it, expect, vi } from 'vitest';
import {
  createUserPhoneDispatcherResolver,
  createBusinessPhoneFallback,
} from '../../src/telephony/dispatcher-phone-resolver';
import type { UserRepository } from '../../src/users/user';
import type { SettingsRepository } from '../../src/settings/settings';

const TENANT = 't-1';

function userRepoStub(
  byId: Record<string, { mobileNumber?: string } | null>,
): UserRepository {
  return {
    findById: vi.fn(async (_t: string, id: string) => byId[id] ?? null),
  } as unknown as UserRepository;
}

function settingsStub(businessPhone?: string): SettingsRepository {
  return {
    findByTenant: vi.fn(async () =>
      businessPhone !== undefined ? { businessPhone } : null,
    ),
  } as unknown as SettingsRepository;
}

describe('createUserPhoneDispatcherResolver', () => {
  it("returns the on-call user's own mobile when set", async () => {
    const resolve = createUserPhoneDispatcherResolver(
      userRepoStub({ u1: { mobileNumber: '+15125550111' } }),
    );
    expect(await resolve(TENANT, 'u1')).toBe('+15125550111');
  });

  it('returns null when the user has no mobile (so the rotation walk advances)', async () => {
    const resolve = createUserPhoneDispatcherResolver(
      userRepoStub({ u1: { mobileNumber: undefined } }),
    );
    expect(await resolve(TENANT, 'u1')).toBeNull();
  });

  it('returns null when the user is not found', async () => {
    const resolve = createUserPhoneDispatcherResolver(userRepoStub({}));
    expect(await resolve(TENANT, 'ghost')).toBeNull();
  });

  it('treats a blank/whitespace mobile as unset', async () => {
    const resolve = createUserPhoneDispatcherResolver(
      userRepoStub({ u1: { mobileNumber: '   ' } }),
    );
    expect(await resolve(TENANT, 'u1')).toBeNull();
  });
});

describe('createBusinessPhoneFallback', () => {
  it('returns the tenant business_phone when set', async () => {
    const fb = createBusinessPhoneFallback(settingsStub('+15125550100'));
    expect(await fb(TENANT)).toBe('+15125550100');
  });

  it('returns null when business_phone is unset or blank', async () => {
    expect(await createBusinessPhoneFallback(settingsStub(undefined))(TENANT)).toBeNull();
    expect(await createBusinessPhoneFallback(settingsStub('  '))(TENANT)).toBeNull();
  });
});
