import { describe, it, expect, beforeEach } from 'vitest';
import { sendCustomerMessage } from '../../src/notifications/customer-message-delivery';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { InMemoryConsentEventRepository } from '../../src/compliance/consent-events';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Customer } from '../../src/customers/customer';

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

describe('sendCustomerMessage — consent ledger + audit', () => {
  let delivery: InMemoryDeliveryProvider;
  let dispatchRepo: InMemoryDispatchRepository;
  let dncRepo: InMemoryDncRepository;
  let consentRepo: InMemoryConsentEventRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    delivery = new InMemoryDeliveryProvider();
    dispatchRepo = new InMemoryDispatchRepository();
    dncRepo = new InMemoryDncRepository();
    consentRepo = new InMemoryConsentEventRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('emits sms_blocked_by_compliance when ledger is revoked', async () => {
    await consentRepo.append({
      tenantId: TENANT,
      customerId: 'cust-1',
      phone: '+15559876543',
      kind: 'sms',
      state: 'revoked',
      source: 'sms',
    });

    await sendCustomerMessage(
      { delivery, dispatchRepo, dncRepo, consentRepo, auditRepo },
      {
        tenantId: TENANT,
        customer: makeCustomer(),
        entityType: 'invoice',
        entityId: 'inv-1',
        channels: ['sms'],
        smsBody: 'Receipt',
        idempotencyKeyPrefix: 'invoice:inv-1:receipt',
      },
    );

    expect(delivery.sentSms).toHaveLength(0);
    const events = await auditRepo.findByEntity(TENANT, 'invoice', 'inv-1');
    expect(events.some((e) => e.eventType === 'sms_blocked_by_compliance')).toBe(true);
  });
});
