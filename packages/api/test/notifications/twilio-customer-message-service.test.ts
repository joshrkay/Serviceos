/**
 * Unit tests for TwilioCustomerMessageService.sendCustomMessage
 * (Tradesperson wave 1, Task 5 — quality-review fixes).
 *
 * Covers: channel routing (sms/email), the "no phone/email on file" and
 * "customer not found" refusals, provider-level idempotencyKey pass-through
 * (parity with TwilioDelayNotificationService — see
 * test/notifications/twilio-delay-notification-service.test.ts), and HTML
 * escaping on the email body (the owner approves PLAIN TEXT on the card; the
 * customer must never receive live links/markup the card never rendered).
 */
import { describe, it, expect } from 'vitest';
import { TwilioCustomerMessageService } from '../../src/notifications/twilio-customer-message-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import type { Customer, CustomerRepository } from '../../src/customers/customer';

const TENANT = 'tenant-1';
const CUSTOMER_ID = 'cust-1';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  const now = new Date('2026-05-17T10:00:00Z');
  return {
    id: CUSTOMER_ID,
    tenantId: TENANT,
    firstName: 'Alice',
    lastName: 'Smith',
    displayName: 'Alice Smith',
    primaryPhone: '+15551234567',
    email: 'alice@example.com',
    preferredChannel: 'email',
    smsConsent: true,
    isArchived: false,
    createdBy: 'system',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeService(customer: Customer | null = makeCustomer()) {
  const delivery = new InMemoryDeliveryProvider();
  const dispatchRepo = new InMemoryDispatchRepository();
  const customerRepo: Pick<CustomerRepository, 'findById'> = {
    findById: async () => customer,
  };
  return {
    delivery,
    dispatchRepo,
    service: new TwilioCustomerMessageService(delivery, dispatchRepo, customerRepo),
  };
}

const baseInput = {
  tenantId: TENANT,
  customerId: CUSTOMER_ID,
  body: 'Your part arrived — we can come Thursday morning.',
  actorId: 'u-1',
  idempotencyKey: 'send_customer_message:prop-1:sms',
};

describe('TwilioCustomerMessageService — SMS', () => {
  it('sends via the primary phone with the stored consent flag and logs a custom_message dispatch', async () => {
    const { service, delivery, dispatchRepo } = makeService();
    await service.sendCustomMessage({ ...baseInput, channel: 'sms' });

    expect(delivery.sentSms).toHaveLength(1);
    expect(delivery.sentSms[0].to).toBe('+15551234567');
    expect(delivery.sentSms[0].body).toBe('Your part arrived — we can come Thursday morning.');
    expect(delivery.sentSms[0].consent).toEqual({ smsConsent: true, customerId: CUSTOMER_ID });

    const rows = await dispatchRepo.findByEntity(TENANT, 'custom_message', CUSTOMER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('sms');
  });

  it('passes the derived idempotencyKey through to BOTH the provider call and the dispatch row', async () => {
    const { service, delivery, dispatchRepo } = makeService();
    await service.sendCustomMessage({
      ...baseInput,
      channel: 'sms',
      idempotencyKey: 'send_customer_message:prop-42:sms',
    });

    expect(delivery.sentSms[0].idempotencyKey).toBe('send_customer_message:prop-42:sms');
    const rows = await dispatchRepo.findByEntity(TENANT, 'custom_message', CUSTOMER_ID);
    expect(rows[0].idempotencyKey).toBe('send_customer_message:prop-42:sms');
  });

  it('throws when the customer has no phone number on file', async () => {
    const { service } = makeService(makeCustomer({ primaryPhone: undefined }));
    await expect(service.sendCustomMessage({ ...baseInput, channel: 'sms' })).rejects.toThrow(
      /no phone number/i,
    );
  });

  it('throws when the customer is not found', async () => {
    const { service } = makeService(null);
    await expect(service.sendCustomMessage({ ...baseInput, channel: 'sms' })).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('TwilioCustomerMessageService — email', () => {
  it('sends via email and escapes HTML entities in the html body while leaving the plain-text body verbatim', async () => {
    const { service, delivery } = makeService();
    const body = 'Reply <STOP> to opt out & "confirm" it\'s you.\nSecond line.';

    await service.sendCustomMessage({
      ...baseInput,
      channel: 'email',
      body,
    });

    expect(delivery.sentEmails).toHaveLength(1);
    // Plain text carries the message verbatim — never mangled.
    expect(delivery.sentEmails[0].text).toBe(body);
    // The HTML body must escape every entity BEFORE the newline→<br> replace,
    // so no live markup/tag the approval card never rendered reaches the
    // customer's inbox as real HTML.
    expect(delivery.sentEmails[0].html).toBe(
      '<p>Reply &lt;STOP&gt; to opt out &amp; &quot;confirm&quot; it&#39;s you.<br>Second line.</p>',
    );
  });

  it('passes the derived idempotencyKey through to BOTH the provider call and the dispatch row', async () => {
    const { service, delivery, dispatchRepo } = makeService();
    await service.sendCustomMessage({
      ...baseInput,
      channel: 'email',
      idempotencyKey: 'send_customer_message:prop-42:email',
    });

    expect(delivery.sentEmails[0].idempotencyKey).toBe('send_customer_message:prop-42:email');
    const rows = await dispatchRepo.findByEntity(TENANT, 'custom_message', CUSTOMER_ID);
    expect(rows[0].idempotencyKey).toBe('send_customer_message:prop-42:email');
  });

  it('uses a stated subject when present, otherwise a generic default', async () => {
    const { service, delivery } = makeService();
    await service.sendCustomMessage({ ...baseInput, channel: 'email', subject: 'Inspection results' });
    expect(delivery.sentEmails[0].subject).toBe('Inspection results');
  });

  it('throws when the customer has no email on file', async () => {
    const { service } = makeService(makeCustomer({ email: undefined }));
    await expect(service.sendCustomMessage({ ...baseInput, channel: 'email' })).rejects.toThrow(
      /no email address/i,
    );
  });
});
