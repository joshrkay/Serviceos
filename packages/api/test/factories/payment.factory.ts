import { faker } from '@faker-js/faker';
import { Payment, PaymentStatus, PaymentMethod, RecordPaymentInput } from '../../src/invoices/payment';

export function buildPayment(overrides?: Partial<Payment>): Payment {
  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    invoiceId: faker.string.uuid(),
    amountCents: faker.number.int({ min: 100, max: 100000 }),
    method: faker.helpers.arrayElement(['cash', 'check', 'credit_card', 'bank_transfer', 'other'] as PaymentMethod[]),
    status: 'completed' as PaymentStatus,
    providerReference: faker.string.alphanumeric(12),
    note: faker.lorem.sentence(),
    receivedAt: faker.date.recent(),
    processedBy: faker.string.uuid(),
    createdAt: faker.date.recent(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

export function buildRecordPaymentInput(overrides?: Partial<RecordPaymentInput>): RecordPaymentInput {
  return {
    tenantId: faker.string.uuid(),
    invoiceId: faker.string.uuid(),
    amountCents: faker.number.int({ min: 100, max: 100000 }),
    method: 'credit_card',
    processedBy: faker.string.uuid(),
    ...overrides,
  };
}
