import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  InMemoryCustomerPaymentMethodRepository,
  CustomerPaymentMethod,
} from '../../src/payments/customer-payment-method';

function pm(overrides: Partial<CustomerPaymentMethod>): CustomerPaymentMethod {
  const now = new Date();
  return {
    id: uuidv4(),
    tenantId: 't',
    customerId: 'c',
    stripeCustomerId: 'cus_1',
    stripePaymentMethodId: `pm_${uuidv4()}`,
    brand: 'visa',
    last4: '4242',
    expMonth: 12,
    expYear: 2030,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('InMemoryCustomerPaymentMethodRepository', () => {
  it('creates and lists by customer, newest first', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    const t = uuidv4();
    const c = uuidv4();
    await repo.create(pm({ tenantId: t, customerId: c, createdAt: new Date(1000) }));
    await repo.create(pm({ tenantId: t, customerId: c, createdAt: new Date(2000) }));
    const list = await repo.findByCustomer(t, c);
    expect(list).toHaveLength(2);
    expect(list[0].createdAt.getTime()).toBe(2000);
  });

  it('isolates by tenant', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    const c = uuidv4();
    await repo.create(pm({ tenantId: 'A', customerId: c }));
    expect(await repo.findByCustomer('B', c)).toEqual([]);
  });

  it('finds the default card and a card by its Stripe payment-method id', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    const t = uuidv4();
    const c = uuidv4();
    const d = await repo.create(
      pm({ tenantId: t, customerId: c, isDefault: true, stripePaymentMethodId: 'pm_default' }),
    );
    await repo.create(pm({ tenantId: t, customerId: c, isDefault: false }));
    expect((await repo.findDefaultForCustomer(t, c))?.id).toBe(d.id);
    expect((await repo.findByStripePaymentMethodId(t, 'pm_default'))?.id).toBe(d.id);
  });

  it('reuses one Stripe customer id across a customer cards', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    const t = uuidv4();
    const c = uuidv4();
    await repo.create(pm({ tenantId: t, customerId: c, stripeCustomerId: 'cus_shared' }));
    expect(await repo.findStripeCustomerId(t, c)).toBe('cus_shared');
    expect(await repo.findStripeCustomerId(t, uuidv4())).toBeNull();
  });

  it('setDefault makes exactly one card the default', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    const t = uuidv4();
    const c = uuidv4();
    await repo.create(pm({ tenantId: t, customerId: c, isDefault: true }));
    const b = await repo.create(pm({ tenantId: t, customerId: c, isDefault: false }));
    await repo.setDefault(t, b.id);
    const list = await repo.findByCustomer(t, c);
    expect(list.filter((p) => p.isDefault).map((p) => p.id)).toEqual([b.id]);
    expect((await repo.findDefaultForCustomer(t, c))?.id).toBe(b.id);
  });
});
