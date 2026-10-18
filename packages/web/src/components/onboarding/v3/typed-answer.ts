/**
 * "Type instead", deterministically. Two turns can be answered by typing:
 * the greeting (free text) and the price (two dollar amounts, parsed to integer
 * cents on the client). The other five turns have no such control; S4 adds the
 * spoken and free-text override to them, so nothing on screen is dead today.
 *
 * Pure: the same values always give the same override or the same inline
 * messages, which is what the API will accept (a greeting override may write
 * only `voiceGreeting`; the price override must carry `prices`).
 */
import type { OnboardingChoiceKey, StagedOnboardingChoice } from '@ai-service-os/shared';
import { parseDollarsToCents } from './parse-dollars';
import { dollars } from './summarize';

/** A free-speech override as the API stages it: how the owner said it, the values it writes, and prices on the price turn. */
export type TypedOverride = Extract<StagedOnboardingChoice, { override: unknown }>['override'];

export type TypedKind = 'greeting' | 'price';

/** Which kind of typed answer a turn takes, or null for the five that take none. */
export function typedKind(key: OnboardingChoiceKey): TypedKind | null {
  if (key === 'greeting') return 'greeting';
  if (key === 'trip_fee_and_rate') return 'price';
  return null;
}

/** What the owner has typed so far. The turn keeps it so flipping to the cards and back loses nothing. */
export interface TypedValues {
  greeting: string;
  trip: string;
  rate: string;
}

export type TypedField = keyof TypedValues;
export type TypedErrors = Partial<Record<TypedField, string>>;

/** Either the override to stage, or what to tell the owner field by field. Never both. */
export type TypedResult = { override: TypedOverride; errors?: undefined } | { errors: TypedErrors; override?: undefined };

/** The greeting label is stored with the draft, which keeps at most this many characters. */
export const GREETING_MAX = 120;

const DOLLARS_HINT = 'Use dollars, like 120 or 89.50.';

export function typedAnswer(kind: TypedKind, values: TypedValues): TypedResult {
  if (kind === 'greeting') {
    const text = values.greeting.trim();
    if (!text) return { errors: { greeting: 'Type what you want me to say.' } };
    if (text.length > GREETING_MAX) return { errors: { greeting: `Keep it to ${GREETING_MAX} characters or fewer.` } };
    return { override: { label: text, writes: { voiceGreeting: text } } };
  }

  const tripFeeCents = parseDollarsToCents(values.trip);
  const hourlyRateCents = parseDollarsToCents(values.rate);
  const errors: TypedErrors = {};
  // A free trip is a real answer; a free hour is not.
  if (values.trip.trim() === '') errors.trip = 'Enter what you charge to come out.';
  else if (tripFeeCents === null) errors.trip = DOLLARS_HINT;
  if (values.rate.trim() === '' || hourlyRateCents === 0) errors.rate = 'Enter your hourly rate.';
  else if (hourlyRateCents === null) errors.rate = DOLLARS_HINT;
  if (errors.trip || errors.rate || tripFeeCents === null || hourlyRateCents === null) return { errors };
  return {
    override: {
      label: `${dollars(tripFeeCents)} to come out, then ${dollars(hourlyRateCents)} an hour`,
      writes: {},
      prices: { tripFeeCents, hourlyRateCents },
    },
  };
}

/** Blank, or the owner's earlier typed answer when one is already staged (resume and edit). */
export function initialTypedValues(staged: StagedOnboardingChoice | undefined): TypedValues {
  const override = staged && 'override' in staged ? staged.override : undefined;
  return {
    greeting: override?.writes.voiceGreeting ?? '',
    trip: override?.prices ? dollars(override.prices.tripFeeCents) : '',
    rate: override?.prices ? dollars(override.prices.hourlyRateCents) : '',
  };
}

/** True when the staged answer is one the owner typed. */
export function isTypedAnswer(staged: StagedOnboardingChoice | undefined): boolean {
  return staged !== undefined && 'override' in staged;
}
