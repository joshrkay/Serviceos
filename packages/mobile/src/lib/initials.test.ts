import { describe, expect, it } from 'vitest';
import { initials } from './initials';

describe('initials', () => {
  it('takes the first + last word initials', () => {
    expect(initials('Emily Lee')).toBe('EL');
    expect(initials('Acme Plumbing')).toBe('AP');
    expect(initials('Mary Jane Watson')).toBe('MW'); // first + last, not middle
  });

  it('takes the first two chars of a single word', () => {
    expect(initials('Cher')).toBe('CH');
  });

  it('handles empty / whitespace input', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});
