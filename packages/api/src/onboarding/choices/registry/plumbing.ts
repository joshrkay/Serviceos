import type { ChoiceEntry } from '../schema';
import { buildTradeRegistry } from './common';

export const PLUMBING_CHOICES: ChoiceEntry[] = buildTradeRegistry({
  tradeNoun: 'plumbing',
  emergencyExample: "there's water coming through my ceiling and my dad can't get upstairs to the shutoff",
  priceAsk: 'what a water heater would run them',
});
