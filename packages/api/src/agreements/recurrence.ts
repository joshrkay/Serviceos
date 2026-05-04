/**
 * P9-003 — Recurrence rule parser + next-occurrence calculator.
 *
 * RRULE subset:
 *   FREQ=(MONTHLY|QUARTERLY|YEARLY)
 *   INTERVAL=<positive integer>      (defaults to 1)
 *   BYMONTHDAY=<1..31>               (defaults to startsOn day-of-month)
 *
 * Edge cases handled:
 *   - BYMONTHDAY=31 in a 30-day month → last day of that month (30)
 *   - BYMONTHDAY=29..31 in February   → Feb 28 / 29 (leap-aware)
 *   - QUARTERLY collapses to MONTHLY * 3
 *   - YEARLY anchors on the same month-of-year as the input fromDate
 *
 * tenantTz is accepted for API symmetry with the rest of the codebase
 * but is not required for the math: we operate on UTC date components and
 * leave timezone-aware rendering to the route layer.
 */

import { RecurrenceFrequency } from './enums';

export interface ParsedRule {
  freq: RecurrenceFrequency;
  interval: number;
  /** undefined means "use the day-of-month from the anchor date" */
  byMonthDay: number | undefined;
}

export class RecurrenceRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceRuleError';
  }
}

export function parseRule(rule: string): ParsedRule {
  if (typeof rule !== 'string' || rule.length === 0) {
    throw new RecurrenceRuleError('rule is empty');
  }

  const parts = rule.split(';').map((p) => p.trim()).filter(Boolean);
  const map = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      throw new RecurrenceRuleError(`malformed segment: ${part}`);
    }
    map.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }

  const freqRaw = map.get('FREQ');
  if (!freqRaw) {
    throw new RecurrenceRuleError('FREQ is required');
  }
  let freq: RecurrenceFrequency;
  switch (freqRaw.toUpperCase()) {
    case 'MONTHLY':
      freq = 'monthly';
      break;
    case 'QUARTERLY':
      freq = 'quarterly';
      break;
    case 'YEARLY':
      freq = 'yearly';
      break;
    default:
      throw new RecurrenceRuleError(`unsupported FREQ: ${freqRaw}`);
  }

  let interval = 1;
  const intervalRaw = map.get('INTERVAL');
  if (intervalRaw !== undefined) {
    const n = Number(intervalRaw);
    if (!Number.isInteger(n) || n < 1) {
      throw new RecurrenceRuleError(`INTERVAL must be a positive integer, got: ${intervalRaw}`);
    }
    interval = n;
  }

  let byMonthDay: number | undefined;
  const bymdRaw = map.get('BYMONTHDAY');
  if (bymdRaw !== undefined) {
    const n = Number(bymdRaw);
    if (!Number.isInteger(n) || n < 1 || n > 31) {
      throw new RecurrenceRuleError(`BYMONTHDAY must be 1..31, got: ${bymdRaw}`);
    }
    byMonthDay = n;
  }

  return { freq, interval, byMonthDay };
}

/**
 * Days in `month` (1..12) of `year`. Handles leap years for February.
 */
export function daysInMonth(year: number, month: number): number {
  // new Date(year, month, 0) returns the last day of `month-1`; passing
  // 1-indexed month gives us the last day of that month directly.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Compute the next occurrence strictly after `fromDate`.
 *
 * Algorithm:
 *   1. Anchor month/year = fromDate's month/year.
 *   2. Target day = byMonthDay (clamped to month length) or fromDate.day.
 *   3. If candidate <= fromDate, advance by `interval` units of FREQ
 *      and recompute (handles BYMONTHDAY clamping in the new month).
 */
export function nextOccurrence(
  rule: ParsedRule | string,
  fromDate: Date,
  _tenantTz?: string,
): Date {
  const parsed = typeof rule === 'string' ? parseRule(rule) : rule;
  const monthsPerStep =
    parsed.freq === 'monthly'
      ? parsed.interval
      : parsed.freq === 'quarterly'
        ? parsed.interval * 3
        : parsed.interval * 12;

  const fromY = fromDate.getUTCFullYear();
  const fromM = fromDate.getUTCMonth(); // 0-indexed
  const fromD = fromDate.getUTCDate();
  const fromMs = fromDate.getTime();
  const targetDay = parsed.byMonthDay ?? fromD;

  // Walk forward in steps of `monthsPerStep` until we land strictly after fromDate.
  let candidateY = fromY;
  let candidateM = fromM;
  // Try anchor month first, then advance if needed.
  for (let i = 0; i < 1200; i++) {
    const dim = daysInMonth(candidateY, candidateM + 1);
    const day = Math.min(targetDay, dim);
    const candidate = new Date(Date.UTC(candidateY, candidateM, day));
    if (candidate.getTime() > fromMs) {
      return candidate;
    }
    // Advance one step.
    const nextMonthIdx = candidateM + monthsPerStep;
    candidateY += Math.floor(nextMonthIdx / 12);
    candidateM = ((nextMonthIdx % 12) + 12) % 12;
  }
  throw new RecurrenceRuleError('next occurrence search exceeded max iterations');
}
