import { describe, it, expect, beforeEach } from 'vitest';
import { createMockLLMGateway } from '../../../../src/ai/gateway/factory';
import { PricingExtractor } from '../../../../src/ai/tasks/onboarding/pricing-extractor';
import { ExtractionContext } from '../../../../src/ai/tasks/onboarding/types';
import { MockLLMProvider } from '../../../../src/ai/providers/mock';
import { LLMGateway } from '../../../../src/ai/gateway/gateway';
import * as fs from 'fs';
import * as path from 'path';

const fixturesDir = path.join(__dirname, '../../../fixtures/onboarding');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
}

function makeContext(transcript: string): ExtractionContext {
  return {
    tenantId: 'tenant-001',
    transcript,
    userId: 'user-001',
    previousExtractions: {
      categories: {
        categories: [
          { verticalType: 'hvac', categoryId: 'diagnostic', name: 'Diagnostic', confidence: 0.9, sourceText: '' },
          { verticalType: 'hvac', categoryId: 'maintenance', name: 'Tune-up', confidence: 0.9, sourceText: '' },
          { verticalType: 'hvac', categoryId: 'replacement', name: 'Replacement', confidence: 0.9, sourceText: '' },
        ],
      },
    },
  };
}

describe('P4-EXT-003 — Pricing extraction from voice transcript', () => {
  let gateway: LLMGateway;
  let provider: MockLLMProvider;
  let extractor: PricingExtractor;

  beforeEach(() => {
    const mock = createMockLLMGateway();
    gateway = mock.gateway;
    provider = mock.provider;
    extractor = new PricingExtractor(gateway);
  });

  // T3-004: Pricing with exact prices — "$149"
  it('T3-004 — extracts exact prices in integer cents', async () => {
    provider.setDefaultResponse(JSON.stringify({
      prices: [
        { service_ref: 'Diagnostic', amount_cents: 8900, price_type: 'exact', confidence: 0.95, source_text: 'Diagnostic fee is $89' },
        { service_ref: 'Tune-up', amount_cents: 14900, price_type: 'exact', confidence: 0.95, source_text: 'tune-ups run $149' },
      ],
      confidence_score: 0.92,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-01-hvac-happy-path.txt')));

    expect(result.data.prices).toHaveLength(2);
    const diagnostic = result.data.prices.find((p) => p.serviceRef === 'Diagnostic');
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.amountCents).toBe(8900);
    expect(diagnostic!.priceType).toBe('exact');

    const tuneUp = result.data.prices.find((p) => p.serviceRef === 'Tune-up');
    expect(tuneUp!.amountCents).toBe(14900);
  });

  // T3-005: Range pricing — "starts at around $4,500 depending on the unit"
  it('T3-005 — extracts range pricing with qualifier', async () => {
    provider.setDefaultResponse(JSON.stringify({
      prices: [
        {
          service_ref: 'Replacement',
          amount_cents: 450000,
          price_type: 'range_start',
          qualifier: 'depending on the unit',
          confidence: 0.8,
          source_text: 'replacements typically start at about $4,500',
        },
      ],
      confidence_score: 0.8,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-01-hvac-happy-path.txt')));

    const replacement = result.data.prices.find((p) => p.serviceRef === 'Replacement');
    expect(replacement).toBeDefined();
    expect(replacement!.amountCents).toBe(450000);
    expect(replacement!.priceType).toBe('range_start');
    expect(replacement!.qualifier).toBeDefined();
  });

  // T3-015: Multi-line pricing — "Tune-up is $149 — 45 min labor at $85/hr plus a $25 filter"
  it('T3-015 — extracts component-based pricing', async () => {
    provider.setDefaultResponse(JSON.stringify({
      prices: [
        { service_ref: 'Tune-up', amount_cents: 14900, price_type: 'exact', confidence: 0.9, source_text: 'Tune-up is $149' },
        { service_ref: 'Tune-up labor', amount_cents: 8500, price_type: 'hourly_rate', confidence: 0.85, source_text: '$85/hr' },
        { service_ref: 'Tune-up filter', amount_cents: 2500, price_type: 'component', confidence: 0.85, source_text: '$25 filter' },
      ],
      confidence_score: 0.85,
    }));

    const result = await extractor.extract(makeContext('Tune-up is $149 — 45 min labor at $85/hr plus a $25 filter'));

    expect(result.data.prices.length).toBeGreaterThanOrEqual(2);

    const hourly = result.data.prices.find((p) => p.priceType === 'hourly_rate');
    expect(hourly).toBeDefined();
    expect(hourly!.amountCents).toBe(8500);

    const component = result.data.prices.find((p) => p.priceType === 'component');
    expect(component).toBeDefined();
    expect(component!.amountCents).toBe(2500);
  });

  // T2-007: Contradictory statements — uses most recent value
  it('T2-007 — uses most recent price when contradictory', async () => {
    provider.setDefaultResponse(JSON.stringify({
      prices: [
        { service_ref: 'Diagnostic', amount_cents: 8900, price_type: 'exact', confidence: 0.85, source_text: 'actually we just raised it to $89' },
        { service_ref: 'Tune-up', amount_cents: 14900, price_type: 'exact', confidence: 0.8, source_text: 'yeah $149' },
      ],
      confidence_score: 0.75,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-05-contradictory-rambling.txt')));

    const diagnostic = result.data.prices.find((p) => p.serviceRef === 'Diagnostic');
    expect(diagnostic).toBeDefined();
    // The LLM is instructed to use the most recent value
    expect(diagnostic!.amountCents).toBe(8900);
  });

  it('all amounts are integer cents', async () => {
    provider.setDefaultResponse(JSON.stringify({
      prices: [
        { service_ref: 'Service', amount_cents: 14900, price_type: 'exact', confidence: 0.9, source_text: '$149' },
      ],
      confidence_score: 0.9,
    }));

    const result = await extractor.extract(makeContext('$149 for a service'));

    for (const price of result.data.prices) {
      expect(Number.isInteger(price.amountCents)).toBe(true);
      expect(price.amountCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('filters out prices with non-integer amounts', async () => {
    provider.setDefaultResponse(JSON.stringify({
      prices: [
        { service_ref: 'Good', amount_cents: 14900, price_type: 'exact', confidence: 0.9, source_text: '$149' },
        { service_ref: 'Bad', amount_cents: 149.5, price_type: 'exact', confidence: 0.9, source_text: 'bad' },
      ],
      confidence_score: 0.8,
    }));

    const result = await extractor.extract(makeContext('$149'));

    expect(result.data.prices).toHaveLength(1);
    expect(result.data.prices[0].serviceRef).toBe('Good');
  });
});
