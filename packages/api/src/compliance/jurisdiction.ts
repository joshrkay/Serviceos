import { normalizeUsState, zonesForState } from './us-geography';

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
  /** The first instant a send is allowed — `now` itself when allowed now. */
  nextAllowedAt: Date;
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
 * Who a customer text is going to, as far as the send window cares.
 */
export interface RecipientLocale {
  /**
   * The tenant's IANA zone, or null when unknown (never chosen, or invalid) —
   * then the window must be open in every US zone at once
   * (`US_RECIPIENT_ZONES`), never a guessed one.
   */
  tenantTimezone: string | null;
  /**
   * The customer's service-location states, as stored (free text: "FL",
   * "Florida", "Fla." all count). None recognised = residence unknown, which
   * gets the strictest (20:00) close.
   */
  serviceStates: readonly string[];
  /**
   * The state the phone's NANP area code belongs to. Its zones join the
   * window and an early-close state tightens the close (the Florida and
   * Oklahoma acts presume an in-state area code is a resident); it never
   * relaxes either, because a number travels with its owner.
   */
  areaCodeState: string | null;
}

/**
 * US quiet hours — the send window for a NON-transactional customer text:
 * open 08:00 (inclusive) to 21:00 (exclusive), or 20:00 for an early-close
 * state or an unknown residence, in EVERY zone the text could land in: the
 * tenant's zone (all US zones when unknown) plus every zone of each
 * recognised service-location state and of the area-code state. Requiring
 * all of them can only shrink the window. Consumed by GatedMessageDelivery
 * for texts tagged `quietHours: 'defer'`.
 */
export function recipientQuietHours(
  locale: RecipientLocale,
  now: Date = new Date(),
): QuietHoursResult {
  const serviceStates = locale.serviceStates
    .map(normalizeUsState)
    .filter((code): code is string => code !== null);
  const areaCodeState = locale.areaCodeState ? normalizeUsState(locale.areaCodeState) : null;
  const residenceStates = [...serviceStates, ...(areaCodeState ? [areaCodeState] : [])];

  // No recognised service address → assume the strictest close rather than guess.
  const earlyClose =
    serviceStates.length === 0 || residenceStates.some((code) => EARLY_CLOSE_STATES.has(code));
  const endHour = earlyClose ? EARLY_CLOSE_END_HOUR : WINDOW_END_HOUR;
  const zones = new Set<string>(locale.tenantTimezone ? [locale.tenantTimezone] : US_RECIPIENT_ZONES);
  for (const code of residenceStates) for (const zone of zonesForState(code)) zones.add(zone);
  return sendWindow([...zones], now, endHour);
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
  endHour: number,
): QuietHoursResult {
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
