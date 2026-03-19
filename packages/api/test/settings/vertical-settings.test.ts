import {
  InMemorySettingsRepository,
  createSettings,
  updateSettings,
  getSettings,
  validateSettingsInput,
  validateUpdateSettingsInput,
} from '../../src/settings/settings';

describe('P4-010A — Active vertical settings in tenant config', () => {
  let repo: InMemorySettingsRepository;

  beforeEach(() => {
    repo = new InMemorySettingsRepository();
  });

  it('happy path — creates settings with active vertical packs', async () => {
    const settings = await createSettings({
      tenantId: 't1',
      businessName: 'HVAC Pro',
      activeVerticalPacks: ['hvac-v1'],
    }, repo);

    expect(settings.activeVerticalPacks).toEqual(['hvac-v1']);
  });

  it('happy path — updates active packs', async () => {
    await createSettings({
      tenantId: 't1',
      businessName: 'Service Co',
    }, repo);

    const updated = await updateSettings('t1', {
      activeVerticalPacks: ['hvac-v1', 'plumbing-v1'],
    }, repo);

    expect(updated).not.toBeNull();
    expect(updated!.activeVerticalPacks).toEqual(['hvac-v1', 'plumbing-v1']);
  });

  it('happy path — retrieves settings with packs', async () => {
    await createSettings({
      tenantId: 't1',
      businessName: 'Service Co',
      activeVerticalPacks: ['plumbing-v1'],
    }, repo);

    const settings = await getSettings('t1', repo);
    expect(settings).not.toBeNull();
    expect(settings!.activeVerticalPacks).toEqual(['plumbing-v1']);
  });

  it('happy path — settings without packs default to undefined', async () => {
    await createSettings({
      tenantId: 't1',
      businessName: 'Service Co',
    }, repo);

    const settings = await getSettings('t1', repo);
    expect(settings!.activeVerticalPacks).toBeUndefined();
  });

  it('validation — can clear active packs', async () => {
    await createSettings({
      tenantId: 't1',
      businessName: 'Service Co',
      activeVerticalPacks: ['hvac-v1'],
    }, repo);

    const updated = await updateSettings('t1', {
      activeVerticalPacks: [],
    }, repo);

    expect(updated!.activeVerticalPacks).toEqual([]);
  });

  it('validation — rejects empty or whitespace-only pack IDs', () => {
    const errors = validateSettingsInput({
      tenantId: 't1',
      businessName: 'Service Co',
      activeVerticalPacks: ['hvac-v1', '   '],
    });

    expect(errors).toContain('activeVerticalPacks[1] must be a non-empty string');
  });

  it('validation — rejects duplicate pack IDs after normalization', () => {
    const errors = validateUpdateSettingsInput({
      activeVerticalPacks: [' HVAC-v1 ', 'hvac-v1'],
    });

    expect(errors).toContain('activeVerticalPacks contains duplicate pack ID: hvac-v1');
  });

  it('validation — accepts multi-pack configuration and normalizes IDs', async () => {
    await createSettings({
      tenantId: 't1',
      businessName: 'Service Co',
    }, repo);

    const updated = await updateSettings('t1', {
      activeVerticalPacks: [' HVAC-v1 ', 'Plumbing-V1'],
    }, repo);

    expect(updated!.activeVerticalPacks).toEqual(['hvac-v1', 'plumbing-v1']);
  });

  it('validation — updateSettings rejects invalid packs before persisting', async () => {
    await createSettings({
      tenantId: 't1',
      businessName: 'Service Co',
      activeVerticalPacks: ['hvac-v1'],
    }, repo);

    await expect(
      updateSettings('t1', {
        activeVerticalPacks: ['hvac-v1', ' HVAC-v1 '],
      }, repo)
    ).rejects.toThrow('activeVerticalPacks contains duplicate pack ID: hvac-v1');

    const settings = await getSettings('t1', repo);
    expect(settings!.activeVerticalPacks).toEqual(['hvac-v1']);
  });

  it('validation — supports constraining pack IDs to known values', () => {
    const errors = validateUpdateSettingsInput(
      { activeVerticalPacks: ['hvac-v1', 'electrical-v1'] },
      { knownPackIds: ['hvac-v1', 'plumbing-v1'] }
    );

    expect(errors).toContain('activeVerticalPacks contains unknown pack ID: electrical-v1');
  });
});
