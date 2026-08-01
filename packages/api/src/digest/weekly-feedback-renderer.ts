/**
 * Epic 12.6 — Weekly feedback email renderer (pure).
 *
 * Renders a performance snapshot + wins/misses/actions into a subject + plain
 * text + minimal HTML. No external template engine: a tiny, dependency-free
 * builder keeps it unit-testable and safe (all interpolated values are
 * numbers/escaped strings).
 */
import type { WeeklyFeedbackSnapshot, WeeklySuggestions } from './weekly-feedback';

export interface RenderedWeeklyEmail {
  subject: string;
  text: string;
  html: string;
}

export interface RenderWeeklyOptions {
  businessName?: string;
}

// Hoisted so we don't construct an Intl formatter on every call.
const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');

function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${NUMBER_FORMATTER.format(Math.abs(Math.round(cents / 100)))}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtRange(startIso: string, endIso: string): string {
  const start = DATE_FORMATTER.format(new Date(startIso));
  // weekEnd is exclusive (the next Monday); show the inclusive last day.
  const lastDay = new Date(new Date(endIso).getTime() - 24 * 60 * 60 * 1000);
  const end = DATE_FORMATTER.format(lastDay);
  return `${start} – ${end}`;
}

export function renderWeeklyFeedbackEmail(
  snapshot: WeeklyFeedbackSnapshot,
  suggestions: WeeklySuggestions,
  opts: RenderWeeklyOptions = {},
): RenderedWeeklyEmail {
  const range = fmtRange(snapshot.weekStartIso, snapshot.weekEndIso);
  const subject = `Your week: ${dollars(snapshot.revenueCents)} collected, ${snapshot.jobsCompleted} ${
    snapshot.jobsCompleted === 1 ? 'job' : 'jobs'
  } done`;

  const stats: Array<[string, string]> = [
    ['Revenue', dollars(snapshot.revenueCents)],
    ['Jobs completed', String(snapshot.jobsCompleted)],
    ['Jobs booked', String(snapshot.jobsBooked)],
    ['Estimates sent', String(snapshot.estimatesSent)],
    ['Calls answered', String(snapshot.callsAnswered)],
    ['New leads', String(snapshot.newLeads)],
    ['Outstanding', dollars(snapshot.outstandingCents)],
  ];

  const section = (title: string, items: string[]): string[] =>
    items.length === 0 ? [] : [`${title}:`, ...items.map((i) => `  • ${i}`), ''];

  const greeting = opts.businessName ? `Here’s ${opts.businessName}’s week (${range}).` : `Here’s your week (${range}).`;

  // WS22 — "same mistake twice" honest line. Omitted when the snapshot
  // carries no repeatCorrections (repo/method not wired, or zero corrections
  // this week — the builder already applies the "omit if zero" rule).
  const rc = snapshot.repeatCorrections;
  const repeatCorrectionsLine =
    rc && rc.total > 0
      ? `Of ${rc.total} correction${rc.total === 1 ? '' : 's'} this week, ${rc.repeats} ${
          rc.repeats === 1 ? 'was a repeat' : 'were repeats'
        } of an earlier correction (${rc.rate}%).`
      : null;

  const textLines = [
    greeting,
    '',
    ...stats.map(([k, v]) => `${k}: ${v}`),
    '',
    ...section('Wins', suggestions.wins),
    ...section('Worth watching', suggestions.misses),
    ...section('Suggested next steps', suggestions.actions),
    ...(repeatCorrectionsLine ? [repeatCorrectionsLine, ''] : []),
  ];
  const text = textLines.join('\n').trim();

  const statRows = stats
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${escapeHtml(k)}</td><td style="padding:4px 0;font-weight:600;color:#0f172a">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  const list = (title: string, items: string[]): string =>
    items.length === 0
      ? ''
      : `<h3 style="margin:16px 0 6px;color:#0f172a;font-size:15px">${escapeHtml(title)}</h3><ul style="margin:0;padding-left:18px;color:#334155">${items
          .map((i) => `<li style="margin:2px 0">${escapeHtml(i)}</li>`)
          .join('')}</ul>`;

  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">`,
    `<p style="color:#334155">${escapeHtml(greeting)}</p>`,
    `<table style="border-collapse:collapse;margin:8px 0">${statRows}</table>`,
    list('Wins', suggestions.wins),
    list('Worth watching', suggestions.misses),
    list('Suggested next steps', suggestions.actions),
    repeatCorrectionsLine
      ? `<p style="color:#64748b;font-size:13px;margin-top:16px">${escapeHtml(repeatCorrectionsLine)}</p>`
      : '',
    `</div>`,
  ].join('');

  return { subject, text, html };
}
