import type { ChoiceEntry } from '../schema';
import { buildTradeRegistry } from './common';

export const ELECTRICAL_CHOICES: ChoiceEntry[] = buildTradeRegistry({
  tradeNoun: 'electrical',
  emergencyExample: 'my panel is sparking and I smell something burning',
  priceAsk: 'what a panel upgrade would run them',
});
