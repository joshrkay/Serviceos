import {
  InMemoryWordingPreferenceRepository,
  captureWordingPreferences,
  validateWordingPreference,
} from '../../src/estimates/wording-preferences';

describe('P4-007A — Tenant wording preference capture', () => {
  let repo: InMemoryWordingPreferenceRepository;

  beforeEach(() => {
    repo = new InMemoryWordingPreferenceRepository();
  });

  it('happy path — captures wording preferences from diffs', () => {
    const prefs = captureWordingPreferences('t1', [
      { original: 'AC unit repair', revised: 'Air conditioning unit repair' },
      { original: 'Diagnostic fee', revised: 'System diagnostic charge' },
    ], 'hvac');

    expect(prefs).toHaveLength(2);
    expect(prefs[0].tenantId).toBe('t1');
    expect(prefs[0].verticalType).toBe('hvac');
  });

  it('happy path — skips identical pairs', () => {
    const prefs = captureWordingPreferences('t1', [
      { original: 'Same text', revised: 'Same text' },
    ]);
    expect(prefs).toHaveLength(0);
  });

  it('happy path — upserts preferences', async () => {
    const p1 = await repo.upsert('t1', 'ac repair', 'air conditioning repair', 'hvac');
    expect(p1.frequency).toBe(1);

    const p2 = await repo.upsert('t1', 'ac repair', 'air conditioning repair', 'hvac');
    expect(p2.frequency).toBe(2);
  });

  it('validation — rejects missing canonicalPhrase', () => {
    const errors = validateWordingPreference({ tenantId: 't1', canonicalPhrase: '', preferredPhrase: 'preferred' });
    expect(errors).toContain('canonicalPhrase is required');
  });

  it('validation — rejects same canonical and preferred', () => {
    const errors = validateWordingPreference({ tenantId: 't1', canonicalPhrase: 'same', preferredPhrase: 'same' });
    expect(errors).toContain('canonicalPhrase and preferredPhrase must differ');
  });
});
