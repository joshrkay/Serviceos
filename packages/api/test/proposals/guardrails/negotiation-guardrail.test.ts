/**
 * Unit tests for the negotiation guardrail's deterministic ask-type detector
 * (src/proposals/guardrails/negotiation-guardrail.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  detectNegotiationAskType,
  recommendNegotiationResponse,
  negotiationAskLabel,
  customerValueTier,
  buildNegotiationCallbackContent,
  NEGOTIATION_GUARDRAIL_MARKER_REASON,
  type NegotiationAskType,
} from '../../../src/proposals/guardrails/negotiation-guardrail';
import type { CustomerNegotiationContext } from '../../../src/customers/customer-negotiation-context';
import type { NegotiationCallbackPayload } from '@ai-service-os/shared';

const valuedRepeat: CustomerNegotiationContext = {
  lifetimeValueCents: 250000, // $2,500
  lastSeenAt: new Date(Date.now() - 21 * 86_400_000), // ~3 weeks ago
  jobsCompletedCount: 5,
};
const firstTimer: CustomerNegotiationContext = {
  lifetimeValueCents: 0,
  lastSeenAt: null,
  jobsCompletedCount: 0,
};

describe('detectNegotiationAskType', () => {
  it('detects discount asks', () => {
    expect(detectNegotiationAskType('can you knock fifty bucks off?')).toBe('discount');
    expect(detectNegotiationAskType("what's the best price you can do")).toBe('discount');
    expect(detectNegotiationAskType('that seems too expensive, any discount?')).toBe('discount');
    expect(detectNegotiationAskType('can you lower the quote a bit')).toBe('discount');
    expect(detectNegotiationAskType('do you have any coupons or specials')).toBe('discount');
  });

  it('detects scope-change asks', () => {
    expect(detectNegotiationAskType("throw in the trip fee and you've got a deal")).toBe(
      'scope_change',
    );
    expect(detectNegotiationAskType('can you do the second faucet for free')).toBe('scope_change');
    expect(detectNegotiationAskType('while you are here, just comp the inspection')).toBe(
      'scope_change',
    );
  });

  it('detects refund-as-leverage asks', () => {
    expect(detectNegotiationAskType('I want a refund')).toBe('refund_leverage');
    expect(detectNegotiationAskType('give me my money back')).toBe('refund_leverage');
    expect(detectNegotiationAskType('I expect a partial credit for this')).toBe('refund_leverage');
  });

  it('detects owner/manager escalation asks', () => {
    expect(detectNegotiationAskType('let me talk to the owner about this price')).toBe(
      'manager_escalation',
    );
    expect(detectNegotiationAskType('who is in charge there')).toBe('manager_escalation');
  });

  it('detects deadline/review threats', () => {
    expect(detectNegotiationAskType("lower it or I'll leave a one-star review")).toBe(
      'deadline_threat',
    );
    expect(detectNegotiationAskType("I'll take my business elsewhere")).toBe('deadline_threat');
    expect(detectNegotiationAskType('I will leave you a bad review')).toBe('deadline_threat');
  });

  it('prefers the concrete lever (refund) over the generic threat', () => {
    // Refund is checked before deadline_threat by design.
    expect(
      detectNegotiationAskType("give me a refund or I'll leave a one-star review"),
    ).toBe('refund_leverage');
  });

  it('returns null when no negotiation pattern matches', () => {
    expect(detectNegotiationAskType('what time are you coming tomorrow?')).toBeNull();
    expect(detectNegotiationAskType('how much is a water heater install?')).toBeNull();
    expect(detectNegotiationAskType('')).toBeNull();
  });
});

describe('recommendNegotiationResponse', () => {
  it('returns a distinct, non-empty recommendation per ask type', () => {
    const askTypes: NegotiationAskType[] = [
      'discount',
      'scope_change',
      'refund_leverage',
      'manager_escalation',
      'deadline_threat',
    ];
    const seen = new Set<string>();
    for (const t of askTypes) {
      const rec = recommendNegotiationResponse(t);
      expect(rec.length).toBeGreaterThan(0);
      seen.add(rec);
    }
    expect(seen.size).toBe(askTypes.length);
  });

  it('returns a generic recommendation for a null ask type', () => {
    expect(recommendNegotiationResponse(null)).toMatch(/did not concede|your terms/i);
  });

  it('never recommends conceding a discount', () => {
    expect(recommendNegotiationResponse('discount')).toMatch(/don't auto-discount/i);
  });
});

describe('negotiationAskLabel', () => {
  it('labels each ask type and the null fallback', () => {
    expect(negotiationAskLabel('discount')).toBe('discount request');
    expect(negotiationAskLabel('scope_change')).toBe('scope-change request');
    expect(negotiationAskLabel('refund_leverage')).toBe('refund request');
    expect(negotiationAskLabel('manager_escalation')).toBe('owner/manager request');
    expect(negotiationAskLabel('deadline_threat')).toBe('pressure/ultimatum');
    expect(negotiationAskLabel(null)).toBe('pricing pushback');
  });
});

describe('NEGOTIATION_GUARDRAIL_MARKER_REASON', () => {
  it('is a stable, greppable marker reason', () => {
    expect(NEGOTIATION_GUARDRAIL_MARKER_REASON).toBe('negotiation_guardrail');
  });
});

describe('customerValueTier', () => {
  it('classifies a high-LTV or repeat customer as valued_repeat', () => {
    expect(customerValueTier(valuedRepeat)).toBe('valued_repeat');
    expect(
      customerValueTier({ lifetimeValueCents: 100000, lastSeenAt: null, jobsCompletedCount: 0 }),
    ).toBe('valued_repeat');
    expect(
      customerValueTier({ lifetimeValueCents: 0, lastSeenAt: null, jobsCompletedCount: 3 }),
    ).toBe('valued_repeat');
  });

  it('classifies a customer with some history as established', () => {
    expect(
      customerValueTier({ lifetimeValueCents: 5000, lastSeenAt: null, jobsCompletedCount: 1 }),
    ).toBe('established');
  });

  it('classifies a customer with no history as new_or_unknown', () => {
    expect(customerValueTier(firstTimer)).toBe('new_or_unknown');
  });
});

describe('recommendNegotiationResponse with customer context', () => {
  it('includes the LTV dollar amount and recency for a valued repeat', () => {
    const rec = recommendNegotiationResponse('discount', valuedRepeat);
    expect(rec).toMatch(/don't auto-discount/i); // base guidance preserved
    expect(rec).toContain('$2,500'); // LTV context
    expect(rec).toMatch(/last seen/i); // recency context
    expect(rec).toMatch(/valued repeat/i);
  });

  it('tells the owner to hold firm for a first-timer', () => {
    const rec = recommendNegotiationResponse('discount', firstTimer);
    expect(rec).toMatch(/hold firm|no real history/i);
    expect(rec).toMatch(/new customer/i); // recency label for a null lastSeenAt
  });

  it('falls back to base guidance with no context (backward compatible)', () => {
    expect(recommendNegotiationResponse('discount')).toBe(
      recommendNegotiationResponse('discount', null),
    );
  });

  it('never proposes a percentage discount', () => {
    for (const ctx of [valuedRepeat, firstTimer, null]) {
      expect(recommendNegotiationResponse('discount', ctx)).not.toMatch(/%\s*off/i);
    }
  });
});

describe('buildNegotiationCallbackContent customer context', () => {
  it('embeds the serialized customer context and a value-aware recommendation', () => {
    const content = buildNegotiationCallbackContent({
      detectText: 'can you knock $50 off?',
      customerName: 'Dana',
      customerContext: valuedRepeat,
    });
    const payload = content.payload as NegotiationCallbackPayload;
    expect(payload.negotiationAskType).toBe('discount');
    expect(payload.customerContext).not.toBeNull();
    expect(payload.customerContext?.lifetimeValueCents).toBe(250000);
    expect(typeof payload.customerContext?.lastSeenAt).toBe('string'); // ISO string
    expect(payload.customerContext?.recencyLabel).toMatch(/weeks ago/);
    expect(payload.recommendation).toContain('$2,500');
  });

  it('sets customerContext to null for an unknown caller', () => {
    const content = buildNegotiationCallbackContent({ detectText: 'best price?' });
    const payload = content.payload as NegotiationCallbackPayload;
    expect(payload.customerContext).toBeNull();
  });
});
