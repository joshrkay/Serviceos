import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import {
  suggestionsForPath,
  useVoiceSuggestions,
  DEFAULT_VOICE_SUGGESTIONS,
} from './useVoiceSuggestions';

describe('suggestionsForPath', () => {
  it('returns schedule-relevant utterances on /schedule and /dispatch', () => {
    expect(suggestionsForPath('/schedule')).toContain("What's on tomorrow's schedule?");
    expect(suggestionsForPath('/dispatch')).toEqual(suggestionsForPath('/schedule'));
  });

  it('returns invoice-relevant utterances on /invoices and nested invoice routes (prefix match)', () => {
    expect(suggestionsForPath('/invoices')).toContain('Any overdue invoices?');
    expect(suggestionsForPath('/invoices/inv-1')).toContain('Any overdue invoices?');
  });

  it('returns onboarding-relevant setup answers on /onboarding', () => {
    expect(suggestionsForPath('/onboarding')).toContain('My business is Acme Plumbing');
    expect(suggestionsForPath('/onboarding')).not.toEqual(suggestionsForPath('/'));
  });

  it('gives every route 2–3 suggestions', () => {
    for (const p of ['/', '/onboarding', '/jobs', '/schedule', '/customers', '/estimates', '/invoices', '/inbox', '/whatever']) {
      const s = suggestionsForPath(p);
      expect(s.length, p).toBeGreaterThanOrEqual(2);
      expect(s.length, p).toBeLessThanOrEqual(3);
    }
  });

  it('different sections surface different suggestions', () => {
    expect(suggestionsForPath('/schedule')).not.toEqual(suggestionsForPath('/invoices'));
    expect(suggestionsForPath('/jobs')).not.toEqual(suggestionsForPath('/customers'));
  });

  it('falls back to the generic set for home and unlisted routes', () => {
    expect(suggestionsForPath('/')).toEqual([...DEFAULT_VOICE_SUGGESTIONS]);
    expect(suggestionsForPath('/settings/profile')).toEqual([...DEFAULT_VOICE_SUGGESTIONS]);
  });

  it('returns a fresh array each call (caller may mutate safely)', () => {
    const a = suggestionsForPath('/jobs');
    a.push('mutated');
    expect(suggestionsForPath('/jobs')).not.toContain('mutated');
  });
});

describe('useVoiceSuggestions', () => {
  it('reads the current route from the router', () => {
    const { result } = renderHook(() => useVoiceSuggestions(), {
      wrapper: ({ children }) =>
        createElement(MemoryRouter, { initialEntries: ['/customers/cust-1'] }, children),
    });
    expect(result.current).toContain('Add a new customer');
  });
});
