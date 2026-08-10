import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';

/**
 * Deterministic natural-language → UTC datetime resolver for the inbound
 * voice booking path (P0 correctness fix).
 *
 * BACKGROUND. The create_appointment and reschedule task handlers used
 * to ask the LLM to turn "next Tuesday at 2pm" into an ISO UTC datetime,
 * with a system prompt that hardcoded `America/Los_Angeles` for EVERY
 * tenant and passed no current date. That mis-booked every non-Pacific
 * tenant (the product default is `America/New_York`) and made relative
 * phrases ("tomorrow", "next Tuesday") unreliable because the model had
 * no anchor date.
 *
 * HYBRID APPROACH. The LLM/classifier only extracts the verbatim phrase
 * (e.g. "next Tuesday at 2pm"). This module resolves it deterministically
 * against the tenant's timezone and the current instant:
 *   - chrono-node parses the phrase relative to tenant-local "now"
 *     (forwardDate so bare weekdays resolve to the NEXT occurrence).
 *   - luxon converts the parsed wall-clock fields to a UTC instant in the
 *     tenant timezone, handling DST correctly.
 *   - the result is validated (no past times, no inverted/implausible
 *     ranges) so garbage never reaches the proposal/execution layer.
 *
 * Ambiguity (a date with no time-of-day, e.g. bare "Tuesday") is reported
 * back to the caller rather than guessed — the handler turns it into a
 * voice_clarification ("what time on Tuesday?").
 */

/** Product-default tenant timezone (matches `tenant_settings.timezone`). */
export const DEFAULT_TENANT_TIMEZONE = 'America/New_York';

/** Default appointment length when the caller gives only a start time. */
export const DEFAULT_DURATION_MIN = 60;

/** Reject durations longer than this — almost always a parse error. */
const MAX_DURATION_MIN = 12 * 60;

/** Grace for "in the past" so an utterance spoken at the slot time still books. */
const PAST_GRACE_MS = 5 * 60 * 1000;

/**
 * Daypart → arrival window (tenant-local hours). When a caller says
 * "tomorrow morning" with no specific hour, we book the start of the
 * window and carry the whole window as the customer-facing arrival window
 * (the home-services standard).
 */
// Only unambiguous service dayparts. "night"/"tonight" are deliberately
// excluded: they're too ambiguous to book without mis-stating the time
// (chrono reads "night" as ~8pm, not the 5pm an evening window implies), so
// they fall through to a clarification. "noon" is omitted because chrono
// already resolves it to a certain 12:00 (the exact-time path handles it).
const DAYPARTS: Record<string, { startHour: number; endHour: number }> = {
  morning: { startHour: 8, endHour: 12 },
  afternoon: { startHour: 12, endHour: 17 },
  evening: { startHour: 17, endHour: 20 },
};

export interface ResolveDateTimeOptions {
  /** IANA timezone of the tenant. Defaults to DEFAULT_TENANT_TIMEZONE. */
  timezone?: string;
  /** Reference instant for relative phrases. Defaults to now. */
  now?: Date;
  /** Appointment length when only a start time is given. */
  defaultDurationMin?: number;
}

export type ResolveDateTimeFailureReason =
  | 'empty'
  | 'unparseable'
  | 'ambiguous_no_time'
  | 'in_past'
  | 'inverted'
  | 'implausible';

export type ResolveDateTimeResult =
  | {
      ok: true;
      /** ISO 8601 UTC instant. */
      startUtc: string;
      /** ISO 8601 UTC instant. */
      endUtc: string;
      /** Echo of the timezone actually used (after validation/fallback). */
      timezone: string;
      /** 'exact' = explicit clock time; 'daypart' = morning/afternoon/etc. */
      precision: 'exact' | 'daypart';
      /** Present for daypart precision: the customer-facing arrival window. */
      arrivalWindowStartUtc?: string;
      arrivalWindowEndUtc?: string;
    }
  | {
      ok: false;
      reason: ResolveDateTimeFailureReason;
      detail?: string;
    };

function isValidTimezone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    // Throws RangeError for an unknown IANA zone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function clampDuration(min: number): number {
  if (!Number.isFinite(min) || min <= 0) return DEFAULT_DURATION_MIN;
  return Math.min(min, MAX_DURATION_MIN);
}

/** Detect an explicit daypart word so "tomorrow morning" resolves to a window. */
function detectDaypart(text: string): keyof typeof DAYPARTS | undefined {
  const lower = text.toLowerCase();
  for (const key of Object.keys(DAYPARTS)) {
    if (new RegExp(`\\b${key}\\b`).test(lower)) return key;
  }
  return undefined;
}

function wallToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  zone: string,
): DateTime {
  return DateTime.fromObject(
    { ...parts, second: 0, millisecond: 0 },
    { zone },
  );
}

/**
 * Resolve the hour for a parsed component, biasing a bare hour to service
 * hours. When the caller gives no am/pm ("come at 5"), chrono leaves the
 * meridiem uncertain and tends to pick the literal hour (5 → 5am). For a
 * field-service call that almost always means the afternoon, so an uncertain
 * meridiem at hours 1–7 is biased to PM. Hours 8–12 stay as spoken (a bare
 * "8" is morning, "12" is noon), and an explicit am/pm is always honored.
 */
function resolveServiceHour(component: {
  get: (u: 'hour') => number | null;
  isCertain: (u: 'meridiem') => boolean;
}): number {
  const hour = component.get('hour') ?? 0;
  if (!component.isCertain('meridiem') && hour >= 1 && hour <= 7) {
    return hour + 12;
  }
  return hour;
}

/**
 * Resolve a natural-language date/time phrase to a concrete UTC window.
 * Pure and deterministic given `phrase` + `now` + `timezone` — safe to
 * unit-test across DST boundaries and tenant timezones.
 */
export function resolveDateTime(
  phrase: string,
  opts: ResolveDateTimeOptions = {},
): ResolveDateTimeResult {
  const timezone = isValidTimezone(opts.timezone) ? opts.timezone : DEFAULT_TENANT_TIMEZONE;
  const now = opts.now ?? new Date();
  const durationMin = clampDuration(opts.defaultDurationMin ?? DEFAULT_DURATION_MIN);

  const text = (phrase ?? '').trim();
  if (!text) return { ok: false, reason: 'empty' };

  // chrono is timezone-naive: feed it a reference Date whose LOCAL fields
  // mirror the tenant's wall clock so "tomorrow"/"next Tuesday" anchor to
  // the tenant's today, not the server's.
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

  const results = chrono.parse(text, referenceDate, { forwardDate: true });
  if (results.length === 0) return { ok: false, reason: 'unparseable' };

  const r = results[0];
  const start = r.start;
  const day = {
    year: start.get('year'),
    month: start.get('month'),
    dayOfMonth: start.get('day'),
  };
  if (day.year == null || day.month == null || day.dayOfMonth == null) {
    return { ok: false, reason: 'unparseable' };
  }

  const hasExactTime = start.isCertain('hour');
  const daypart = hasExactTime ? undefined : detectDaypart(text);

  // A bare date with neither an explicit time nor a daypart is ambiguous —
  // ask rather than guess a default hour.
  if (!hasExactTime && !daypart) return { ok: false, reason: 'ambiguous_no_time' };

  let startDt: DateTime;
  let endDt: DateTime;
  let precision: 'exact' | 'daypart';
  let arrivalStart: DateTime | undefined;
  let arrivalEnd: DateTime | undefined;

  if (hasExactTime) {
    precision = 'exact';
    startDt = wallToUtc(
      {
        year: day.year,
        month: day.month,
        day: day.dayOfMonth,
        hour: resolveServiceHour(start),
        minute: start.get('minute') ?? 0,
      },
      timezone,
    );
    if (r.end && r.end.isCertain('hour')) {
      endDt = wallToUtc(
        {
          year: r.end.get('year') ?? day.year,
          month: r.end.get('month') ?? day.month,
          day: r.end.get('day') ?? day.dayOfMonth,
          hour: resolveServiceHour(r.end),
          minute: r.end.get('minute') ?? 0,
        },
        timezone,
      );
    } else {
      endDt = startDt.plus({ minutes: durationMin });
    }
  } else {
    // Daypart: book the start of the window, carry the window as the
    // customer-facing arrival window.
    precision = 'daypart';
    const window = DAYPARTS[daypart!];
    startDt = wallToUtc(
      { year: day.year, month: day.month, day: day.dayOfMonth, hour: window.startHour, minute: 0 },
      timezone,
    );
    endDt = startDt.plus({ minutes: durationMin });
    arrivalStart = startDt;
    arrivalEnd = wallToUtc(
      { year: day.year, month: day.month, day: day.dayOfMonth, hour: window.endHour, minute: 0 },
      timezone,
    );
  }

  if (!startDt.isValid || !endDt.isValid) {
    return { ok: false, reason: 'implausible', detail: startDt.invalidReason ?? endDt.invalidReason ?? undefined };
  }
  if (endDt <= startDt) return { ok: false, reason: 'inverted' };
  if (endDt.diff(startDt, 'minutes').minutes > MAX_DURATION_MIN) {
    return { ok: false, reason: 'implausible', detail: 'duration exceeds maximum' };
  }
  if (startDt.toMillis() < now.getTime() - PAST_GRACE_MS) {
    return { ok: false, reason: 'in_past' };
  }

  const result: ResolveDateTimeResult = {
    ok: true,
    startUtc: startDt.toUTC().toISO()!,
    endUtc: endDt.toUTC().toISO()!,
    timezone,
    precision,
  };
  if (arrivalStart && arrivalEnd) {
    result.arrivalWindowStartUtc = arrivalStart.toUTC().toISO()!;
    result.arrivalWindowEndUtc = arrivalEnd.toUTC().toISO()!;
  }
  return result;
}

/**
 * Resolve a spoken DAY phrase ("Thursday", "tomorrow", "next Monday",
 * "this Friday", "Thursday afternoon") to a calendar date key
 * (`YYYY-MM-DD`) in the tenant's timezone — WITHOUT requiring a
 * time-of-day or daypart.
 *
 * (2026-08-09, Task 10 quality-review C1) This is the lookup-side sibling
 * of `resolveDateTime`, which this module's OTHER exported function
 * intentionally REFUSES a bare day for (`ambiguous_no_time`) — booking a
 * bare "Thursday" is meaningless, there's no time to reserve. But a
 * day/window LOOKUP ("who's free Thursday?", "what's Mike's day look
 * like Monday?") has NOTHING to book; it only needs to know WHICH DAY.
 * `ai/skills/lookup-crew-schedule.ts` used to call `resolveDateTime` for
 * this and silently answered about TODAY for every bare-day phrase —
 * "Thursday", "tomorrow", "Monday", "this Friday", "next week" all
 * failed with `ambiguous_no_time` and fell through to a today-default,
 * even though the classifier prompt actively instructs callers to speak
 * exactly those phrasings. One shared chrono parse, two contracts:
 * `resolveDateTime` needs a time to book; this needs ONLY the day.
 *
 * Returns `null` when the phrase is empty, unparseable, or the tenant
 * zone is invalid — callers must treat `null` as "couldn't tell which
 * day was meant," never guess a day.
 *
 * ── NOT A DEADLINE RESOLVER (2026-08-09, review follow-up J4) ────────────
 *
 * This answers "WHICH ONE CALENDAR DAY did they mean?". It does NOT answer
 * "where does this deadline RANGE end?", and the two are different
 * questions for any phrase naming a period rather than a day. Measured,
 * reference Thu 2026-06-11 America/New_York:
 *
 *   "end of the week"        -> 2026-06-18   (a deadline reading wants 06-14)
 *   "by the end of the month"-> 2026-07-11   (a deadline reading wants 06-30)
 *   "this week"              -> 2026-06-12
 *   "the weekend"            -> 2026-06-13
 *   "last Friday"            -> 2026-06-12   (`forwardDate: true` flips a
 *                                             backward phrase forward)
 *
 * Both current callers are day-shaped and safe: `lookup-crew-schedule.ts`
 * genuinely wants one day, and `lookup-materials.ts` uses the resolved day
 * as a bracketed [day, day+1) window whose label it ALWAYS speaks back, so
 * a range phrase surfaces as an audible mismatch rather than a silent wrong
 * answer. Do NOT add a deadline/range caller without first building a
 * resolver with that contract — widening this one in place would silently
 * change what both existing callers report.
 */
export function resolveSpokenDay(phrase: string, opts: ResolveDateTimeOptions = {}): string | null {
  const timezone = isValidTimezone(opts.timezone) ? opts.timezone : DEFAULT_TENANT_TIMEZONE;
  const now = opts.now ?? new Date();
  const text = (phrase ?? '').trim();
  if (!text) return null;

  // Same tenant-local reference-date construction as resolveDateTime, so
  // "tomorrow"/"next Thursday" anchor to the tenant's today, not the
  // server's — see that function's own comment for the full rationale.
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

  const results = chrono.parse(text, referenceDate, { forwardDate: true });
  if (results.length === 0) return null;

  const start = results[0].start;
  const year = start.get('year');
  const month = start.get('month');
  const dayOfMonth = start.get('day');
  if (year == null || month == null || dayOfMonth == null) return null;

  // Render at LOCAL midnight in the tenant zone (no time component at
  // all is needed) and format as YYYY-MM-DD.
  const dt = DateTime.fromObject({ year, month, day: dayOfMonth }, { zone: timezone });
  if (!dt.isValid) return null;
  return dt.toFormat('yyyy-MM-dd');
}

/**
 * Human-readable, tenant-local rendering of a resolved UTC instant for the
 * spoken read-back ("Tuesday, June 3 at 2:00 PM"). Reuses the Intl pattern
 * already used across the ai/skills/lookup-* formatters.
 */
export function formatForReadback(utcIso: string, timezone: string): string {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TENANT_TIMEZONE;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(utcIso));
}

/** Render just the clock time in tenant tz ("2:00 PM") — for arrival windows. */
export function formatTimeForReadback(utcIso: string, timezone: string): string {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TENANT_TIMEZONE;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(utcIso));
}
