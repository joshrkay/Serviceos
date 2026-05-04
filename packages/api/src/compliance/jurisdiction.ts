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

const US_SMS_OPT_IN_LANGUAGE =
  'By providing your number, you agree to receive automated text messages from us. Consent is not a condition of purchase. Msg & data rates may apply. Reply STOP to unsubscribe and HELP for help.';

const US_UNSUBSCRIBE_FOOTER =
  'To stop receiving marketing emails, use the unsubscribe link in this email or reply with unsubscribe preferences.';

export interface QuietHoursResult {
  allowedNow: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  localTime: string;
}

function normalizeRegion(region: string): string {
  return region.trim().toUpperCase();
}

export function requiresRecordingDisclosure(region: string): boolean {
  return US_RECORDING_DISCLOSURE_STATES.has(normalizeRegion(region));
}

export function smsOptInLanguage(): string {
  return US_SMS_OPT_IN_LANGUAGE;
}

export function requires10dlcRegistration(): boolean {
  return true;
}

export function unsubscribeFooter(): string {
  return US_UNSUBSCRIBE_FOOTER;
}

export function quietHours(recipientTimezone: string, now: Date = new Date()): QuietHoursResult {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: recipientTimezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const hourPart = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minutePart = parts.find((part) => part.type === 'minute')?.value ?? '00';

  const localHour = parseInt(hourPart, 10) % 24;
  const localMinute = parseInt(minutePart, 10);
  const minutesSinceMidnight = localHour * 60 + localMinute;

  const start = 8 * 60;
  const end = 21 * 60;

  const allowedNow = minutesSinceMidnight >= start && minutesSinceMidnight < end;

  return {
    allowedNow,
    quietHoursStart: '21:00',
    quietHoursEnd: '08:00',
    localTime: `${localHour.toString().padStart(2, '0')}:${localMinute
      .toString()
      .padStart(2, '0')}`,
  };
}
