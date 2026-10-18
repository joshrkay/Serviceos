import type { ChoiceEntry } from '../schema';
import { buildTradeRegistry } from './common';

/** Any pack without dedicated wording (painting, roofing, remodel, landscaping, concrete, other). */
export const GENERIC_CHOICES: ChoiceEntry[] = buildTradeRegistry({
  tradeNoun: 'service',
  emergencyExample: "something's failed and there's damage happening right now",
  priceAsk: 'what the job would run them',
});
