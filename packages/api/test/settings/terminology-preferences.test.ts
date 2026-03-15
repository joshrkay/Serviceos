import { applyTerminologyPreferences, getTerminologyPreferences, validateTerminologyPreferenceUpdate } from '../../src/settings/terminology-preferences';
import { createWordingPreference, InMemoryWordingPreferenceRepository } from '../../src/estimates/wording-preference';

describe('P4-010B — Terminology preference controls', () => {
  it('happy path — applies new preferences', async () => {
    const repo = new InMemoryWordingPreferenceRepository();
    const results = await applyTerminologyPreferences({
      tenantId: 'tenant-1',
      verticalSlug: 'hvac',
      preferences: [
        { originalPhrase: 'AC unit', preferredPhrase: 'air conditioning system' },
      ],
    }, repo);
    expect(results).toHaveLength(1);
    expect(results[0].preferredPhrase).toBe('air conditioning system');
  });

  it('happy path — updates existing preference', async () => {
    const repo = new InMemoryWordingPreferenceRepository();
    const existing = createWordingPreference({ tenantId: 'tenant-1', verticalSlug: 'hvac', originalPhrase: 'AC unit', preferredPhrase: 'old phrase', source: 'manual' });
    await repo.create(existing);

    const results = await applyTerminologyPreferences({
      tenantId: 'tenant-1',
      verticalSlug: 'hvac',
      preferences: [{ originalPhrase: 'AC unit', preferredPhrase: 'new phrase' }],
    }, repo);
    expect(results[0].preferredPhrase).toBe('new phrase');
    expect(results[0].occurrenceCount).toBe(2);
  });

  it('validation — rejects invalid input', () => {
    const errors = validateTerminologyPreferenceUpdate({
      tenantId: '',
      verticalSlug: '',
      preferences: [{ originalPhrase: '', preferredPhrase: '' }],
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('verticalSlug is required');
    expect(errors).toContain('each preference must have an originalPhrase');
    expect(errors).toContain('each preference must have a preferredPhrase');
  });

  it('mock provider test — getTerminologyPreferences retrieves by vertical', async () => {
    const repo = new InMemoryWordingPreferenceRepository();
    const pref = createWordingPreference({ tenantId: 'tenant-1', verticalSlug: 'hvac', originalPhrase: 'AC', preferredPhrase: 'Air Conditioning', source: 'manual' });
    await repo.create(pref);

    const found = await getTerminologyPreferences('tenant-1', 'hvac', repo);
    expect(found).toHaveLength(1);
  });

  it('malformed AI output handled gracefully — empty preferences array', async () => {
    const repo = new InMemoryWordingPreferenceRepository();
    const results = await applyTerminologyPreferences({ tenantId: 't', verticalSlug: 'v', preferences: [] }, repo);
    expect(results).toEqual([]);
  });
});
