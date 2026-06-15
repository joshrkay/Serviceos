import { describe, it, expect } from 'vitest';
import {
  evaluateDiscountAsk,
  type DiscountAskInput,
  type DiscountGrounding,
  type DiscountTarget,
} from '../../../src/proposals/guardrails/discount-evaluator';
import type { DiscountPolicy } from '../../../src/settings/settings';
import { discountDecisionSchema } from '@ai-service-os/shared';

function policy(over: Partial<DiscountPolicy> = {}): DiscountPolicy {
  return { maxBps: 1000, floorCents: null, neverBelowCatalog: true, ...over };
}
const grounded = (listCents: number): DiscountGrounding => ({ catalogGrounded: true, listCents });
const ungrounded: DiscountGrounding = { catalogGrounded: false };
const price = (targetPriceCents: number): DiscountTarget => ({ ambiguous: false, targetPriceCents });
const ambiguous: DiscountTarget = { ambiguous: true };

/** Every decision the evaluator returns must satisfy the shared contract. */
function evaluate(input: DiscountAskInput) {
  const decision = evaluateDiscountAsk(input);
  expect(() => discountDecisionSchema.parse(decision)).not.toThrow();
  return decision;
}

describe('evaluateDiscountAsk — routing precedence', () => {
  it('maxBps 0 (not opted in) → NEEDS_APPROVAL/no_policy, exactly V1', () => {
    // Even a perfectly in-range, grounded ask escalates when unconfigured.
    const d = evaluate({ policy: policy({ maxBps: 0 }), grounding: grounded(20000), target: price(18000) });
    expect(d).toEqual({ outcome: 'NEEDS_APPROVAL', reason: 'no_policy' });
  });

  it('no_policy takes precedence over ungrounded scope and ambiguity', () => {
    expect(evaluate({ policy: policy({ maxBps: 0 }), grounding: ungrounded, target: ambiguous })).toEqual({
      outcome: 'NEEDS_APPROVAL',
      reason: 'no_policy',
    });
  });

  it('ungrounded scope → NEEDS_APPROVAL/ungrounded_scope', () => {
    expect(evaluate({ policy: policy(), grounding: ungrounded, target: price(18000) })).toEqual({
      outcome: 'NEEDS_APPROVAL',
      reason: 'ungrounded_scope',
    });
  });

  it('ungrounded takes precedence over ambiguous target', () => {
    expect(evaluate({ policy: policy(), grounding: ungrounded, target: ambiguous })).toEqual({
      outcome: 'NEEDS_APPROVAL',
      reason: 'ungrounded_scope',
    });
  });

  it('grounded + ambiguous target → CLARIFY (never guess)', () => {
    expect(evaluate({ policy: policy(), grounding: grounded(20000), target: ambiguous })).toEqual({
      outcome: 'CLARIFY',
      reason: 'ambiguous_target',
    });
  });
});

describe('evaluateDiscountAsk — floor boundary (list 20000, 10% cap → floor 18000)', () => {
  const base: Omit<DiscountAskInput, 'target'> = { policy: policy({ maxBps: 1000 }), grounding: grounded(20000) };

  it('ALLOW exactly at the floor', () => {
    expect(evaluate({ ...base, target: price(18000) })).toEqual({
      outcome: 'ALLOW',
      targetPriceCents: 18000,
      discountCents: 2000,
      discountBps: 1000,
      listCents: 20000,
      floorCents: 18000,
    });
  });

  it('REJECT_WITH_COUNTER one cent below the floor', () => {
    expect(evaluate({ ...base, target: price(17999) })).toEqual({
      outcome: 'REJECT_WITH_COUNTER',
      requestedPriceCents: 17999,
      counterPriceCents: 18000,
      listCents: 20000,
      floorCents: 18000,
    });
  });

  it('ALLOW above the floor reports the smaller discount', () => {
    expect(evaluate({ ...base, target: price(19000) })).toMatchObject({
      outcome: 'ALLOW',
      discountCents: 1000,
      discountBps: 500,
    });
  });

  it('ALLOW with zero discount when target >= list (no real concession)', () => {
    expect(evaluate({ ...base, target: price(20000) })).toMatchObject({ outcome: 'ALLOW', discountCents: 0, discountBps: 0 });
    expect(evaluate({ ...base, target: price(25000) })).toMatchObject({ outcome: 'ALLOW', discountCents: 0 });
  });

  it('clamps a negative/zero target to a 0-cent request (never an invalid decision)', () => {
    expect(evaluate({ ...base, target: price(-500) })).toEqual({
      outcome: 'REJECT_WITH_COUNTER',
      requestedPriceCents: 0,
      counterPriceCents: 18000,
      listCents: 20000,
      floorCents: 18000,
    });
  });
});

describe('evaluateDiscountAsk — absolute floor & neverBelowCatalog', () => {
  it('absolute floor RAISES the floor above the cap (strict, default)', () => {
    // 50% cap → capFloor 10000; absolute floor 15000 wins.
    const base = { policy: policy({ maxBps: 5000, floorCents: 15000 }), grounding: grounded(20000) };
    expect(evaluate({ ...base, target: price(15000) })).toMatchObject({ outcome: 'ALLOW', floorCents: 15000 });
    expect(evaluate({ ...base, target: price(14999) })).toMatchObject({
      outcome: 'REJECT_WITH_COUNTER',
      counterPriceCents: 15000,
    });
    // Above the cap floor but below the absolute floor still rejects.
    expect(evaluate({ ...base, target: price(12000) })).toMatchObject({ outcome: 'REJECT_WITH_COUNTER', counterPriceCents: 15000 });
  });

  it('neverBelowCatalog=false lets a hard floor bind BELOW the % cap', () => {
    // 10% cap → capFloor 18000; absolute floor 16000 binds because lenient.
    const lenient = { policy: policy({ maxBps: 1000, floorCents: 16000, neverBelowCatalog: false }), grounding: grounded(20000) };
    expect(evaluate({ ...lenient, target: price(16000) })).toMatchObject({ outcome: 'ALLOW', floorCents: 16000 });
    expect(evaluate({ ...lenient, target: price(15999) })).toMatchObject({ outcome: 'REJECT_WITH_COUNTER', counterPriceCents: 16000 });

    // Same numbers, strict → the cap (18000) binds instead, so 16000 rejects.
    const strict = { policy: policy({ maxBps: 1000, floorCents: 16000, neverBelowCatalog: true }), grounding: grounded(20000) };
    expect(evaluate({ ...strict, target: price(16000) })).toMatchObject({ outcome: 'REJECT_WITH_COUNTER', counterPriceCents: 18000 });
  });

  it('neverBelowCatalog=false with no absolute floor falls back to the cap floor', () => {
    const d = evaluate({ policy: policy({ maxBps: 1000, floorCents: null, neverBelowCatalog: false }), grounding: grounded(20000), target: price(18000) });
    expect(d).toMatchObject({ outcome: 'ALLOW', floorCents: 18000 });
  });
});

describe('evaluateDiscountAsk — member-stacking defense', () => {
  it('measures the floor against the member-adjusted base (protects margin vs naive stacking)', () => {
    // list 20000, member 10%, negotiation cap 10%.
    // memberAdjustedBase = 18000; capFloor = 18000 - 1800 = 16200.
    const base = { policy: policy({ maxBps: 1000 }), grounding: grounded(20000), memberDiscountBps: 1000 };
    expect(evaluate({ ...base, target: price(16200) })).toMatchObject({ outcome: 'ALLOW', floorCents: 16200 });
    expect(evaluate({ ...base, target: price(16199) })).toMatchObject({ outcome: 'REJECT_WITH_COUNTER', counterPriceCents: 16200 });
    // The defended floor (16200) is strictly higher than naive additive
    // stacking would allow (20000 * (1 - 0.20) = 16000).
    expect(16200).toBeGreaterThan(16000);
  });

  it('ignores an invalid member bps (defensive clamp to 0)', () => {
    const d = evaluate({ policy: policy({ maxBps: 1000 }), grounding: grounded(20000), memberDiscountBps: -5, target: price(18000) });
    expect(d).toMatchObject({ outcome: 'ALLOW', floorCents: 18000 });
  });
});

describe('evaluateDiscountAsk — extremes & rounding', () => {
  it('100% policy floors at 0 (tenant opted into full discretion)', () => {
    const base = { policy: policy({ maxBps: 10000 }), grounding: grounded(20000) };
    expect(evaluate({ ...base, target: price(0) })).toEqual({
      outcome: 'ALLOW',
      targetPriceCents: 0,
      discountCents: 20000,
      discountBps: 10000,
      listCents: 20000,
      floorCents: 0,
    });
  });

  it('reports discountBps via applyBps-consistent rounding', () => {
    // list 30000, cap 20% → capFloor 24000; target 27777 → discount 2223.
    // bps = round(2223 * 10000 / 30000) = round(741) = 741.
    const d = evaluate({ policy: policy({ maxBps: 2000 }), grounding: grounded(30000), target: price(27777) });
    expect(d).toMatchObject({ outcome: 'ALLOW', discountCents: 2223, discountBps: 741 });
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
