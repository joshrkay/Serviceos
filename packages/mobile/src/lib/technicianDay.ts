function dateTimeOptions(timeZone?: string): Intl.DateTimeFormatOptions {
  return timeZone ? { timeZone } : {};
}

export function tenantLocalDate(now: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...dateTimeOptions(timeZone),
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  return `${year}-${month}-${day}`;
}

export function formatAppointmentWindow(
  scheduledStart: string,
  scheduledEnd: string,
  timeZone?: string,
): string {
  const start = new Date(scheduledStart);
  const end = new Date(scheduledEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...dateTimeOptions(timeZone),
  });
  return `${formatter.format(start)}–${formatter.format(end)}`;
}

export function technicianStatusLabel(status: string): string {
  const words = status.replaceAll('_', ' ');
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}
