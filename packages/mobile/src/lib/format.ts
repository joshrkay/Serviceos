// Display formatters shared by the read screens. Money is always integer cents
// (never float math); dates render in the tenant's timezone per CLAUDE.md.
import { formatUsdCentsFixed } from '@ai-service-os/shared';

/** Integer cents → "$1,234.56" (or "-$20.00"). Delegates to the cross-package
 *  canonical so detail-screen money matches the web/api rendering exactly. */
export const formatMoneyCents = formatUsdCentsFixed;

/**
 * Integer cents → whole dollars for at-a-glance dashboard figures, e.g.
 * "$1,234" / "-$200". Rounds to the nearest dollar (cents are noise at the
 * dashboard altitude); the detail screens use {@link formatMoneyCents}.
 */
export function formatMoneyShort(cents: number): string {
  const dollars = Math.round(Math.abs(cents) / 100);
  // No sign when the magnitude rounds to $0 — otherwise -$0.40 renders "-$0".
  const sign = cents < 0 && dollars !== 0 ? '-' : '';
  return `${sign}$${dollars.toLocaleString('en-US')}`;
}

/**
 * Short calendar date in the tenant's timezone (falls back to the device zone
 * when none is given). UTC instants are stored server-side; this renders them
 * in the business's local time.
 */
export function formatShortDate(
  value: string | number | Date | null | undefined,
  timeZone?: string,
): string {
  if (value === null || value === undefined) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/** Long weekday + short date for the dashboard header, e.g. "Saturday, Jun 20". */
export function formatWeekdayDate(
  value: string | number | Date | null | undefined,
  timeZone?: string,
): string {
  if (value === null || value === undefined) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}
