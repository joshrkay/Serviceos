/**
 * assembleTypicalShop — the finished shop Rivet shows before asking anything.
 *
 * Takes the trade and the metro (from the owner's area code) and returns the
 * seven choices with every template token rendered, the price options priced
 * from the regional tier (metro → national → pack default), and the default
 * answer per choice (what most shops pick). Pure apart from the tier lookup;
 * no model call.
 */
import { formatUsdCentsPlain } from '@ai-service-os/shared';
import type { MetroLookup } from '../../compliance/us-geography';
import { getChoiceRegistry, registryTradeForPack, type RegistryTrade } from './registry';
import { resolvePriceTiers, type PriceTier, type PriceTierSource, type RegionalPriceTierRepository } from './price-tiers';
import type { AnyChoiceKey, ChoiceEntry, ChoiceOption, OptionKey } from './schema';

export interface AssembleInput {
  packId: string;
  businessName: string;
  ownerFirstName?: string;
  metro: MetroLookup | null;
}

export interface AssembledOption extends Omit<ChoiceOption, 'priceTier'> {
  /** Resolved cents for the price choice's options; absent elsewhere. */
  prices?: PriceTier;
}

export interface AssembledChoice {
  settingKey: AnyChoiceKey;
  question: string;
  supportLine?: string;
  options: [AssembledOption, AssembledOption];
  mostShops: OptionKey;
}

export interface AssembledShop {
  trade: RegistryTrade;
  packId: string;
  metroCode: string | null;
  metroName: string | null;
  /** Populated only when the area code spans more than one metro. */
  metroCandidates: Array<{ metroCode: string; name: string }>;
  priceSource: PriceTierSource;
  showsCity: boolean;
  choices: AssembledChoice[];
  /** The answer used when the owner skips a choice: its `mostShops` option. */
  defaults: Record<string, OptionKey>;
}

export interface TemplateTokens {
  businessName: string;
  tripFee: string;
  hourlyRate: string;
  city: string;
  ownerFirstName: string;
}

const TOKEN = /\{(\w+)\}/g;

/** Substitute {token}s; an unknown token is a content bug and throws rather than being spoken. */
export function renderTemplate(template: string, tokens: TemplateTokens): string {
  return template.replace(TOKEN, (_m, name: string) => {
    if (!(name in tokens)) throw new Error(`renderTemplate: unknown token {${name}} in "${template}"`);
    return tokens[name as keyof TemplateTokens];
  });
}

/** "$89" for whole dollars, "$89.50" otherwise. Spoken and shown the same way. */
export function formatPrice(cents: number): string {
  const plain = formatUsdCentsPlain(cents); // "$89.00"
  return plain.endsWith('.00') ? plain.slice(0, -3) : plain;
}

export async function assembleTypicalShop(repo: RegionalPriceTierRepository, input: AssembleInput): Promise<AssembledShop> {
  const trade = registryTradeForPack(input.packId);
  const metro = input.metro;
  const metroCode = metro?.kind === 'metro' ? metro.metroCode : null;
  const metroName = metro?.kind === 'metro' ? metro.name : null;
  const metroCandidates = metro?.kind === 'ambiguous' ? metro.metros : [];

  const resolved = await resolvePriceTiers(repo, input.packId, metroCode);
  const baseTokens = {
    businessName: input.businessName,
    city: resolved.showsCity && metroName ? metroName : 'your area',
    ownerFirstName: input.ownerFirstName?.trim() || 'the owner',
  };

  const choices: AssembledChoice[] = getChoiceRegistry(input.packId).map((entry) => assembleChoice(entry, baseTokens, resolved.tiers));
  const defaults: Record<string, OptionKey> = {};
  for (const c of choices) defaults[c.settingKey] = c.mostShops;

  return {
    trade,
    packId: input.packId,
    metroCode,
    metroName,
    metroCandidates,
    priceSource: resolved.source,
    showsCity: resolved.showsCity,
    choices,
    defaults,
  };
}

function assembleChoice(
  entry: ChoiceEntry,
  base: Omit<TemplateTokens, 'tripFee' | 'hourlyRate'>,
  tiers: { standard: PriceTier; premium: PriceTier },
): AssembledChoice {
  // Entry-level text is rendered with the standard tier so {tripFee} in a
  // question or support line reads as "what most shops charge".
  const entryTokens = withPrices(base, tiers.standard);
  const options = entry.options.map((o): AssembledOption => {
    const prices = o.priceTier ? tiers[o.priceTier] : undefined;
    const tokens = withPrices(base, prices ?? tiers.standard);
    const { priceTier: _priceTier, ...rest } = o;
    return {
      ...rest,
      label: renderTemplate(o.label, tokens),
      detail: o.detail === undefined ? undefined : renderTemplate(o.detail, tokens),
      rivetLine: renderTemplate(o.rivetLine, tokens),
      writes: renderWrites(o.writes, tokens),
      ...(prices ? { prices } : {}),
    };
  }) as [AssembledOption, AssembledOption];

  return {
    settingKey: entry.settingKey,
    question: renderTemplate(entry.question, entryTokens),
    supportLine: entry.supportLine === undefined ? undefined : renderTemplate(entry.supportLine, entryTokens),
    options,
    mostShops: entry.mostShops,
  };
}

function withPrices(base: Omit<TemplateTokens, 'tripFee' | 'hourlyRate'>, tier: PriceTier): TemplateTokens {
  return { ...base, tripFee: formatPrice(tier.tripFeeCents), hourlyRate: formatPrice(tier.hourlyRateCents) };
}

/** Only string-valued writes carry templates (the greeting); everything else passes through. */
function renderWrites(writes: ChoiceOption['writes'], tokens: TemplateTokens): ChoiceOption['writes'] {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(writes)) {
    out[k] = typeof v === 'string' ? renderTemplate(v, tokens) : v;
  }
  return out as ChoiceOption['writes'];
}
