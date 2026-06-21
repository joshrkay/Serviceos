import { describe, it, expect } from 'vitest';
import { renderWeeklyFeedbackEmail } from '../../src/digest/weekly-feedback-renderer';
import type { WeeklyFeedbackSnapshot, WeeklySuggestions } from '../../src/digest/weekly-feedback';

const snapshot: WeeklyFeedbackSnapshot = {
  weekStartIso: '2026-06-01T00:00:00.000Z',
  weekEndIso: '2026-06-08T00:00:00.000Z',
  revenueCents: 1_250_000,
  priorRevenueCents: 1_000_000,
  jobsCompleted: 8,
  priorJobsCompleted: 6,
  jobsBooked: 5,
  estimatesSent: 3,
  estimatesSentValueCents: 900_000,
  invoicesPaidCount: 4,
  callsAnswered: 12,
  newLeads: 2,
  outstandingCents: 250_000,
};

const suggestions: WeeklySuggestions = {
  wins: ['Revenue up 25%'],
  misses: ['$2,500 outstanding'],
  actions: ['Send payment reminders'],
};

describe('renderWeeklyFeedbackEmail', () => {
  it('builds a subject with revenue + jobs and an inclusive date range', () => {
    const email = renderWeeklyFeedbackEmail(snapshot, suggestions, { businessName: 'Ace HVAC' });
    expect(email.subject).toBe('Your week: $12,500 collected, 8 jobs done');
    expect(email.text).toContain('Ace HVAC');
    // Inclusive last day is Jun 7 (weekEnd Jun 8 is exclusive).
    expect(email.text).toContain('Jun 1 – Jun 7');
  });

  it('includes the snapshot stats and the three suggestion sections in text', () => {
    const email = renderWeeklyFeedbackEmail(snapshot, suggestions);
    expect(email.text).toContain('Revenue: $12,500');
    expect(email.text).toContain('Calls answered: 12');
    expect(email.text).toContain('Wins:');
    expect(email.text).toContain('Worth watching:');
    expect(email.text).toContain('Suggested next steps:');
    expect(email.text).toContain('• Send payment reminders');
  });

  it('emits HTML and escapes interpolated suggestion text', () => {
    const email = renderWeeklyFeedbackEmail(snapshot, {
      wins: ['Beat <goal> & target'],
      misses: [],
      actions: [],
    });
    expect(email.html).toContain('<table');
    expect(email.html).toContain('Beat &lt;goal&gt; &amp; target');
    expect(email.html).not.toContain('Beat <goal>');
  });

  it('omits empty suggestion sections', () => {
    const email = renderWeeklyFeedbackEmail(snapshot, { wins: ['w'], misses: [], actions: [] });
    expect(email.text).toContain('Wins:');
    expect(email.text).not.toContain('Worth watching:');
  });
});
