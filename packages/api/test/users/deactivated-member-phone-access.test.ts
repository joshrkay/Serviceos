/**
 * #1402 §13 — a deactivated teammate's phone loses its powers: it is no
 * longer dialed on escalation and no longer counts as an approver phone.
 * Seams: createUserPhoneDispatcherResolver and resolveApproverPhones.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryUserRepository } from '../../src/users/user';
import { InMemorySettingsRepository, createSettings, updateSettings } from '../../src/settings/settings';
import { createUserPhoneDispatcherResolver } from '../../src/telephony/dispatcher-phone-resolver';
import { resolveApproverPhones } from '../../src/proposals/approver-identity';

const TENANT = 'tenant-deactivated-phone';

describe('deactivated member phone access (#1402 §13)', () => {
  let users: InMemoryUserRepository;
  let techId: string;

  beforeEach(async () => {
    users = new InMemoryUserRepository();
    techId = uuidv4();
    await users.create!({
      id: techId, tenantId: TENANT, email: 'tech@example.com', role: 'technician',
      canFieldServe: true, clerkUserId: 'clerk_tech', mobileNumber: '+15125550111',
    });
    await users.deactivateMember(TENANT, techId);
  });

  it('is skipped by the on-call escalation dialer', async () => {
    const resolve = createUserPhoneDispatcherResolver(users);

    expect(await resolve(TENANT, techId)).toBeNull();
  });

  it('no longer counts as the backup supervisor approver phone', async () => {
    const settingsRepo = new InMemorySettingsRepository();
    await createSettings({ tenantId: TENANT, businessName: 'Co', ownerPhone: '+15125550100' }, settingsRepo);
    await updateSettings(TENANT, { backupSupervisorUserId: techId }, settingsRepo);

    const phones = await resolveApproverPhones({ settingsRepo, userRepo: users }, TENANT);

    expect(phones).toEqual(['+15125550100']);
  });
});
