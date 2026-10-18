/**
 * The choice registry: per-trade content for the seven this-or-this onboarding
 * choices (plus the optional established-shop one), validated at module load.
 *
 * Trades with their own wording: plumbing, hvac, electrical. Every other pack
 * id (painting, roofing, gc_remodel, landscaping, concrete, other) uses the
 * generic wording; the pack still drives prices and templates.
 */
import {
  TradeChoiceRegistrySchema,
  type AnyChoiceKey,
  type ChoiceEntry,
  type TradeChoiceRegistry,
} from './schema';
import { PLUMBING_CHOICES } from './registry/plumbing';
import { HVAC_CHOICES } from './registry/hvac';
import { ELECTRICAL_CHOICES } from './registry/electrical';
import { GENERIC_CHOICES } from './registry/generic';

export const REGISTRY_TRADES = ['plumbing', 'hvac', 'electrical', 'generic'] as const;
export type RegistryTrade = (typeof REGISTRY_TRADES)[number];

export const CHOICE_REGISTRY: Readonly<Record<RegistryTrade, TradeChoiceRegistry>> = {
  plumbing: TradeChoiceRegistrySchema.parse(PLUMBING_CHOICES),
  hvac: TradeChoiceRegistrySchema.parse(HVAC_CHOICES),
  electrical: TradeChoiceRegistrySchema.parse(ELECTRICAL_CHOICES),
  generic: TradeChoiceRegistrySchema.parse(GENERIC_CHOICES),
};

/** Map a pack id (what the owner picked or the signup carried) to a registry trade. */
export function registryTradeForPack(packId: string): RegistryTrade {
  switch (packId) {
    case 'plumbing':
    case 'hvac':
    case 'electrical':
      return packId;
    default:
      return 'generic';
  }
}

export function getChoiceRegistry(packId: string): TradeChoiceRegistry {
  return CHOICE_REGISTRY[registryTradeForPack(packId)];
}

export function getChoiceEntry(packId: string, key: AnyChoiceKey): ChoiceEntry {
  const entry = getChoiceRegistry(packId).find((e) => e.settingKey === key);
  if (!entry) {
    // Unreachable for a validated registry; kept as a hard failure rather than a silent undefined.
    throw new Error(`choice registry for "${packId}" has no entry "${key}"`);
  }
  return entry;
}
