import { createTenantSettingsProposal } from '../../../src/ai/tasks/onboarding/tenant-settings-proposer';
import { assembleEstimateTemplates } from '../../../src/ai/tasks/onboarding/template-assembler';
import {
  onboardingTenantSettingsPayloadSchema,
  onboardingServiceCategoryPayloadSchema,
  onboardingEstimateTemplatePayloadSchema,
  onboardingTeamMemberPayloadSchema,
  onboardingSchedulePayloadSchema,
} from '../../../src/proposals/contracts/onboarding';
import { missingFieldsFor } from '../../../src/proposals/proposal';
import type {
  BusinessProfileExtraction,
  ServiceCategoryExtraction,
  PricingExtraction,
} from '../../../src/ai/tasks/onboarding/types';

// ─── TenantSettingsProposer ──────────────────────────────────────────────────

describe('P4-EXT-006 — Tenant settings proposal from extraction', () => {
  /**
   * B1.20 — a pricing capture that DID produce an hourly rate. Passed by
   * every case below that is not specifically about the missing-rate gate,
   * because `createTenantSettingsProposal` now gates on `hourlyRateCents`
   * whenever no rate was captured (see the missing-rate cases at the bottom
   * of this describe): without a rate on the payload the tenant-settings
   * write leaves `hourly_rate_cents` NULL and `deriveOnboardingStatus`
   * bounces the owner back to the identity form.
   */
  const hourlyPricing: PricingExtraction = {
    prices: [
      { serviceRef: 'labor', amountCents: 12000, priceType: 'hourly_rate', confidence: 0.9, sourceText: '$120 an hour' },
    ],
  };

  /**
   * A zone the tenant had ALREADY chosen (a partly-completed form wizard, or
   * an account predating migration 263) — the one non-gating source of a
   * timezone. Passed by every case below that is not specifically about the
   * missing-timezone gate, because `createTenantSettingsProposal` gates on
   * `timezone` whenever the tenant has none: no onboarding extractor captures
   * a zone, and this path must never derive one from the city/state it DID
   * capture (Scottsdale, AZ is precisely the case the Phoenix mis-booking
   * postmortem is named after). Without a zone the settings write leaves
   * `tenant_settings.timezone` NULL and CreateAppointmentTaskHandler turns
   * every spoken booking into a timezone clarification.
   */
  const KNOWN_TZ = 'America/Phoenix';

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
    const result = createTenantSettingsProposal(
      'tenant-1',
      'user-1',
      baseProfile,
      'conv-42',
      hourlyPricing,
      KNOWN_TZ,
    );

    expect(result!.proposal.sourceContext).toEqual({ conversationId: 'conv-42' });
  });

  // ── Unresolved vertical pack ⇒ GATED, never approve-then-fail ──────────
  //
  // `OnboardingTenantSettingsExecutionHandler` always refuses an empty
  // `verticalPacks`, so drafting one ungated is an approvable proposal that
  // deterministically fails at execution (losing the identity fields with
  // it, since the handler writes identity + packs in one shot).

  it('unsupported/unresolved trade — gates on verticalPacks instead of drafting an approvable proposal', () => {
    const unresolvedProfile: BusinessProfileExtraction = {
      businessName: 'Blue Water Pool Service',
      city: 'Mesa',
      state: 'AZ',
      verticalPacks: [],
      serviceDescriptions: ['pool cleaning'],
      confidence: 0.9,
      lowConfidenceFields: ['verticalPacks'],
    };

    const result = createTenantSettingsProposal(
      'tenant-1',
      'user-1',
      unresolvedProfile,
      'conv-9',
      hourlyPricing,
      KNOWN_TZ,
    );

    expect(result).not.toBeNull();
    // Everything the owner DID say survives onto the card.
    expect(result!.proposal.payload.businessName).toBe('Blue Water Pool Service');
    expect(result!.proposal.payload.city).toBe('Mesa');
    expect(result!.proposal.payload.verticalPacks).toEqual([]);
    // …but it cannot be approved until the pack is supplied.
    expect(missingFieldsFor(result!.proposal)).toEqual(['verticalPacks']);
    expect(result!.proposal.status).toBe('draft');
    expect(result!.proposal.sourceContext).toMatchObject({ conversationId: 'conv-9' });
    // The card says what it needs rather than implying it is ready.
    expect(result!.proposal.summary.toLowerCase()).toContain('which trade');
  });

  it('positive control — a supported trade drafts an APPROVABLE proposal with the pack set (gate cannot pass vacuously)', () => {
    const result = createTenantSettingsProposal(
      'tenant-1',
      'user-1',
      baseProfile,
      'conv-9',
      hourlyPricing,
      KNOWN_TZ,
    );

    expect(result!.proposal.payload.verticalPacks).toEqual(['hvac']);
    expect(missingFieldsFor(result!.proposal)).toEqual([]);
  });

  it('a low-confidence-only vertical still counts as resolved — no gate', () => {
    const lowConfProfile: BusinessProfileExtraction = {
      ...baseProfile,
      verticalPacks: [{ type: 'plumbing', confidence: 0.2, sourceText: 'maybe plumbing' }],
    };

    const result = createTenantSettingsProposal(
      'tenant-1',
      'user-1',
      lowConfProfile,
      undefined,
      hourlyPricing,
      KNOWN_TZ,
    );

    // The fallback above put 'plumbing' on the payload, so the handler can
    // execute — gating here would block a proposal that would have worked.
    expect(result!.proposal.payload.verticalPacks).toEqual(['plumbing']);
    expect(missingFieldsFor(result!.proposal)).toEqual([]);
  });

  // ── No hourly rate captured ⇒ GATED, never a silent bounce-back ────────
  //
  // The silent twin of the verticalPacks gate. `PricingExtractor` treats any
  // nonempty price list as complete, so a service-call-fee-only or
  // flat-rate-only answer yields prices with no `hourly_rate` entry and
  // `pickHourlyRateCents` returns undefined. Ungated, that proposal is
  // approvable AND executes SUCCESSFULLY — the handler just never writes the
  // column — leaving `hourly_rate_cents` NULL, which
  // `deriveOnboardingStatus` (onboarding/derive-status.ts) requires non-null
  // for the identity step. The owner completes the conversation, approves,
  // sees no error, and is sent back to the identity form.

  it('service-call fee only (no hourly rate) — gates on hourlyRateCents instead of drafting an approvable proposal', () => {
    const serviceCallOnly: PricingExtraction = {
      prices: [
        { serviceRef: 'service call', amountCents: 9500, priceType: 'exact', confidence: 0.9, sourceText: '$95 to come out' },
      ],
    };

    const result = createTenantSettingsProposal(
      'tenant-1',
      'user-1',
      baseProfile,
      'conv-9',
      serviceCallOnly,
      KNOWN_TZ,
    );

    // Everything the owner DID say survives, and no rate is invented.
    expect(result!.proposal.payload.businessName).toBe('Comfort Zone HVAC');
    expect(result!.proposal.payload.verticalPacks).toEqual(['hvac']);
    expect(result!.proposal.payload.hourlyRateCents).toBeUndefined();
    // …but it cannot be approved until the rate is supplied.
    expect(missingFieldsFor(result!.proposal)).toEqual(['hourlyRateCents']);
    expect(result!.proposal.status).toBe('draft');
    expect(result!.proposal.summary.toLowerCase()).toContain('hourly labor rate');
  });

  it('flat-rate-only pricing (ranges/components, no hourly entry) — still gated', () => {
    const flatRateOnly: PricingExtraction = {
      prices: [
        { serviceRef: 'water heater', amountCents: 145000, priceType: 'range_start', confidence: 0.9, sourceText: 'starts at $1,450' },
        { serviceRef: 'filter', amountCents: 2500, priceType: 'component', confidence: 0.9, sourceText: '$25 filter' },
      ],
    };

    const result = createTenantSettingsProposal('tenant-1', 'user-1', baseProfile, 'conv-9', flatRateOnly, KNOWN_TZ);

    expect(result!.proposal.payload.hourlyRateCents).toBeUndefined();
    expect(missingFieldsFor(result!.proposal)).toEqual(['hourlyRateCents']);
  });

  it('no pricing extraction at all (single-shot orchestrator) — gated, never defaulted', () => {
    const result = createTenantSettingsProposal('tenant-1', 'user-1', baseProfile, 'conv-9', undefined, KNOWN_TZ);

    expect(result!.proposal.payload.hourlyRateCents).toBeUndefined();
    expect(missingFieldsFor(result!.proposal)).toEqual(['hourlyRateCents']);
  });

  it('rate AND pack both missing — both gates are listed, not just the first', () => {
    const unresolvedProfile: BusinessProfileExtraction = {
      ...baseProfile,
      businessName: 'Blue Water Pool Service',
      verticalPacks: [],
      lowConfidenceFields: ['verticalPacks'],
    };
    const serviceCallOnly: PricingExtraction = {
      prices: [
        { serviceRef: 'service call', amountCents: 9500, priceType: 'exact', confidence: 0.9, sourceText: '$95' },
      ],
    };

    const result = createTenantSettingsProposal(
      'tenant-1',
      'user-1',
      unresolvedProfile,
      'conv-9',
      serviceCallOnly,
      KNOWN_TZ,
    );

    expect(missingFieldsFor(result!.proposal).sort()).toEqual(['hourlyRateCents', 'verticalPacks']);
    // The card asks for both, not just whichever was checked first.
    expect(result!.proposal.summary.toLowerCase()).toContain('which trade');
    expect(result!.proposal.summary.toLowerCase()).toContain('hourly labor rate');
  });

  it('positive control — an hourly rate on the pricing capture leaves the proposal APPROVABLE with the rate in integer cents', () => {
    const result = createTenantSettingsProposal(
      'tenant-1',
      'user-1',
      baseProfile,
      'conv-9',
      hourlyPricing,
      KNOWN_TZ,
    );

    expect(result!.proposal.payload.hourlyRateCents).toBe(12000);
    expect(Number.isInteger(result!.proposal.payload.hourlyRateCents)).toBe(true);
    expect(missingFieldsFor(result!.proposal)).toEqual([]);
    expect(result!.proposal.summary.toLowerCase()).not.toContain('hourly labor rate');
  });

  // ── No timezone ⇒ GATED, never guessed ────────────────────────────────
  //
  // The LOUDEST-DOWNSTREAM member of the same family. No onboarding
  // extractor captures a zone, so a "Talk it through" tenant reaches here
  // with none. Ungated, the card approved and — before the handler was made
  // to require it — executed SUCCESSFULLY with the key simply omitted,
  // leaving `tenant_settings.timezone` NULL. `CreateAppointmentTaskHandler`
  // (ai/tasks/create-appointment-task.ts) then converts EVERY spoken booking
  // into a `voice_clarification`, deterministically, because it refuses to
  // guess a zone. There is no safe fallback — not the locale, not the area
  // code, and not the city/state on this very payload (`baseProfile` is in
  // Arizona, the state that named the postmortem) — so the answer is a gate.

  it('no stored timezone — gates on timezone instead of drafting an approvable proposal', () => {
    const result = createTenantSettingsProposal(
      'tenant-1',
      'user-1',
      baseProfile,
      'conv-9',
      hourlyPricing,
    );

    // Everything the owner DID say survives onto the card…
    expect(result!.proposal.payload.businessName).toBe('Comfort Zone HVAC');
    expect(result!.proposal.payload.verticalPacks).toEqual(['hvac']);
    // …and no zone is invented from Scottsdale, AZ.
    expect(result!.proposal.payload.timezone).toBeUndefined();
    expect(missingFieldsFor(result!.proposal)).toEqual(['timezone']);
    expect(result!.proposal.status).toBe('draft');
    expect(result!.proposal.summary.toLowerCase()).toContain('timezone');
  });

  it('positive control — a tenant who already chose a zone is NOT asked again (gate cannot pass vacuously)', () => {
    const result = createTenantSettingsProposal(
      'tenant-1',
      'user-1',
      baseProfile,
      'conv-9',
      hourlyPricing,
      KNOWN_TZ,
    );

    expect(result!.proposal.payload.timezone).toBe(KNOWN_TZ);
    expect(missingFieldsFor(result!.proposal)).toEqual([]);
    expect(result!.proposal.summary.toLowerCase()).not.toContain('timezone');
  });

  it.each([
    ['a bogus zone', 'Foo/Bar'],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('a stored %s is not trusted onto the payload — the proposal gates and asks', (_label, stored) => {
    const result = createTenantSettingsProposal(
      'tenant-1',
      'user-1',
      baseProfile,
      'conv-9',
      hourlyPricing,
      stored,
    );

    expect(result!.proposal.payload.timezone).toBeUndefined();
    expect(missingFieldsFor(result!.proposal)).toEqual(['timezone']);
  });

  it('all three gates at once are listed independently', () => {
    const unresolvedProfile: BusinessProfileExtraction = {
      ...baseProfile,
      businessName: 'Blue Water Pool Service',
      verticalPacks: [],
      lowConfidenceFields: ['verticalPacks'],
    };

    const result = createTenantSettingsProposal('tenant-1', 'user-1', unresolvedProfile, 'conv-9');

    expect(missingFieldsFor(result!.proposal).sort()).toEqual([
      'hourlyRateCents',
      'timezone',
      'verticalPacks',
    ]);
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

  it('onboarding_service_category — accepts electrical as a basic supported vertical type', () => {
    const result = onboardingServiceCategoryPayloadSchema.safeParse({
      verticalType: 'electrical',
      categoryId: 'wiring',
      displayName: 'Wiring',
    });
    expect(result.success).toBe(true);
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
