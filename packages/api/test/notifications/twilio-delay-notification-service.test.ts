/**
 * Unit tests for TwilioDelayNotificationService.sendDelayNotice — channel
 * routing, the entityId derivation from metadata.appointmentId, dispatch
 * logging, and idempotency-key pass-through.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TwilioDelayNotificationService } from '../../src/notifications/twilio-delay-notification-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';

const TENANT = 'tenant-1';

function makeService() {
  const delivery = new InMemoryDeliveryProvider();
  const dispatchRepo = new InMemoryDispatchRepository();
  return { delivery, dispatchRepo, service: new TwilioDelayNotificationService(delivery, dispatchRepo) };
}

const base = {
  tenantId: TENANT,
  customerId: 'cust-1',
  destination: '+15551112222',
  message: 'Running 30 min late',
  idempotencyKey: 'delay:appt-1',
};

describe('sendDelayNotice — SMS', () => {
  it('sends SMS, logs a delay_notice dispatch, and returns the provider message id', async () => {
    const { service, delivery, dispatchRepo } = makeService();
    const result = await service.sendDelayNotice({
      ...base,
      channel: 'sms',
      metadata: { appointmentId: 'appt-1' },
    });

    expect(delivery.sentSms).toHaveLength(1);
    expect(delivery.sentSms[0].idempotencyKey).toBe('delay:appt-1');
    expect(result.providerMessageId).toBe('mem-sms-1');

    const rows = await dispatchRepo.findByEntity(TENANT, 'delay_notice', 'appt-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('sms');
    expect(rows[0].idempotencyKey).toBe('delay:appt-1');
  });

  it('derives entityId from customerId when metadata.appointmentId is absent', async () => {
    const { service, dispatchRepo } = makeService();
    await service.sendDelayNotice({ ...base, channel: 'sms' });
    const rows = await dispatchRepo.findByEntity(TENANT, 'delay_notice', 'cust-1');
    expect(rows).toHaveLength(1);
  });

  it('derives entityId from customerId when appointmentId is not a string', async () => {
    const { service, dispatchRepo } = makeService();
    await service.sendDelayNotice({
      ...base,
      channel: 'sms',
      metadata: { appointmentId: 12345 as unknown as string },
    });
    expect(await dispatchRepo.findByEntity(TENANT, 'delay_notice', 'cust-1')).toHaveLength(1);
  });
});

describe('sendDelayNotice — email', () => {
  it('sends email with a wrapped HTML body and logs an email dispatch', async () => {
    const { service, delivery, dispatchRepo } = makeService();
    const result = await service.sendDelayNotice({
      ...base,
      message: 'line one\nline two',
      channel: 'email',
      destination: 'sam@example.com',
      metadata: { appointmentId: 'appt-9' },
    });

    expect(delivery.sentEmails).toHaveLength(1);
    expect(delivery.sentEmails[0].html).toBe('<p>line one<br>line two</p>');
    expect(result.providerMessageId).toBe('mem-email-1');
    const rows = await dispatchRepo.findByEntity(TENANT, 'delay_notice', 'appt-9');
    expect(rows[0].channel).toBe('email');
  });
});
