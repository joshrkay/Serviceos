import {
  assembleVerticalContext,
  buildContextPromptSection,
  formatVerticalForCallerPrompt,
  ContextAssemblyDependencies,
} from '../../src/verticals/context-assembly';
import { InMemoryVerticalPackRepository } from '../../src/verticals/registry';
import { InMemoryEstimateTemplateRepository, createTemplate } from '../../src/templates/estimate-template';
import { InMemoryServiceBundleRepository, createBundle } from '../../src/verticals/bundles';
import { InMemoryWordingPreferenceRepository, createWordingPreference } from '../../src/verticals/wording-preferences';
import { InMemoryApprovedEstimateRepository } from '../../src/learning/approved-estimates';
import { createHvacPack } from '../../src/verticals/packs/hvac';

describe('P4-009 — Vertical-Aware Context Assembly', () => {
  let deps: ContextAssemblyDependencies;

  beforeEach(async () => {
    const verticalPackRepo = new InMemoryVerticalPackRepository();
    const templateRepo = new InMemoryEstimateTemplateRepository();
    const bundleRepo = new InMemoryServiceBundleRepository();
    const wordingRepo = new InMemoryWordingPreferenceRepository();
    const approvedEstimateRepo = new InMemoryApprovedEstimateRepository();

    // Seed HVAC pack
    await verticalPackRepo.create(createHvacPack());

    // Seed a template
    await createTemplate(
      {
        tenantId: 'tenant-1',
        verticalType: 'hvac',
        categoryId: 'hvac-repair-ac',
        name: 'Standard AC Repair',
        lineItemTemplates: [
          { description: 'Diagnostic', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: 8900, taxable: true, sortOrder: 1, isOptional: false },
        ],
        createdBy: 'user-1',
      },
      templateRepo
    );

    // Seed a bundle
    await createBundle(
      {
        tenantId: 'tenant-1',
        verticalType: 'hvac',
        name: 'AC Tune-Up',
        categoryIds: ['hvac-maint-tuneup'],
        lineItemTemplates: [
          { description: 'Tune-up', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: 9900, taxable: true, sortOrder: 1, isOptional: false },
        ],
        triggerKeywords: ['tune up', 'tune-up'],
      },
      bundleRepo
    );

    // Seed wording preferences
    await createWordingPreference(
      {
        tenantId: 'tenant-1',
        scope: 'line_item_description',
        key: 'labor',
        preferredWording: 'Service Labor',
        avoidWordings: ['Work'],
      },
      wordingRepo
    );

    deps = {
      verticalPackRepo,
      templateRepo,
      bundleRepo,
      wordingRepo,
      approvedEstimateRepo,
    };
  });

  it('assembles context with all components', async () => {
    const context = await assembleVerticalContext(
      {
        tenantId: 'tenant-1',
        verticalType: 'hvac',
        categoryId: 'hvac-repair-ac',
        descriptionText: 'AC repair needed',
        keywords: ['ac', 'repair'],
      },
      deps
    );

    expect(context.verticalPack).not.toBeNull();
    expect(context.verticalPack!.type).toBe('hvac');
    expect(context.matchedTemplate).not.toBeNull();
    expect(context.matchedTemplate!.name).toBe('Standard AC Repair');
    expect(context.missingItemRules.length).toBeGreaterThan(0);
    expect(context.wordingGuidelines).toContain('Service Labor');
    expect(context.resolvedTerms['ac']).toBe('Air Conditioner');
  });

  it('matches bundles by description text', async () => {
    const context = await assembleVerticalContext(
      {
        tenantId: 'tenant-1',
        verticalType: 'hvac',
        categoryId: 'hvac-maint-tuneup',
        descriptionText: 'Need a tune up for my AC',
        keywords: ['tune up'],
      },
      deps
    );

    expect(context.matchedBundles).toHaveLength(1);
    expect(context.matchedBundles[0].name).toBe('AC Tune-Up');
  });

  it('returns empty context without vertical type', async () => {
    const context = await assembleVerticalContext(
      {
        tenantId: 'tenant-1',
        descriptionText: 'Some work needed',
        keywords: [],
      },
      deps
    );

    expect(context.verticalPack).toBeNull();
    expect(context.matchedBundles).toHaveLength(0);
    expect(context.missingItemRules).toHaveLength(0);
  });

  it('builds prompt section from context', async () => {
    const context = await assembleVerticalContext(
      {
        tenantId: 'tenant-1',
        verticalType: 'hvac',
        categoryId: 'hvac-repair-ac',
        descriptionText: 'AC repair',
        keywords: ['ac'],
      },
      deps
    );

    const prompt = buildContextPromptSection(context);
    expect(prompt).toContain('HVAC Professional');
    expect(prompt).toContain('Standard AC Repair');
    expect(prompt).toContain('Diagnostic');
    expect(prompt).toContain('Terminology');
    expect(prompt).toContain('Air Conditioner');
  });

  it('handles missing template gracefully', async () => {
    const context = await assembleVerticalContext(
      {
        tenantId: 'tenant-1',
        verticalType: 'hvac',
        categoryId: 'non-existent-category',
        descriptionText: 'Some work',
        keywords: [],
      },
      deps
    );

    expect(context.matchedTemplate).toBeNull();
  });

  it('tenant isolation — does not leak data across tenants', async () => {
    const context = await assembleVerticalContext(
      {
        tenantId: 'other-tenant',
        verticalType: 'hvac',
        categoryId: 'hvac-repair-ac',
        descriptionText: 'AC repair',
        keywords: ['ac'],
      },
      deps
    );

    // Vertical pack is shared (not tenant-scoped), but templates/bundles/preferences are tenant-scoped
    expect(context.verticalPack).not.toBeNull(); // shared data
    expect(context.matchedTemplate).toBeNull(); // tenant-scoped
    expect(context.matchedBundles).toHaveLength(0); // tenant-scoped
    expect(context.wordingGuidelines).toBe(''); // tenant-scoped
  });
});

describe('formatVerticalForCallerPrompt — §3B caller-prompt section', () => {
  it('returns empty string when pack is null', () => {
    expect(formatVerticalForCallerPrompt(null)).toBe('');
    expect(formatVerticalForCallerPrompt(undefined)).toBe('');
  });

  it('emits vertical name + industry context for a real pack', () => {
    const pack = createHvacPack();
    const out = formatVerticalForCallerPrompt(pack);
    expect(out).toContain('Service vertical: HVAC Professional');
    expect(out).toContain('Industry context: Heating, ventilation');
  });

  it('lists equipment terminology with aliases', () => {
    const pack = createHvacPack();
    const out = formatVerticalForCallerPrompt(pack);
    expect(out).toContain('Equipment and terminology recognized:');
    // Furnace + its aliases — caller may say "heater" or "heating unit".
    expect(out).toMatch(/Furnace.*heater.*heating unit/);
    // Air Conditioner + its colloquial names — "central air", "a/c", etc.
    expect(out).toMatch(/Air Conditioner.*air conditioner.*central air/);
    // Thermostat + smart-home synonyms.
    expect(out).toMatch(/Thermostat.*smart thermostat/);
  });

  it('lists service categories', () => {
    const pack = createHvacPack();
    const out = formatVerticalForCallerPrompt(pack);
    expect(out).toContain('Service types offered:');
    expect(out).toContain('Installation');
    expect(out).toContain('Repair');
    expect(out).toContain('Maintenance');
  });

  it('omits sections cleanly when terminology or categories are empty', () => {
    const pack = createHvacPack();
    const stripped = { ...pack, terminology: {}, categories: [] };
    const out = formatVerticalForCallerPrompt(stripped);
    expect(out).toContain('Service vertical: HVAC Professional');
    expect(out).not.toContain('Equipment and terminology recognized:');
    expect(out).not.toContain('Service types offered:');
  });

  it('handles a terminology entry with no aliases without producing dangling parens', () => {
    const pack = createHvacPack();
    const noAliases = {
      ...pack,
      terminology: {
        widget: { displayName: 'Widget', aliases: [], description: 'A widget' },
      },
    };
    const out = formatVerticalForCallerPrompt(noAliases);
    expect(out).toContain('  - Widget');
    expect(out).not.toContain('Widget ()');
  });
});
