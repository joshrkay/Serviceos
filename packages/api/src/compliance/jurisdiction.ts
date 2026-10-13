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
  return { ...sendWindow([recipientTimezone], now), localHour };
}

/**
 * Who a customer text is going to, as far as the send window cares.
 */
export interface RecipientLocale {
  /**
   * The recipient's IANA zone, or null when unknown — then the window must be
   * open in every US zone at once (`US_RECIPIENT_ZONES`), never a guessed one.
   */
  timezone: string | null;
  /** US states the recipient is associated with (service address, area code). */
  states: readonly string[];
}

/**
 * The recipient-local send window for a NON-transactional customer text.
 * `nextAllowedAt` is the first instant the text may go out (`now` itself when
 * it may go out now).
 */
export function recipientQuietHours(
  locale: RecipientLocale,
  now: Date = new Date(),
): Omit<QuietHoursResult, 'localHour'> {
  // No known state → assume the strictest close rather than guess.
  const earlyClose =
    locale.states.length === 0 ||
    locale.states.some((s) => EARLY_CLOSE_STATES.has(s.trim().toUpperCase()));
  const endHour = earlyClose ? EARLY_CLOSE_END_HOUR : WINDOW_END_HOUR;
  const zones = locale.timezone ? [locale.timezone] : US_RECIPIENT_ZONES;
  return sendWindow(zones, now, endHour);
}

/**
 * Every zone a US recipient of unknown location could be in, east to west.
 * Requiring all of them leaves a daily window (≈14:00–20:00 Eastern) that is
 * inside 08:00–20:00 for every one.
 */
const US_RECIPIENT_ZONES: readonly string[] = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
];

const WINDOW_START_HOUR = 8;
/** Federal TCPA: no contact at or after 21:00 recipient-local. */
const WINDOW_END_HOUR = 21;
/**
 * States whose telephone-solicitation statutes close the window at 20:00:
 * Florida (Telephone Solicitation Act), Oklahoma (Telephone Solicitation Act),
 * Maryland (Stop the Spam Calls Act) and Washington (RCW 80.36). Other state
 * rules (Sunday/holiday bans, later start hours) are NOT modelled here; they
 * are a counsel decision.
 */
const EARLY_CLOSE_STATES: ReadonlySet<string> = new Set(['FL', 'OK', 'MD', 'WA']);
const EARLY_CLOSE_END_HOUR = 20;

/**
 * NANPA area codes (incl. overlays) of the early-close states. Florida's and
 * Oklahoma's acts presume a number with an in-state area code belongs to a
 * resident, so the area code counts even when the service address is
 * elsewhere. Keep this list current with NANPA: an extra code only makes a
 * window stricter, a missing one makes it too loose.
 */
const EARLY_CLOSE_AREA_CODES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    [
      '239', '305', '321', '324', '352', '386', '407', '448', '561', '645', '656',
      '689', '727', '728', '754', '772', '786', '813', '850', '863', '904', '941', '954',
    ].map((code) => [code, 'FL']),
  ),
  ...Object.fromEntries(['405', '539', '572', '580', '918'].map((code) => [code, 'OK'])),
  ...Object.fromEntries(['227', '240', '301', '410', '443', '667'].map((code) => [code, 'MD'])),
  ...Object.fromEntries(['206', '253', '360', '425', '509', '564'].map((code) => [code, 'WA'])),
};

/**
 * The early-close state a US (+1) number's area code belongs to, or null —
 * null means "not one of those states' codes", not "not a resident there".
 */
export function earlyCloseStateForPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  return EARLY_CLOSE_AREA_CODES[national.slice(0, 3)] ?? null;
}

function inWindow(now: Date, zones: readonly string[], endHour: number): boolean {
  return zones.every((zone) => {
    const hour = getLocalHour(now, zone);
    return hour >= WINDOW_START_HOUR && hour < endHour;
  });
}

/**
 * Allowed now when `now` is inside the window in every zone; otherwise the
 * first whole UTC hour after `now` at which it is (a 72-hour search bound —
 * any real window is found within a day).
 */
function sendWindow(
  zones: readonly string[],
  now: Date,
  endHour: number = WINDOW_END_HOUR,
): Omit<QuietHoursResult, 'localHour'> {
  if (inWindow(now, zones, endHour)) {
    return { isAllowedNow: true, nextAllowedAt: new Date(now) };
  }

  const nextAllowedAt = new Date(now);
  nextAllowedAt.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 72; i += 1) {
    nextAllowedAt.setUTCHours(nextAllowedAt.getUTCHours() + 1);
    if (inWindow(nextAllowedAt, zones, endHour)) break;
  }
  return { isAllowedNow: false, nextAllowedAt };
}
