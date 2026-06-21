import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CancelAppointmentExecutionHandler } from '../../../src/proposals/execution/cancellation-handler';
import { Proposal } from '../../../src/proposals/proposal';
import {
  InMemoryAppointmentRepository,
  createAppointment,
} from '../../../src/appointments/appointment';
import { OwnerNotificationService } from '../../../src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../../src/notifications/push-delivery-provider';
import { InMemoryDeviceTokenRepository } from '../../../src/push/device-token-service';
import { setOwnerNotifications } from '../../../src/notifications/owner-notifications-instance';

const tenantId = '550e8400-e29b-41d4-a716-446655440000';
const userId = 'user-owner-1';
const context = { tenantId, executedBy: 'user-1' };

function makeProposal(payload: Record<string, unknown>): Proposal {
  return {
    id: 'prop-1',
    tenantId,
    proposalType: 'cancel_appointment',
    status: 'approved',
    payload,
    summary: 'Cancel appointment',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('U5 — appointment cancellation owner push', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let repo: InMemoryDeviceTokenRepository;
  let provider: InMemoryPushDeliveryProvider;

  beforeEach(async () => {
    appointmentRepo = new InMemoryAppointmentRepository();
    repo = new InMemoryDeviceTokenRepository();
    provider = new InMemoryPushDeliveryProvider();
    await repo.register({
      tenantId,
      userId,
      expoPushToken: 'ExponentPushToken[a]',
      platform: 'ios',
    });
    setOwnerNotifications(new OwnerNotificationService({ deviceTokenRepo: repo, provider }));
  });

  afterEach(() => {
    setOwnerNotifications(undefined);
  });

  async function seedAppointment() {
    return createAppointment(
      {
        tenantId,
        jobId: 'job-1',
        scheduledStart: new Date('2026-09-12T13:00:00Z'),
        scheduledEnd: new Date('2026-09-12T15:00:00Z'),
        timezone: 'America/New_York',
        createdBy: 'user-1',
      },
      appointmentRepo,
    );
  }

  it('fires appointment_cancellation with the resolved name + tenant-tz time', async () => {
    const appt = await seedAppointment();
    const handler = new CancelAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      undefined,
      undefined,
      async () => 'Jane Doe',
    );

    const result = await handler.execute(
      makeProposal({ appointmentId: appt.id, reason: 'Customer cancelled', cancellationType: 'customer_request' }),
      context,
    );
    expect(result.success).toBe(true);

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].data?.type).toBe('appointment_cancellation');
    expect(provider.sent[0].data?.screen).toBe('/schedule');
    expect(provider.sent[0].body).toContain('Jane Doe');
    // 13:00 UTC → 9:00 AM in America/New_York (EDT).
    expect(provider.sent[0].body).toContain('9:00');
  });

  it('falls back to a generic name when no resolver is wired (no crash)', async () => {
    const appt = await seedAppointment();
    const handler = new CancelAppointmentExecutionHandler(appointmentRepo);

    const result = await handler.execute(
      makeProposal({ appointmentId: appt.id, reason: 'Owner cancelled', cancellationType: 'other' }),
      context,
    );
    expect(result.success).toBe(true);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].body).toContain('A customer');
  });

  it('a name-resolver failure never breaks the cancellation', async () => {
    const appt = await seedAppointment();
    const handler = new CancelAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      undefined,
      undefined,
      async () => {
        throw new Error('lookup boom');
      },
    );

    const result = await handler.execute(
      makeProposal({ appointmentId: appt.id, reason: 'Cancelled', cancellationType: 'other' }),
      context,
    );
    expect(result.success).toBe(true);
    const updated = await appointmentRepo.findById(tenantId, appt.id);
    expect(updated!.status).toBe('canceled');
    expect(provider.sent).toHaveLength(0);
  });
});
