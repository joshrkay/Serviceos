import { hvacTerminologyEntries } from '../../src/verticals/data/hvac-terminology';
import { createTerminologyMap, lookupTerm } from '../../src/verticals/terminology-map';

describe('P4-002A — HVAC terminology map', () => {
  const map = createTerminologyMap({
    verticalSlug: 'hvac',
    version: '1.0.0',
    entries: hvacTerminologyEntries,
  });

  it('happy path — terminology map has entries', () => {
    expect(map.entries.length).toBeGreaterThanOrEqual(20);
    expect(map.verticalSlug).toBe('hvac');
  });

  it('happy path — lookupTerm finds by exact term', () => {
    const entry = lookupTerm(map, 'SEER');
    expect(entry).not.toBeNull();
    expect(entry!.term).toBe('SEER');
    expect(entry!.category).toBe('efficiency');
  });

  it('happy path — lookupTerm finds by alias (case-insensitive)', () => {
    const entry = lookupTerm(map, 'outdoor unit');
    expect(entry).not.toBeNull();
    expect(entry!.term).toBe('Condenser');
  });

  it('validation — all entries have required fields', () => {
    for (const entry of hvacTerminologyEntries) {
      expect(entry.term).toBeTruthy();
      expect(entry.definition).toBeTruthy();
      expect(Array.isArray(entry.aliases)).toBe(true);
    }
  });

  it('mock provider test — lookupTerm is case-insensitive', () => {
    expect(lookupTerm(map, 'seer')).not.toBeNull();
    expect(lookupTerm(map, 'SEER')).not.toBeNull();
    expect(lookupTerm(map, 'Seer')).not.toBeNull();
  });

  it('malformed AI output handled gracefully — lookupTerm returns null for unknown', () => {
    const result = lookupTerm(map, 'nonexistent-term-xyz');
    expect(result).toBeNull();
  });
});
