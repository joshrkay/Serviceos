import { ALL_US_ZONES, normalizeUsState, placePhone, zonesForState } from './us-geography';

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
   * then the window must be open in every US zone at once (`ALL_US_ZONES`),
   * never a guessed one.
   */
  tenantTimezone: string | null;
  /**
   * The customer's service-location states, as stored (free text: "FL",
   * "Florida", "Fla." all count). None recognised = residence unknown, which
   * gets the strictest (20:00) close; an unrecognisable one also adds every
   * US zone.
   */
  serviceStates: readonly string[];
  /**
   * The recipient's number. Its NANP area code adds the zones it can ring in
   * (and an early-close state tightens the close: the Florida and Oklahoma
   * acts presume an in-state area code is a resident); a number that cannot
   * be placed adds every US zone. It never relaxes the close. Null when no
   * recipient is known (a tenant-level verdict).
   */
  phone: string | null;
  /**
   * The tenant's own business number. When its area code places it, those
   * zones are one more constraint — catching a tenant zone left at a
   * pre-migration-263 default.
   */
  tenantPhone: string | null;
}

/**
 * US quiet hours — the send window for a NON-transactional customer text:
 * open 08:00 (inclusive) to 21:00 (exclusive), or 20:00 for an early-close
 * state or an unknown residence, in EVERY zone the text could land in: the
 * tenant's zone (all US zones when unknown) and its business number's, plus
 * every zone of each service-location state and of the recipient's number.
 * Whatever cannot be placed counts as anywhere in the US. Requiring all of
 * them can only shrink the window. Consumed by GatedMessageDelivery for texts
 * tagged `quietHours: 'defer'`.
 */
export function recipientQuietHours(
  locale: RecipientLocale,
  now: Date = new Date(),
): QuietHoursResult {
  const zones = new Set<string>(locale.tenantTimezone ? [locale.tenantTimezone] : ALL_US_ZONES);
  const add = (list: readonly string[]) => list.forEach((zone) => zones.add(zone));

  const serviceStates: string[] = [];
  for (const raw of locale.serviceStates) {
    const code = normalizeUsState(raw);
    if (code) {
      serviceStates.push(code);
      add(zonesForState(code));
    } else if (raw.trim().length > 0) {
      add(ALL_US_ZONES); // a state we cannot read could be any state
    }
  }
  const recipient = locale.phone ? placePhone(locale.phone) : null;
  if (recipient) add(recipient.zones);
  const tenantPhone = locale.tenantPhone ? placePhone(locale.tenantPhone) : null;
  if (tenantPhone?.placed) add(tenantPhone.zones);

  // No recognised service address → assume the strictest close rather than guess.
  const earlyClose =
    serviceStates.length === 0 ||
    [...serviceStates, recipient?.state].some((code) => code != null && EARLY_CLOSE_STATES.has(code));
  const endHour = earlyClose ? EARLY_CLOSE_END_HOUR : WINDOW_END_HOUR;
  return sendWindow([...zones], now, endHour);
}

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
