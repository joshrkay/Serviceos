/**
 * R-JOB (Jobber parity) — recurrence engine.
 *
 * Jobber's recurring jobs repeat on a schedule (weekly lawn care, monthly HVAC
 * maintenance). This module is the pure scheduling brain: given an anchor date
 * and a rule, it computes the next N occurrence dates. It is calendar-date math
 * only (no clock time, no timezone) — occurrences are 'YYYY-MM-DD' service days;
 * the appointment layer attaches the time-of-day in the tenant timezone.
 *
 * Kept deliberately dependency-free and side-effect-free so it is exhaustively
 * unit-testable; persistence lives in recurring-job.ts / pg-recurring-job.ts.
 */

export type RecurrenceFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';

export const RECURRENCE_FREQUENCIES: readonly RecurrenceFrequency[] = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
];

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  /** Repeat every `interval` units of the frequency (>= 1). Default 1. */
  interval: number;
  /** Stop after this many occurrences (inclusive). Mutually exclusive with `until`. */
  count?: number;
  /** Stop on/after this date ('YYYY-MM-DD'), inclusive. */
  until?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = parseDate(value);
  return formatDate(d) === value; // rejects e.g. 2026-02-30 (rolls over)
}

/** Parse 'YYYY-MM-DD' to a UTC-midnight Date (used purely as a calendar date). */
function parseDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/**
 * Add `months` to a date, clamping the day to the target month's length so
 * Jan 31 + 1 month → Feb 28/29 (not a roll-over into March). This mirrors how
 * scheduling tools anchor "the 31st" to month-end in shorter months.
 */
function addMonthsClamped(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const targetMonthFirst = new Date(Date.UTC(y, m + months, 1));
  const daysInTarget = new Date(
    Date.UTC(targetMonthFirst.getUTCFullYear(), targetMonthFirst.getUTCMonth() + 1, 0),
  ).getUTCDate();
  targetMonthFirst.setUTCDate(Math.min(d, daysInTarget));
  return targetMonthFirst;
}

export function validateRecurrenceRule(rule: {
  frequency?: unknown;
  interval?: unknown;
  count?: unknown;
  until?: unknown;
}): string[] {
  const errors: string[] = [];
  if (!RECURRENCE_FREQUENCIES.includes(rule.frequency as RecurrenceFrequency)) {
    errors.push('frequency must be one of: ' + RECURRENCE_FREQUENCIES.join(', '));
  }
  if (rule.interval !== undefined) {
    if (typeof rule.interval !== 'number' || !Number.isInteger(rule.interval) || rule.interval < 1) {
      errors.push('interval must be a positive integer');
    }
  }
  if (rule.count !== undefined && rule.until !== undefined) {
    errors.push('set either count or until, not both');
  }
  if (rule.count !== undefined) {
    if (typeof rule.count !== 'number' || !Number.isInteger(rule.count) || rule.count < 1) {
      errors.push('count must be a positive integer');
    }
  }
  if (rule.until !== undefined && !isValidDateString(rule.until)) {
    errors.push('until must be a date (YYYY-MM-DD)');
  }
  return errors;
}

function stepFor(rule: RecurrenceRule): (date: Date, step: number) => Date {
  const interval = rule.interval ?? 1;
  switch (rule.frequency) {
    case 'daily':
      return (date, step) => addDays(date, step * interval);
    case 'weekly':
      return (date, step) => addDays(date, step * interval * 7);
    case 'biweekly':
      return (date, step) => addDays(date, step * interval * 14);
    case 'monthly':
      return (date, step) => addMonthsClamped(date, step * interval);
  }
}

/**
 * Compute occurrence dates starting at `anchor` (inclusive), honoring the
 * rule's `count`/`until` bounds. `limit` caps how many are returned regardless
 * of the rule (so an unbounded rule still yields a finite preview). Returns
 * 'YYYY-MM-DD' strings in ascending order.
 */
export function computeOccurrences(anchor: string, rule: RecurrenceRule, limit: number): string[] {
  if (!isValidDateString(anchor)) throw new Error('anchor must be a date (YYYY-MM-DD)');
  if (!Number.isInteger(limit) || limit < 0) throw new Error('limit must be a non-negative integer');
  const errors = validateRecurrenceRule(rule);
  if (errors.length > 0) throw new Error(`Invalid recurrence: ${errors.join(', ')}`);

  const step = stepFor(rule);
  const anchorDate = parseDate(anchor);
  const untilDate = rule.until ? parseDate(rule.until) : null;
  const max = rule.count !== undefined ? Math.min(rule.count, limit) : limit;

  const out: string[] = [];
  for (let i = 0; out.length < max; i++) {
    const occ = step(anchorDate, i);
    if (untilDate && occ.getTime() > untilDate.getTime()) break;
    out.push(formatDate(occ));
    // Safety valve: a daily rule with a huge `until` shouldn't loop forever
    // past the limit — the out.length < max guard already bounds it, but cap
    // the iteration count defensively.
    if (i > 100_000) break;
  }
  return out;
}

/** Human-readable summary for UI/audit, e.g. "Every 2 weeks, 10 times". */
export function describeRecurrence(rule: RecurrenceRule): string {
  const interval = rule.interval ?? 1;
  const unit: Record<RecurrenceFrequency, string> = {
    daily: 'day',
    weekly: 'week',
    biweekly: '2 weeks',
    monthly: 'month',
  };
  let base: string;
  if (rule.frequency === 'biweekly') {
    base = interval === 1 ? 'Every 2 weeks' : `Every ${interval * 2} weeks`;
  } else {
    base = interval === 1 ? `Every ${unit[rule.frequency]}` : `Every ${interval} ${unit[rule.frequency]}s`;
  }
  if (rule.count !== undefined) return `${base}, ${rule.count} time${rule.count === 1 ? '' : 's'}`;
  if (rule.until) return `${base}, until ${rule.until}`;
  return base;
}
