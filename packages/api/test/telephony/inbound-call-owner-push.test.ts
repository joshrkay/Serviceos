import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { notifyOwnerOfIncomingCall } from '../../src/telephony/twilio-adapter';
import { OwnerNotificationService } from '../../src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import { InMemoryDeviceTokenRepository } from '../../src/push/device-token-service';
import { setOwnerNotifications } from '../../src/notifications/owner-notifications-instance';

/**
 * U2 — inbound call fires exactly one `incoming_call` owner push. The seam in
 * twilio-adapter delegates to the exported `notifyOwnerOfIncomingCall` helper;
 * we unit-test that helper directly (the surrounding handler is huge and
 * DB-bound).
 */
describe('U2 — inbound call owner push', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const userId = 'user-owner-1';

  let repo: InMemoryDeviceTokenRepository;
  let provider: InMemoryPushDeliveryProvider;

  beforeEach(async () => {
    repo = new InMemoryDeviceTokenRepository();
    provider = new InMemoryPushDeliveryProvider();
    await repo.register({
      tenantId,
      userId,
      expoPushToken: 'ExponentPushToken[a]',
      platform: 'ios',
    });
    // No resolver → all tenant devices receive it.
    setOwnerNotifications(new OwnerNotificationService({ deviceTokenRepo: repo, provider }));
  });

  afterEach(() => {
    setOwnerNotifications(undefined);
  });

  it('known caller → deep-links to the customer with their name', async () => {
    await notifyOwnerOfIncomingCall({
      tenantId,
      customerId: 'cust-1',
      customerName: 'Jane Doe',
      fromPhone: '+15555550123',
    });

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].data?.type).toBe('incoming_call');
    expect(provider.sent[0].data?.screen).toBe('/customers/cust-1');
    expect(provider.sent[0].body).toContain('Jane Doe');
  });

  it('unknown caller (lead only) → routes to the customers LIST, not a dead /customers/<leadId>', async () => {
    await notifyOwnerOfIncomingCall({
      tenantId,
      fromPhone: '+15555550199',
    });

    expect(provider.sent).toHaveLength(1);
    // A lead has no mobile detail route — the tap must land on a valid screen.
    expect(provider.sent[0].data?.screen).toBe('/customers');
    expect(provider.sent[0].data?.entityId).toBeUndefined();
    expect(provider.sent[0].body).toContain('New caller: +15555550199');
  });

  it('blocked/withheld caller-id → generic "New caller" label, no crash', async () => {
    await notifyOwnerOfIncomingCall({
      tenantId,
      fromPhone: 'restricted',
    });

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].data?.screen).toBe('/customers');
    expect(provider.sent[0].body).toContain('New caller');
    expect(provider.sent[0].body).not.toContain('restricted');
  });

  it('caller with no id at all → still fires one push to the customers list', async () => {
    await notifyOwnerOfIncomingCall({ tenantId, fromPhone: '+15555550000' });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].data?.screen).toBe('/customers');
  });

  it('fires exactly one push (not per media frame) per call', async () => {
    await notifyOwnerOfIncomingCall({ tenantId, customerId: 'cust-1', customerName: 'A' });
    expect(provider.sent).toHaveLength(1);
  });
});
