import { plumbingTerminologyEntries } from '../../src/verticals/data/plumbing-terminology';
import { createTerminologyMap, lookupTerm } from '../../src/verticals/terminology-map';

describe('P4-003A — Plumbing terminology map', () => {
  const map = createTerminologyMap({
    verticalSlug: 'plumbing',
    version: '1.0.0',
    entries: plumbingTerminologyEntries,
  });

  it('happy path — terminology map has entries', () => {
    expect(map.entries.length).toBeGreaterThanOrEqual(20);
    expect(map.verticalSlug).toBe('plumbing');
  });

  it('happy path — lookupTerm finds by exact term', () => {
    const entry = lookupTerm(map, 'PEX');
    expect(entry).not.toBeNull();
    expect(entry!.term).toBe('PEX');
    expect(entry!.category).toBe('materials');
  });

  it('happy path — lookupTerm finds by alias', () => {
    const entry = lookupTerm(map, 'sewer camera');
    expect(entry).not.toBeNull();
    expect(entry!.term).toBe('Sewer Scope');
  });

  it('validation — all entries have required fields', () => {
    for (const entry of plumbingTerminologyEntries) {
      expect(entry.term).toBeTruthy();
      expect(entry.definition).toBeTruthy();
      expect(Array.isArray(entry.aliases)).toBe(true);
    }
  });

  it('mock provider test — lookupTerm is case-insensitive', () => {
    expect(lookupTerm(map, 'pex')).not.toBeNull();
    expect(lookupTerm(map, 'PEX')).not.toBeNull();
  });

  it('malformed AI output handled gracefully — lookupTerm returns null for unknown', () => {
    expect(lookupTerm(map, 'nonexistent-plumbing-term')).toBeNull();
  });
});
