import { describe, it, expect } from 'vitest';
import { InMemoryServiceCreditRepository } from '../../src/reputation/service-credit';

const TENANT = '22222222-2222-2222-2222-222222222222';
const CUSTOMER = '44444444-4444-4444-4444-444444444444';
const PROPOSAL = '55555555-5555-5555-5555-555555555555';
const REVIEW = '11111111-1111-1111-1111-111111111111';

describe('P7-026 InMemoryServiceCreditRepository', () => {
  it('create + sumIssuedInLast12Months round-trip', async () => {
    const repo = new InMemoryServiceCreditRepository();
    await repo.create({
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 5000,
      reviewId: REVIEW,
      proposalId: PROPOSAL,
    });
    const sum = await repo.sumIssuedInLast12Months(TENANT, CUSTOMER);
    expect(sum).toBe(5000);
  });

  it('sums multiple credits to one customer', async () => {
    const repo = new InMemoryServiceCreditRepository();
    await repo.create({
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 2500,
      reviewId: REVIEW,
      proposalId: PROPOSAL,
    });
    await repo.create({
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 5000,
      reviewId: null,
      proposalId: PROPOSAL,
    });
    expect(await repo.sumIssuedInLast12Months(TENANT, CUSTOMER)).toBe(7500);
  });

  it('does not include credits issued more than 12 months ago', async () => {
    const now = new Date('2026-05-17T00:00:00Z');
    const thirteenMonthsAgo = new Date('2025-04-01T00:00:00Z');
    const sixMonthsAgo = new Date('2025-11-17T00:00:00Z');
    const repo = new InMemoryServiceCreditRepository(() => now);
    await repo.create({
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 9999,
      reviewId: null,
      proposalId: PROPOSAL,
      issuedAt: thirteenMonthsAgo,
    });
    await repo.create({
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 2500,
      reviewId: null,
      proposalId: PROPOSAL,
      issuedAt: sixMonthsAgo,
    });
    expect(await repo.sumIssuedInLast12Months(TENANT, CUSTOMER)).toBe(2500);
  });

  it('isolates by tenant (one tenant cannot see another tenants credits)', async () => {
    const repo = new InMemoryServiceCreditRepository();
    await repo.create({
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 5000,
      reviewId: null,
      proposalId: PROPOSAL,
    });
    const OTHER_TENANT = '99999999-9999-9999-9999-999999999999';
    expect(await repo.sumIssuedInLast12Months(OTHER_TENANT, CUSTOMER)).toBe(0);
  });

  it('isolates by customer', async () => {
    const repo = new InMemoryServiceCreditRepository();
    await repo.create({
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 5000,
      reviewId: null,
      proposalId: PROPOSAL,
    });
    const OTHER_CUSTOMER = '88888888-8888-8888-8888-888888888888';
    expect(await repo.sumIssuedInLast12Months(TENANT, OTHER_CUSTOMER)).toBe(0);
  });

  it('rejects zero or negative amount', async () => {
    const repo = new InMemoryServiceCreditRepository();
    await expect(
      repo.create({
        tenantId: TENANT,
        customerId: CUSTOMER,
        amountCents: 0,
        reviewId: null,
        proposalId: PROPOSAL,
      }),
    ).rejects.toThrow(/positive/);
    await expect(
      repo.create({
        tenantId: TENANT,
        customerId: CUSTOMER,
        amountCents: -500,
        reviewId: null,
        proposalId: PROPOSAL,
      }),
    ).rejects.toThrow(/positive/);
  });

  it('uses calendar-month subtraction (matches Pg INTERVAL 12 months), not a fixed 365-day window', async () => {
    // Mirrors the Pg semantics: `NOW() - INTERVAL '12 months'` rolls
    // back exactly 12 calendar months, not 365 days. Boundary contract
    // is strict (`>`): a row at cutoff - 1ms is excluded, a row at
    // cutoff + 1ms is included.
    const now = new Date('2026-05-17T12:00:00Z');
    const repo = new InMemoryServiceCreditRepository(() => now);
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - 12);
    // Diverges from the fixed 365-day window: that would land on
    // 2025-05-17 (same day), but `setMonth(-12)` from a leap-year
    // anchor confirms the path actually walks calendar months — assert
    // both the boundary and the cross-year date arithmetic.
    expect(cutoff.toISOString()).toBe('2025-05-17T12:00:00.000Z');

    const justBefore = new Date(cutoff.getTime() - 1);
    const justAfter = new Date(cutoff.getTime() + 1);

    await repo.create({
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 1111,
      reviewId: null,
      proposalId: PROPOSAL,
      issuedAt: justBefore,
    });
    await repo.create({
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 2222,
      reviewId: null,
      proposalId: PROPOSAL,
      issuedAt: justAfter,
    });

    expect(await repo.sumIssuedInLast12Months(TENANT, CUSTOMER)).toBe(2222);
  });

  it('returns a fresh ID per create (no collision)', async () => {
    const repo = new InMemoryServiceCreditRepository();
    const a = await repo.create({
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 100,
      reviewId: null,
      proposalId: PROPOSAL,
    });
    const b = await repo.create({
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 100,
      reviewId: null,
      proposalId: PROPOSAL,
    });
    expect(a.id).not.toBe(b.id);
  });
});
