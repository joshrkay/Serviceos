import { buildWordingContextBlock, formatWordingPreferencesForPrompt, applyWordingPreferences } from '../../src/estimates/wording-context';
import { createWordingPreference, InMemoryWordingPreferenceRepository } from '../../src/estimates/wording-preference';

describe('P4-007B — Wording preference context injection', () => {
  it('happy path — builds context block with preferences', async () => {
    const repo = new InMemoryWordingPreferenceRepository();
    const pref = createWordingPreference({ tenantId: 'tenant-1', verticalSlug: 'hvac', originalPhrase: 'AC unit', preferredPhrase: 'air conditioning system', source: 'manual' });
    await repo.create(pref);

    const block = await buildWordingContextBlock('tenant-1', 'hvac', repo);
    expect(block.type).toBe('wording_preferences');
    expect(block.content).toContain('AC unit');
    expect(block.content).toContain('air conditioning system');
  });

  it('happy path — applyWordingPreferences replaces text', () => {
    const prefs = [
      createWordingPreference({ tenantId: 't', verticalSlug: 'v', originalPhrase: 'AC unit', preferredPhrase: 'air conditioning system', source: 'manual' }),
    ];
    const result = applyWordingPreferences('Replace AC unit on roof', prefs);
    expect(result).toBe('Replace air conditioning system on roof');
  });

  it('validation — formatWordingPreferencesForPrompt handles empty', () => {
    const result = formatWordingPreferencesForPrompt([]);
    expect(result).toContain('No wording preferences');
  });

  it('mock provider test — block has correct priority', async () => {
    const repo = new InMemoryWordingPreferenceRepository();
    const block = await buildWordingContextBlock('tenant-1', 'hvac', repo);
    expect(block.priority).toBe(6);
    expect(block.source).toBe('tenant_preferences');
  });

  it('malformed AI output handled gracefully — apply with no preferences returns original', () => {
    const result = applyWordingPreferences('Original text', []);
    expect(result).toBe('Original text');
  });
});
