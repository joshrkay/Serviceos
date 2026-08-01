import { describe, it, expect } from 'vitest';
import {
  MAX_ESTIMATE_CLARIFICATION_LOOPS,
  detectEstimateAmbiguities,
  generateEstimateClarifications,
  decideEstimateClarification,
  EstimateDraftSignals,
} from '../../src/ai/clarification/estimate-clarification';

const groundedSignals: EstimateDraftSignals = {
  description: 'Replace the capacitor on the upstairs AC unit and recharge refrigerant',
  hasCustomer: true,
  lineItems: [
    { description: 'Capacitor', quantity: 1, unitPriceCents: 4500, pricingSource: 'catalog' },
    { description: 'Refrigerant', quantity: 2, unitPriceCents: 6000, pricingSource: 'catalog' },
  ],
};

describe('7.2 — detectEstimateAmbiguities', () => {
  it('returns no ambiguities for a fully grounded request', () => {
    expect(detectEstimateAmbiguities(groundedSignals)).toEqual([]);
  });

  it('flags an empty line-item list (and a vague description)', () => {
    const codes = detectEstimateAmbiguities({
      description: 'fix it',
      hasCustomer: true,
      lineItems: [],
    }).map((a) => a.code);
    expect(codes).toContain('no_line_items');
    expect(codes).toContain('vague_description');
  });

  it('flags a missing customer', () => {
    const codes = detectEstimateAmbiguities({ ...groundedSignals, hasCustomer: false }).map((a) => a.code);
    expect(codes).toContain('missing_customer');
  });

  it('flags missing/zero quantities with the affected lines', () => {
    const ambiguities = detectEstimateAmbiguities({
      ...groundedSignals,
      lineItems: [{ description: 'Vents', quantity: 0, unitPriceCents: 1000, pricingSource: 'catalog' }],
    });
    const qty = ambiguities.find((a) => a.code === 'missing_quantity');
    expect(qty).toBeDefined();
    expect(qty?.detail).toContain('Vents');
  });

  it('flags uncatalogued prices', () => {
    const ambiguities = detectEstimateAmbiguities({
      ...groundedSignals,
      lineItems: [{ description: 'Custom bracket', quantity: 1, unitPriceCents: 5000, pricingSource: 'uncatalogued' }],
    });
    expect(ambiguities.map((a) => a.code)).toContain('uncatalogued_price');
  });

  it('flags ambiguous catalog matches', () => {
    const ambiguities = detectEstimateAmbiguities({
      ...groundedSignals,
      ambiguousCatalogFields: ['AC unit'],
    });
    const match = ambiguities.find((a) => a.code === 'ambiguous_catalog_match');
    expect(match?.detail).toContain('AC unit');
  });
});

describe('7.2 — generateEstimateClarifications', () => {
  it('produces a targeted question per ambiguity and dedupes', () => {
    const questions = generateEstimateClarifications([
      { code: 'missing_customer' },
      { code: 'missing_quantity', detail: 'Vents' },
      { code: 'missing_customer' }, // duplicate code → one question
    ]);
    expect(questions).toContain('Who is this estimate for?');
    expect(questions.some((q) => q.includes('Vents'))).toBe(true);
    expect(questions.filter((q) => q === 'Who is this estimate for?')).toHaveLength(1);
  });

  it('returns no questions when there are no ambiguities', () => {
    expect(generateEstimateClarifications([])).toEqual([]);
  });
});

describe('7.2 — decideEstimateClarification', () => {
  const ambiguities = [{ code: 'missing_customer' as const }];

  it('drafts immediately when nothing is ambiguous', () => {
    const d = decideEstimateClarification({ clarificationCount: 0, ambiguities: [] });
    expect(d.action).toBe('draft');
    expect(d.flaggedForReview).toBe(false);
    expect(d.questions).toEqual([]);
  });

  it('asks (does not guess) while under the cap', () => {
    for (let count = 0; count < MAX_ESTIMATE_CLARIFICATION_LOOPS; count++) {
      const d = decideEstimateClarification({ clarificationCount: count, ambiguities });
      expect(d.action).toBe('clarify');
      expect(d.flaggedForReview).toBe(false);
      expect(d.capped).toBe(false);
      expect(d.questions.length).toBeGreaterThan(0);
    }
  });

  it('after the 3rd loop, proposes a best-effort estimate flagged for review', () => {
    const d = decideEstimateClarification({
      clarificationCount: MAX_ESTIMATE_CLARIFICATION_LOOPS,
      ambiguities,
    });
    expect(d.action).toBe('draft');
    expect(d.flaggedForReview).toBe(true);
    expect(d.capped).toBe(true);
    // It still carries the unresolved questions for the reviewer's context.
    expect(d.questions.length).toBeGreaterThan(0);
  });

  it('honors a custom maxLoops', () => {
    const d = decideEstimateClarification({ clarificationCount: 1, ambiguities, maxLoops: 1 });
    expect(d.action).toBe('draft');
    expect(d.flaggedForReview).toBe(true);
  });
});
