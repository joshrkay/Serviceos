import { describe, it, expect } from 'vitest';
import {
  checkAccountRouting,
  checkBrandVoice,
  checkMissedUrgency,
  checkPricingAnomaly,
  extractRoutingSignals,
  parseSupervisorLlmResponse,
  urgencySeverityPreFilter,
  PRICING_MIN_SAMPLES,
} from '../../../src/ai/supervisor/checks';

describe('N-004 supervisor checks — pricing anomaly (deterministic, flag-only)', () => {
  it('does not flag at exactly 20% deviation (boundary is strictly >20%)', () => {
    // 12000 vs 10000 avg = exactly 20%.
    const r = checkPricingAnomaly({ totalCents: 12000, baselineAvgCents: 10000, sampleSize: 10 });
    expect(r.verdict).toBe('pass');
  });

  it('flags above 20% deviation', () => {
    const r = checkPricingAnomaly({ totalCents: 13000, baselineAvgCents: 10000, sampleSize: 10 });
    expect(r.verdict).toBe('flag');
    expect(r.reason).toContain('30%');
    expect(r.reason).toContain('above');
  });

  it('cold-start: below MIN_SAMPLES never flags', () => {
    const r = checkPricingAnomaly({
      totalCents: 99999,
      baselineAvgCents: 10000,
      sampleSize: PRICING_MIN_SAMPLES - 1,
    });
    expect(r.verdict).toBe('pass');
    expect(r.evidence?.insufficientHistory).toBe(true);
  });

  it('never returns critical — even a zero total is only a flag', () => {
    const r = checkPricingAnomaly({ totalCents: 0, baselineAvgCents: 10000, sampleSize: 10 });
    expect(r.verdict).toBe('flag');
  });

  it('passes when baseline is unknown', () => {
    const r = checkPricingAnomaly({ totalCents: 5000, baselineAvgCents: null, sampleSize: 0 });
    expect(r.verdict).toBe('pass');
  });
});

describe('N-004 supervisor checks — account routing (deterministic)', () => {
  it('B2B money terms on a residential account is CRITICAL (money-term change)', () => {
    const r = checkAccountRouting({
      accountType: 'residential',
      hasB2bMoneyTerms: true,
      impliedSegment: null,
    });
    expect(r.verdict).toBe('critical');
  });

  it('residential routing on a b2b account is a flag (no money-term change)', () => {
    const r = checkAccountRouting({
      accountType: 'b2b',
      hasB2bMoneyTerms: false,
      impliedSegment: 'residential',
    });
    expect(r.verdict).toBe('flag');
  });

  it('residential routing on a property_manager account is a flag', () => {
    const r = checkAccountRouting({
      accountType: 'property_manager',
      hasB2bMoneyTerms: false,
      impliedSegment: 'residential',
    });
    expect(r.verdict).toBe('flag');
  });

  it('passes when account_type is unknown', () => {
    const r = checkAccountRouting({ accountType: null, hasB2bMoneyTerms: true });
    expect(r.verdict).toBe('pass');
  });

  it('extractRoutingSignals detects NET terms, PO, and tax-exempt', () => {
    expect(extractRoutingSignals({ paymentTerms: 'NET-30' }).hasB2bMoneyTerms).toBe(true);
    expect(extractRoutingSignals({ poNumber: 'PO-1234' }).hasB2bMoneyTerms).toBe(true);
    expect(extractRoutingSignals({ taxExempt: true }).hasB2bMoneyTerms).toBe(true);
    expect(extractRoutingSignals({ summary: 'residential drain clear' }).hasB2bMoneyTerms).toBe(
      false,
    );
  });
});

describe('N-004 supervisor checks — brand voice (deterministic banned phrase, flag-only)', () => {
  it('flags a banned-phrase hit without a model call', () => {
    const r = checkBrandVoice({ text: 'We offer the CHEAPEST prices in town', bannedPhrases: ['cheapest'] });
    expect(r.verdict).toBe('flag');
    expect(r.evidence?.bannedPhraseHits).toContain('cheapest');
  });

  it('flags register drift from the LLM even without a banned phrase', () => {
    const r = checkBrandVoice({ text: 'ok', bannedPhrases: [], registerDrift: true });
    expect(r.verdict).toBe('flag');
  });

  it('passes clean text', () => {
    const r = checkBrandVoice({ text: 'Thanks for calling', bannedPhrases: ['cheapest'] });
    expect(r.verdict).toBe('pass');
  });
});

describe('N-004 supervisor checks — missed urgency (pre-filter + LLM)', () => {
  const now = new Date('2026-07-10T12:00:00Z');

  it('pre-filter flags an urgent triage scheduled beyond same-day', () => {
    const r = urgencySeverityPreFilter({
      severity: 'urgent',
      scheduledStart: '2026-07-15T12:00:00Z',
      now,
    });
    expect(r?.verdict).toBe('flag');
  });

  it('pre-filter returns null for a non-urgent severity', () => {
    expect(urgencySeverityPreFilter({ severity: 'routine', now })).toBeNull();
  });

  it('unescalated medical mention is CRITICAL (customer-harm)', () => {
    const r = checkMissedUrgency(
      { missedUrgency: false, medicalMentionUnescalated: true, registerDrift: false },
      null,
    );
    expect(r.verdict).toBe('critical');
  });

  it('llm missedUrgency without medical mention is a flag', () => {
    const r = checkMissedUrgency(
      { missedUrgency: true, medicalMentionUnescalated: false, registerDrift: false },
      null,
    );
    expect(r.verdict).toBe('flag');
  });

  it('passes when neither the pre-filter nor the LLM flags', () => {
    const r = checkMissedUrgency(
      { missedUrgency: false, medicalMentionUnescalated: false, registerDrift: false },
      null,
    );
    expect(r.verdict).toBe('pass');
  });

  it('parseSupervisorLlmResponse rejects malformed JSON', () => {
    expect(parseSupervisorLlmResponse('not json')).toBeNull();
    expect(parseSupervisorLlmResponse('[]')).toBeNull();
  });
});
