/**
 * Shared spoken-output formatting helpers used by the lookup-skill family.
 *
 * These are pure, zero-dependency utilities — no DB access, no I/O.
 * All three helpers are intentionally kept together so a single import
 * covers the common voice-formatting surface; adding a new lookup skill
 * should not require duplicating them.
 *
 * Formatting contract: output must read correctly on both TTS engines
 * (Amazon Polly and Google Cloud TTS). In practice that means:
 *   - Dollar amounts as "$120.50" (not "120 dollars 50 cents" — that
 *     confuses Polly's number-interpretation heuristic).
 *   - No markdown, no HTML entities, no trailing punctuation added here
 *     (the caller's sentence owns punctuation).
 */
import { formatUsdCentsPlain } from '@ai-service-os/shared';

/**
 * Simple pluralisation helper.
 *
 * plural(1, 'appointment')          → 'appointment'
 * plural(3, 'appointment')          → 'appointments'
 * plural(1, 'approval is', 'approvals are') → 'approval is'
 * plural(2, 'approval is', 'approvals are') → 'approvals are'
 */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/**
 * Format an integer-cents amount as a USD dollar string suitable for TTS.
 * Delegates to the cross-package `formatUsdCentsPlain` (bare `$N.NN`, no
 * thousands separators) — separators confuse Polly's number heuristic, which
 * is exactly the terse contract that helper provides.
 *
 * formatCents(45000) → '$450.00'
 * formatCents(0)     → '$0.00'
 */
export function formatCents(cents: number): string {
  return formatUsdCentsPlain(cents);
}

/**
 * Alias for formatCents — used by lookup-pending-items which names the
 * helper "formatUsd" internally for readability. Both produce identical
 * output; the alias keeps callers in sync without a rename.
 */
export const formatUsd = formatCents;

/**
 * "8 hours", "1 hour", "4.5 hours" — spoken (and card-row) duration.
 * Takes HOURS (a float; `TimeEntryService.weeklyHoursByUser`'s
 * `totalHours` is already hours). A caller holding MINUTES
 * (`JobProfit.laborMinutes`) divides by 60 first — one shared rounding
 * rule beats two independently-rounded copies drifting apart.
 *
 * (2026-08-09, Task 10 quality-review I2/I4) — this used to be copied
 * into lookup-job-profit.ts (minutes-based) AND lookup-timesheets.ts
 * (hours-based) separately; worse, voice-lookup-answer.ts's timesheet
 * ROW builder didn't call either copy at all and spoke the raw 2-decimal
 * `totalHours` value directly ("7.83 hrs" on the card vs. "7.8 hours" in
 * the spoken summary) — one shared formatter, used by BOTH the skill's
 * summary and the router's row, closes that gap by construction.
 */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${rounded === 1 ? 'hour' : 'hours'}`;
}

/**
 * "9 AM", "2:30 PM" — a UTC instant rendered as a bare clock time in the
 * given IANA timezone, with a bare-hour ":00" dropped so "1:00 PM" speaks
 * as "1 PM". Shared by every lookup skill that reads back a schedule
 * (day overview, crew schedule, my-day) — previously three byte-identical
 * copies (quality-review I2).
 */
export function formatTime(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
    timeZone: timezone,
  })
    .format(d)
    .replace(':00', '');
}

/**
 * "Mike Diaz" from first/last name, falling back to the email when both
 * are absent (invited-but-unnamed team members). Shared by every lookup
 * skill that names a crew member — previously three byte-identical
 * copies (quality-review I2).
 */
export function technicianDisplayName(u: {
  firstName?: string;
  lastName?: string;
  email: string;
}): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
}

/**
 * Join items into natural spoken English: "Mike" / "Mike and Carlos" /
 * "Mike, Carlos and Dana". Mirrors the cost-clause join
 * `lookup-job-profit.ts`'s `formatJobProfitSummary` already used ("you
 * spent $320 on materials and 3 hours of labor") — lifted here so every
 * lookup skill speaks a list the same way (quality-review I3) instead of
 * joining with bare commas and only remembering "and" for a truncated
 * tail (a capped list read "...Dana, and 5 more" while an uncapped one
 * read "...Carlos, Mike, Dana." with no "and" at all). A "N more" tail is
 * just another list item — pass it as the last element of `items` rather
 * than concatenating it separately.
 */
export function spokenList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
