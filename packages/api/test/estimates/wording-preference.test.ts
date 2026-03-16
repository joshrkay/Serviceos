import {
  createWordingPreference,
  findMatchingPreference,
  learnWordingFromEdits,
  validateWordingPreferenceInput,
  InMemoryWordingPreferenceRepository,
} from '../../src/estimates/wording-preference';
import { buildLineItem } from '../../src/shared/billing-engine';

describe('P4-007A — Tenant wording preference capture', () => {
  it('happy path — creates wording preference', () => {
    const pref = createWordingPreference({
      tenantId: 'tenant-1',
      verticalSlug: 'hvac',
      originalPhrase: 'AC unit',
      preferredPhrase: 'air conditioning system',
      source: 'manual',
    });
    expect(pref.id).toBeTruthy();
    expect(pref.occurrenceCount).toBe(1);
    expect(pref.source).toBe('manual');
  });

  it('happy path — findMatchingPreference finds match', () => {
    const prefs = [
      createWordingPreference({ tenantId: 't', verticalSlug: 'v', originalPhrase: 'AC unit', preferredPhrase: 'air conditioning system', source: 'manual' }),
    ];
    const match = findMatchingPreference('Replace AC unit on roof', prefs);
    expect(match).not.toBeNull();
    expect(match!.preferredPhrase).toBe('air conditioning system');
  });

  it('happy path — learnWordingFromEdits detects changes', () => {
    const original = [buildLineItem('1', 'Fix AC unit', 1, 10000, 1, true)];
    const edited = [buildLineItem('1', 'Repair air conditioning system', 1, 10000, 1, true)];
    const prefs = learnWordingFromEdits(original, edited, 'tenant-1', 'hvac');
    expect(prefs).toHaveLength(1);
    expect(prefs[0].originalPhrase).toBe('Fix AC unit');
    expect(prefs[0].preferredPhrase).toBe('Repair air conditioning system');
    expect(prefs[0].source).toBe('learned');
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateWordingPreferenceInput({
      tenantId: '',
      verticalSlug: '',
      originalPhrase: '',
      preferredPhrase: '',
      source: '' as any,
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('verticalSlug is required');
    expect(errors).toContain('originalPhrase is required');
    expect(errors).toContain('preferredPhrase is required');
    expect(errors).toContain('source is required');
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryWordingPreferenceRepository();
    const pref = createWordingPreference({ tenantId: 'tenant-1', verticalSlug: 'hvac', originalPhrase: 'AC', preferredPhrase: 'Air Conditioning', source: 'manual' });
    await repo.create(pref);

    const found = await repo.findByVertical('tenant-1', 'hvac');
    expect(found).toHaveLength(1);
  });

  it('mock provider test — repository isolates tenants', async () => {
    const repo = new InMemoryWordingPreferenceRepository();
    const pref = createWordingPreference({ tenantId: 'tenant-1', verticalSlug: 'hvac', originalPhrase: 'AC', preferredPhrase: 'Air Conditioning', source: 'manual' });
    await repo.create(pref);

    const found = await repo.findByTenant('other-tenant');
    expect(found).toHaveLength(0);
  });

  it('malformed AI output handled gracefully — no matching preference', () => {
    const result = findMatchingPreference('Completely different text', []);
    expect(result).toBeNull();
  });
});
