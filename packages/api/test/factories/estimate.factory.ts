import { faker } from './faker';
import { Estimate, EstimateStatus, CreateEstimateInput } from '../../src/estimates/estimate';
import { calculateDocumentTotals } from '../../src/shared/billing-engine';
import { buildLineItem } from './line-item.factory';

export function buildEstimate(overrides?: Partial<Estimate>): Estimate {
  const lineItems = overrides?.lineItems ?? [buildLineItem(), buildLineItem()];
  const totals = overrides?.totals ?? calculateDocumentTotals(lineItems, 0, 800);

  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    jobId: faker.string.uuid(),
    estimateNumber: `EST-${faker.string.numeric(4)}`,
    status: 'draft' as EstimateStatus,
    lineItems,
    totals,
    validUntil: faker.date.future(),
    customerMessage: faker.lorem.sentence(),
    internalNotes: faker.lorem.sentence(),
    createdBy: faker.string.uuid(),
    createdAt: faker.date.recent(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

export function buildCreateEstimateInput(overrides?: Partial<CreateEstimateInput>): CreateEstimateInput {
  return {
    tenantId: faker.string.uuid(),
    jobId: faker.string.uuid(),
    estimateNumber: `EST-${faker.string.numeric(4)}`,
    lineItems: [buildLineItem()],
    discountCents: 0,
    taxRateBps: 800,
    createdBy: faker.string.uuid(),
    ...overrides,
  };
}
