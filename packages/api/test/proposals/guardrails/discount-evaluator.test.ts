/**
 * U3 (P2-036 V2) — Unit tests for the pure discount-decision evaluator
 * (src/proposals/guardrails/discount-evaluator.ts), the MONEY-CORRECTNESS CORE.
 *
 * This is an exhaustive boundary table. The branch ORDER in the evaluator is the
 * contract, so the cases below pin it: each input maps to exactly one
 * DiscountDecision, and every returned object is round-tripped through
 * `discountDecisionSchema.parse` to prove it satisfies the shared shape.
 *
 * Money is integer cents; rates are basis points (bps). All percentage-of-money
 * math here mirrors the evaluator's single helper (applyBps), so a 10% ask on a
 * $250 quote is $25 off → $225, not a hand-rolled float.
 */
import { describe, it, expect } from 'vitest';
import { discountDecisionSchema } from '@ai-service-os/shared';
import {
  evaluateDiscountAsk,
  type EvaluateDiscountAskInput,
} from '../../../src/proposals/guardrails/discount-evaluator';
import type { DiscountPolicy } from '../../../src/settings/settings';
import type { ParsedDiscountTarget } from '../../../src/conversations/negotiation/target-price-parser';

/** Fail-closed policy: the V1-identical posture (no auto-allow, no floors). */
const failClosed: DiscountPolicy = {
  maxDiscountBps: 0,
  absoluteFloorCents: null,
  neverBelowCatalog: true,
};

/**
 * A configured policy used across the boundary table: 10% auto-allow cap, a
 * $150 absolute floor, and (catalogFloorCents being null today) no catalog
 * floor in play.
 */
const configured: DiscountPolicy = {
  maxDiscountBps: 1000, // 10%
  absoluteFloorCents: 15_000, // $150
  neverBelowCatalog: true,
};

/** A permissive policy with NO floor — isolates the policy-cap branches. */
const noFloor: DiscountPolicy = {
  maxDiscountBps: 1000,
  absoluteFloorCents: null,
  neverBelowCatalog: false,
};

const QUOTE = 25_000; // $250 — the reference quote for the configured table.

function run(overrides: Partial<EvaluateDiscountAskInput> & { parsed: ParsedDiscountTarget }) {
  const input: EvaluateDiscountAskInput = {
    currentQuotedCents: QUOTE,
    policy: configured,
    catalogGrounded: true,
    ...overrides,
  };
  const decision = evaluateDiscountAsk(input);
  // Every decision MUST satisfy the shared contract shape.
  expect(() => discountDecisionSchema.parse(decision)).not.toThrow();
  return decision;
}

const targetPrice = (cents: number): ParsedDiscountTarget => ({
  kind: 'target_price',
  requestedTargetCents: cents,
});
const discountAmount = (cents: number): ParsedDiscountTarget => ({
  kind: 'discount_amount',
  requestedDiscountAmountCents: cents,
});
const discountPercent = (bps: number): ParsedDiscountTarget => ({
  kind: 'discount_percent',
  requestedDiscountBps: bps,
});
const ambiguous: ParsedDiscountTarget = { kind: 'ambiguous' };

describe('evaluateDiscountAsk — CLARIFY guards (steps 1, 2, 5)', () => {
  it('ambiguous parse → CLARIFY (step 1, before everything else)', () => {
    const d = run({ parsed: ambiguous });
    expect(d).toEqual({ kind: 'CLARIFY', reason: 'ambiguous_discount_target' });
  });

  it('ambiguous wins even on an ungrounded quote (order: step 1 before step 3)', () => {
    const d = run({ parsed: ambiguous, catalogGrounded: false });
    expect(d.kind).toBe('CLARIFY');
  });

  it('currentQuotedCents 0 → CLARIFY (step 2: no base to evaluate)', () => {
    const d = run({ parsed: targetPrice(10_000), currentQuotedCents: 0 });
    expect(d).toEqual({ kind: 'CLARIFY', reason: 'ambiguous_discount_target' });
  });

  it('negative currentQuotedCents → CLARIFY (step 2)', () => {
    const d = run({ parsed: targetPrice(10_000), currentQuotedCents: -5 });
    expect(d.kind).toBe('CLARIFY');
  });

  it('requestedFinal === quoted (not a discount) → CLARIFY (step 5)', () => {
    const d = run({ parsed: targetPrice(QUOTE) });
    expect(d.kind).toBe('CLARIFY');
  });

  it('requestedFinal > quoted (a price increase) → CLARIFY (step 5)', () => {
    const d = run({ parsed: targetPrice(QUOTE + 5_000) });
    expect(d.kind).toBe('CLARIFY');
  });

  it('requestedFinal <= 0 (e.g. amount off >= quote) → CLARIFY (step 5)', () => {
    const d = run({ parsed: discountAmount(QUOTE) }); // final = 0
    expect(d.kind).toBe('CLARIFY');
  });

  it('requestedFinal negative (amount off > quote) → CLARIFY (step 5)', () => {
    const d = run({ parsed: discountAmount(QUOTE + 1_000) });
    expect(d.kind).toBe('CLARIFY');
  });
});

describe('evaluateDiscountAsk — fail-closed (maxDiscountBps 0) ≡ V1', () => {
  it('KEY PROPERTY: policyAllowsCents === currentQuotedCents at maxDiscountBps 0', () => {
    // With a 0 cap, applyBps(quote, 10000-0) === quote, so policyAllows === quote
    // and no real discount (final < quote) can ever satisfy the ALLOW branch's
    // `requestedFinalCents >= policyAllowsCents` test. Every ask escalates — the
    // exact V1 behavior, which blocked discounts entirely.
    const d = run({ parsed: targetPrice(24_000), policy: failClosed });
    expect(d).toEqual({
      kind: 'NEEDS_APPROVAL',
      requestedTargetCents: 24_000,
      requestedDiscountBps: Math.round(((QUOTE - 24_000) * 10_000) / QUOTE),
    });
  });

  it('a tiny 1% ask still escalates under fail-closed', () => {
    const d = run({ parsed: discountPercent(100), policy: failClosed });
    expect(d.kind).toBe('NEEDS_APPROVAL');
  });

  it('a large 50% ask escalates (no floor configured → not a counter)', () => {
    const d = run({ parsed: discountPercent(5_000), policy: failClosed });
    expect(d.kind).toBe('NEEDS_APPROVAL');
  });
});

describe('evaluateDiscountAsk — configured policy (cap 10%, floor $150, quote $250)', () => {
  it('8% ask → $230 → ALLOW', () => {
    const d = run({ parsed: discountPercent(800) });
    expect(d).toEqual({
      kind: 'ALLOW',
      approvedDiscountBps: 800,
      discountedPriceCents: 23_000,
      floorCents: 15_000,
    });
  });

  it('exactly-at-cap: 10% → $225, requestedFinal === policyAllows → ALLOW (boundary)', () => {
    const d = run({ parsed: discountPercent(1_000) });
    expect(d).toEqual({
      kind: 'ALLOW',
      approvedDiscountBps: 1_000,
      discountedPriceCents: 22_500, // === applyBps(25000, 9000)
      floorCents: 15_000,
    });
  });

  it('12% ask → $220 → NEEDS_APPROVAL (over the 10% cap, below policyAllows)', () => {
    const d = run({ parsed: discountPercent(1_200) });
    expect(d).toEqual({
      kind: 'NEEDS_APPROVAL',
      requestedTargetCents: 22_000,
      requestedDiscountBps: 1_200,
    });
  });

  it('below floor: target $100 → REJECT_WITH_COUNTER at floor $150', () => {
    const d = run({ parsed: targetPrice(10_000) });
    expect(d).toEqual({
      kind: 'REJECT_WITH_COUNTER',
      counterCents: 15_000,
      floorCents: 15_000,
    });
  });

  it('one cent below the floor → REJECT_WITH_COUNTER (boundary)', () => {
    const d = run({ parsed: targetPrice(14_999) });
    expect(d).toEqual({
      kind: 'REJECT_WITH_COUNTER',
      counterCents: 15_000,
      floorCents: 15_000,
    });
  });

  it('exactly at the floor → NOT rejected; routes by policy (here NEEDS_APPROVAL)', () => {
    // $150 final is a 40% discount: above the floor (so not a counter), but far
    // over the 10% cap → escalate, not allow. Pins step-9 ordering: the
    // `< floor` reject is strict, so `=== floor` falls through.
    const d = run({ parsed: targetPrice(15_000) });
    expect(d).toEqual({
      kind: 'NEEDS_APPROVAL',
      requestedTargetCents: 15_000,
      requestedDiscountBps: Math.round(((QUOTE - 15_000) * 10_000) / QUOTE),
    });
  });

  it('floor dominates the policy cap (stricter-of-both): within-cap ask still allowed only above floor', () => {
    // With a HIGH floor that exceeds the policy-allows price, an at-cap ask that
    // would otherwise ALLOW is instead countered at the (stricter) floor.
    const d = run({
      parsed: discountPercent(1_000), // would be $225
      policy: { maxDiscountBps: 1_000, absoluteFloorCents: 23_000, neverBelowCatalog: true },
    });
    expect(d).toEqual({
      kind: 'REJECT_WITH_COUNTER',
      counterCents: 23_000,
      floorCents: 23_000,
    });
  });
});

describe('evaluateDiscountAsk — ungrounded quote (step 3, before normalization)', () => {
  it('within-policy ask still → NEEDS_APPROVAL when !catalogGrounded', () => {
    const d = run({ parsed: discountPercent(800), catalogGrounded: false });
    // 8% on $250 → echo the literal ask: target $230, bps 800.
    expect(d).toEqual({
      kind: 'NEEDS_APPROVAL',
      requestedTargetCents: 23_000,
      requestedDiscountBps: 800,
    });
  });

  it('target_price ungrounded → echoes target, null bps', () => {
    const d = run({ parsed: targetPrice(20_000), catalogGrounded: false });
    expect(d).toEqual({
      kind: 'NEEDS_APPROVAL',
      requestedTargetCents: 20_000,
      requestedDiscountBps: null,
    });
  });

  it('discount_amount ungrounded → derives target, null bps', () => {
    const d = run({ parsed: discountAmount(5_000), catalogGrounded: false });
    expect(d).toEqual({
      kind: 'NEEDS_APPROVAL',
      requestedTargetCents: 20_000,
      requestedDiscountBps: null,
    });
  });
});

describe('evaluateDiscountAsk — parsed-input variants normalize correctly (step 4)', () => {
  it('discount_amount maps to currentQuoted - amount', () => {
    // $20 off $250 = $230 → 8% → within cap & above floor → ALLOW.
    const d = run({ parsed: discountAmount(2_000) });
    expect(d).toEqual({
      kind: 'ALLOW',
      approvedDiscountBps: 800,
      discountedPriceCents: 23_000,
      floorCents: 15_000,
    });
  });

  it('discount_percent maps via applyBps (no float drift)', () => {
    const d = run({ parsed: discountPercent(800) });
    expect(d.kind).toBe('ALLOW');
    if (d.kind === 'ALLOW') expect(d.discountedPriceCents).toBe(23_000);
  });

  it('target_price maps to the named price directly', () => {
    const d = run({ parsed: targetPrice(23_000) });
    expect(d.kind).toBe('ALLOW');
    if (d.kind === 'ALLOW') {
      expect(d.discountedPriceCents).toBe(23_000);
      expect(d.approvedDiscountBps).toBe(800);
    }
  });
});

describe('evaluateDiscountAsk — combined-discount sanity (step 7)', () => {
  it('member 9000 bps + requested 1500 bps (≥ 10000 combined) → REJECT_WITH_COUNTER', () => {
    // 15% off $250 = $212.50 → requestedDiscountBps 1500; 9000 + 1500 = 10500 ≥ 10000.
    const d = run({ parsed: discountPercent(1_500), memberDiscountBps: 9_000 });
    expect(d).toEqual({
      kind: 'REJECT_WITH_COUNTER',
      counterCents: 15_000, // configured absolute floor
      floorCents: 15_000,
    });
  });

  it('combined just under 100% does NOT trip the sanity guard', () => {
    // member 8000 + requested 800 = 8800 < 10000 → normal evaluation (ALLOW at 8%).
    const d = run({ parsed: discountPercent(800), memberDiscountBps: 8_000 });
    expect(d.kind).toBe('ALLOW');
  });

  it('sanity counter uses zero floor when no floors configured', () => {
    const d = run({
      parsed: discountPercent(1_500),
      memberDiscountBps: 9_000,
      policy: noFloor,
    });
    expect(d).toEqual({
      kind: 'REJECT_WITH_COUNTER',
      counterCents: 0,
      floorCents: 0,
    });
  });
});

describe('evaluateDiscountAsk — catalog floor + neverBelowCatalog interaction', () => {
  it('neverBelowCatalog true: catalogFloorCents raises the effective floor', () => {
    // 8% ask → $230, but catalog floor $235 is stricter → counter at $235.
    const d = run({
      parsed: discountPercent(800),
      catalogFloorCents: 23_500,
      policy: { maxDiscountBps: 1_000, absoluteFloorCents: null, neverBelowCatalog: true },
    });
    expect(d).toEqual({
      kind: 'REJECT_WITH_COUNTER',
      counterCents: 23_500,
      floorCents: 23_500,
    });
  });

  it('neverBelowCatalog false: catalogFloorCents is ignored', () => {
    // Same $235 catalog floor, but neverBelowCatalog false → floor 0 → 8% ALLOWs.
    const d = run({
      parsed: discountPercent(800),
      catalogFloorCents: 23_500,
      policy: { maxDiscountBps: 1_000, absoluteFloorCents: null, neverBelowCatalog: false },
    });
    expect(d).toEqual({
      kind: 'ALLOW',
      approvedDiscountBps: 800,
      discountedPriceCents: 23_000,
      floorCents: 0,
    });
  });

  it('stricter of absolute vs catalog floor wins when both set', () => {
    const d = run({
      parsed: targetPrice(20_000),
      catalogFloorCents: 21_000, // catalog floor stricter than absolute
      policy: { maxDiscountBps: 1_000, absoluteFloorCents: 18_000, neverBelowCatalog: true },
    });
    expect(d).toEqual({
      kind: 'REJECT_WITH_COUNTER',
      counterCents: 21_000,
      floorCents: 21_000,
    });
  });
});

describe('evaluateDiscountAsk — schema compliance across all decision kinds', () => {
  const cases: Array<{ name: string; input: EvaluateDiscountAskInput }> = [
    {
      name: 'ALLOW',
      input: { currentQuotedCents: QUOTE, parsed: discountPercent(800), policy: configured, catalogGrounded: true },
    },
    {
      name: 'NEEDS_APPROVAL',
      input: { currentQuotedCents: QUOTE, parsed: discountPercent(1_200), policy: configured, catalogGrounded: true },
    },
    {
      name: 'CLARIFY',
      input: { currentQuotedCents: QUOTE, parsed: ambiguous, policy: configured, catalogGrounded: true },
    },
    {
      name: 'REJECT_WITH_COUNTER',
      input: { currentQuotedCents: QUOTE, parsed: targetPrice(5_000), policy: configured, catalogGrounded: true },
    },
  ];

  it.each(cases)('$name decision validates against discountDecisionSchema', ({ input }) => {
    const decision = evaluateDiscountAsk(input);
    const parsed = discountDecisionSchema.parse(decision);
    expect(parsed).toEqual(decision);
  });
});
