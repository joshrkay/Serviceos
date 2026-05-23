/**
 * Unit tests for sendCustomerMessage — the sms_consent + DNC gates, the
 * independent email channel, and the per-channel idempotency keys.
 *
 * Behavior note: when consent is absent or the number is on the DNC list the
 * SMS is simply not sent and NO dispatch row is written (the function gates
 * before logging a dispatch); the email channel is unaffected.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sendCustomerMessage } from '../../src/notifications/customer-message-delivery';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { Customer } from '../../src/customers/customer';

const TENANT = 'tenant-1';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cust-1',
    tenantId: TENANT,
    firstName: 'Sam',
    lastName: 'Lee',
    displayName: 'Sam Lee',
    primaryPhone: '+15559876543',
    email: 'sam@example.com',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDeps() {
  return {
    delivery: new InMemoryDeliveryProvider(),
    dispatchRepo: new InMemoryDispatchRepository(),
    dncRepo: new InMemoryDncRepository(),
  };
}

const baseInput = {
  tenantId: TENANT,
  entityType: 'estimate' as const,
  entityId: 'est-1',
  smsBody: 'Your estimate is ready',
  emailSubject: 'Estimate ready',
  emailText: 'Your estimate is ready',
  idempotencyKeyPrefix: 'estimate:est-1:send',
};

describe('sendCustomerMessage — both channels', () => {
  it('sends SMS + email and logs a dispatch row each with channel-specific idempotency keys', async () => {
    const deps = makeDeps();
    await sendCustomerMessage(deps, {
      ...baseInput,
      customer: makeCustomer(),
      channels: ['sms', 'email'],
    });

    expect(deps.delivery.sentSms).toHaveLength(1);
    expect(deps.delivery.sentEmails).toHaveLength(1);

    const smsRows = await deps.dispatchRepo.findByEntity(TENANT, 'estimate', 'est-1');
    const keys = smsRows.map((r) => r.idempotencyKey).sort();
    expect(keys).toEqual(['estimate:est-1:send:email', 'estimate:est-1:send:sms']);
    expect(smsRows.every((r) => r.status === 'sent')).toBe(true);
  });
});

describe('sendCustomerMessage — SMS consent + DNC gates', () => {
  it('skips SMS (no row) when smsConsent is false but still sends email', async () => {
    const deps = makeDeps();
    await sendCustomerMessage(deps, {
      ...baseInput,
      customer: makeCustomer({ smsConsent: false }),
      channels: ['sms', 'email'],
    });

    expect(deps.delivery.sentSms).toHaveLength(0);
    expect(deps.delivery.sentEmails).toHaveLength(1);
    const rows = await deps.dispatchRepo.findByEntity(TENANT, 'estimate', 'est-1');
    expect(rows.map((r) => r.channel)).toEqual(['email']);
  });

  it('skips SMS (no row) when the number is on the DNC list', async () => {
    const deps = makeDeps();
    await deps.dncRepo.addToDnc(TENANT, normalizePhone('+15559876543'), 'test');
    await sendCustomerMessage(deps, {
      ...baseInput,
      customer: makeCustomer(),
      channels: ['sms'],
    });
    expect(deps.delivery.sentSms).toHaveLength(0);
    expect(await deps.dispatchRepo.findByEntity(TENANT, 'estimate', 'est-1')).toHaveLength(0);
  });

  it('skips SMS when the customer has no primary phone', async () => {
    const deps = makeDeps();
    await sendCustomerMessage(deps, {
      ...baseInput,
      customer: makeCustomer({ primaryPhone: undefined }),
      channels: ['sms'],
    });
    expect(deps.delivery.sentSms).toHaveLength(0);
  });
});

describe('sendCustomerMessage — email requirements', () => {
  it('skips email when the customer has no email address', async () => {
    const deps = makeDeps();
    await sendCustomerMessage(deps, {
      ...baseInput,
      customer: makeCustomer({ email: undefined }),
      channels: ['email'],
    });
    expect(deps.delivery.sentEmails).toHaveLength(0);
  });

  it('does not send a channel that was not requested', async () => {
    const deps = makeDeps();
    await sendCustomerMessage(deps, {
      ...baseInput,
      customer: makeCustomer(),
      channels: ['sms'],
    });
    expect(deps.delivery.sentSms).toHaveLength(1);
    expect(deps.delivery.sentEmails).toHaveLength(0);
  });
});
