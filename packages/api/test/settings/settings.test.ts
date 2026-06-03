import {
  createSettings,
  getSettings,
  updateSettings,
  getNextEstimateNumber,
  getNextInvoiceNumber,
  validateSettingsInput,
  ensureTenantSettings,
  InMemorySettingsRepository,
} from '../../src/settings/settings';

describe('P1-017 — Tenant business settings and numbering preferences', () => {
  let repo: InMemorySettingsRepository;

  beforeEach(() => {
    repo = new InMemorySettingsRepository();
  });

  it('happy path — creates settings with defaults', async () => {
    const settings = await createSettings(
      { tenantId: 'tenant-1', businessName: 'ACME HVAC' },
      repo
    );

    expect(settings.id).toBeTruthy();
    expect(settings.tenantId).toBe('tenant-1');
    expect(settings.businessName).toBe('ACME HVAC');
    expect(settings.timezone).toBe('America/New_York');
    expect(settings.estimatePrefix).toBe('EST-');
    expect(settings.invoicePrefix).toBe('INV-');
    expect(settings.nextEstimateNumber).toBe(1);
    expect(settings.nextInvoiceNumber).toBe(1);
    expect(settings.defaultPaymentTermDays).toBe(30);
    // P11-002 — language stack seeded with safe defaults.
    expect(settings.defaultLanguage).toBe('en');
    expect(settings.autoDetectLanguage).toBe(true);
  });

  it('P11-002 — persists language settings end-to-end', async () => {
    await createSettings({ tenantId: 'tenant-lang', businessName: 'Bilingual Co' }, repo);
    const updated = await updateSettings(
      'tenant-lang',
      {
        defaultLanguage: 'es',
        autoDetectLanguage: false,
        ttsVoiceEs: 'Polly.Lupe',
        spanishDispatcherUserIds: ['11111111-1111-1111-1111-111111111111'],
      },
      repo,
    );
    expect(updated?.defaultLanguage).toBe('es');
    expect(updated?.autoDetectLanguage).toBe(false);
    expect(updated?.ttsVoiceEs).toBe('Polly.Lupe');
    expect(updated?.spanishDispatcherUserIds).toEqual([
      '11111111-1111-1111-1111-111111111111',
    ]);

    const reread = await getSettings('tenant-lang', repo);
    expect(reread?.defaultLanguage).toBe('es');
    expect(reread?.autoDetectLanguage).toBe(false);
  });

  it('happy path — creates settings with custom values', async () => {
    const settings = await createSettings(
      {
        tenantId: 'tenant-1',
        businessName: 'Pro Plumbing',
        timezone: 'America/Chicago',
        estimatePrefix: 'Q-',
        invoicePrefix: 'I-',
        defaultPaymentTermDays: 15,
      },
      repo
    );

    expect(settings.timezone).toBe('America/Chicago');
    expect(settings.estimatePrefix).toBe('Q-');
    expect(settings.invoicePrefix).toBe('I-');
    expect(settings.defaultPaymentTermDays).toBe(15);
  });

  it('happy path — retrieves settings by tenant', async () => {
    await createSettings({ tenantId: 'tenant-1', businessName: 'ACME' }, repo);
    const found = await getSettings('tenant-1', repo);
    expect(found).not.toBeNull();
    expect(found!.businessName).toBe('ACME');
  });

  it('happy path — updates settings', async () => {
    await createSettings({ tenantId: 'tenant-1', businessName: 'ACME' }, repo);
    const updated = await updateSettings('tenant-1', { businessName: 'ACME Pro' }, repo);
    expect(updated!.businessName).toBe('ACME Pro');
  });

  it('happy path — generates sequential estimate numbers', async () => {
    await createSettings({ tenantId: 'tenant-1', businessName: 'ACME' }, repo);

    const num1 = await getNextEstimateNumber('tenant-1', repo);
    const num2 = await getNextEstimateNumber('tenant-1', repo);
    const num3 = await getNextEstimateNumber('tenant-1', repo);

    expect(num1).toBe('EST-0001');
    expect(num2).toBe('EST-0002');
    expect(num3).toBe('EST-0003');
  });

  it('happy path — generates sequential invoice numbers', async () => {
    await createSettings(
      { tenantId: 'tenant-1', businessName: 'ACME', invoicePrefix: 'INV-' },
      repo
    );

    const num1 = await getNextInvoiceNumber('tenant-1', repo);
    const num2 = await getNextInvoiceNumber('tenant-1', repo);

    expect(num1).toBe('INV-0001');
    expect(num2).toBe('INV-0002');
  });

  it('validation — rejects missing businessName', () => {
    const errors = validateSettingsInput({ tenantId: 'tenant-1', businessName: '' });
    expect(errors).toContain('businessName is required');
  });

  it('validation — rejects missing tenantId', () => {
    const errors = validateSettingsInput({ tenantId: '', businessName: 'ACME' });
    expect(errors).toContain('tenantId is required');
  });

  it('validation — rejects invalid timezone', () => {
    const errors = validateSettingsInput({
      tenantId: 'tenant-1',
      businessName: 'ACME',
      timezone: 'Invalid/Zone',
    });
    expect(errors).toContain('Invalid timezone');
  });

  it('validation — rejects empty prefix', () => {
    const errors = validateSettingsInput({
      tenantId: 'tenant-1',
      businessName: 'ACME',
      estimatePrefix: '',
    });
    expect(errors).toContain('estimatePrefix cannot be empty');
  });

  it('validation — rejects negative payment terms', () => {
    const errors = validateSettingsInput({
      tenantId: 'tenant-1',
      businessName: 'ACME',
      defaultPaymentTermDays: -1,
    });
    expect(errors).toContain('defaultPaymentTermDays must be non-negative');
  });

  it('validation — createSettings surfaces validator errors', async () => {
    await expect(
      createSettings(
        { tenantId: 'tenant-1', businessName: 'ACME', timezone: 'Invalid/Zone' },
        repo
      )
    ).rejects.toThrow('Validation failed: Invalid timezone');
  });

  it('tenant isolation — settings are tenant-scoped', async () => {
    await createSettings({ tenantId: 'tenant-1', businessName: 'ACME' }, repo);
    await createSettings({ tenantId: 'tenant-2', businessName: 'Beta Co' }, repo);

    const s1 = await getSettings('tenant-1', repo);
    const s2 = await getSettings('tenant-2', repo);

    expect(s1!.businessName).toBe('ACME');
    expect(s2!.businessName).toBe('Beta Co');
  });

  it('prevents duplicate settings for same tenant', async () => {
    await createSettings({ tenantId: 'tenant-1', businessName: 'ACME' }, repo);
    await expect(
      createSettings({ tenantId: 'tenant-1', businessName: 'Duplicate' }, repo)
    ).rejects.toThrow('Settings already exist');
  });

  describe('onboarding-blocker fix — ensureTenantSettings seeds aiModel', () => {
    const ORIGINAL_DEFAULT_MODEL = process.env.AI_DEFAULT_MODEL;

    afterEach(() => {
      if (ORIGINAL_DEFAULT_MODEL === undefined) {
        delete process.env.AI_DEFAULT_MODEL;
      } else {
        process.env.AI_DEFAULT_MODEL = ORIGINAL_DEFAULT_MODEL;
      }
    });

    it('writes a non-null aiModel for a fresh tenant (env default wins)', async () => {
      process.env.AI_DEFAULT_MODEL = 'gpt-4o-mini-test';

      const settings = await ensureTenantSettings('tenant-new', repo, {
        businessName: 'Fresh Co',
      });

      expect(settings.aiModel).toBe('gpt-4o-mini-test');
      // Sanity: the row that lands in the repo carries the same value so
      // the onboarding "AI check" step finds aiConfigPresent === true.
      const reread = await getSettings('tenant-new', repo);
      expect(reread?.aiModel).toBe('gpt-4o-mini-test');
    });

    it('falls back to a hardcoded default when AI_DEFAULT_MODEL is unset', async () => {
      delete process.env.AI_DEFAULT_MODEL;

      const settings = await ensureTenantSettings('tenant-no-env', repo);

      expect(settings.aiModel).toBe('gpt-4o-mini');
      expect(settings.aiModel).not.toBeNull();
    });

    it('never overwrites an existing tenant override on idempotent re-call', async () => {
      // Seed with a different model than what AI_DEFAULT_MODEL would yield.
      process.env.AI_DEFAULT_MODEL = 'platform-default-now';
      await createSettings({ tenantId: 'tenant-override', businessName: 'X' }, repo);
      await updateSettings('tenant-override', { aiModel: 'tenant-pinned-model' }, repo);

      // Change AI_DEFAULT_MODEL to prove ensureTenantSettings does not re-seed.
      process.env.AI_DEFAULT_MODEL = 'new-platform-default';
      const second = await ensureTenantSettings('tenant-override', repo);

      expect(second.aiModel).toBe('tenant-pinned-model');
    });
  });
});
