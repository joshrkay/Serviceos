/**
 * P7-026 final wiring — MessageDeliveryReviewPrivateMessageSender tests.
 *
 * The adapter resolves a customer's address from the customer row and
 * delegates to the underlying MessageDeliveryProvider. These tests
 * cover SMS, email, idempotency-key passthrough, and the
 * missing-customer / missing-contact failure modes.
 */
import { describe, it, expect } from 'vitest';
import { MessageDeliveryReviewPrivateMessageSender } from '../../src/reputation/private-message-sender-adapter';
import {
  InMemoryDeliveryProvider,
  type DeliveryResult,
  type EmailMessage,
  type MessageDeliveryProvider,
  type SmsMessage,
} from '../../src/notifications/delivery-provider';
import type { Customer, CustomerRepository } from '../../src/customers/customer';

const TENANT = 'tenant-1';
const CUSTOMER_ID = 'customer-1';

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

class StubCustomerRepo implements Partial<CustomerRepository> {
  constructor(private readonly customer: Customer | null) {}
  async findById(_tenantId: string, _id: string): Promise<Customer | null> {
    return this.customer;
  }
}

function makeAdapter(customer: Customer | null): {
  adapter: MessageDeliveryReviewPrivateMessageSender;
  provider: InMemoryDeliveryProvider;
} {
  const provider = new InMemoryDeliveryProvider();
  const adapter = new MessageDeliveryReviewPrivateMessageSender(
    provider,
    new StubCustomerRepo(customer) as CustomerRepository,
  );
  return { adapter, provider };
}

describe('P7-026 MessageDeliveryReviewPrivateMessageSender', () => {
  it('forwards SMS to the provider with the customer phone, body, and idempotency key', async () => {
    const { adapter, provider } = makeAdapter(makeCustomer());

    const result = await adapter.send({
      tenantId: TENANT,
      customerId: CUSTOMER_ID,
      channel: 'sms',
      body: 'Sorry to hear about your experience',
      idempotencyKey: 'review-response-private:p-1',
    });

    expect(result.providerMessageId).toMatch(/^mem-sms-/);
    expect(provider.sentSms).toHaveLength(1);
    expect(provider.sentSms[0]).toEqual({
      to: '+15551234567',
      body: 'Sorry to hear about your experience',
      tenantId: TENANT,
      idempotencyKey: 'review-response-private:p-1',
    });
  });

  it('forwards email to the provider with subject, plain body, HTML body, and idempotency key', async () => {
    const { adapter, provider } = makeAdapter(makeCustomer());

    await adapter.send({
      tenantId: TENANT,
      customerId: CUSTOMER_ID,
      channel: 'email',
      body: 'Line one\nLine two',
      idempotencyKey: 'review-response-private:p-2',
    });

    expect(provider.sentEmails).toHaveLength(1);
    const sent = provider.sentEmails[0];
    expect(sent.to).toBe('alice@example.com');
    expect(sent.text).toBe('Line one\nLine two');
    expect(sent.html).toContain('Line one<br>Line two');
    expect(sent.subject).toBeTruthy();
    expect(sent.tenantId).toBe(TENANT);
    expect(sent.idempotencyKey).toBe('review-response-private:p-2');
  });

  it('throws customer_not_found when the customer row is missing', async () => {
    const { adapter } = makeAdapter(null);

    await expect(
      adapter.send({
        tenantId: TENANT,
        customerId: 'absent',
        channel: 'sms',
        body: 'x',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow(/customer_not_found/);
  });

  it('throws missing_phone when SMS is requested but the customer has no phone', async () => {
    const { adapter } = makeAdapter(
      makeCustomer({ primaryPhone: undefined }),
    );

    await expect(
      adapter.send({
        tenantId: TENANT,
        customerId: CUSTOMER_ID,
        channel: 'sms',
        body: 'x',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow(/missing_phone/);
  });

  it('throws missing_email when email is requested but the customer has no email', async () => {
    const { adapter } = makeAdapter(makeCustomer({ email: undefined }));

    await expect(
      adapter.send({
        tenantId: TENANT,
        customerId: CUSTOMER_ID,
        channel: 'email',
        body: 'x',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow(/missing_email/);
  });

  it('escapes HTML special characters in the email body', async () => {
    const { adapter, provider } = makeAdapter(makeCustomer());

    await adapter.send({
      tenantId: TENANT,
      customerId: CUSTOMER_ID,
      channel: 'email',
      body: '<script>alert("x")</script> & co.',
      idempotencyKey: 'k',
    });

    const html = provider.sentEmails[0].html ?? '';
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; co.');
  });

  it('maps the provider response into a {providerMessageId} envelope', async () => {
    const customRecorded: SmsMessage[] = [];
    const customResult: DeliveryResult = {
      providerMessageId: 'twilio-MSG-XYZ',
      provider: 'twilio',
      channel: 'sms',
    };
    const provider: MessageDeliveryProvider = {
      async sendSms(message: SmsMessage) {
        customRecorded.push(message);
        return customResult;
      },
      async sendEmail(_m: EmailMessage) {
        throw new Error('not used');
      },
    };
    const adapter = new MessageDeliveryReviewPrivateMessageSender(
      provider,
      new StubCustomerRepo(makeCustomer()) as CustomerRepository,
    );

    const result = await adapter.send({
      tenantId: TENANT,
      customerId: CUSTOMER_ID,
      channel: 'sms',
      body: 'hi',
      idempotencyKey: 'k',
    });

    expect(result).toEqual({ providerMessageId: 'twilio-MSG-XYZ' });
    expect(customRecorded).toHaveLength(1);
  });
});
