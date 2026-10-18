import type { ChoiceEntry } from '../schema';
import { buildTradeRegistry } from './common';

export const HVAC_CHOICES: ChoiceEntry[] = buildTradeRegistry({
  tradeNoun: 'heating and cooling',
  emergencyExample: "my AC just stopped, it's 104 in here, and my mom is on oxygen",
  priceAsk: 'what a new condenser would run them',
});
