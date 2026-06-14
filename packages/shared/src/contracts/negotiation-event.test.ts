import { describe, it, expect } from 'vitest';
import {
  negotiationCallbackPayloadSchema,
  negotiationCustomerContextSchema,
  discountDecisionSchema,
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

describe('discountDecisionSchema', () => {
  it('parses a well-formed ALLOW decision', () => {
    const parsed = discountDecisionSchema.parse({
      kind: 'ALLOW',
      approvedDiscountBps: 1000,
      discountedPriceCents: 18000,
      floorCents: 15000,
    });
    expect(parsed.kind).toBe('ALLOW');
    if (parsed.kind === 'ALLOW') {
      expect(parsed.approvedDiscountBps).toBe(1000);
    }
  });

  it('parses a well-formed NEEDS_APPROVAL decision (nullable fields)', () => {
    expect(() =>
      discountDecisionSchema.parse({
        kind: 'NEEDS_APPROVAL',
        requestedTargetCents: 12000,
        requestedDiscountBps: 2500,
      }),
    ).not.toThrow();
    // both nullable fields may be null
    expect(() =>
      discountDecisionSchema.parse({
        kind: 'NEEDS_APPROVAL',
        requestedTargetCents: null,
        requestedDiscountBps: null,
      }),
    ).not.toThrow();
  });

  it('parses a well-formed CLARIFY decision', () => {
    const parsed = discountDecisionSchema.parse({
      kind: 'CLARIFY',
      reason: 'ambiguous_discount_target',
    });
    expect(parsed.kind).toBe('CLARIFY');
  });

  it('parses a well-formed REJECT_WITH_COUNTER decision', () => {
    const parsed = discountDecisionSchema.parse({
      kind: 'REJECT_WITH_COUNTER',
      counterCents: 15000,
      floorCents: 15000,
    });
    expect(parsed.kind).toBe('REJECT_WITH_COUNTER');
  });

  it('rejects an unknown discriminator kind', () => {
    expect(() =>
      discountDecisionSchema.parse({
        kind: 'MAYBE',
        approvedDiscountBps: 1000,
        discountedPriceCents: 18000,
        floorCents: 15000,
      }),
    ).toThrow();
  });

  it('rejects a CLARIFY with a wrong reason literal', () => {
    expect(() =>
      discountDecisionSchema.parse({ kind: 'CLARIFY', reason: 'something_else' }),
    ).toThrow();
  });

  it('rejects bps fields above 10000', () => {
    expect(() =>
      discountDecisionSchema.parse({
        kind: 'ALLOW',
        approvedDiscountBps: 10001,
        discountedPriceCents: 18000,
        floorCents: 15000,
      }),
    ).toThrow();
  });

  it('rejects negative bps fields', () => {
    expect(() =>
      discountDecisionSchema.parse({
        kind: 'NEEDS_APPROVAL',
        requestedTargetCents: 12000,
        requestedDiscountBps: -1,
      }),
    ).toThrow();
  });

  it('rejects negative cents fields', () => {
    expect(() =>
      discountDecisionSchema.parse({
        kind: 'REJECT_WITH_COUNTER',
        counterCents: -1,
        floorCents: 15000,
      }),
    ).toThrow();
  });

  it('rejects fractional cents fields', () => {
    expect(() =>
      discountDecisionSchema.parse({
        kind: 'ALLOW',
        approvedDiscountBps: 1000,
        discountedPriceCents: 18000.5,
        floorCents: 15000,
      }),
    ).toThrow();
  });

  it('rejects fractional bps fields', () => {
    expect(() =>
      discountDecisionSchema.parse({
        kind: 'ALLOW',
        approvedDiscountBps: 1000.5,
        discountedPriceCents: 18000,
        floorCents: 15000,
      }),
    ).toThrow();
  });
});
