import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  resolveMemberDiscountBps,
  getCustomerMemberDiscountBps,
} from '../../src/agreements/member-pricing';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';
import type { Agreement } from '../../src/agreements/agreement';

function agreement(overrides: Partial<Agreement>): Agreement {
  const now = new Date();
  return {
    id: uuidv4(),
    tenantId: 't',
    customerId: 'c',
    name: 'membership',
    recurrenceRule: 'FREQ=MONTHLY',
    priceCents: 1000,
    autoGenerateInvoice: true,
    autoGenerateJob: true,
    nextRunAt: now,
    status: 'active',
    startsOn: '2026-01-01',
    memberDiscountBps: 1000,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('resolveMemberDiscountBps', () => {
  const asOf = new Date('2026-06-01T00:00:00Z');

  it('returns 0 when there are no agreements', () => {
    expect(resolveMemberDiscountBps([], asOf)).toBe(0);
  });

  it('returns the bps of an active, in-term, discounting membership', () => {
    expect(resolveMemberDiscountBps([agreement({ memberDiscountBps: 1500 })], asOf)).toBe(1500);
  });

  it('ignores a zero-discount agreement', () => {
    expect(resolveMemberDiscountBps([agreement({ memberDiscountBps: 0 })], asOf)).toBe(0);
  });

  it('ignores paused or cancelled memberships', () => {
    expect(
      resolveMemberDiscountBps([agreement({ status: 'paused', memberDiscountBps: 2000 })], asOf),
    ).toBe(0);
    expect(
      resolveMemberDiscountBps([agreement({ status: 'cancelled', memberDiscountBps: 2000 })], asOf),
    ).toBe(0);
  });

  it('ignores a membership that has not started or has lapsed', () => {
    expect(
      resolveMemberDiscountBps([agreement({ startsOn: '2026-07-01', memberDiscountBps: 2000 })], asOf),
    ).toBe(0);
    expect(
      resolveMemberDiscountBps([agreement({ endsOn: '2026-05-01', memberDiscountBps: 2000 })], asOf),
    ).toBe(0);
  });

  it('returns the best (highest) discount across multiple memberships', () => {
    expect(
      resolveMemberDiscountBps(
        [
          agreement({ memberDiscountBps: 500 }),
          agreement({ memberDiscountBps: 1500 }),
          agreement({ memberDiscountBps: 1000 }),
        ],
        asOf,
      ),
    ).toBe(1500);
  });

  it('treats the term boundaries as inclusive (starts/ends today)', () => {
    expect(
      resolveMemberDiscountBps(
        [agreement({ startsOn: '2026-06-01', endsOn: '2026-06-01', memberDiscountBps: 1200 })],
        asOf,
      ),
    ).toBe(1200);
  });
});

describe('getCustomerMemberDiscountBps', () => {
  it('resolves the best discount from the customer active agreements', async () => {
    const repo = new InMemoryAgreementRepository();
    const tenantId = uuidv4();
    const customerId = uuidv4();
    await repo.create(agreement({ tenantId, customerId, memberDiscountBps: 1000 }));
    await repo.create(agreement({ tenantId, customerId, memberDiscountBps: 2000 }));
    // A different customer's richer membership must not leak in.
    await repo.create(agreement({ tenantId, customerId: uuidv4(), memberDiscountBps: 5000 }));
    const bps = await getCustomerMemberDiscountBps(
      tenantId,
      customerId,
      repo,
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(bps).toBe(2000);
  });

  it('returns 0 for a customer with no memberships', async () => {
    const repo = new InMemoryAgreementRepository();
    const bps = await getCustomerMemberDiscountBps(uuidv4(), uuidv4(), repo, new Date());
    expect(bps).toBe(0);
  });
});
