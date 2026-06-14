/**
 * User-facing greeting helpers — first name from Clerk profile and
 * time-of-day salutation in the tenant timezone.
 */

export function firstNameFromUser(
  fullName: string | null | undefined,
  email?: string | null,
): string {
  if (fullName?.trim()) {
    return fullName.trim().split(/\s+/)[0] ?? 'there';
  }
  const local = email?.split('@')[0]?.trim();
  if (local) return local;
  return 'there';
}

export function timeOfDayGreeting(now: Date, timeZone: string): string {
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: 'numeric',
        hour12: false,
      }).format(now),
    );
  } catch {
    hour = now.getHours();
  }
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function homeGreetingHeading(
  firstName: string,
  now: Date,
  timeZone: string,
): string {
  const period = timeOfDayGreeting(now, timeZone);
  const hour = (() => {
    try {
      return Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone,
          hour: 'numeric',
          hour12: false,
        }).format(now),
      );
    } catch {
      return now.getHours();
    }
  })();
  const emoji = hour < 12 ? '☀️' : hour < 17 ? '👋' : '🌙';
  return `${period}, ${firstName} ${emoji}`;
}
