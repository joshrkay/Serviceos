import { describe, it, expect } from 'vitest';
import {
  evaluateDepositRule,
  deriveDepositStatus,
  type DepositRuleSettings,
} from '../../src/jobs/deposit-rule';

const NO_RULE: DepositRuleSettings = {};

describe('evaluateDepositRule — Tier 4 PR 2 pure rule evaluator', () => {
  describe('no rule configured', () => {
    it('returns 0 when depositStrategy is undefined', () => {
      expect(evaluateDepositRule(NO_RULE, 100000)).toBe(0);
    });
    it('returns 0 when depositStrategy is null', () => {
      expect(evaluateDepositRule({ depositStrategy: null }, 100000)).toBe(0);
    });
  });

  describe('non-positive totals', () => {
    it('returns 0 when total is 0', () => {
      expect(
        evaluateDepositRule(
          { depositStrategy: 'percentage', depositPercentageBps: 2500 },
          0,
        ),
      ).toBe(0);
    });
    it('returns 0 when total is negative', () => {
      expect(
        evaluateDepositRule(
          { depositStrategy: 'fixed', depositFixedCents: 50000 },
          -100,
        ),
      ).toBe(0);
    });
    it('returns 0 when total is NaN', () => {
      expect(
        evaluateDepositRule(
          { depositStrategy: 'percentage', depositPercentageBps: 2500 },
          NaN,
        ),
      ).toBe(0);
    });
  });

  describe('threshold', () => {
    it('returns 0 when total is below depositRequiredAboveCents', () => {
      const settings: DepositRuleSettings = {
        depositStrategy: 'percentage',
        depositPercentageBps: 2500,
        depositRequiredAboveCents: 50000, // $500
      };
      expect(evaluateDepositRule(settings, 49999)).toBe(0);
    });
    it('applies the rule at the threshold (>= comparison)', () => {
      const settings: DepositRuleSettings = {
        depositStrategy: 'percentage',
        depositPercentageBps: 2500,
        depositRequiredAboveCents: 50000,
      };
      expect(evaluateDepositRule(settings, 50000)).toBe(12500);
    });
  });

  describe('percentage strategy', () => {
    it('25% of $1000 → $250', () => {
      expect(
        evaluateDepositRule(
          { depositStrategy: 'percentage', depositPercentageBps: 2500 },
          100000,
        ),
      ).toBe(25000);
    });
    it('100% of total caps at total', () => {
      expect(
        evaluateDepositRule(
          { depositStrategy: 'percentage', depositPercentageBps: 10000 },
          100000,
        ),
      ).toBe(100000);
    });
    it('rounds half-cents to nearest integer', () => {
      // 33.33% of 100 cents = 33.33 cents → 33
      expect(
        evaluateDepositRule(
          { depositStrategy: 'percentage', depositPercentageBps: 3333 },
          100,
        ),
      ).toBe(33);
    });
    it('returns 0 when bps is missing', () => {
      expect(
        evaluateDepositRule({ depositStrategy: 'percentage' }, 100000),
      ).toBe(0);
    });
    it('returns 0 when bps is 0', () => {
      expect(
        evaluateDepositRule(
          { depositStrategy: 'percentage', depositPercentageBps: 0 },
          100000,
        ),
      ).toBe(0);
    });
  });

  describe('fixed strategy', () => {
    it('returns the fixed amount when total exceeds it', () => {
      expect(
        evaluateDepositRule(
          { depositStrategy: 'fixed', depositFixedCents: 50000 },
          100000,
        ),
      ).toBe(50000);
    });
    it('caps at total — never demand more than the contract is worth', () => {
      // Fixed $500 deposit but the job is only $100 total → cap.
      expect(
        evaluateDepositRule(
          { depositStrategy: 'fixed', depositFixedCents: 50000 },
          10000,
        ),
      ).toBe(10000);
    });
    it('returns 0 when fixed is missing', () => {
      expect(evaluateDepositRule({ depositStrategy: 'fixed' }, 100000)).toBe(0);
    });
    it('returns 0 when fixed is 0', () => {
      expect(
        evaluateDepositRule(
          { depositStrategy: 'fixed', depositFixedCents: 0 },
          100000,
        ),
      ).toBe(0);
    });
  });
});

describe('deriveDepositStatus — Tier 4 PR 2', () => {
  it('returns not_required when required is 0', () => {
    expect(deriveDepositStatus(0, 0)).toBe('not_required');
  });
  it('returns not_required even if paid > 0 but required is 0 (pathological data)', () => {
    expect(deriveDepositStatus(0, 5000)).toBe('not_required');
  });
  it('returns pending when required > 0 and paid < required', () => {
    expect(deriveDepositStatus(50000, 0)).toBe('pending');
    expect(deriveDepositStatus(50000, 25000)).toBe('pending');
  });
  it('returns paid when paid === required', () => {
    expect(deriveDepositStatus(50000, 50000)).toBe('paid');
  });
  it('returns paid when paid > required (overpayment edge — treat as satisfied)', () => {
    expect(deriveDepositStatus(50000, 75000)).toBe('paid');
  });
});
