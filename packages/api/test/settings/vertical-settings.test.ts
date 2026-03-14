import {
  InMemorySettingsRepository,
  createSettings,
  updateSettings,
  getSettings,
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
});
