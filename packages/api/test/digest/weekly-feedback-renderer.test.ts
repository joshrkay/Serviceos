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

  // ─── WS22: "same mistake twice" repeat-corrections line ──────────────────

  describe('repeatCorrections line', () => {
    it('renders the honest repeat-correction line (singular correction) when present', () => {
      const withRepeats: WeeklyFeedbackSnapshot = {
        ...snapshot,
        repeatCorrections: { total: 6, repeats: 2, rate: 33 },
      };
      const email = renderWeeklyFeedbackEmail(withRepeats, suggestions);
      expect(email.text).toContain(
        'Of 6 corrections this week, 2 were repeats of an earlier correction (33%).',
      );
      expect(email.html).toContain('Of 6 corrections this week, 2 were repeats');
    });

    it('uses singular "correction"/"was a repeat" wording for total=1, repeats=1', () => {
      const withRepeats: WeeklyFeedbackSnapshot = {
        ...snapshot,
        repeatCorrections: { total: 1, repeats: 1, rate: 100 },
      };
      const email = renderWeeklyFeedbackEmail(withRepeats, suggestions);
      expect(email.text).toContain('Of 1 correction this week, 1 was a repeat of an earlier correction (100%).');
    });

    it('omits the line entirely when repeatCorrections is absent', () => {
      const email = renderWeeklyFeedbackEmail(snapshot, suggestions);
      expect(email.text).not.toContain('correction');
      expect(email.html).not.toContain('correction');
    });

    it('omits the line when repeatCorrections.total is 0 (defensive — builder should already omit)', () => {
      const withZero: WeeklyFeedbackSnapshot = {
        ...snapshot,
        repeatCorrections: { total: 0, repeats: 0, rate: 0 },
      };
      const email = renderWeeklyFeedbackEmail(withZero, suggestions);
      expect(email.text).not.toContain('correction');
    });
  });
});
