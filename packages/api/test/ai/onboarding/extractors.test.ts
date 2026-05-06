import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import { CategoryExtractor } from '../../../src/ai/tasks/onboarding/category-extractor';
import { PricingExtractor } from '../../../src/ai/tasks/onboarding/pricing-extractor';
import { TeamExtractor } from '../../../src/ai/tasks/onboarding/team-extractor';
import { ScheduleExtractor } from '../../../src/ai/tasks/onboarding/schedule-extractor';
import type { ExtractionContext } from '../../../src/ai/tasks/onboarding/types';
import {
  loadFixture,
  buildExtractionContext,
  mockCategoryResponse,
  mockPricingResponse,
  mockTeamResponse,
  mockScheduleResponse,
} from './helpers';

// ─── CategoryExtractor ───────────────────────────────────────────────────────

describe('P4-EXT-002 — Service category extraction from voice transcript', () => {
  function contextWithProfile(overrides: Partial<ExtractionContext> = {}): ExtractionContext {
    return buildExtractionContext({
      previousExtractions: {
        businessProfile: {
          businessName: 'Comfort Zone HVAC',
          city: 'Scottsdale',
          state: 'AZ',
          verticalPacks: [{ type: 'hvac', confidence: 0.95, sourceText: 'HVAC company' }],
          serviceDescriptions: ['AC repair', 'maintenance', 'replacements'],
          confidence: 0.9,
          lowConfidenceFields: [],
        },
      },
      ...overrides,
    });
  }

  it('T3-003 — extracts HVAC categories (repair, maintenance, replacement)', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(mockCategoryResponse());
    const extractor = new CategoryExtractor(gateway);

    const result = await extractor.extract(contextWithProfile());

    expect(result.data.categories.length).toBeGreaterThanOrEqual(3);
    const ids = result.data.categories.map((c) => c.categoryId);
    expect(ids).toContain('repair');
    expect(ids).toContain('maintenance');
    expect(ids).toContain('replacement');
    expect(result.data.categories.every((c) => c.verticalType === 'hvac')).toBe(true);
  });

  it('T3-004 — extracts plumbing categories (drain, water-heater, replacement)', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      mockCategoryResponse({
        categories: [
          { vertical_type: 'plumbing', category_id: 'drain', name: 'Drain Clearing', confidence: 0.95, source_text: 'drain clearing' },
          { vertical_type: 'plumbing', category_id: 'water-heater', name: 'Water Heater Install', confidence: 0.9, source_text: 'water heater installs' },
          { vertical_type: 'plumbing', category_id: 'replacement', name: 'Repipe', confidence: 0.85, source_text: 'repipes' },
        ],
      })
    );
    const extractor = new CategoryExtractor(gateway);
    const transcript = loadFixture('fixture-02-plumbing.txt');

    const ctx = buildExtractionContext({
      transcript,
      previousExtractions: {
        businessProfile: {
          businessName: 'Reliable Plumbing',
          city: 'Tempe',
          state: 'AZ',
          verticalPacks: [{ type: 'plumbing', confidence: 0.95, sourceText: 'plumbing' }],
          serviceDescriptions: ['drain clearing', 'water heater installs', 'repipes'],
          confidence: 0.9,
          lowConfidenceFields: [],
        },
      },
    });

    const result = await extractor.extract(ctx);

    const ids = result.data.categories.map((c) => c.categoryId);
    expect(ids).toContain('drain');
    expect(ids).toContain('water-heater');
    expect(ids).toContain('replacement');
    expect(result.data.categories.every((c) => c.verticalType === 'plumbing')).toBe(true);
  });

  it('filters out invalid category IDs', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      mockCategoryResponse({
        categories: [
          { vertical_type: 'hvac', category_id: 'repair', name: 'Repair', confidence: 0.9, source_text: 'repair' },
          { vertical_type: 'hvac', category_id: 'duct_cleaning', name: 'Duct Cleaning', confidence: 0.8, source_text: 'duct cleaning' }, // not in taxonomy
        ],
      })
    );
    const extractor = new CategoryExtractor(gateway);

    const result = await extractor.extract(contextWithProfile());

    expect(result.data.categories).toHaveLength(1);
    expect(result.data.categories[0].categoryId).toBe('repair');
  });

  it('empty categories triggers clarification', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({ categories: [], confidence_score: 0.2 }));
    const extractor = new CategoryExtractor(gateway);

    const result = await extractor.extract(contextWithProfile());

    expect(result.data.categories).toHaveLength(0);
    expect(result.needsClarification).toBe(true);
    expect(result.clarificationQuestions!.length).toBeGreaterThan(0);
  });

  it('includes vertical context from previous extractions in LLM call', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(mockCategoryResponse());
    const extractor = new CategoryExtractor(gateway);

    await extractor.extract(contextWithProfile());

    const calls = provider.getCalls();
    expect(calls).toHaveLength(1);
    const userMsg = calls[0].messages.find((m) => m.role === 'user');
    expect(userMsg!.content).toContain('<context>');
    expect(userMsg!.content).toContain('hvac');
  });
});

// ─── PricingExtractor ────────────────────────────────────────────────────────

describe('P4-EXT-003 — Pricing extraction from voice transcript', () => {
  function contextWithCategories(overrides: Partial<ExtractionContext> = {}): ExtractionContext {
    return buildExtractionContext({
      previousExtractions: {
        categories: {
          categories: [
            { verticalType: 'hvac', categoryId: 'diagnostic', name: 'Diagnostic', confidence: 0.9, sourceText: 'diagnostic' },
            { verticalType: 'hvac', categoryId: 'maintenance', name: 'Tune-Up', confidence: 0.9, sourceText: 'tune-up' },
            { verticalType: 'hvac', categoryId: 'replacement', name: 'Replacement', confidence: 0.85, sourceText: 'replacement' },
          ],
        },
      },
      ...overrides,
    });
  }

  it('T3-004 — extracts exact prices in integer cents', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(mockPricingResponse());
    const extractor = new PricingExtractor(gateway);

    const result = await extractor.extract(contextWithCategories());

    const diag = result.data.prices.find((p) => p.serviceRef === 'diagnostic');
    expect(diag).toBeDefined();
    expect(diag!.amountCents).toBe(8900);
    expect(diag!.priceType).toBe('exact');

    const maint = result.data.prices.find((p) => p.serviceRef === 'maintenance');
    expect(maint).toBeDefined();
    expect(maint!.amountCents).toBe(14900);
    expect(maint!.priceType).toBe('exact');
  });

  it('T3-005 — extracts range pricing with qualifier', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(mockPricingResponse());
    const extractor = new PricingExtractor(gateway);

    const result = await extractor.extract(contextWithCategories());

    const replacement = result.data.prices.find((p) => p.serviceRef === 'replacement');
    expect(replacement).toBeDefined();
    expect(replacement!.amountCents).toBe(450000);
    expect(replacement!.priceType).toBe('range_start');
    expect(replacement!.qualifier).toBeDefined();
  });

  it('T3-015 — extracts multi-component pricing (labor + material)', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      mockPricingResponse({
        prices: [
          { service_ref: 'tune-up labor', amount_cents: 6375, price_type: 'hourly_rate', confidence: 0.9, source_text: '45 min labor at $85/hr' },
          { service_ref: 'filter', amount_cents: 2500, price_type: 'component', confidence: 0.9, source_text: '$25 filter' },
        ],
      })
    );
    const extractor = new PricingExtractor(gateway);

    const result = await extractor.extract(contextWithCategories());

    expect(result.data.prices).toHaveLength(2);
    const labor = result.data.prices.find((p) => p.priceType === 'hourly_rate');
    expect(labor!.amountCents).toBe(6375);
    const material = result.data.prices.find((p) => p.priceType === 'component');
    expect(material!.amountCents).toBe(2500);
    // All amounts are integers
    result.data.prices.forEach((p) => {
      expect(Number.isInteger(p.amountCents)).toBe(true);
    });
  });

  it('T2-007 — contradictory prices use most recent value', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      mockPricingResponse({
        prices: [
          { service_ref: 'diagnostic', amount_cents: 8900, price_type: 'exact', confidence: 0.8, source_text: 'actually we just raised it to $89' },
          { service_ref: 'tune-up', amount_cents: 14900, price_type: 'exact', confidence: 0.85, source_text: 'yeah $149' },
        ],
      })
    );
    const extractor = new PricingExtractor(gateway);
    const transcript = loadFixture('fixture-05-contradictory-rambling.txt');

    const result = await extractor.extract(contextWithCategories({ transcript }));

    const diag = result.data.prices.find((p) => p.serviceRef === 'diagnostic');
    expect(diag!.amountCents).toBe(8900); // $89, not $79
    const tuneUp = result.data.prices.find((p) => p.serviceRef === 'tune-up');
    expect(tuneUp!.amountCents).toBe(14900); // $149, not $129 or $139
  });

  it('filters out non-integer amounts', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({
      prices: [
        { service_ref: 'valid', amount_cents: 8900, price_type: 'exact', confidence: 0.9, source_text: '$89' },
        { service_ref: 'float', amount_cents: 89.5, price_type: 'exact', confidence: 0.9, source_text: 'bad' },
        { service_ref: 'negative', amount_cents: -100, price_type: 'exact', confidence: 0.9, source_text: 'bad' },
      ],
      confidence_score: 0.8,
    }));
    const extractor = new PricingExtractor(gateway);

    const result = await extractor.extract(contextWithCategories());

    expect(result.data.prices).toHaveLength(1);
    expect(result.data.prices[0].serviceRef).toBe('valid');
  });

  it('no prices triggers clarification', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({ prices: [], confidence_score: 0.1 }));
    const extractor = new PricingExtractor(gateway);

    const result = await extractor.extract(contextWithCategories());

    expect(result.data.prices).toHaveLength(0);
    expect(result.needsClarification).toBe(true);
    expect(result.clarificationQuestions).toBeDefined();
  });
});

// ─── TeamExtractor ───────────────────────────────────────────────────────────

describe('P4-EXT-004 — Team member extraction from voice transcript', () => {
  it('T3-006 — extracts team members with names', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(mockTeamResponse());
    const extractor = new TeamExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    expect(result.data.members).toHaveLength(2);
    const names = result.data.members.map((m) => m.name);
    expect(names).toContain('Marcus');
    expect(names).toContain('Tony');
    expect(result.data.members.every((m) => m.inferredRole === 'technician')).toBe(true);
  });

  it('T3-007 — disambiguates roles (technician vs dispatcher)', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      mockTeamResponse({
        members: [
          { name: 'Mike', inferred_role: 'technician', confidence: 0.9, source_text: 'Mike and Dave are in the field' },
          { name: 'Dave', inferred_role: 'technician', confidence: 0.9, source_text: 'Mike and Dave are in the field' },
          { name: 'Rosa', inferred_role: 'dispatcher', confidence: 0.85, source_text: 'Rosa handles the office' },
        ],
      })
    );
    const extractor = new TeamExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    const rosa = result.data.members.find((m) => m.name === 'Rosa');
    expect(rosa).toBeDefined();
    expect(rosa!.inferredRole).toBe('dispatcher');

    const techs = result.data.members.filter((m) => m.inferredRole === 'technician');
    expect(techs).toHaveLength(2);
  });

  it('filters out invalid roles', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({
      members: [
        { name: 'Valid', inferred_role: 'technician', confidence: 0.9, source_text: 'tech' },
        { name: 'Invalid', inferred_role: 'manager', confidence: 0.9, source_text: 'manager' }, // not in valid roles
      ],
      confidence_score: 0.8,
    }));
    const extractor = new TeamExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    expect(result.data.members).toHaveLength(1);
    expect(result.data.members[0].name).toBe('Valid');
  });

  it('filters out entries with empty names', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({
      members: [
        { name: 'Marcus', inferred_role: 'technician', confidence: 0.9, source_text: 'Marcus' },
        { name: '', inferred_role: 'technician', confidence: 0.9, source_text: 'unnamed' },
      ],
      confidence_score: 0.8,
    }));
    const extractor = new TeamExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    expect(result.data.members).toHaveLength(1);
    expect(result.data.members[0].name).toBe('Marcus');
  });

  it('plumbing fixture — extracts owner, techs, and dispatcher', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      mockTeamResponse({
        members: [
          { name: 'Mike', inferred_role: 'owner', confidence: 0.9, source_text: 'I run the trucks myself' },
          { name: 'Javier', inferred_role: 'technician', confidence: 0.9, source_text: 'two guys, Javier and Sam' },
          { name: 'Sam', inferred_role: 'technician', confidence: 0.9, source_text: 'two guys, Javier and Sam' },
          { name: 'Linda', inferred_role: 'dispatcher', confidence: 0.85, source_text: 'my wife Linda answers the phones' },
        ],
      })
    );
    const extractor = new TeamExtractor(gateway);
    const transcript = loadFixture('fixture-02-plumbing.txt');

    const result = await extractor.extract(buildExtractionContext({ transcript }));

    expect(result.data.members).toHaveLength(4);
    const roles = result.data.members.map((m) => m.inferredRole);
    expect(roles).toContain('owner');
    expect(roles).toContain('dispatcher');
    expect(roles.filter((r) => r === 'technician')).toHaveLength(2);
  });
});

// ─── ScheduleExtractor ──────────────────────────────────────────────────────

describe('P4-EXT-005 — Schedule and SLA extraction from voice transcript', () => {
  it('T3-008 — extracts M-F 8-5 with seasonal Saturday', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(mockScheduleResponse());
    const extractor = new ScheduleExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    expect(result.data.workingHours.length).toBeGreaterThanOrEqual(1);

    const weekday = result.data.workingHours.find((wh) => wh.days.includes('monday'));
    expect(weekday).toBeDefined();
    expect(weekday!.startTime).toBe('08:00');
    expect(weekday!.endTime).toBe('17:00');
    expect(weekday!.days).toHaveLength(5);

    const saturday = result.data.workingHours.find((wh) => wh.days.includes('saturday'));
    expect(saturday).toBeDefined();
    expect(saturday!.seasonal).toBe('summer');
  });

  it('T3-009 — extracts emergency SLA (best-effort, not guarantee)', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(mockScheduleResponse());
    const extractor = new ScheduleExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    expect(result.data.sla).toBeDefined();
    expect(result.data.sla!.type).toBe('emergency');
    expect(result.data.sla!.hoursTarget).toBe(4);
    expect(result.data.sla!.isGuarantee).toBe(false);
  });

  it('filters out invalid day names', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({
      working_hours: [
        { days: ['monday', 'funday', 'friday'], start_time: '08:00', end_time: '17:00' },
      ],
      sla: null,
      confidence_score: 0.7,
    }));
    const extractor = new ScheduleExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    expect(result.data.workingHours).toHaveLength(1);
    // 'funday' should be filtered out
    expect(result.data.workingHours[0].days).toContain('monday');
    expect(result.data.workingHours[0].days).toContain('friday');
    expect(result.data.workingHours[0].days).not.toContain('funday');
  });

  it('no schedule triggers clarification', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({ working_hours: [], sla: null, confidence_score: 0.1 }));
    const extractor = new ScheduleExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    expect(result.data.workingHours).toHaveLength(0);
    expect(result.needsClarification).toBe(true);
    expect(result.clarificationQuestions).toBeDefined();
  });

  it('SLA with zero hours_target is excluded', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({
      working_hours: [
        { days: ['monday'], start_time: '08:00', end_time: '17:00' },
      ],
      sla: { type: 'emergency', hours_target: 0, is_guarantee: false, source_text: '' },
      confidence_score: 0.7,
    }));
    const extractor = new ScheduleExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    expect(result.data.sla).toBeUndefined();
  });

  it('M-Sat 7-4 schedule for plumbing fixture', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({
      working_hours: [
        { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'], start_time: '07:00', end_time: '16:00' },
      ],
      sla: null,
      confidence_score: 0.9,
    }));
    const extractor = new ScheduleExtractor(gateway);
    const transcript = loadFixture('fixture-02-plumbing.txt');

    const result = await extractor.extract(buildExtractionContext({ transcript }));

    expect(result.data.workingHours).toHaveLength(1);
    expect(result.data.workingHours[0].days).toHaveLength(6);
    expect(result.data.workingHours[0].startTime).toBe('07:00');
    expect(result.data.workingHours[0].endTime).toBe('16:00');
    expect(result.data.sla).toBeUndefined();
  });
});
