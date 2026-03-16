import { PLUMBING_TERMINOLOGY, validateTerminologyMap } from '../../src/verticals/plumbing/terminology';

describe('P4-003A — Plumbing terminology map', () => {
  it('happy path — plumbing terminology has expected component entries', () => {
    expect(PLUMBING_TERMINOLOGY.pipe).toBeDefined();
    expect(PLUMBING_TERMINOLOGY.fitting).toBeDefined();
    expect(PLUMBING_TERMINOLOGY.valve).toBeDefined();
    expect(PLUMBING_TERMINOLOGY.fixture).toBeDefined();
    expect(PLUMBING_TERMINOLOGY.drain).toBeDefined();
    expect(PLUMBING_TERMINOLOGY.sewer).toBeDefined();
    expect(PLUMBING_TERMINOLOGY.water_heater).toBeDefined();
    expect(PLUMBING_TERMINOLOGY.sump_pump).toBeDefined();
    expect(PLUMBING_TERMINOLOGY.backflow_preventer).toBeDefined();
  });

  it('happy path — plumbing terminology has action entries', () => {
    expect(PLUMBING_TERMINOLOGY.diagnostic).toBeDefined();
    expect(PLUMBING_TERMINOLOGY.repair).toBeDefined();
    expect(PLUMBING_TERMINOLOGY.install).toBeDefined();
    expect(PLUMBING_TERMINOLOGY.replacement).toBeDefined();
  });

  it('happy path — plumbing terminology has qualifier entries', () => {
    expect(PLUMBING_TERMINOLOGY.emergency).toBeDefined();
    expect(PLUMBING_TERMINOLOGY.warranty).toBeDefined();
  });

  it('happy path — each entry has all required fields', () => {
    for (const [key, entry] of Object.entries(PLUMBING_TERMINOLOGY)) {
      expect(entry.canonical).toBeTruthy();
      expect(entry.displayLabel).toBeTruthy();
      expect(entry.promptHint).toBeTruthy();
      expect(Array.isArray(entry.aliases)).toBe(true);
      expect(entry.aliases.length).toBeGreaterThan(0);
    }
  });

  it('happy path — validates the plumbing terminology map', () => {
    const errors = validateTerminologyMap(PLUMBING_TERMINOLOGY);
    expect(errors).toHaveLength(0);
  });

  it('validation — rejects empty terminology map', () => {
    const errors = validateTerminologyMap({});
    expect(errors).toContain('Terminology map must have at least one entry');
  });

  it('validation — rejects entry missing promptHint', () => {
    const errors = validateTerminologyMap({
      test: { canonical: 'test', displayLabel: 'Test', promptHint: '', aliases: ['t'] },
    });
    expect(errors).toContain('Entry "test" is missing promptHint');
  });
});
