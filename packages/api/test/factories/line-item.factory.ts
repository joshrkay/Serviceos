import { faker } from '@faker-js/faker';
import { LineItem, LineItemCategory, calculateLineItemTotal } from '../../src/shared/billing-engine';

export function buildLineItem(overrides?: Partial<LineItem>): LineItem {
  const quantity = overrides?.quantity ?? faker.number.int({ min: 1, max: 10 });
  const unitPriceCents = overrides?.unitPriceCents ?? faker.number.int({ min: 500, max: 50000 });
  const totalCents = overrides?.totalCents ?? calculateLineItemTotal(quantity, unitPriceCents);

  return {
    id: faker.string.uuid(),
    description: faker.commerce.productName(),
    category: faker.helpers.arrayElement(['labor', 'material', 'equipment', 'other'] as LineItemCategory[]),
    quantity,
    unitPriceCents,
    totalCents,
    sortOrder: faker.number.int({ min: 0, max: 10 }),
    taxable: true,
    ...overrides,
  };
}
