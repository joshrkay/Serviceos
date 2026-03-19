import {
  createSettings,
  getSettings,
  updateSettings,
  getNextEstimateNumber,
  getNextInvoiceNumber,
  validateSettingsInput,
  InMemorySettingsRepository,
} from '../../src/settings/settings';
import { ValidationError } from '../../src/shared/errors';

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

  it('validation — write path rejects missing businessName with structured errors', async () => {
    await expect(createSettings({ tenantId: 'tenant-1', businessName: '' }, repo)).rejects.toMatchObject({
      name: 'ValidationError',
      message: 'Invalid settings input',
      details: { errors: ['businessName is required'] },
    } satisfies Partial<ValidationError>);
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
});
