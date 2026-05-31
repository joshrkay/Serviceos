import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { DunningConfig } from '../../src/invoices/dunning-config';
import { computeLateFeeCents, daysPastDue } from '../../src/invoices/late-fee';

const TENANT = 'tenant-late-fee';

function makeConfig(overrides: Partial<DunningConfig> = {}): DunningConfig {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: uuidv4(),
    tenantId: TENANT,
    enabled: true,
    reminderSteps: [],
    lateFeeType: 'flat',
    lateFeeValueCents: 2500,
    lateFeeGraceDays: 0,
    lateFeeMaxCents: undefined,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const dueDate = new Date('2026-01-01T00:00:00Z');
const tenDaysLate = new Date('2026-01-11T00:00:00Z');

describe('daysPastDue', () => {
  it('is 0 before/at the due date', () => {
    expect(daysPastDue(dueDate, new Date('2025-12-31T00:00:00Z'))).toBe(0);
    expect(daysPastDue(dueDate, dueDate)).toBe(0);
  });
  it('counts whole elapsed days', () => {
    expect(daysPastDue(dueDate, tenDaysLate)).toBe(10);
    expect(daysPastDue(dueDate, new Date('2026-01-11T12:00:00Z'))).toBe(10);
  });
});

describe('computeLateFeeCents', () => {
  it('returns 0 when policy is none', () => {
    const fee = computeLateFeeCents(makeConfig({ lateFeeType: 'none' }), {
      amountDueCents: 100000,
      dueDate,
      now: tenDaysLate,
    });
    expect(fee).toBe(0);
  });

  it('returns 0 when disabled', () => {
    const fee = computeLateFeeCents(makeConfig({ enabled: false }), {
      amountDueCents: 100000,
      dueDate,
      now: tenDaysLate,
    });
    expect(fee).toBe(0);
  });

  it('returns 0 when nothing is outstanding', () => {
    const fee = computeLateFeeCents(makeConfig(), {
      amountDueCents: 0,
      dueDate,
      now: tenDaysLate,
    });
    expect(fee).toBe(0);
  });

  it('applies a flat fee once past due', () => {
    const fee = computeLateFeeCents(makeConfig({ lateFeeValueCents: 2500 }), {
      amountDueCents: 100000,
      dueDate,
      now: tenDaysLate,
    });
    expect(fee).toBe(2500);
  });

  it('applies a percent fee in basis points of the balance', () => {
    // 1.5% of $1,000.00 = $15.00
    const fee = computeLateFeeCents(
      makeConfig({ lateFeeType: 'percent', lateFeeValueCents: 150 }),
      { amountDueCents: 100000, dueDate, now: tenDaysLate },
    );
    expect(fee).toBe(1500);
  });

  it('rounds percent fees to the nearest cent', () => {
    // 1.5% of $3.33 = 4.995c → 5c
    const fee = computeLateFeeCents(
      makeConfig({ lateFeeType: 'percent', lateFeeValueCents: 150 }),
      { amountDueCents: 333, dueDate, now: tenDaysLate },
    );
    expect(fee).toBe(5);
  });

  it('respects the grace period (no fee within grace)', () => {
    const cfg = makeConfig({ lateFeeGraceDays: 15 });
    expect(
      computeLateFeeCents(cfg, { amountDueCents: 100000, dueDate, now: tenDaysLate }),
    ).toBe(0);
    // strictly after grace: day 16
    expect(
      computeLateFeeCents(cfg, {
        amountDueCents: 100000,
        dueDate,
        now: new Date('2026-01-17T00:00:00Z'),
      }),
    ).toBe(2500);
  });

  it('caps total accrual at lateFeeMaxCents', () => {
    const cfg = makeConfig({ lateFeeValueCents: 2500, lateFeeMaxCents: 4000 });
    // already accrued 2500 → only 1500 of headroom remains
    expect(
      computeLateFeeCents(cfg, {
        amountDueCents: 100000,
        dueDate,
        now: tenDaysLate,
        alreadyAccruedCents: 2500,
      }),
    ).toBe(1500);
    // cap already reached → 0
    expect(
      computeLateFeeCents(cfg, {
        amountDueCents: 100000,
        dueDate,
        now: tenDaysLate,
        alreadyAccruedCents: 4000,
      }),
    ).toBe(0);
  });

  it('returns 0 for a non-positive configured value', () => {
    expect(
      computeLateFeeCents(makeConfig({ lateFeeValueCents: 0 }), {
        amountDueCents: 100000,
        dueDate,
        now: tenDaysLate,
      }),
    ).toBe(0);
  });
});
