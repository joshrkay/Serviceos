import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { routeUnsupervisedProposal } from '../../src/proposals/auto-approve';
import { EmergencyDispatchExecutionHandler } from '../../src/proposals/execution/emergency-dispatch-handler';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Proposal } from '../../src/proposals/proposal';
import type { SettingsRepository } from '../../src/settings/settings';
import { OwnerNotificationService } from '../../src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import { InMemoryDeviceTokenRepository } from '../../src/push/device-token-service';
import { setOwnerNotifications } from '../../src/notifications/owner-notifications-instance';

const SECRET = 'test-secret-key-at-least-32-bytes-long-1234';
const TENANT = 'tenant-1';
const CUSTOMER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('escalation / emergency owner push (U6)', () => {
  let provider: InMemoryPushDeliveryProvider;

  beforeEach(async () => {
    const tokenRepo = new InMemoryDeviceTokenRepository();
    await tokenRepo.register({
      tenantId: TENANT,
      userId: 'owner-1',
      expoPushToken: 'ExponentPushToken[escalation-owner]',
      platform: 'ios',
    });
    provider = new InMemoryPushDeliveryProvider();
    setOwnerNotifications(
      new OwnerNotificationService({ deviceTokenRepo: tokenRepo, provider }),
    );
  });

  afterEach(() => {
    setOwnerNotifications(undefined);
  });

  describe('escalate_to_oncall → escalation', () => {
    function routeDeps() {
      return {
        auditRepo: new InMemoryAuditRepository(),
        secret: SECRET,
        sendSms: async () => {},
        escalateToOnCall: async () => {},
        buildApproveUrl: (token: string) => `https://app.test/p/approve?token=${token}`,
      };
    }

    it('fires an escalation push with the proposalId when escalated', async () => {
      const result = await routeUnsupervisedProposal(routeDeps(), {
        tenantId: TENANT,
        proposalId: 'prop-esc-1',
        channel: 'voice_inbound',
        routing: 'escalate_to_oncall',
        summaryText: 'Customer is furious about a missed appointment',
      });

      expect(result.escalated).toBe(true);
      expect(provider.sent).toHaveLength(1);
      const msg = provider.sent[0];
      expect(msg.data?.type).toBe('escalation');
      expect(msg.data?.proposalId).toBe('prop-esc-1');
      expect(msg.body).toContain('furious');
    });

    it('does NOT fire escalation when the escalation falls back to queue_only', async () => {
      const result = await routeUnsupervisedProposal(routeDeps(), {
        tenantId: TENANT,
        proposalId: 'prop-esc-2',
        channel: 'inapp', // non-call → falls back to queue_only, no escalation
        routing: 'escalate_to_oncall',
      });

      expect(result.escalated).toBe(false);
      // queue_only does not active-notify (no notifyPush wired) and no escalation push.
      expect(provider.sent).toHaveLength(0);
    });
  });

  describe('emergency_dispatch → emergency', () => {
    function settingsStub(): SettingsRepository {
      return {
        findByTenant: vi.fn(async () => ({
          ownerPhone: '+15125550999',
          businessName: 'Acme Plumbing',
        })),
      } as unknown as SettingsRepository;
    }

    function makeProposal(payload: Record<string, unknown>): Proposal {
      const now = new Date();
      return {
        id: 'prop-em-1',
        tenantId: TENANT,
        proposalType: 'emergency_dispatch',
        status: 'approved',
        payload,
        summary: 'Emergency dispatch',
        createdBy: 'calling-agent',
        createdAt: now,
        updatedAt: now,
      };
    }

    it('fires an emergency push with proposalId + customerId on a successful dispatch', async () => {
      const jobRepo = new InMemoryJobRepository();
      const locationRepo = new InMemoryLocationRepository();
      await locationRepo.create({
        id: 'loc-1',
        tenantId: TENANT,
        customerId: CUSTOMER,
        street1: '1 Main St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        country: 'US',
        isPrimary: true,
        isArchived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const handler = new EmergencyDispatchExecutionHandler(
        jobRepo,
        locationRepo,
        settingsStub(),
        { sendSms: vi.fn(async () => ({})) },
        new InMemoryAuditRepository(),
      );

      const result = await handler.execute(
        makeProposal({
          intent: 'emergency_dispatch',
          entities: {
            emergencyDescription: 'gas leak in the basement',
            detectedKeywords: ['gas leak'],
            customerId: CUSTOMER,
            callerPhone: '+15125550111',
          },
          sessionId: 's1',
        }),
        { tenantId: TENANT, executedBy: 'owner-1' },
      );

      expect(result.success).toBe(true);
      expect(provider.sent).toHaveLength(1);
      const msg = provider.sent[0];
      expect(msg.data?.type).toBe('emergency');
      expect(msg.data?.proposalId).toBe('prop-em-1');
      expect(msg.body).toContain('gas leak');
    });

    it('fires an emergency push even for an anonymous caller (page-only success)', async () => {
      const handler = new EmergencyDispatchExecutionHandler(
        new InMemoryJobRepository(),
        new InMemoryLocationRepository(),
        settingsStub(),
        { sendSms: vi.fn(async () => ({})) },
        new InMemoryAuditRepository(),
      );

      const result = await handler.execute(
        makeProposal({
          emergencyDescription: 'flooding from a burst pipe',
          detectedKeywords: ['flooding'],
          // no customerId → anonymous; the page still goes out → success.
        }),
        { tenantId: TENANT, executedBy: 'owner-1' },
      );

      expect(result.success).toBe(true);
      expect(provider.sent).toHaveLength(1);
      const msg = provider.sent[0];
      expect(msg.data?.type).toBe('emergency');
      expect(msg.data?.proposalId).toBe('prop-em-1');
    });
  });
});
