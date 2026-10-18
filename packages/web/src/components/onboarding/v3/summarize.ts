/**
 * Plain-language summaries of an onboarding draft for the Ready screen and the
 * read-back. Pure: everything comes from the draft the server assembled, so the
 * wording the owner sees is the wording the server will save.
 *
 * Resolution mirrors the server (onboarding/draft/approve.ts resolveChoices):
 * a free-speech override wins, then the staged option, then the option most
 * shops pick.
 */
import {
  ONBOARDING_CORE_CHOICE_KEYS,
  formatUsdCentsFixed,
  type OnboardingChoiceKey,
  type OnboardingCoreChoiceKey,
  type OnboardingDraft,
  type OnboardingPriceTier,
} from '@ai-service-os/shared';

export const CHOICE_COUNT = ONBOARDING_CORE_CHOICE_KEYS.length;

export interface ResolvedChoice {
  key: OnboardingChoiceKey;
  /** The picked option's label, the override's wording, or the default's label. */
  label: string;
  source: 'a' | 'b' | 'override';
  /** True when the answer is the option most shops pick. */
  isMostShops: boolean;
  prices?: OnboardingPriceTier;
}

export function resolveChoice(draft: OnboardingDraft, key: OnboardingChoiceKey): ResolvedChoice | null {
  const choice = draft.assembled.choices.find((c) => c.settingKey === key);
  if (!choice) return null;
  const staged = draft.choices[key];
  if (staged && 'override' in staged) {
    return { key, label: staged.override.label, source: 'override', isMostShops: false, prices: staged.override.prices };
  }
  const picked = staged && 'option' in staged ? staged.option : choice.mostShops;
  const option = choice.options[picked === 'a' ? 0 : 1];
  return { key, label: option.label, source: picked, isMostShops: picked === choice.mostShops, prices: option.prices };
}

/** "$89" for whole dollars, "$89.50" otherwise: the same rule the server uses in its option labels. */
export function dollars(cents: number): string {
  const fixed = formatUsdCentsFixed(cents);
  return fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed;
}

const TRADE_ADJECTIVE: Record<string, string> = { plumbing: 'plumbing', hvac: 'HVAC', electrical: 'electrical' };
const TRADE_PEOPLE: Record<string, string> = { plumbing: 'plumbers', hvac: 'HVAC shops', electrical: 'electricians' };

/** The city only when the prices really are that city's; otherwise the copy drops it. */
function cityFor(draft: OnboardingDraft): string | null {
  return draft.assembled.showsCity && draft.metroName ? draft.metroName : null;
}

/** "most Cleveland plumbing shops" / "most plumbing shops" / "most shops like yours". */
export function typicalShopPhrase(draft: OnboardingDraft): string {
  const city = cityFor(draft);
  const adjective = TRADE_ADJECTIVE[draft.assembled.trade];
  const shops = adjective ? `${adjective} shops` : 'shops like yours';
  return `most ${city ? `${city} ` : ''}${shops}`;
}

/** The sentence under the price on the read-back. */
export function pricesNote(draft: OnboardingDraft): string {
  const city = cityFor(draft);
  const people = TRADE_PEOPLE[draft.assembled.trade] ?? 'shops like yours';
  return `Typical for ${city ? `${city} ` : ''}${people}. Most new owners start here and adjust after a few jobs.`;
}

export type ReadyRowId = 'greeting' | 'trip_fee_and_rate' | 'booking' | 'payment_collection_mode' | 'emergency_target';

export interface ReadyRow {
  id: ReadyRowId;
  label: string;
  value: string;
  /** Show the "Most shops" mark: every answer behind this row is the typical one. */
  mostShops: boolean;
}

function priceValue(choice: ResolvedChoice | null, shape: (trip: string, rate: string) => string): string {
  if (!choice) return '';
  if (!choice.prices) return choice.label;
  return shape(dollars(choice.prices.tripFeeCents), dollars(choice.prices.hourlyRateCents));
}

/** The finished shop as the Ready screen shows it. A row is dropped when the draft lacks its choice. */
export function readyRows(draft: OnboardingDraft): ReadyRow[] {
  const get = (key: OnboardingChoiceKey) => resolveChoice(draft, key);
  const greeting = get('greeting');
  const price = get('trip_fee_and_rate');
  const hours = get('booking_hours');
  const posture = get('booking_posture');
  const paid = get('payment_collection_mode');
  const emergency = get('emergency_target');

  const rows: Array<ReadyRow | null> = [
    greeting && { id: 'greeting', label: 'Answering as', value: `“${greeting.label}”`, mostShops: greeting.isMostShops },
    price && {
      id: 'trip_fee_and_rate',
      label: 'To come out',
      value: priceValue(price, (trip, rate) => `${trip}, then ${rate} an hour`),
      mostShops: price.isMostShops,
    },
    hours && posture && {
      id: 'booking',
      label: 'Booking',
      value: `${hours.label}. ${posture.label}.`,
      mostShops: hours.isMostShops && posture.isMostShops,
    },
    paid && { id: 'payment_collection_mode', label: 'Getting paid', value: paid.label, mostShops: paid.isMostShops },
    emergency && { id: 'emergency_target', label: 'Emergencies', value: emergency.label, mostShops: emergency.isMostShops },
  ];
  return rows.filter((r): r is ReadyRow => r !== null);
}

const READBACK_LABEL: Record<OnboardingCoreChoiceKey, string> = {
  greeting: 'Answering as',
  trip_fee_and_rate: 'Prices',
  booking_posture: 'Booking',
  payment_collection_mode: 'Getting paid',
  booking_hours: 'Hours',
  emergency_target: 'Emergencies',
  after_hours_mode: 'After hours',
};

export interface ReadbackRow {
  key: OnboardingCoreChoiceKey;
  label: string;
  value: string;
  /** A second, muted line; only the price row has one. */
  note?: string;
}

/** One row per core choice, in the order Rivet asks them, showing what will be saved. */
export function readbackRows(draft: OnboardingDraft): ReadbackRow[] {
  const rows: ReadbackRow[] = [];
  for (const key of ONBOARDING_CORE_CHOICE_KEYS) {
    const choice = resolveChoice(draft, key);
    if (!choice) continue;
    if (key === 'trip_fee_and_rate') {
      rows.push({
        key,
        label: READBACK_LABEL[key],
        value: priceValue(choice, (trip, rate) => `${trip} to come out, ${rate} an hour after`),
        ...(choice.source === 'override' ? {} : { note: pricesNote(draft) }),
      });
      continue;
    }
    rows.push({ key, label: READBACK_LABEL[key], value: choice.label });
  }
  return rows;
}
