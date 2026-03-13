import {
  InMemorySettingsRepository,
  createSettings,
  updateTerminologyPreferences,
  validateTerminologyPreferences,
} from '../../src/settings/settings';

describe('P4-010B — Terminology preference controls', () => {
  let repo: InMemorySettingsRepository;

  beforeEach(async () => {
    repo = new InMemorySettingsRepository();
    await createSettings({
      tenantId: 't1',
      businessName: 'HVAC Pro',
      activeVerticalPacks: ['hvac-v1'],
    }, repo);
  });

  it('happy path — updates terminology preferences', async () => {
    const updated = await updateTerminologyPreferences('t1', {
      furnace: 'Heating Unit',
      ac_unit: 'Cooling System',
    }, repo);

    expect(updated).not.toBeNull();
    expect(updated!.terminologyPreferences).toEqual({
      furnace: 'Heating Unit',
      ac_unit: 'Cooling System',
    });
  });

  it('happy path — validates terminology preferences', () => {
    const errors = validateTerminologyPreferences({
      furnace: 'Heating Unit',
    });
    expect(errors).toHaveLength(0);
  });

  it('validation — rejects empty value', () => {
    const errors = validateTerminologyPreferences({
      furnace: '',
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('validation — rejects unrecognized key when validKeys provided', () => {
    const errors = validateTerminologyPreferences(
      { unknown_term: 'Some value' },
      ['furnace', 'ac_unit', 'thermostat']
    );
    expect(errors).toContain('terminologyPreferences key "unknown_term" is not a recognized term for the active vertical');
  });

  it('validation — accepts recognized keys', () => {
    const errors = validateTerminologyPreferences(
      { furnace: 'Heater', ac_unit: 'Air Conditioner' },
      ['furnace', 'ac_unit', 'thermostat']
    );
    expect(errors).toHaveLength(0);
  });

  it('happy path — overrides previous preferences', async () => {
    await updateTerminologyPreferences('t1', { furnace: 'Heater' }, repo);
    const updated = await updateTerminologyPreferences('t1', { ac_unit: 'Cooler' }, repo);

    expect(updated!.terminologyPreferences).toEqual({ ac_unit: 'Cooler' });
  });
});
