import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import {
  PgRegionalPriceTierRepository,
  resolvePriceTiers,
  type RegionalPriceTiers,
} from '../../src/onboarding/choices/price-tiers';

const CLE: RegionalPriceTiers = {
  standard: { tripFeeCents: 8900, hourlyRateCents: 15000 },
  premium: { tripFeeCents: 12900, hourlyRateCents: 18500 },
};

describe('regional_price_tiers (platform table)', () => {
  let pool: Pool;
  let repo: PgRegionalPriceTierRepository;
  const trade = `plumbing-${crypto.randomUUID().slice(0, 8)}`; // isolate from other files

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgRegionalPriceTierRepository(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM regional_price_tiers WHERE trade = $1', [trade]);
    await closeSharedTestDb();
  });

  it('has the expected columns and no tenant_id (platform-owned)', async () => {
    const { rows } = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'regional_price_tiers' ORDER BY ordinal_position`,
    );
    const cols = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    expect(cols).toMatchObject({
      trade: 'text',
      metro_code: 'text',
      tier: 'jsonb',
      source: 'text',
      updated_at: 'timestamp with time zone',
    });
    expect(cols).not.toHaveProperty('tenant_id');
  });

  it('is not row-level-secured (no tenant to scope by)', async () => {
    const { rows } = await pool.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'regional_price_tiers'`,
    );
    expect(rows[0].relrowsecurity).toBe(false);
  });

  it('upserts and reads a metro row back with cents intact', async () => {
    await repo.upsert(trade, 'CLE', CLE, 'founder-curated');
    expect(await repo.find(trade, 'CLE')).toEqual(CLE);
    const bumped = { ...CLE, standard: { ...CLE.standard, tripFeeCents: 9900 } };
    await repo.upsert(trade, 'CLE', bumped, 'founder-curated');
    expect(await repo.find(trade, 'CLE')).toEqual(bumped);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM regional_price_tiers WHERE trade = $1', [trade]);
    expect(rows[0].n).toBe(1);
  });

  it('returns null for a missing metro and resolves through the national row', async () => {
    expect(await repo.find(trade, 'DEN')).toBeNull();
    const US = { standard: { tripFeeCents: 7900, hourlyRateCents: 13500 }, premium: { tripFeeCents: 11900, hourlyRateCents: 17500 } };
    await repo.upsert(trade, 'US', US, 'national-default');
    const r = await resolvePriceTiers(repo, trade, 'DEN');
    expect(r).toEqual({ tiers: US, source: 'national', showsCity: false });
  });

  it('rejects a tier payload that is not integer cents at the boundary', async () => {
    await expect(
      repo.upsert(trade, 'BAD', { ...CLE, standard: { tripFeeCents: 89.5, hourlyRateCents: 15000 } }, 'test'),
    ).rejects.toThrow();
  });
});
