import { createTenantSettingsProposal } from '../../../src/ai/tasks/onboarding/tenant-settings-proposer';
import { assembleEstimateTemplates } from '../../../src/ai/tasks/onboarding/template-assembler';
import {
  onboardingTenantSettingsPayloadSchema,
  onboardingServiceCategoryPayloadSchema,
  onboardingEstimateTemplatePayloadSchema,
  onboardingTeamMemberPayloadSchema,
  onboardingSchedulePayloadSchema,
} from '../../../src/proposals/contracts/onboarding';
import type {
  BusinessProfileExtraction,
  ServiceCategoryExtraction,
  PricingExtraction,
} from '../../../src/ai/tasks/onboarding/types';

// ─── TenantSettingsProposer ──────────────────────────────────────────────────

describe('P4-EXT-006 — Tenant settings proposal from extraction', () => {
  const baseProfile: BusinessProfileExtraction = {
    businessName: 'Comfort Zone HVAC',
    city: 'Scottsdale',
    state: 'AZ',
    verticalPacks: [{ type: 'hvac', confidence: 0.95, sourceText: 'HVAC company' }],
    serviceDescriptions: ['AC repair', 'maintenance', 'replacements'],
    confidence: 0.9,
    lowConfidenceFields: [],
  };

  it('happy path — generates valid tenant settings proposal', () => {
    const result = createTenantSettingsProposal('tenant-1', 'user-1', baseProfile, 'conv-1');

    expect(result).not.toBeNull();
    expect(result!.proposal.proposalType).toBe('onboarding_tenant_settings');
    expect(result!.proposal.status).toBe('draft');
    expect(result!.proposal.tenantId).toBe('tenant-1');
    expect(result!.proposal.createdBy).toBe('user-1');

    const payload = result!.proposal.payload;
    expect(payload.businessName).toBe('Comfort Zone HVAC');
    expect(payload.verticalPacks).toEqual(['hvac']);
  });

  it('T4-007 — payload passes Zod schema validation', () => {
    const result = createTenantSettingsProposal('tenant-1', 'user-1', baseProfile);

    const parsed = onboardingTenantSettingsPayloadSchema.safeParse(result!.proposal.payload);
    expect(parsed.success).toBe(true);
  });

  it('no name and no verticals — returns null', () => {
    const emptyProfile: BusinessProfileExtraction = {
      businessName: null,
      city: null,
      state: null,
      verticalPacks: [],
      serviceDescriptions: [],
      confidence: 0,
      lowConfidenceFields: ['businessName', 'verticalPacks'],
    };

    const result = createTenantSettingsProposal('tenant-1', 'user-1', emptyProfile);

    expect(result).toBeNull();
  });

  it('low-confidence verticals included when no high-confidence ones exist', () => {
    const lowConfProfile: BusinessProfileExtraction = {
      ...baseProfile,
      verticalPacks: [{ type: 'hvac', confidence: 0.3, sourceText: 'maybe hvac' }],
    };

    const result = createTenantSettingsProposal('tenant-1', 'user-1', lowConfProfile);

    expect(result).not.toBeNull();
    // Low confidence verticals are included as fallback
    expect((result!.proposal.payload.verticalPacks as string[])).toContain('hvac');
  });

  it('dual verticals both included in payload', () => {
    const dualProfile: BusinessProfileExtraction = {
      ...baseProfile,
      businessName: 'Desert Home Services',
      verticalPacks: [
        { type: 'hvac', confidence: 0.9, sourceText: 'HVAC' },
        { type: 'plumbing', confidence: 0.9, sourceText: 'plumbing' },
      ],
    };

    const result = createTenantSettingsProposal('tenant-1', 'user-1', dualProfile);

    expect(result).not.toBeNull();
    const packs = result!.proposal.payload.verticalPacks as string[];
    expect(packs).toContain('hvac');
    expect(packs).toContain('plumbing');
  });

  it('includes conversationId in sourceContext when provided', () => {
    const result = createTenantSettingsProposal('tenant-1', 'user-1', baseProfile, 'conv-42');

    expect(result!.proposal.sourceContext).toEqual({ conversationId: 'conv-42' });
  });

  it('uses "My Business" fallback when name is null but verticals exist', () => {
    const noNameProfile: BusinessProfileExtraction = {
      ...baseProfile,
      businessName: null,
    };

    const result = createTenantSettingsProposal('tenant-1', 'user-1', noNameProfile);

    expect(result).not.toBeNull();
    expect(result!.proposal.payload.businessName).toBe('My Business');
  });
});

// ─── TemplateAssembler ───────────────────────────────────────────────────────

describe('P4-EXT-007 — Estimate template assembly from voice description', () => {
  const hvacCategories: ServiceCategoryExtraction = {
    categories: [
      { verticalType: 'hvac', categoryId: 'diagnostic', name: 'Diagnostic', confidence: 0.9, sourceText: 'diagnostic' },
      { verticalType: 'hvac', categoryId: 'maintenance', name: 'Tune-Up', confidence: 0.9, sourceText: 'tune-up' },
      { verticalType: 'hvac', categoryId: 'replacement', name: 'Replacement', confidence: 0.85, sourceText: 'replacement' },
    ],
  };

  const hvacPricing: PricingExtraction = {
    prices: [
      { serviceRef: 'Diagnostic', amountCents: 8900, priceType: 'exact', confidence: 0.95, sourceText: '$89' },
      { serviceRef: 'Tune-Up', amountCents: 14900, priceType: 'exact', confidence: 0.95, sourceText: '$149' },
      { serviceRef: 'Replacement', amountCents: 450000, priceType: 'range_start', qualifier: 'basic system', confidence: 0.8, sourceText: '$4500' },
    ],
  };

  it('creates one template proposal per category', () => {
    const result = assembleEstimateTemplates('tenant-1', 'user-1', hvacCategories, hvacPricing, 'conv-1');

    expect(result.proposals).toHaveLength(3);
    expect(result.proposals.every((p) => p.proposalType === 'onboarding_estimate_template')).toBe(true);
  });

  it('T4-007 — all template payloads pass Zod validation', () => {
    const result = assembleEstimateTemplates('tenant-1', 'user-1', hvacCategories, hvacPricing);

    for (const proposal of result.proposals) {
      const parsed = onboardingEstimateTemplatePayloadSchema.safeParse(proposal.payload);
      expect(parsed.success).toBe(true);
    }
  });

  it('categories with matched prices produce line items with correct cents', () => {
    const result = assembleEstimateTemplates('tenant-1', 'user-1', hvacCategories, hvacPricing);

    const diagProposal = result.proposals.find((p) => p.payload.categoryId === 'diagnostic');
    expect(diagProposal).toBeDefined();
    const lineItems = diagProposal!.payload.lineItems as Array<{ defaultUnitPriceCents: number }>;
    expect(lineItems.length).toBeGreaterThanOrEqual(1);
    expect(lineItems[0].defaultUnitPriceCents).toBe(8900);
  });

  it('categories without prices get placeholder template', () => {
    const noPricing: PricingExtraction = { prices: [] };
    const result = assembleEstimateTemplates('tenant-1', 'user-1', hvacCategories, noPricing);

    expect(result.proposals).toHaveLength(3);
    for (const proposal of result.proposals) {
      const lineItems = proposal.payload.lineItems as Array<{ defaultUnitPriceCents: number }>;
      expect(lineItems).toHaveLength(1);
      expect(lineItems[0].defaultUnitPriceCents).toBe(0);
    }
  });

  it('infers labor category for hourly rate prices', () => {
    const laborPricing: PricingExtraction = {
      prices: [
        { serviceRef: 'Tune-Up', amountCents: 8500, priceType: 'hourly_rate', confidence: 0.9, sourceText: '$85/hr' },
      ],
    };
    const result = assembleEstimateTemplates('tenant-1', 'user-1', hvacCategories, laborPricing);

    const tuneUpProposal = result.proposals.find((p) => p.payload.categoryId === 'maintenance');
    expect(tuneUpProposal).toBeDefined();
    const lineItems = tuneUpProposal!.payload.lineItems as Array<{ category?: string }>;
    expect(lineItems[0].category).toBe('labor');
  });

  it('infers material category for filter/part references', () => {
    const materialPricing: PricingExtraction = {
      prices: [
        { serviceRef: 'filter', amountCents: 2500, priceType: 'component', confidence: 0.9, sourceText: '$25 filter' },
      ],
    };
    // Use a category that can match 'filter' by substring
    const catWithFilter: ServiceCategoryExtraction = {
      categories: [
        { verticalType: 'hvac', categoryId: 'maintenance', name: 'filter', confidence: 0.9, sourceText: 'filter change' },
      ],
    };
    const result = assembleEstimateTemplates('tenant-1', 'user-1', catWithFilter, materialPricing);

    const proposal = result.proposals[0];
    const lineItems = proposal.payload.lineItems as Array<{ category?: string }>;
    expect(lineItems[0].category).toBe('material');
  });
});

// ─── Zod Contract Validation ─────────────────────────────────────────────────

describe('T4-007 — Zod schema validation for all onboarding proposal types', () => {
  it('onboarding_tenant_settings — valid payload', () => {
    const result = onboardingTenantSettingsPayloadSchema.safeParse({
      businessName: 'Test HVAC',
      city: 'Phoenix',
      state: 'AZ',
      verticalPacks: ['hvac'],
    });
    expect(result.success).toBe(true);
  });

  it('onboarding_tenant_settings — rejects empty businessName', () => {
    const result = onboardingTenantSettingsPayloadSchema.safeParse({
      businessName: '',
      verticalPacks: ['hvac'],
    });
    expect(result.success).toBe(false);
  });

  it('onboarding_tenant_settings — rejects empty verticalPacks', () => {
    const result = onboardingTenantSettingsPayloadSchema.safeParse({
      businessName: 'Test',
      verticalPacks: [],
    });
    expect(result.success).toBe(false);
  });

  it('onboarding_service_category — valid payload', () => {
    const result = onboardingServiceCategoryPayloadSchema.safeParse({
      verticalType: 'hvac',
      categoryId: 'repair',
      displayName: 'AC Repair',
    });
    expect(result.success).toBe(true);
  });

  it('onboarding_service_category — rejects invalid vertical type', () => {
    const result = onboardingServiceCategoryPayloadSchema.safeParse({
      verticalType: 'electrical',
      categoryId: 'wiring',
      displayName: 'Wiring',
    });
    expect(result.success).toBe(false);
  });

  it('onboarding_estimate_template — valid payload', () => {
    const result = onboardingEstimateTemplatePayloadSchema.safeParse({
      verticalType: 'hvac',
      categoryId: 'maintenance',
      templateName: 'AC Tune-Up',
      lineItems: [
        { description: 'Tune-up labor', defaultQuantity: 1, defaultUnitPriceCents: 14900, taxable: true, sortOrder: 0 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('onboarding_estimate_template — rejects empty lineItems', () => {
    const result = onboardingEstimateTemplatePayloadSchema.safeParse({
      verticalType: 'hvac',
      categoryId: 'maintenance',
      templateName: 'AC Tune-Up',
      lineItems: [],
    });
    expect(result.success).toBe(false);
  });

  it('onboarding_estimate_template — rejects negative unitPriceCents', () => {
    const result = onboardingEstimateTemplatePayloadSchema.safeParse({
      verticalType: 'hvac',
      categoryId: 'maintenance',
      templateName: 'Test',
      lineItems: [
        { description: 'Bad', defaultQuantity: 1, defaultUnitPriceCents: -100, taxable: true, sortOrder: 0 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('onboarding_team_member — valid payload', () => {
    const result = onboardingTeamMemberPayloadSchema.safeParse({
      name: 'Marcus',
      role: 'technician',
    });
    expect(result.success).toBe(true);
  });

  it('onboarding_team_member — rejects invalid role', () => {
    const result = onboardingTeamMemberPayloadSchema.safeParse({
      name: 'Bob',
      role: 'manager',
    });
    expect(result.success).toBe(false);
  });

  it('onboarding_schedule — valid payload', () => {
    const result = onboardingSchedulePayloadSchema.safeParse({
      workingHours: [
        { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], startTime: '08:00', endTime: '17:00' },
      ],
      emergencySLA: { hoursTarget: 4, isGuarantee: false },
    });
    expect(result.success).toBe(true);
  });

  it('onboarding_schedule — rejects invalid time format', () => {
    const result = onboardingSchedulePayloadSchema.safeParse({
      workingHours: [
        { days: ['monday'], startTime: '8am', endTime: '5pm' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('onboarding_schedule — rejects empty workingHours', () => {
    const result = onboardingSchedulePayloadSchema.safeParse({
      workingHours: [],
    });
    expect(result.success).toBe(false);
  });
});
