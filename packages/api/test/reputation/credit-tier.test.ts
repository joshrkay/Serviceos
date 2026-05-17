/**
 * P7-026 — credit-tier suggestion + 12-month cap tests.
 *
 * Verifies the $100 maximum (10,000 cents) per customer per rolling 12
 * months and the proposal-builder-friendly bounding helper. The hard
 * `assertCreditWithinCap` is exercised separately so the execution
 * handler's defense-in-depth use is covered.
 */

import { describe, it, expect } from 'vitest';
import {
  suggestCreditTier,
  boundCreditByCap,
  assertCreditWithinCap,
  SERVICE_CREDIT_12MO_CAP_CENTS,
} from '../../src/reputation/credit-tier';
import { InMemoryServiceCreditRepository } from '../../src/reputation/service-credit-repository';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-05-17T18:00:00Z');

describe('P7-026 suggestCreditTier', () => {
  it('P7-026 suggests $0 for praise reviews', () => {
    expect(
      suggestCreditTier({
        classification: 'praise',
        matchConfidence: 'high',
        rating: 5,
      }),
    ).toBe(0);
  });

  it('P7-026 suggests $0 for wrong_business (no apology owed)', () => {
    expect(
      suggestCreditTier({
        classification: 'wrong_business',
        matchConfidence: 'high',
        rating: 1,
      }),
    ).toBe(0);
  });

  it('P7-026 suggests $0 when match is not high-confidence', () => {
    expect(
      suggestCreditTier({
        classification: 'specific_complaint',
        matchConfidence: 'low',
        rating: 1,
      }),
    ).toBe(0);
  });

  it('P7-026 1-star specific complaint with high match → $100 cents', () => {
    expect(
      suggestCreditTier({
        classification: 'specific_complaint',
        matchConfidence: 'high',
        rating: 1,
      }),
    ).toBe(10000);
  });

  it('P7-026 2-star specific complaint with high match → $50', () => {
    expect(
      suggestCreditTier({
        classification: 'specific_complaint',
        matchConfidence: 'high',
        rating: 2,
      }),
    ).toBe(5000);
  });

  it('P7-026 vague complaint with high match → $25', () => {
    expect(
      suggestCreditTier({
        classification: 'vague_complaint',
        matchConfidence: 'high',
        rating: 2,
      }),
    ).toBe(2500);
  });

  it('P7-026 credit suggestion never exceeds the V1 hard cap', () => {
    // No matter the input combo, the suggestion is at most the cap.
    for (const rating of [1, 2, 3, 4, 5]) {
      const v = suggestCreditTier({
        classification: 'specific_complaint',
        matchConfidence: 'high',
        rating,
      });
      expect(v).toBeLessThanOrEqual(SERVICE_CREDIT_12MO_CAP_CENTS);
    }
  });
});

describe('P7-026 boundCreditByCap — 12-month sliding window', () => {
  it('P7-026 returns full proposed amount when customer has no prior credits', async () => {
    const repo = new InMemoryServiceCreditRepository();
    const result = await boundCreditByCap({
      tenantId: TENANT,
      customerId: CUSTOMER,
      proposedAmountCents: 10000,
      now: NOW,
      repo,
    });
    expect(result.amountCents).toBe(10000);
    expect(result.alreadyIssuedCents).toBe(0);
    expect(result.capApplied).toBe(false);
  });

  it('P7-026 clamps to the remaining allowance', async () => {
    const repo = new InMemoryServiceCreditRepository();
    await repo.create({
      id: 'c1',
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 7500,
      issuedAt: new Date('2026-03-01T00:00:00Z'),
      issuedByUserId: 'u1',
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });
    const result = await boundCreditByCap({
      tenantId: TENANT,
      customerId: CUSTOMER,
      proposedAmountCents: 10000,
      now: NOW,
      repo,
    });
    expect(result.amountCents).toBe(2500);
    expect(result.capApplied).toBe(true);
    expect(result.alreadyIssuedCents).toBe(7500);
    expect(result.remainingCapCents).toBe(0);
  });

  it('P7-026 returns zero when the customer already hit the cap', async () => {
    const repo = new InMemoryServiceCreditRepository();
    await repo.create({
      id: 'c1',
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 10000,
      issuedAt: new Date('2026-03-01T00:00:00Z'),
      issuedByUserId: 'u1',
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });
    const result = await boundCreditByCap({
      tenantId: TENANT,
      customerId: CUSTOMER,
      proposedAmountCents: 5000,
      now: NOW,
      repo,
    });
    expect(result.amountCents).toBe(0);
    expect(result.capApplied).toBe(true);
  });

  it('P7-026 ignores credits older than 12 months (sliding window)', async () => {
    const repo = new InMemoryServiceCreditRepository();
    // 13 months ago — outside window
    await repo.create({
      id: 'c1',
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 10000,
      issuedAt: new Date('2025-04-01T00:00:00Z'),
      issuedByUserId: 'u1',
      createdAt: new Date('2025-04-01T00:00:00Z'),
    });
    const result = await boundCreditByCap({
      tenantId: TENANT,
      customerId: CUSTOMER,
      proposedAmountCents: 10000,
      now: NOW,
      repo,
    });
    expect(result.amountCents).toBe(10000);
    expect(result.alreadyIssuedCents).toBe(0);
  });

  it('P7-026 rejects floating-point cent amounts (CLAUDE.md money rule)', async () => {
    const repo = new InMemoryServiceCreditRepository();
    await expect(
      boundCreditByCap({
        tenantId: TENANT,
        customerId: CUSTOMER,
        proposedAmountCents: 1234.5,
        now: NOW,
        repo,
      }),
    ).rejects.toThrow(/integer/);
  });
});

describe('P7-026 assertCreditWithinCap — execution-time hard guard', () => {
  it('P7-026 passes when the suggestion fits the remaining cap', async () => {
    const repo = new InMemoryServiceCreditRepository();
    await expect(
      assertCreditWithinCap({
        tenantId: TENANT,
        customerId: CUSTOMER,
        proposedAmountCents: 5000,
        now: NOW,
        repo,
      }),
    ).resolves.toBeUndefined();
  });

  it('P7-026 throws when the requested issuance would breach the cap', async () => {
    const repo = new InMemoryServiceCreditRepository();
    await repo.create({
      id: 'c1',
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 7500,
      issuedAt: new Date('2026-03-01T00:00:00Z'),
      issuedByUserId: 'u1',
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });
    await expect(
      assertCreditWithinCap({
        tenantId: TENANT,
        customerId: CUSTOMER,
        proposedAmountCents: 10000,
        now: NOW,
        repo,
      }),
    ).rejects.toThrow(/12-month/);
  });
});
