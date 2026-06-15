import { describe, it, expect } from 'vitest';
import {
  evaluateNegotiationDiscount,
  type NegotiationDiscountInput,
} from '../../../src/conversations/negotiation/negotiate-discount';
import type { DiscountPolicy } from '../../../src/settings/settings';
import type { DiscountGrounding } from '../../../src/proposals/guardrails/discount-evaluator';
import { discountDecisionSchema } from '@ai-service-os/shared';

const policy = (over: Partial<DiscountPolicy> = {}): DiscountPolicy => ({
  maxBps: 1000,
  floorCents: null,
  neverBelowCatalog: true,
  ...over,
});
const grounded = (listCents: number): DiscountGrounding => ({ catalogGrounded: true, listCents });
const ungrounded: DiscountGrounding = { catalogGrounded: false };

function decide(input: NegotiationDiscountInput) {
  const d = evaluateNegotiationDiscount(input);
  expect(() => discountDecisionSchema.parse(d)).not.toThrow();
  return d;
}

describe('evaluateNegotiationDiscount — parser + evaluator composition', () => {
  it('not opted in (maxBps 0) → NEEDS_APPROVAL/no_policy (exact V1)', () => {
    expect(
      decide({ policy: policy({ maxBps: 0 }), askText: 'knock $50 off', grounding: grounded(25000) }),
    ).toEqual({ outcome: 'NEEDS_APPROVAL', reason: 'no_policy' });
  });

  it('ungrounded scope → NEEDS_APPROVAL/ungrounded_scope', () => {
    expect(decide({ policy: policy(), askText: '$50 off', grounding: ungrounded })).toEqual({
      outcome: 'NEEDS_APPROVAL',
      reason: 'ungrounded_scope',
    });
  });

  it('ambiguous ask on a grounded scope → CLARIFY', () => {
    expect(
      decide({ policy: policy(), askText: 'can you give me a discount?', grounding: grounded(25000) }),
    ).toEqual({ outcome: 'CLARIFY', reason: 'ambiguous_target' });
  });

  it('in-policy percent ask at the floor → ALLOW', () => {
    // 10% cap on a $250 list → floor $225; "10% off" lands exactly at it.
    expect(decide({ policy: policy({ maxBps: 1000 }), askText: 'can you do 10% off?', grounding: grounded(25000) })).toMatchObject({
      outcome: 'ALLOW',
      targetPriceCents: 22500,
      discountBps: 1000,
    });
  });

  it('below-floor amount ask → REJECT_WITH_COUNTER at the floor', () => {
    // "$50 off" → pay $200, below the $225 cap floor → counter $225.
    expect(decide({ policy: policy({ maxBps: 1000 }), askText: 'knock $50 off', grounding: grounded(25000) })).toMatchObject({
      outcome: 'REJECT_WITH_COUNTER',
      counterPriceCents: 22500,
    });
  });

  it('member discount lowers the floor (member-stacking defense)', () => {
    // Same "$50 off" ask, but a 10% member: floor measured against the
    // member-adjusted base ($225) → cap floor $202.50, so the counter drops.
    expect(
      decide({
        policy: policy({ maxBps: 1000 }),
        askText: 'knock $50 off',
        grounding: grounded(25000),
        memberDiscountBps: 1000,
      }),
    ).toMatchObject({ outcome: 'REJECT_WITH_COUNTER', counterPriceCents: 20250 });
  });
});
