import {
  loadPackConfig,
  loadActivePackConfigs,
  validatePackConfig,
} from '../../src/shared/pack-config-loader';
import { InMemoryVerticalPackRegistry, registerPack, activatePackStatus } from '../../src/shared/vertical-pack-registry';
import { InMemoryPackActivationRepository, activatePack } from '../../src/settings/pack-activation';

describe('P4-001C — Vertical pack config loading', () => {
  let registry: InMemoryVerticalPackRegistry;
  let activationRepo: InMemoryPackActivationRepository;

  beforeEach(async () => {
    registry = new InMemoryVerticalPackRegistry();
    activationRepo = new InMemoryPackActivationRepository();
  });

  async function registerAndActivateHvac(): Promise<string> {
    const pack = await registerPack({
      packId: 'hvac-v1',
      version: '1.0.0',
      verticalType: 'hvac',
      displayName: 'HVAC Pack',
    }, registry);
    await activatePackStatus(pack.id, registry);
    return pack.packId;
  }

  async function registerAndActivatePlumbing(): Promise<string> {
    const pack = await registerPack({
      packId: 'plumbing-v1',
      version: '1.0.0',
      verticalType: 'plumbing',
      displayName: 'Plumbing Pack',
    }, registry);
    await activatePackStatus(pack.id, registry);
    return pack.packId;
  }

  it('happy path — loads HVAC config with terminology, categories, templates, and intake config', async () => {
    await registerAndActivateHvac();

    const config = await loadPackConfig('hvac-v1', registry);
    expect(config).not.toBeNull();
    expect(config!.verticalType).toBe('hvac');
    expect(config!.packId).toBe('hvac-v1');
    expect(Object.keys(config!.terminology).length).toBeGreaterThan(0);
    expect(config!.terminology.furnace).toBeDefined();
    expect(config!.categories.length).toBeGreaterThan(0);
    expect(config!.categories.find((c) => c.id === 'diagnostic')).toBeDefined();
    expect(config!.templates.length).toBeGreaterThan(0);
    expect(config!.templates[0].lineItems.length).toBeGreaterThan(0);
    expect(config!.intakeConfig.questions.length).toBeGreaterThan(0);
    expect(config!.intakeConfig.questions.some((q) => q.required)).toBe(true);
  });

  it('happy path — loads plumbing config with terminology and categories', async () => {
    await registerAndActivatePlumbing();

    const config = await loadPackConfig('plumbing-v1', registry);
    expect(config).not.toBeNull();
    expect(config!.verticalType).toBe('plumbing');
    expect(config!.terminology.pipe).toBeDefined();
    expect(config!.categories.find((c) => c.id === 'drain')).toBeDefined();
  });

  it('happy path — loads active pack configs for tenant', async () => {
    await registerAndActivateHvac();
    await registerAndActivatePlumbing();
    await activatePack({ tenantId: 't1', packId: 'hvac-v1' }, activationRepo);
    await activatePack({ tenantId: 't1', packId: 'plumbing-v1' }, activationRepo);

    const configs = await loadActivePackConfigs('t1', activationRepo, registry);
    expect(configs).toHaveLength(2);
    expect(configs.map((c) => c.verticalType).sort()).toEqual(['hvac', 'plumbing']);
  });

  it('validation — inactive pack returns null', async () => {
    await registerPack({
      packId: 'hvac-draft',
      version: '0.1.0',
      verticalType: 'hvac',
      displayName: 'Draft HVAC',
    }, registry);

    const config = await loadPackConfig('hvac-draft', registry);
    expect(config).toBeNull();
  });

  it('validation — unknown pack returns null', async () => {
    const config = await loadPackConfig('nonexistent', registry);
    expect(config).toBeNull();
  });

  it('validation — validates pack config', () => {
    const errors = validatePackConfig({
      verticalType: 'hvac',
      packId: 'hvac-v1',
      version: '1.0.0',
      terminology: { test: { canonical: 'test', displayLabel: 'Test', promptHint: 'test', aliases: [] } },
      categories: [{ id: 'diagnostic', name: 'Diag', description: 'Diag', sortOrder: 1, typicalLineItems: ['x'] }],
      templates: [
        {
          id: 'tmpl-1',
          name: 'Template',
          categoryId: 'diagnostic',
          lineItems: [{ description: 'Diagnostic fee', unitPriceCents: 8900 }],
        },
      ],
      intakeConfig: {
        questions: [{ id: 'problemSummary', label: 'Describe issue', inputType: 'multiline', required: true }],
      },
    });
    expect(errors).toHaveLength(0);
  });

  it('validation — rejects empty terminology', () => {
    const errors = validatePackConfig({
      verticalType: 'hvac',
      packId: 'test',
      version: '1.0.0',
      terminology: {},
      categories: [{ id: 'diagnostic', name: 'Diag', description: 'Diag', sortOrder: 1, typicalLineItems: ['x'] }],
      templates: [
        {
          id: 'tmpl-1',
          name: 'Template',
          categoryId: 'diagnostic',
          lineItems: [{ description: 'Diagnostic fee', unitPriceCents: 8900 }],
        },
      ],
      intakeConfig: {
        questions: [{ id: 'problemSummary', label: 'Describe issue', inputType: 'multiline', required: true }],
      },
    });
    expect(errors).toContain('terminology must not be empty');
  });

  it('validation — rejects empty categories', () => {
    const errors = validatePackConfig({
      verticalType: 'hvac',
      packId: 'test',
      version: '1.0.0',
      terminology: { test: { canonical: 'test', displayLabel: 'Test', promptHint: 'test', aliases: [] } },
      categories: [],
      templates: [
        {
          id: 'tmpl-1',
          name: 'Template',
          categoryId: 'diagnostic',
          lineItems: [{ description: 'Diagnostic fee', unitPriceCents: 8900 }],
        },
      ],
      intakeConfig: {
        questions: [{ id: 'problemSummary', label: 'Describe issue', inputType: 'multiline', required: true }],
      },
    });
    expect(errors).toContain('categories must not be empty');
  });

  it('validation — rejects missing templates', () => {
    const errors = validatePackConfig({
      verticalType: 'hvac',
      packId: 'test',
      version: '1.0.0',
      terminology: { test: { canonical: 'test', displayLabel: 'Test', promptHint: 'test', aliases: [] } },
      categories: [{ id: 'diagnostic', name: 'Diag', description: 'Diag', sortOrder: 1, typicalLineItems: ['x'] }],
      templates: [],
      intakeConfig: {
        questions: [{ id: 'problemSummary', label: 'Describe issue', inputType: 'multiline', required: true }],
      },
    });
    expect(errors).toContain('templates must not be empty');
  });

  it('validation — rejects invalid intake config', () => {
    const errors = validatePackConfig({
      verticalType: 'hvac',
      packId: 'test',
      version: '1.0.0',
      terminology: { test: { canonical: 'test', displayLabel: 'Test', promptHint: 'test', aliases: [] } },
      categories: [{ id: 'diagnostic', name: 'Diag', description: 'Diag', sortOrder: 1, typicalLineItems: ['x'] }],
      templates: [
        {
          id: 'tmpl-1',
          name: 'Template',
          categoryId: 'diagnostic',
          lineItems: [{ description: 'Diagnostic fee', unitPriceCents: 8900 }],
        },
      ],
      intakeConfig: {
        questions: [{ id: 'urgency', label: 'Urgency', inputType: 'select', required: true, options: [] }],
      },
    });
    expect(errors).toContain('intakeConfig question "urgency" select options must not be empty');
  });

  it('edge case — both packs load independently', async () => {
    await registerAndActivateHvac();
    await registerAndActivatePlumbing();

    const hvac = await loadPackConfig('hvac-v1', registry);
    const plumbing = await loadPackConfig('plumbing-v1', registry);

    expect(hvac!.terminology.furnace).toBeDefined();
    expect(hvac!.terminology.pipe).toBeUndefined();

    expect(plumbing!.terminology.pipe).toBeDefined();
    expect(plumbing!.terminology.furnace).toBeUndefined();
  });
});
