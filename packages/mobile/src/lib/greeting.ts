// Time-of-day greeting for the Home/Today header. Pure so it unit-tests
// without a renderer; the hour is read in the tenant's timezone when one is
// given (falls back to the device zone, matching the read-screen date helpers).

function hourInZone(date: Date, timeZone?: string): number {
  if (!timeZone) return date.getHours();
  const hour = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone,
  }).formatToParts(date).find((p) => p.type === 'hour')?.value;
  // Some engines emit "24" for midnight under hour12:false — normalize to 0.
  return Number(hour ?? 0) % 24;
}

/** "Good morning" (<12), "Good afternoon" (<17), else "Good evening". */
export function greetingForDate(date: Date = new Date(), timeZone?: string): string {
  const hour = hourInZone(date, timeZone);
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
