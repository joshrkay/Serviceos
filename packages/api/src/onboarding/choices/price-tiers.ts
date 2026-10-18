/**
 * Regional price tiers for "pick, don't build" onboarding.
 *
 * The price choice shows two options: what most shops in the owner's metro
 * charge (standard) and a premium tier. Rows are platform-owned and
 * founder-curated per launch metro in `regional_price_tiers`; `metro_code =
 * 'US'` is the national fallback; when even that is absent the trade pack's
 * line-item defaults apply and the UI drops the city from its copy.
 *
 * All money is integer cents. The one rounding rule for derived prices lives
 * in `scaleCentsBps`.
 */
import type { Pool } from 'pg';
import { z } from 'zod';
import { packHeadlinePrices } from '../../packs/seed-pack-defaults';
import { scaleCentsBps } from '../../shared/scale-cents-bps';
export { scaleCentsBps };

export const NATIONAL_METRO_CODE = 'US';

/** Premium tier = standard × 1.30, rounded to the nearest dollar. */
export const PREMIUM_MULTIPLIER_BPS = 13000;

const centsSchema = z.number().int().nonnegative();

export const PriceTierSchema = z
  .object({
    tripFeeCents: centsSchema,
    hourlyRateCents: centsSchema,
  })
  .strict();
export type PriceTier = z.infer<typeof PriceTierSchema>;

export const RegionalPriceTiersSchema = z
  .object({
    standard: PriceTierSchema,
    premium: PriceTierSchema,
  })
  .strict();
export type RegionalPriceTiers = z.infer<typeof RegionalPriceTiersSchema>;

export type PriceTierSource = 'metro' | 'national' | 'pack_default';

export interface ResolvedPriceTiers {
  tiers: RegionalPriceTiers;
  source: PriceTierSource;
  /** True only when the prices really are for the owner's metro. */
  showsCity: boolean;
}

/** An unknown pack id (registry drift) falls back to the seeder's generic 'other' prices. */
const FALLBACK_PACK_ID = 'other';

function premiumFrom(standard: PriceTier): PriceTier {
  return {
    tripFeeCents: scaleCentsBps(standard.tripFeeCents, PREMIUM_MULTIPLIER_BPS),
    hourlyRateCents: scaleCentsBps(standard.hourlyRateCents, PREMIUM_MULTIPLIER_BPS),
  };
}

/** The tiers a trade gets when no regional row exists: the pack's own headline prices. */
export function packDefaultTiers(packId: string): RegionalPriceTiers {
  const h = packHeadlinePrices(packId) ?? packHeadlinePrices(FALLBACK_PACK_ID);
  if (!h) throw new Error('seed-pack-defaults has no generic pack; cannot derive default tiers');
  const standard: PriceTier = { tripFeeCents: h.visitCents, hourlyRateCents: h.laborCents };
  return RegionalPriceTiersSchema.parse({ standard, premium: premiumFrom(standard) });
}

export interface RegionalPriceTierRepository {
  find(trade: string, metroCode: string): Promise<RegionalPriceTiers | null>;
}

/** Test and hermetic-boot implementation; same contract as the Pg repository. */
export class InMemoryRegionalPriceTierRepository implements RegionalPriceTierRepository {
  private readonly rows = new Map<string, RegionalPriceTiers>();
  constructor(seed: Record<string, RegionalPriceTiers> = {}) {
    for (const [k, v] of Object.entries(seed)) this.rows.set(k, RegionalPriceTiersSchema.parse(v));
  }
  async find(trade: string, metroCode: string): Promise<RegionalPriceTiers | null> {
    return this.rows.get(`${trade}|${metroCode}`) ?? null;
  }
  async upsert(trade: string, metroCode: string, tiers: RegionalPriceTiers): Promise<void> {
    this.rows.set(`${trade}|${metroCode}`, RegionalPriceTiersSchema.parse(tiers));
  }
}

export class PgRegionalPriceTierRepository implements RegionalPriceTierRepository {
  constructor(private readonly pool: Pool) {}

  async find(trade: string, metroCode: string): Promise<RegionalPriceTiers | null> {
    const { rows } = await this.pool.query<{ tier: unknown }>(
      'SELECT tier FROM regional_price_tiers WHERE trade = $1 AND metro_code = $2',
      [trade, metroCode],
    );
    if (rows.length === 0) return null;
    return RegionalPriceTiersSchema.parse(rows[0].tier);
  }

  /** Admin/founder write path (scripts, seeds). Validates before it touches the table. */
  async upsert(trade: string, metroCode: string, tiers: RegionalPriceTiers, source: string): Promise<void> {
    const parsed = RegionalPriceTiersSchema.parse(tiers);
    await this.pool.query(
      `INSERT INTO regional_price_tiers (trade, metro_code, tier, source, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, NOW())
       ON CONFLICT (trade, metro_code)
       DO UPDATE SET tier = EXCLUDED.tier, source = EXCLUDED.source, updated_at = NOW()`,
      [trade, metroCode, JSON.stringify(parsed), source],
    );
  }
}

/**
 * Metro row → national row → pack defaults. `showsCity` is true only for a
 * metro hit, so the card copy never claims "most Cleveland plumbers" on
 * national or default numbers.
 */
export async function resolvePriceTiers(
  repo: RegionalPriceTierRepository,
  trade: string,
  metroCode: string | null,
): Promise<ResolvedPriceTiers> {
  if (metroCode && metroCode !== NATIONAL_METRO_CODE) {
    const metro = await repo.find(trade, metroCode);
    if (metro) return { tiers: RegionalPriceTiersSchema.parse(metro), source: 'metro', showsCity: true };
  }
  const national = await repo.find(trade, NATIONAL_METRO_CODE);
  if (national) return { tiers: RegionalPriceTiersSchema.parse(national), source: 'national', showsCity: false };
  return { tiers: packDefaultTiers(trade), source: 'pack_default', showsCity: false };
}
