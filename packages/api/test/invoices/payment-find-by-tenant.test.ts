import { describe, it, expect } from 'vitest';
import { InMemoryPaymentRepository, Payment } from '../../src/invoices/payment';

function makePayment(over: Partial<Payment>): Payment {
  const now = new Date();
  return {
    id: `pay-${Math.random().toString(36).slice(2)}`,
    tenantId: 't1',
    invoiceId: 'inv1',
    amountCents: 10000,
    method: 'credit_card',
    status: 'completed',
    receivedAt: new Date('2026-05-10T00:00:00.000Z'),
    processedBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('InMemoryPaymentRepository.findByTenant', () => {
  it('filters by tenant, status, and receivedAt window', async () => {
    const repo = new InMemoryPaymentRepository();
    await repo.create(makePayment({ receivedAt: new Date('2026-05-05') }));
    await repo.create(makePayment({ status: 'pending', receivedAt: new Date('2026-05-06') }));
    await repo.create(makePayment({ receivedAt: new Date('2026-06-10') }));
    await repo.create(makePayment({ tenantId: 't2', receivedAt: new Date('2026-05-07') }));

    const all = await repo.findByTenant('t1');
    expect(all).toHaveLength(3);

    const completedInMay = await repo.findByTenant('t1', {
      status: 'completed',
      from: new Date('2026-05-01'),
      to: new Date('2026-06-01'),
    });
    expect(completedInMay).toHaveLength(1);
  });
});
