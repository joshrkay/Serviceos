/**
 * Human-readable recurrence for service agreements.
 *
 * The API stores a constrained RRULE subset
 * (`FREQ=(MONTHLY|QUARTERLY|YEARLY)[;INTERVAL=n][;BYMONTHDAY=d]`,
 * packages/api/src/agreements/enums.ts). This turns that into a phrase for the
 * agreement card — pure, so it's unit-tested directly and never renders a raw
 * rule string at the operator.
 */

const FREQ_LABEL: Record<string, string> = {
  MONTHLY: 'month',
  QUARTERLY: 'quarter',
  YEARLY: 'year',
};

/** e.g. "Monthly", "Every 3 months", "Yearly on day 15". Falls back to the raw
 * rule when it isn't the recognized subset. */
export function describeRecurrence(rrule: string | undefined | null): string {
  if (!rrule) return '';
  const parts = new Map<string, string>();
  for (const seg of rrule.split(';')) {
    const [k, v] = seg.split('=');
    if (k && v) parts.set(k.toUpperCase(), v);
  }
  const freq = parts.get('FREQ');
  const unit = freq ? FREQ_LABEL[freq] : undefined;
  if (!unit) return rrule; // unrecognized — show it rather than mislabel

  const interval = Number(parts.get('INTERVAL') ?? '1');
  const base =
    interval > 1
      ? `Every ${interval} ${unit}s`
      : { month: 'Monthly', quarter: 'Quarterly', year: 'Yearly' }[unit] ?? `Every ${unit}`;

  const byMonthDay = parts.get('BYMONTHDAY');
  return byMonthDay ? `${base} on day ${byMonthDay}` : base;
}
