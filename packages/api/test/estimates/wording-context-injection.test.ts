import {
  InMemoryWordingPreferenceRepository,
  getWordingContext,
} from '../../src/estimates/wording-preferences';

describe('P4-007B — Wording preference context injection', () => {
  let repo: InMemoryWordingPreferenceRepository;

  beforeEach(async () => {
    repo = new InMemoryWordingPreferenceRepository();
    await repo.upsert('t1', 'ac repair', 'air conditioning repair', 'hvac');
    await repo.upsert('t1', 'diag fee', 'diagnostic service fee', 'hvac');
    await repo.upsert('t1', 'pipe fix', 'pipe repair', 'plumbing');
  });

  it('happy path — returns wording context for tenant', async () => {
    const context = await getWordingContext('t1', undefined, repo);
    expect(context.preferences).toHaveLength(3);
    expect(context.preferences[0]).toHaveProperty('from');
    expect(context.preferences[0]).toHaveProperty('to');
  });

  it('happy path — filters by vertical type', async () => {
    const context = await getWordingContext('t1', 'hvac', repo);
    expect(context.preferences).toHaveLength(2);
    expect(context.preferences.every((p) => p.from !== 'pipe fix')).toBe(true);
  });

  it('edge case — empty preferences returns empty array', async () => {
    const context = await getWordingContext('t-empty', undefined, repo);
    expect(context.preferences).toHaveLength(0);
  });

  it('happy path — compact format for prompt injection', async () => {
    const context = await getWordingContext('t1', 'hvac', repo);
    for (const pref of context.preferences) {
      expect(typeof pref.from).toBe('string');
      expect(typeof pref.to).toBe('string');
    }
  });
});
