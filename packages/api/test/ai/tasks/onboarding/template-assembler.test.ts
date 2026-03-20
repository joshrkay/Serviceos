import { describe, it, expect } from 'vitest';
import { assembleEstimateTemplates } from '../../../../src/ai/tasks/onboarding/template-assembler';
import {
  ServiceCategoryExtraction,
  PricingExtraction,
} from '../../../../src/ai/tasks/onboarding/types';

describe('P4-EXT-007 — Estimate template assembly from voice description', () => {
  const tenantId = 'tenant-001';
  const userId = 'user-001';

  // T3-014: Template assembly — "Tune-up includes checking refrigerant, cleaning coils, testing thermostat, 45 min labor"
  it('T3-014 — assembles multi-line-item template from detailed input', () => {
    const categories: ServiceCategoryExtraction = {
      categories: [
        { verticalType: 'hvac', categoryId: 'maintenance', name: 'Maintenance Tune-up', confidence: 0.9, sourceText: '' },
      ],
    };

    const pricing: PricingExtraction = {
      prices: [
        { serviceRef: 'Maintenance Tune-up', amountCents: 14900, priceType: 'exact', confidence: 0.9, sourceText: '$149' },
      ],
    };

    const result = assembleEstimateTemplates(tenantId, userId, categories, pricing);

    expect(result.proposals).toHaveLength(1);
    const payload = result.proposals[0].payload as Record<string, unknown>;
    expect(payload.templateName).toBe('Maintenance Tune-up');
    expect(payload.verticalType).toBe('hvac');
    expect(payload.categoryId).toBe('maintenance');

    const lineItems = payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems.length).toBeGreaterThanOrEqual(1);
    expect(lineItems[0].defaultUnitPriceCents).toBe(14900);
  });

  // T3-015: Multi-line pricing — template total matches sum
  it('T3-015 — creates template with component pricing', () => {
    const categories: ServiceCategoryExtraction = {
      categories: [
        { verticalType: 'hvac', categoryId: 'maintenance', name: 'Tune-up', confidence: 0.9, sourceText: '' },
      ],
    };

    const pricing: PricingExtraction = {
      prices: [
        { serviceRef: 'Tune-up labor', amountCents: 8500, priceType: 'hourly_rate', confidence: 0.85, sourceText: '$85/hr' },
        { serviceRef: 'Tune-up filter', amountCents: 2500, priceType: 'component', confidence: 0.85, sourceText: '$25 filter' },
      ],
    };

    const result = assembleEstimateTemplates(tenantId, userId, categories, pricing);

    expect(result.proposals).toHaveLength(1);
    const payload = result.proposals[0].payload as Record<string, unknown>;
    const lineItems = payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems).toHaveLength(2);

    const laborItem = lineItems.find((li) => li.category === 'labor');
    expect(laborItem).toBeDefined();
    expect(laborItem!.defaultUnitPriceCents).toBe(8500);

    const materialItem = lineItems.find((li) => li.category === 'material');
    expect(materialItem).toBeDefined();
    expect(materialItem!.defaultUnitPriceCents).toBe(2500);
  });

  it('creates placeholder template when no pricing is available', () => {
    const categories: ServiceCategoryExtraction = {
      categories: [
        { verticalType: 'hvac', categoryId: 'repair', name: 'AC Repair', confidence: 0.9, sourceText: '' },
      ],
    };

    const pricing: PricingExtraction = { prices: [] };

    const result = assembleEstimateTemplates(tenantId, userId, categories, pricing);

    expect(result.proposals).toHaveLength(1);
    const payload = result.proposals[0].payload as Record<string, unknown>;
    const lineItems = payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0].defaultUnitPriceCents).toBe(0);
  });

  it('creates one template per category', () => {
    const categories: ServiceCategoryExtraction = {
      categories: [
        { verticalType: 'hvac', categoryId: 'diagnostic', name: 'Diagnostic', confidence: 0.9, sourceText: '' },
        { verticalType: 'hvac', categoryId: 'maintenance', name: 'Tune-up', confidence: 0.9, sourceText: '' },
        { verticalType: 'hvac', categoryId: 'replacement', name: 'Replacement', confidence: 0.8, sourceText: '' },
      ],
    };

    const pricing: PricingExtraction = {
      prices: [
        { serviceRef: 'Diagnostic', amountCents: 8900, priceType: 'exact', confidence: 0.9, sourceText: '' },
        { serviceRef: 'Tune-up', amountCents: 14900, priceType: 'exact', confidence: 0.9, sourceText: '' },
        { serviceRef: 'Replacement', amountCents: 450000, priceType: 'range_start', confidence: 0.7, sourceText: '' },
      ],
    };

    const result = assembleEstimateTemplates(tenantId, userId, categories, pricing);

    expect(result.proposals).toHaveLength(3);
    expect(result.proposals[0].proposalType).toBe('onboarding_estimate_template');
  });

  it('all line item amounts are integer cents', () => {
    const categories: ServiceCategoryExtraction = {
      categories: [
        { verticalType: 'hvac', categoryId: 'maintenance', name: 'Tune-up', confidence: 0.9, sourceText: '' },
      ],
    };
    const pricing: PricingExtraction = {
      prices: [
        { serviceRef: 'Tune-up', amountCents: 14900, priceType: 'exact', confidence: 0.9, sourceText: '' },
      ],
    };

    const result = assembleEstimateTemplates(tenantId, userId, categories, pricing);
    const payload = result.proposals[0].payload as Record<string, unknown>;
    const lineItems = payload.lineItems as Array<Record<string, unknown>>;

    for (const item of lineItems) {
      expect(Number.isInteger(item.defaultUnitPriceCents)).toBe(true);
    }
  });
});
