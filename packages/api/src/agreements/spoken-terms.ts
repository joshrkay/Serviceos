/**
 * Spoken service-agreement terms → contract fields, deterministic (no LLM).
 *
 * ONE implementation shared by the memo/chat leg
 * (`ai/tasks/create-service-agreement-task.ts`) and the live voice turn
 * (`proposals/voice-payload.ts`, #1540 §6), so the two legs cannot disagree
 * about what "quarterly, starting June 15" means. It lives in `agreements/`
 * because `proposals/` must not import `ai/`.
 *
 * ── Cadence → RRULE ──────────────────────────────────────────────────────
 * The classifier normalizes the spoken cadence word into one of four tokens;
 * each maps to the RRULE the recurrence engine (agreements/recurrence.ts)
 * understands. An absent or unrecognized cadence is the caller's gate —
 * never a guessed default cadence.
 *
 * ── startsOn ─────────────────────────────────────────────────────────────
 * Default: the first of next month on the TENANT's local calendar
 * (`shared/timezone.ts localDateKey`) — never server-local Date math. A
 * spoken start date overrides it best-effort via chrono-node anchored to the
 * tenant-local "now", with two guards: a fully ambiguous relative phrase
 * (neither month nor day certain) and a date already in the tenant's past
 * both fall back to the default.
 */
import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import { localDateKey } from '../shared/timezone';

export type SpokenAgreementCadence = 'monthly' | 'quarterly' | 'twice_a_year' | 'annual';

export const CADENCE_TO_RRULE: Record<SpokenAgreementCadence, string> = {
  monthly: 'FREQ=MONTHLY',
  quarterly: 'FREQ=MONTHLY;INTERVAL=3',
  // FREQ=QUARTERLY;INTERVAL=2 is EQUALLY valid RRULE for "every 6 months";
  // MONTHLY;INTERVAL=6 keeps every multi-month cadence on the same FREQ.
  twice_a_year: 'FREQ=MONTHLY;INTERVAL=6',
  annual: 'FREQ=YEARLY',
};

/** The RRULE for a classifier cadence token, or undefined when unrecognized. */
export function recurrenceRuleForCadence(cadence: unknown): string | undefined {
  return typeof cadence === 'string' && Object.prototype.hasOwnProperty.call(CADENCE_TO_RRULE, cadence)
    ? CADENCE_TO_RRULE[cadence as SpokenAgreementCadence]
    : undefined;
}

/** First of next month (`YYYY-MM-DD`) on the tenant-local calendar. */
export function firstOfNextMonth(now: Date, timezone: string): string {
  const todayLocal = localDateKey(now, timezone); // 'YYYY-MM-DD', tenant-local
  const [y, m] = todayLocal.split('-').map(Number);
  // `m` is 1-indexed; Date.UTC's month is 0-indexed, so passing `m` lands one
  // month ahead — exactly "first of next month" (December rolls over).
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/**
 * Best-effort parse of a spoken starts-on phrase into a calendar date,
 * anchored to the tenant-local "now". Undefined — never throws — when the
 * phrase is ambiguous or names a past date.
 */
export function parseSpokenStartsOn(phrase: string, timezone: string, now: Date): string | undefined {
  const refLocal = DateTime.fromJSDate(now).setZone(timezone);
  const referenceDate = new Date(
    refLocal.year,
    refLocal.month - 1,
    refLocal.day,
    refLocal.hour,
    refLocal.minute,
    refLocal.second,
    refLocal.millisecond,
  );
  const results = chrono.parse(phrase, referenceDate, { forwardDate: true });
  if (results.length === 0) return undefined;
  const start = results[0].start;

  // Guard 1 — reject a fully ambiguous relative phrase.
  if (!start.isCertain('month') && !start.isCertain('day')) return undefined;

  const year = start.get('year');
  const month = start.get('month');
  const day = start.get('day');
  if (year == null || month == null || day == null) return undefined;
  const dt = DateTime.fromObject({ year, month, day }, { zone: timezone });
  if (!dt.isValid) return undefined;
  const resolved = dt.toFormat('yyyy-MM-dd');

  // Guard 2 — reject a date already in the tenant's past.
  if (resolved < localDateKey(now, timezone)) return undefined;

  return resolved;
}

/** The spoken start date when it parses, else the first of next month. */
export function resolveAgreementStartsOn(
  spoken: string | undefined,
  timezone: string,
  now: Date,
): string {
  const phrase = spoken?.trim() ?? '';
  return (phrase.length > 0 ? parseSpokenStartsOn(phrase, timezone, now) : undefined) ??
    firstOfNextMonth(now, timezone);
}
