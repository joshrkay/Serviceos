import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryCustomerRepository, type Customer } from '../../src/customers/customer';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import {
  SmsDeferredError,
  SmsSuppressedError,
} from '../../src/notifications/gated-message-delivery';
import type { MessageDeliveryProvider, SmsMessage } from '../../src/notifications/delivery-provider';
import {
  createOutboundMessaging,
  type OutboundText,
} from '../../src/notifications/outbound-messaging';

const TENANT = 'tenant-om-1';
const NOW = new Date('2026-10-22T15:00:00Z');

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cust-1',
    tenantId: TENANT,
    firstName: 'Mary',
    lastName: 'Johnson',
    displayName: 'Mary Johnson',
    primaryPhone: '+15551234567',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'test',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('outbound messaging', () => {
  let customerRepo: InMemoryCustomerRepository;
  let dncRepo: InMemoryDncRepository;
  let sent: SmsMessage[];
  let sendSms: ReturnType<typeof vi.fn>;
  const logger = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    customerRepo = new InMemoryCustomerRepository();
    dncRepo = new InMemoryDncRepository();
    sent = [];
    sendSms = vi.fn(async (message: SmsMessage) => {
      sent.push(message);
      return { provider: 'test', providerMessageId: `m-${sent.length}`, channel: 'sms' as const };
    });
  });

  function messaging(overrideSend?: (message: SmsMessage) => Promise<never>) {
    const delivery = {
      sendSms: overrideSend ?? sendSms,
      sendEmail: vi.fn(),
    } as unknown as MessageDeliveryProvider;
    return createOutboundMessaging({ delivery, customerRepo, dncRepo, pool: null, logger });
  }

  const toCustomer = (purpose: OutboundText['purpose']): OutboundText => ({
    tenantId: TENANT,
    recipient: { kind: 'customer', customerId: 'cust-1' },
    purpose,
    dedupe: { messageKind: 'test_message', recordId: 'job-1' },
    body: 'Hello',
  });

  it('sends a transactional text now, with the consent it looked up and the dedupe key', async () => {
    await customerRepo.create(makeCustomer());

    const outcome = await messaging().sendText(toCustomer('transactional'));

    expect(outcome).toEqual({
      status: 'sent',
      delivery: { provider: 'test', providerMessageId: 'm-1', channel: 'sms' },
    });
    expect(sent[0]).toEqual({
      to: '+15551234567',
      body: 'Hello',
      tenantId: TENANT,
      recipientClass: 'customer',
      consent: { smsConsent: true, customerId: 'cust-1' },
      idempotencyKey: 'test_message:job-1',
    });
  });

  it('leaves a transactional text to the gate even without stored consent', async () => {
    await customerRepo.create(makeCustomer({ smsConsent: false }));

    const outcome = await messaging().sendText(toCustomer('transactional'));

    expect(outcome.status).toBe('sent');
    expect(sent[0].consent).toEqual({ smsConsent: false, customerId: 'cust-1' });
  });

  it.each(['automated_nudge', 'marketing'] as const)(
    'holds a %s text for the daytime window',
    async (purpose) => {
      await customerRepo.create(makeCustomer());

      await messaging().sendText(toCustomer(purpose));

      expect(sent[0].quietHours).toBe('defer');
    },
  );

  it('blocks a nudge to a customer who has not said yes, without calling the provider', async () => {
    await customerRepo.create(makeCustomer({ smsConsent: false }));

    const outcome = await messaging().sendText(toCustomer('automated_nudge'));

    expect(outcome).toEqual({ status: 'blocked', reason: 'no_consent', permanent: true });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('blocks a nudge to a number on the tenant DNC list', async () => {
    await customerRepo.create(makeCustomer());
    dncRepo.add(TENANT, '+15551234567');

    const outcome = await messaging().sendText(toCustomer('automated_nudge'));

    expect(outcome).toEqual({ status: 'blocked', reason: 'dnc', permanent: true });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('blocks when the customer is missing or has no number', async () => {
    expect(await messaging().sendText(toCustomer('transactional'))).toEqual({
      status: 'blocked',
      reason: 'customer_not_found',
      permanent: true,
    });
    await customerRepo.create(makeCustomer({ primaryPhone: undefined }));
    expect(await messaging().sendText(toCustomer('transactional'))).toEqual({
      status: 'blocked',
      reason: 'no_phone',
      permanent: true,
    });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('sends a reply with the consent the inbound message gave', async () => {
    await messaging().sendText({
      tenantId: TENANT,
      recipient: { kind: 'reply', phone: '+15559876543' },
      purpose: 'reply',
      dedupe: { messageKind: 'reply', recordId: 'inbound-1' },
      body: 'Thanks, see you at 3',
    });

    expect(sent[0]).toMatchObject({
      to: '+15559876543',
      recipientClass: 'customer',
      consent: { smsConsent: true },
    });
    expect(sent[0].quietHours).toBeUndefined();
  });

  it('sends to the owner as owner-class, carrying a life-safety tag', async () => {
    await messaging().sendText({
      tenantId: TENANT,
      recipient: { kind: 'owner', phone: '+15550001111', alertClass: 'life_safety' },
      purpose: 'transactional',
      dedupe: { messageKind: 'e1_alert', recordId: 'call-1' },
      body: 'Gas leak reported',
    });

    expect(sent[0]).toMatchObject({ recipientClass: 'owner', alertClass: 'life_safety' });
    expect(sent[0].consent).toBeUndefined();
  });

  it('reports a quiet-hours deferral as scheduled, with the time the window opens', async () => {
    await customerRepo.create(makeCustomer());
    const opens = new Date('2026-10-23T15:00:00Z');

    const outcome = await messaging(async () => {
      throw new SmsDeferredError(opens);
    }).sendText(toCustomer('automated_nudge'));

    expect(outcome).toEqual({ status: 'scheduled', at: opens, reason: 'quiet_hours' });
  });

  it('marks a gate revocation permanent and the kill switch retryable', async () => {
    await customerRepo.create(makeCustomer());

    const revoked = await messaging(async () => {
      throw new SmsSuppressedError('revoked');
    }).sendText(toCustomer('transactional'));
    const switchedOff = await messaging(async () => {
      throw new SmsSuppressedError('channel_disabled');
    }).sendText(toCustomer('transactional'));

    expect(revoked).toEqual({ status: 'blocked', reason: 'revoked', permanent: true });
    expect(switchedOff).toEqual({ status: 'blocked', reason: 'channel_disabled', permanent: false });
  });

  it('turns a provider error into a retryable block with the reason, never a throw', async () => {
    await customerRepo.create(makeCustomer());

    const outcome = await messaging(async () => {
      throw new Error('Twilio 503');
    }).sendText(toCustomer('transactional'));

    expect(outcome).toEqual({
      status: 'blocked',
      reason: 'send_failed',
      permanent: false,
      detail: 'Twilio 503',
    });
    expect(logger.warn).toHaveBeenCalled();
  });
});
