import {
  createWordingPreference,
  applyWordingPreferences,
  getWordingGuidelinesForPrompt,
  validateWordingPreferenceInput,
  InMemoryWordingPreferenceRepository,
} from '../../src/verticals/wording-preferences';

describe('P4-007 — Wording Preferences', () => {
  let repo: InMemoryWordingPreferenceRepository;

  beforeEach(() => {
    repo = new InMemoryWordingPreferenceRepository();
  });

  it('happy path — creates wording preference', async () => {
    const pref = await createWordingPreference(
      {
        tenantId: 'tenant-1',
        scope: 'line_item_description',
        key: 'labor_description',
        preferredWording: 'Service Labor',
        avoidWordings: ['Work', 'Labor hours'],
      },
      repo
    );

    expect(pref.id).toBeTruthy();
    expect(pref.preferredWording).toBe('Service Labor');
    expect(pref.avoidWordings).toContain('Work');
  });

  it('validates required fields', () => {
    expect(validateWordingPreferenceInput({
      tenantId: '',
      scope: 'line_item_description',
      key: 'test',
      preferredWording: 'Test',
    })).toContain('tenantId is required');

    expect(validateWordingPreferenceInput({
      tenantId: 't-1',
      scope: 'invalid' as any,
      key: 'test',
      preferredWording: 'Test',
    })).toContain('invalid scope');
  });

  it('applies wording preferences to text', async () => {
    const pref1 = await createWordingPreference(
      {
        tenantId: 'tenant-1',
        scope: 'line_item_description',
        key: 'labor',
        preferredWording: 'Service Labor',
        avoidWordings: ['Labor hours', 'work hours'],
      },
      repo
    );

    const prefs = await repo.findByTenant('tenant-1');
    const result = applyWordingPreferences('Labor hours for AC repair', prefs);
    expect(result).toBe('Service Labor for AC repair');
  });

  it('applies wording case-insensitively', async () => {
    await createWordingPreference(
      {
        tenantId: 'tenant-1',
        scope: 'line_item_description',
        key: 'unit',
        preferredWording: 'system',
        avoidWordings: ['unit'],
      },
      repo
    );

    const prefs = await repo.findByTenant('tenant-1');
    const result = applyWordingPreferences('Replace the UNIT', prefs);
    expect(result).toBe('Replace the system');
  });

  it('generates prompt guidelines', async () => {
    await createWordingPreference(
      {
        tenantId: 'tenant-1',
        scope: 'line_item_description',
        key: 'labor',
        preferredWording: 'Service Labor',
        avoidWordings: ['Work', 'Manpower'],
      },
      repo
    );

    const prefs = await repo.findByTenant('tenant-1');
    const guidelines = getWordingGuidelinesForPrompt(prefs, 'line_item_description');
    expect(guidelines).toContain('Service Labor');
    expect(guidelines).toContain('Work');
    expect(guidelines).toContain('Manpower');
  });

  it('filters by scope', async () => {
    await createWordingPreference(
      { tenantId: 'tenant-1', scope: 'line_item_description', key: 'labor', preferredWording: 'Labor' },
      repo
    );
    await createWordingPreference(
      { tenantId: 'tenant-1', scope: 'customer_message', key: 'greeting', preferredWording: 'Hello' },
      repo
    );

    const lineItemPrefs = await repo.findByScope('tenant-1', 'line_item_description');
    expect(lineItemPrefs).toHaveLength(1);
  });

  it('tenant isolation — cannot find other tenant preferences', async () => {
    await createWordingPreference(
      { tenantId: 'tenant-1', scope: 'line_item_description', key: 'k', preferredWording: 'v' },
      repo
    );
    const found = await repo.findByTenant('other-tenant');
    expect(found).toHaveLength(0);
  });

  it('deletes wording preference', async () => {
    const pref = await createWordingPreference(
      { tenantId: 'tenant-1', scope: 'line_item_description', key: 'k', preferredWording: 'v' },
      repo
    );
    const deleted = await repo.delete('tenant-1', pref.id);
    expect(deleted).toBe(true);
    const found = await repo.findById('tenant-1', pref.id);
    expect(found).toBeNull();
  });
});
