import { describe, it, expect } from 'vitest';
import {
  negotiationCallbackPayloadSchema,
  negotiationCustomerContextSchema,
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
