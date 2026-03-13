import { faker } from '@faker-js/faker';
import { Invoice, InvoiceStatus, CreateInvoiceInput } from '../../src/invoices/invoice';
import { calculateDocumentTotals } from '../../src/shared/billing-engine';
import { buildLineItemFactory } from './line-item.factory';

export function buildInvoice(overrides?: Partial<Invoice>): Invoice {
  const lineItems = overrides?.lineItems ?? [buildLineItemFactory(), buildLineItemFactory()];
  const totals = overrides?.totals ?? calculateDocumentTotals(lineItems, 0, 800);

  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    jobId: faker.string.uuid(),
    estimateId: faker.string.uuid(),
    invoiceNumber: `INV-${faker.string.numeric(4)}`,
    status: 'draft' as InvoiceStatus,
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    issuedAt: undefined,
    dueDate: undefined,
    customerMessage: faker.lorem.sentence(),
    createdBy: faker.string.uuid(),
    createdAt: faker.date.recent(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

export function buildCreateInvoiceInput(overrides?: Partial<CreateInvoiceInput>): CreateInvoiceInput {
  return {
    tenantId: faker.string.uuid(),
    jobId: faker.string.uuid(),
    invoiceNumber: `INV-${faker.string.numeric(4)}`,
    lineItems: [buildLineItemFactory()],
    discountCents: 0,
    taxRateBps: 800,
    createdBy: faker.string.uuid(),
    ...overrides,
  };
}
