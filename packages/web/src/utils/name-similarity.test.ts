import { describe, it, expect } from 'vitest';
import { nameSimilarity, FUZZY_NAME_THRESHOLD } from './name-similarity';

describe('nameSimilarity (web — pg_trgm parity)', () => {
  it('scores identical names 1.0', () => {
    expect(nameSimilarity('John Doe', 'john doe')).toBe(1);
  });

  it('scores a close typo at or above the fuzzy threshold', () => {
    expect(nameSimilarity('Jonathan Doe', 'Jonathon Doe')).toBeGreaterThanOrEqual(
      FUZZY_NAME_THRESHOLD,
    );
    expect(nameSimilarity('John Doe', 'Jon Doe')).toBeGreaterThanOrEqual(
      FUZZY_NAME_THRESHOLD,
    );
  });

  it('scores unrelated names below the fuzzy threshold', () => {
    expect(nameSimilarity('John Doe', 'Jane Smith')).toBeLessThan(FUZZY_NAME_THRESHOLD);
    expect(nameSimilarity('Maria Gonzalez', 'John Doe')).toBeLessThan(
      FUZZY_NAME_THRESHOLD,
    );
  });

  it('scores empty input 0', () => {
    expect(nameSimilarity('', 'John Doe')).toBe(0);
    expect(nameSimilarity('John Doe', '')).toBe(0);
  });
});
