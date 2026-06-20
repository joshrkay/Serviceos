// Display formatters shared by the read screens. Money is always integer cents
// (never float math); dates render in the tenant's timezone per CLAUDE.md.

/** Integer cents → "$1,234.56" (or "-$20.00"). */
export function formatMoneyCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const rem = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars}.${rem}`;
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
