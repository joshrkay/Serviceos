import { HVAC_TERMINOLOGY, validateTerminologyMap } from '../../src/verticals/hvac/terminology';

describe('P4-002A — HVAC terminology map', () => {
  it('happy path — HVAC terminology has expected equipment entries', () => {
    expect(HVAC_TERMINOLOGY.furnace).toBeDefined();
    expect(HVAC_TERMINOLOGY.ac_unit).toBeDefined();
    expect(HVAC_TERMINOLOGY.heat_pump).toBeDefined();
    expect(HVAC_TERMINOLOGY.ductwork).toBeDefined();
    expect(HVAC_TERMINOLOGY.thermostat).toBeDefined();
    expect(HVAC_TERMINOLOGY.compressor).toBeDefined();
    expect(HVAC_TERMINOLOGY.condenser).toBeDefined();
    expect(HVAC_TERMINOLOGY.evaporator_coil).toBeDefined();
  });

  it('happy path — HVAC terminology has action entries', () => {
    expect(HVAC_TERMINOLOGY.diagnostic).toBeDefined();
    expect(HVAC_TERMINOLOGY.repair).toBeDefined();
    expect(HVAC_TERMINOLOGY.maintenance).toBeDefined();
    expect(HVAC_TERMINOLOGY.install).toBeDefined();
    expect(HVAC_TERMINOLOGY.replacement).toBeDefined();
  });

  it('happy path — HVAC terminology has qualifier entries', () => {
    expect(HVAC_TERMINOLOGY.emergency).toBeDefined();
    expect(HVAC_TERMINOLOGY.seasonal).toBeDefined();
    expect(HVAC_TERMINOLOGY.warranty).toBeDefined();
  });

  it('happy path — each entry has all required fields', () => {
    for (const [key, entry] of Object.entries(HVAC_TERMINOLOGY)) {
      expect(entry.canonical).toBeTruthy();
      expect(entry.displayLabel).toBeTruthy();
      expect(entry.promptHint).toBeTruthy();
      expect(Array.isArray(entry.aliases)).toBe(true);
      expect(entry.aliases.length).toBeGreaterThan(0);
    }
  });

  it('happy path — validates the HVAC terminology map', () => {
    const errors = validateTerminologyMap(HVAC_TERMINOLOGY);
    expect(errors).toHaveLength(0);
  });

  it('validation — rejects empty terminology map', () => {
    const errors = validateTerminologyMap({});
    expect(errors).toContain('Terminology map must have at least one entry');
  });

  it('validation — rejects entry missing canonical', () => {
    const errors = validateTerminologyMap({
      test: { canonical: '', displayLabel: 'Test', promptHint: 'Test hint', aliases: ['t'] },
    });
    expect(errors).toContain('Entry "test" is missing canonical');
  });

  it('validation — rejects entry missing displayLabel', () => {
    const errors = validateTerminologyMap({
      test: { canonical: 'test', displayLabel: '', promptHint: 'hint', aliases: ['t'] },
    });
    expect(errors).toContain('Entry "test" is missing displayLabel');
  });
});
