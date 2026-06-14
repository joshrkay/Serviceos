/**
 * Unit tests for the negotiation guardrail's deterministic ask-type detector
 * (src/proposals/guardrails/negotiation-guardrail.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  detectNegotiationAskType,
  recommendNegotiationResponse,
  negotiationAskLabel,
  NEGOTIATION_GUARDRAIL_MARKER_REASON,
  type NegotiationAskType,
} from '../../../src/proposals/guardrails/negotiation-guardrail';

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
