import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDeviceTokenRepository } from '../../src/push/device-token-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import {
  OwnerNotificationService,
  type OwnerNotificationServiceDeps,
} from '../../src/notifications/owner-notification-service';
import { userIdsWithPermissionResolver } from '../../src/notifications/user-targeting';
import type { User } from '../../src/users/user';

const TENANT = 'tenant-1';

function user(clerkUserId: string, role: User['role']): User {
  return {
    id: `id-${clerkUserId}`,
    tenantId: TENANT,
    clerkUserId,
    email: 'x@y.test',
    role,
    canFieldServe: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as User;
}

describe('OwnerNotificationService', () => {
  let repo: InMemoryDeviceTokenRepository;
  let provider: InMemoryPushDeliveryProvider;
  let deps: OwnerNotificationServiceDeps;
  let service: OwnerNotificationService;

  beforeEach(() => {
    repo = new InMemoryDeviceTokenRepository();
    provider = new InMemoryPushDeliveryProvider();
    deps = { deviceTokenRepo: repo, provider };
    service = new OwnerNotificationService(deps);
  });

  it('builds typed copy + deep-link data for a new notification type (incoming_call)', async () => {
    await repo.register({ tenantId: TENANT, userId: 'u1', expoPushToken: 'ExponentPushToken[a]', platform: 'ios' });

    await service.notify(TENANT, 'incoming_call', { customerId: 'cust-9', callerLabel: 'Maria Lopez' });

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].title).toBe('Incoming call');
    expect(provider.sent[0].body).toBe('Maria Lopez is calling.');
    expect(provider.sent[0].data).toEqual({
      type: 'incoming_call',
      screen: '/customers/cust-9',
      entityId: 'cust-9',
    });
  });

  it('formats money copy from a pre-formatted cents label (payment_received)', async () => {
    await repo.register({ tenantId: TENANT, userId: 'u1', expoPushToken: 'ExponentPushToken[a]', platform: 'ios' });

    await service.notify(TENANT, 'payment_received', {
      invoiceId: 'inv-2',
      customerName: 'Acme',
      amountLabel: '$123.45',
    });

    expect(provider.sent[0].body).toBe('Acme paid $123.45.');
    expect(provider.sent[0].data.screen).toBe('/invoices');
  });

  it('targets only the devices of users holding the type permission', async () => {
    await repo.register({ tenantId: TENANT, userId: 'owner-1', expoPushToken: 'ExponentPushToken[owner]', platform: 'ios' });
    await repo.register({ tenantId: TENANT, userId: 'tech-1', expoPushToken: 'ExponentPushToken[tech]', platform: 'android' });
    const userRepo = {
      findByTenant: async () => [user('owner-1', 'owner'), user('tech-1', 'technician')],
    };
    const filtered = new OwnerNotificationService({
      deviceTokenRepo: repo,
      provider,
      resolveUserIds: userIdsWithPermissionResolver(userRepo),
    });

    // payment_received → 'payments:create': owner+dispatcher hold it, technician does not.
    await filtered.notify(TENANT, 'payment_received', {
      invoiceId: 'inv-1',
      customerName: 'Acme',
      amountLabel: '$10.00',
    });

    expect(provider.sent.map((m) => m.to)).toEqual(['ExponentPushToken[owner]']);
  });

  it('no tokens → no send (no-op)', async () => {
    await service.notify(TENANT, 'lead_captured', { leadId: 'c1', leadLabel: 'A new lead' });
    expect(provider.sent).toHaveLength(0);
  });

  it('prunes a DeviceNotRegistered token', async () => {
    await repo.register({ tenantId: TENANT, userId: 'u1', expoPushToken: 'ExponentPushToken[live]', platform: 'ios' });
    await repo.register({ tenantId: TENANT, userId: 'u1', expoPushToken: 'ExponentPushToken[dead]', platform: 'ios' });
    provider.deadTokens.add('ExponentPushToken[dead]');

    await service.notify(TENANT, 'inbound_sms', {
      conversationId: 'conv-1',
      customerName: 'Acme',
      preview: 'hi',
    });

    const remaining = await repo.listByTenant(TENANT);
    expect(remaining.map((t) => t.expoPushToken)).toEqual(['ExponentPushToken[live]']);
  });

  it('swallows provider errors (never breaks the triggering path)', async () => {
    await repo.register({ tenantId: TENANT, userId: 'u1', expoPushToken: 'ExponentPushToken[a]', platform: 'ios' });
    const throwing = new OwnerNotificationService({
      deviceTokenRepo: repo,
      provider: {
        async sendPush() {
          throw new Error('gateway down');
        },
      },
    });

    await expect(
      throwing.notify(TENANT, 'emergency', { reason: 'No-heat call, infant in home' }),
    ).resolves.toBeUndefined();
  });

  it('escalation/emergency deep-link to the proposal when one exists, else /approvals', async () => {
    await repo.register({ tenantId: TENANT, userId: 'u1', expoPushToken: 'ExponentPushToken[a]', platform: 'ios' });

    await service.notify(TENANT, 'escalation', { reason: 'Customer disputes the bill', proposalId: 'p7' });
    await service.notify(TENANT, 'escalation', { reason: 'On-call needed' });

    expect(provider.sent[0].data.screen).toBe('/proposals/p7');
    expect(provider.sent[1].data.screen).toBe('/approvals');
  });

  describe('notifyUser (user-targeted — Epic 6 technician assignment)', () => {
    it('sends only to the targeted user\'s devices, not other users', async () => {
      await repo.register({ tenantId: TENANT, userId: 'tech-clerk', expoPushToken: 'ExponentPushToken[tech]', platform: 'ios' });
      await repo.register({ tenantId: TENANT, userId: 'other-clerk', expoPushToken: 'ExponentPushToken[other]', platform: 'android' });

      await service.notifyUser(TENANT, 'tech-clerk', 'appointment_assigned', {
        appointmentId: 'appt-1',
        customerName: 'Acme Co',
        whenLabel: 'Mon, Jun 23, 2:00 PM',
        serviceLabel: 'AC repair',
      });

      expect(provider.sent.map((m) => m.to)).toEqual(['ExponentPushToken[tech]']);
      expect(provider.sent[0].title).toBe('New job assigned');
      expect(provider.sent[0].body).toBe('Acme Co — Mon, Jun 23, 2:00 PM · AC repair');
      expect(provider.sent[0].data).toEqual({
        type: 'appointment_assigned',
        screen: '/schedule',
        entityId: 'appt-1',
      });
    });

    it('appointment_unassigned targets the removed tech with the move-off copy', async () => {
      await repo.register({ tenantId: TENANT, userId: 'tech-clerk', expoPushToken: 'ExponentPushToken[tech]', platform: 'ios' });

      await service.notifyUser(TENANT, 'tech-clerk', 'appointment_unassigned', {
        appointmentId: 'appt-2',
        customerName: 'Beta LLC',
        whenLabel: 'Tue, Jun 24, 9:00 AM',
      });

      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0].title).toBe('Job reassigned');
      expect(provider.sent[0].data.type).toBe('appointment_unassigned');
    });

    it('no device for the targeted user → no send (no-op)', async () => {
      await repo.register({ tenantId: TENANT, userId: 'someone-else', expoPushToken: 'ExponentPushToken[x]', platform: 'ios' });
      await service.notifyUser(TENANT, 'tech-clerk', 'appointment_assigned', {
        appointmentId: 'a', customerName: 'C', whenLabel: 'w', serviceLabel: 's',
      });
      expect(provider.sent).toHaveLength(0);
    });

    it('empty userId → no send (no-op)', async () => {
      await repo.register({ tenantId: TENANT, userId: 'tech-clerk', expoPushToken: 'ExponentPushToken[tech]', platform: 'ios' });
      await service.notifyUser(TENANT, '', 'appointment_assigned', {
        appointmentId: 'a', customerName: 'C', whenLabel: 'w', serviceLabel: 's',
      });
      expect(provider.sent).toHaveLength(0);
    });

    it('prunes a dead token on the user-targeted path', async () => {
      await repo.register({ tenantId: TENANT, userId: 'tech-clerk', expoPushToken: 'ExponentPushToken[dead]', platform: 'ios' });
      provider.deadTokens.add('ExponentPushToken[dead]');

      await service.notifyUser(TENANT, 'tech-clerk', 'appointment_assigned', {
        appointmentId: 'a', customerName: 'C', whenLabel: 'w', serviceLabel: 's',
      });

      expect(await repo.listByTenant(TENANT)).toHaveLength(0);
    });
  });
});
