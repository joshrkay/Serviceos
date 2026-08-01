import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryNotificationPreferenceRepository,
  effectivePreferences,
} from '../../src/notifications/notification-preferences-service';

const TENANT = 'tenant-1';
const USER = 'user-1';

describe('notification preferences (U10)', () => {
  let repo: InMemoryNotificationPreferenceRepository;
  beforeEach(() => {
    repo = new InMemoryNotificationPreferenceRepository();
  });

  it('defaults every type to enabled when the user has no rows (opt-out model)', async () => {
    const prefs = await effectivePreferences(repo, TENANT, USER);
    expect(prefs.incoming_call).toBe(true);
    expect(prefs.payment_received).toBe(true);
    expect(Object.values(prefs).every((v) => v === true)).toBe(true);
  });

  it('setEnabled(false) mutes only that type for that user', async () => {
    await repo.setEnabled(TENANT, USER, 'inbound_sms', false);
    const prefs = await effectivePreferences(repo, TENANT, USER);
    expect(prefs.inbound_sms).toBe(false);
    expect(prefs.incoming_call).toBe(true);
  });

  it('listMutedUserIds returns only users who muted the given type', async () => {
    await repo.setEnabled(TENANT, 'owner-a', 'payment_received', false);
    await repo.setEnabled(TENANT, 'owner-b', 'inbound_sms', false);
    await repo.setEnabled(TENANT, 'owner-c', 'payment_received', true); // re-enabled

    const muted = await repo.listMutedUserIds(TENANT, 'payment_received');
    expect([...muted]).toEqual(['owner-a']);
  });

  it('re-enabling a muted type removes it from the muted set', async () => {
    await repo.setEnabled(TENANT, USER, 'emergency', false);
    expect((await repo.listMutedUserIds(TENANT, 'emergency')).has(USER)).toBe(true);
    await repo.setEnabled(TENANT, USER, 'emergency', true);
    expect((await repo.listMutedUserIds(TENANT, 'emergency')).has(USER)).toBe(false);
  });

  it('preferences are scoped per tenant', async () => {
    await repo.setEnabled(TENANT, USER, 'lead_captured', false);
    const otherTenant = await repo.listMutedUserIds('tenant-2', 'lead_captured');
    expect(otherTenant.size).toBe(0);
  });
});
