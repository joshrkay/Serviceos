const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABEL: Record<string, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

type DayHours = { open: string; close: string } | null;

function formatTime(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12} ${period}` : `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

/** Public-facing one-line summary of tenant business hours for intake forms. */
export function formatBusinessHoursSummary(
  businessHours: unknown,
  timezone: string | null | undefined,
): string | null {
  if (!businessHours || typeof businessHours !== 'object') return null;
  const hours = businessHours as Record<string, DayHours>;
  const openDays = DAY_ORDER.filter((d) => hours[d] != null);
  if (openDays.length === 0) return null;

  const first = hours[openDays[0]!]!;
  const allSame = openDays.every(
    (d) =>
      hours[d]?.open === first.open && hours[d]?.close === first.close,
  );

  const tz = timezone ? timezone.replace(/_/g, ' ') : null;
  const range = `${formatTime(first.open)} – ${formatTime(first.close)}`;

  if (allSame && openDays.length === 7) {
    return tz ? `Daily ${range} (${tz})` : `Daily ${range}`;
  }
  if (allSame && openDays.length >= 2) {
    const span = `${DAY_LABEL[openDays[0]!]!}–${DAY_LABEL[openDays[openDays.length - 1]!]!}`;
    return tz ? `${span} ${range} (${tz})` : `${span} ${range}`;
  }

  const parts = openDays.map((d) => {
    const h = hours[d]!;
    return `${DAY_LABEL[d]} ${formatTime(h.open)}–${formatTime(h.close)}`;
  });
  const summary = parts.join(', ');
  return tz ? `${summary} (${tz})` : summary;
}
