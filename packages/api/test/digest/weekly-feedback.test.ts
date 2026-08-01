import { describe, it, expect } from 'vitest';
import {
  deterministicSuggestions,
  buildSuggestionsPrompt,
  parseSuggestions,
  type WeeklyFeedbackSnapshot,
} from '../../src/digest/weekly-feedback';

function snapshot(over: Partial<WeeklyFeedbackSnapshot> = {}): WeeklyFeedbackSnapshot {
  return {
    weekStartIso: '2026-06-01T00:00:00.000Z',
    weekEndIso: '2026-06-08T00:00:00.000Z',
    revenueCents: 500_000,
    priorRevenueCents: 400_000,
    jobsCompleted: 8,
    priorJobsCompleted: 6,
    jobsBooked: 5,
    estimatesSent: 3,
    estimatesSentValueCents: 900_000,
    invoicesPaidCount: 4,
    callsAnswered: 12,
    newLeads: 2,
    outstandingCents: 250_000,
    ...over,
  };
}

describe('deterministicSuggestions', () => {
  it('surfaces revenue growth, calls, outstanding, and a follow-up action', () => {
    const s = deterministicSuggestions(snapshot());
    expect(s.wins.some((w) => /up 25%/.test(w))).toBe(true);
    expect(s.wins.some((w) => /answered 12 calls/.test(w))).toBe(true);
    expect(s.misses.some((m) => /outstanding/.test(m))).toBe(true);
    expect(s.actions.length).toBeGreaterThanOrEqual(1);
    expect(s.actions.length).toBeLessThanOrEqual(2);
    expect(s.wins.length).toBeLessThanOrEqual(2);
  });

  it('flags a revenue drop as a miss', () => {
    const s = deterministicSuggestions(snapshot({ revenueCents: 200_000, priorRevenueCents: 400_000 }));
    expect(s.misses.some((m) => /down 50%/.test(m))).toBe(true);
  });

  it('always returns at least one action even on a quiet week', () => {
    const s = deterministicSuggestions(
      snapshot({ revenueCents: 0, priorRevenueCents: 0, outstandingCents: 0, estimatesSent: 0, newLeads: 0 }),
    );
    expect(s.actions.length).toBe(1);
  });
});

describe('buildSuggestionsPrompt', () => {
  it('includes the metrics and asks for strict JSON', () => {
    const prompt = buildSuggestionsPrompt(snapshot());
    expect(prompt).toContain('STRICT JSON');
    expect(prompt).toContain('"revenueCents":500000');
    expect(prompt).toContain('"callsAnswered":12');
  });
});

describe('parseSuggestions', () => {
  it('parses a clean JSON object, capping each list at two', () => {
    const raw = JSON.stringify({
      wins: ['a', 'b', 'c'],
      misses: ['x'],
      actions: ['do one', 'do two', 'do three'],
    });
    const parsed = parseSuggestions(raw);
    expect(parsed).toEqual({ wins: ['a', 'b'], misses: ['x'], actions: ['do one', 'do two'] });
  });

  it('extracts JSON even when wrapped in prose', () => {
    const raw = 'Sure! {"wins":["w"],"misses":[],"actions":["a"]} hope that helps';
    expect(parseSuggestions(raw)).toEqual({ wins: ['w'], misses: [], actions: ['a'] });
  });

  it('returns null for unusable or empty payloads', () => {
    expect(parseSuggestions('not json')).toBeNull();
    expect(parseSuggestions('{"wins":[],"misses":[],"actions":[]}')).toBeNull();
  });
});
