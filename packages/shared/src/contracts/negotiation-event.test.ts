import { describe, it, expect } from 'vitest';
import {
  negotiationCallbackPayloadSchema,
  negotiationCustomerContextSchema,
  discountDecisionSchema,
  type DiscountDecision,
  type DiscountDecisionOutcome,
} from './negotiation-event.js';

const validContext = {
  lifetimeValueCents: 125000,
  lastSeenAt: '2026-05-01T12:00:00.000Z',
  recencyLabel: '6 weeks ago',
  jobsCompletedCount: 4,
};

const validPayload = {
  reason: 'customer_negotiation_followup',
  negotiationAskType: 'discount',
  askText: 'can you knock $50 off?',
  recommendation: "Don't auto-discount; this is a valued repeat customer.",
  customerContext: validContext,
  transcript: 'full transcript text',
  conversationId: 'conv-1',
  _meta: {
    overallConfidence: 'medium',
    markers: [{ path: 'recommendation', reason: 'negotiation_guardrail' }],
  },
};

describe('negotiationCallbackPayloadSchema', () => {
  it('accepts a fully-populated payload', () => {
    const parsed = negotiationCallbackPayloadSchema.parse(validPayload);
    expect(parsed.reason).toBe('customer_negotiation_followup');
    expect(parsed.customerContext?.lifetimeValueCents).toBe(125000);
  });

  it('accepts a null customer context (unknown caller)', () => {
    expect(() =>
      negotiationCallbackPayloadSchema.parse({ ...validPayload, customerContext: null }),
    ).not.toThrow();
  });

  it('accepts the general ask-type fallback', () => {
    expect(() =>
      negotiationCallbackPayloadSchema.parse({ ...validPayload, negotiationAskType: 'general' }),
    ).not.toThrow();
  });

  it('rejects a missing recommendation', () => {
    const { recommendation, ...rest } = validPayload;
    void recommendation;
    expect(() => negotiationCallbackPayloadSchema.parse(rest)).toThrow();
  });

  it('rejects an unknown ask type', () => {
    expect(() =>
      negotiationCallbackPayloadSchema.parse({ ...validPayload, negotiationAskType: 'bribe' }),
    ).toThrow();
  });

  it('rejects a wrong reason literal', () => {
    expect(() =>
      negotiationCallbackPayloadSchema.parse({ ...validPayload, reason: 'something_else' }),
    ).toThrow();
  });

  it('requires the customerContext key to be present (null or object)', () => {
    const { customerContext, ...rest } = validPayload;
    void customerContext;
    expect(() => negotiationCallbackPayloadSchema.parse(rest)).toThrow();
  });
});

describe('negotiationCustomerContextSchema', () => {
  it('rejects negative or fractional cents', () => {
    expect(() =>
      negotiationCustomerContextSchema.parse({ ...validContext, lifetimeValueCents: -1 }),
    ).toThrow();
    expect(() =>
      negotiationCustomerContextSchema.parse({ ...validContext, lifetimeValueCents: 12.5 }),
    ).toThrow();
  });

  it('accepts a null lastSeenAt', () => {
    expect(() =>
      negotiationCustomerContextSchema.parse({ ...validContext, lastSeenAt: null }),
    ).not.toThrow();
  });
});

describe('discountDecisionSchema (V2, D-013)', () => {
  const allow = {
    outcome: 'ALLOW',
    targetPriceCents: 18000,
    discountCents: 2000,
    discountBps: 1000,
    listCents: 20000,
    floorCents: 17000,
  };
  const counter = {
    outcome: 'REJECT_WITH_COUNTER',
    requestedPriceCents: 15000,
    counterPriceCents: 17000,
    listCents: 20000,
    floorCents: 17000,
  };

  it('accepts a valid ALLOW decision', () => {
    const parsed = discountDecisionSchema.parse(allow);
    expect(parsed.outcome).toBe('ALLOW');
    if (parsed.outcome === 'ALLOW') expect(parsed.targetPriceCents).toBe(18000);
  });

  it('rejects an ALLOW discountBps above 100% (10000 bps)', () => {
    expect(() => discountDecisionSchema.parse({ ...allow, discountBps: 10001 })).toThrow();
  });

  it('rejects negative cents on the priced branches', () => {
    expect(() => discountDecisionSchema.parse({ ...allow, targetPriceCents: -1 })).toThrow();
    expect(() => discountDecisionSchema.parse({ ...counter, counterPriceCents: -1 })).toThrow();
  });

  it('accepts every NEEDS_APPROVAL reason, with optional context', () => {
    for (const reason of ['no_policy', 'ungrounded_scope']) {
      expect(() => discountDecisionSchema.parse({ outcome: 'NEEDS_APPROVAL', reason })).not.toThrow();
    }
    expect(() =>
      discountDecisionSchema.parse({
        outcome: 'NEEDS_APPROVAL',
        reason: 'ungrounded_scope',
        targetPriceCents: 12000,
        floorCents: 17000,
      }),
    ).not.toThrow();
  });

  it('rejects an unknown NEEDS_APPROVAL reason', () => {
    expect(() =>
      discountDecisionSchema.parse({ outcome: 'NEEDS_APPROVAL', reason: 'because' }),
    ).toThrow();
  });

  it('accepts a CLARIFY with the ambiguous_target reason', () => {
    expect(() =>
      discountDecisionSchema.parse({ outcome: 'CLARIFY', reason: 'ambiguous_target' }),
    ).not.toThrow();
  });

  it('accepts a valid REJECT_WITH_COUNTER decision', () => {
    const parsed = discountDecisionSchema.parse(counter);
    if (parsed.outcome === 'REJECT_WITH_COUNTER') {
      expect(parsed.counterPriceCents).toBe(17000);
    }
  });

  it('rejects an unknown outcome discriminant', () => {
    expect(() => discountDecisionSchema.parse({ outcome: 'MAYBE' })).toThrow();
  });

  it('covers every outcome branch (exhaustiveness)', () => {
    // A runtime proxy for the compile-time exhaustive switch the evaluator
    // (U3) relies on: every outcome maps to a handling label, no default.
    const label = (d: DiscountDecision): string => {
      switch (d.outcome) {
        case 'ALLOW':
          return 'propose';
        case 'NEEDS_APPROVAL':
          return 'callback';
        case 'CLARIFY':
          return 'clarify';
        case 'REJECT_WITH_COUNTER':
          return 'counter';
        default: {
          const exhaustive: never = d;
          return exhaustive;
        }
      }
    };
    const outcomes: DiscountDecisionOutcome[] = [
      'ALLOW',
      'NEEDS_APPROVAL',
      'CLARIFY',
      'REJECT_WITH_COUNTER',
    ];
    expect(outcomes.map((o) => label(discountDecisionSchema.parse(
      o === 'ALLOW' ? allow
        : o === 'REJECT_WITH_COUNTER' ? counter
        : o === 'CLARIFY' ? { outcome: 'CLARIFY', reason: 'ambiguous_target' }
        : { outcome: 'NEEDS_APPROVAL', reason: 'no_policy' },
    )))).toEqual(['propose', 'callback', 'clarify', 'counter']);
  });
});
