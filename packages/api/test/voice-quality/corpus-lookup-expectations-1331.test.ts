/**
 * #1331 (Layer 2 run 36925905917) — two lookup scripts failed criterion 12 on
 * a date the agent got right:
 *
 *   - lookup-appointments-next: the agent said "Friday, June 12th at 9 a.m."
 *     and the judge answered "should be June 12, 2026, not 2025". The
 *     expectation named no weekday, so the judge did its own calendar math on
 *     the weekday the agent spoke. The expectation now states the day the
 *     caller hears ("Friday, June 12") — still no year, which no one says.
 *   - lookup-estimates-recent: the expectation ("sent on April 22") and the
 *     fixture (a sent estimate created April 22, never re-sent) agree; the
 *     agent's text says "April 22" every run and the "April 26th" the judge
 *     saw is the speech-recognition hearing of it (see the PR).
 *
 * Seam: the corpus loader (the scripts as every lane reads them).
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { loadScript, defaultCorpusRoot } from '../../src/ai/voice-quality/corpus/loader';

function script(file: string) {
  return loadScript(path.join(defaultCorpusRoot(), '01-happy-lookups', file));
}

function tenantLocal(iso: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', ...opts }).format(new Date(iso));
}

describe('#1331 — lookup expectations name the date the caller hears', () => {
  it('lookup-appointments-next expects the spoken weekday and date of the seeded visit, and no year', () => {
    const s = script('lookup-appointments-next.json');
    const appt = (s.fixtures.appointments as Array<{ scheduledStart: string }>)[0];

    expect(tenantLocal(appt.scheduledStart, { weekday: 'long', month: 'long', day: 'numeric' })).toBe('Friday, June 12');
    expect(s.turns[0].expected.spokenAnswerMatches).toContain('Friday, June 12');
    expect(s.turns[0].expected.spokenAnswerMatches).not.toMatch(/\b20\d\d\b/);
  });

  it('lookup-estimates-recent expects the date the seeded estimate was sent', () => {
    const s = script('lookup-estimates-recent.json');
    const est = (s.fixtures.estimates as Array<{ status: string; sentAt?: string; createdAt: string }>)[0];

    expect(est.status).toBe('sent');
    expect(tenantLocal(est.sentAt ?? est.createdAt, { month: 'long', day: 'numeric' })).toBe('April 22');
    expect(s.turns[0].expected.spokenAnswerMatches).toContain('sent on April 22');
  });
});
