const US_RECORDING_DISCLOSURE_STATES = new Set([
  'CA',
  'FL',
  'IL',
  'MD',
  'MA',
  'MT',
  'NV',
  'NH',
  'PA',
  'WA',
]);

const SMS_OPT_IN_LANGUAGE =
  'By providing your phone number, you agree to receive recurring automated marketing and service-related text messages. Consent is not a condition of purchase. Message and data rates may apply. Reply STOP to unsubscribe, HELP for help.';

const UNSUBSCRIBE_FOOTER =
  'To stop receiving these emails, use the unsubscribe link in this message or reply with "unsubscribe". Include your mailing address in all commercial email communications.';

export interface QuietHoursResult {
  isAllowedNow: boolean;
  nextAllowedAt: Date;
  localHour: number;
}

function getLocalHour(now: Date, recipientTimezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: recipientTimezone,
    hour: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const hourPart = parts.find((part) => part.type === 'hour')?.value ?? '0';
  return parseInt(hourPart, 10) % 24;
}

export function requiresRecordingDisclosure(region: string): boolean {
  const normalized = region.trim().toUpperCase();
  return US_RECORDING_DISCLOSURE_STATES.has(normalized);
}

export function smsOptInLanguage(): string {
  return SMS_OPT_IN_LANGUAGE;
}

export function requires10dlcRegistration(): boolean {
  return true;
}

export function unsubscribeFooter(): string {
  return UNSUBSCRIBE_FOOTER;
}

/**
 * US quiet-hours compliance helper.
 *
 * Enforces 8:00–21:00 recipient-local contact window (inclusive of 8:00,
 * exclusive of 21:00). Returns a contract callers can use for queueing logic.
 */
export function quietHours(
  recipientTimezone: string,
  now: Date = new Date()
): QuietHoursResult {
  const localHour = getLocalHour(now, recipientTimezone);
  const isAllowedNow = localHour >= 8 && localHour < 21;

  if (isAllowedNow) {
    return { isAllowedNow, nextAllowedAt: new Date(now), localHour };
  }

  const nextAllowedAt = new Date(now);
  nextAllowedAt.setUTCMinutes(0, 0, 0);

  for (let i = 0; i < 48; i += 1) {
    nextAllowedAt.setUTCHours(nextAllowedAt.getUTCHours() + 1);
    const hour = getLocalHour(nextAllowedAt, recipientTimezone);
    if (hour >= 8 && hour < 21) {
      return { isAllowedNow, nextAllowedAt, localHour };
    }
  }

  return { isAllowedNow, nextAllowedAt, localHour };
}
