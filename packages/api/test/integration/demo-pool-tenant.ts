/**
 * Integration helper (S6-4): a demo tenant shaped exactly like a pool slot
 * (`owner_id = 'demo:<trade>:<slot>'`, `demo = true`, `demo_trade`), at a
 * random high slot so it never collides with the seeded pool on a shared
 * database. With `seed`, the fixture is applied as the pool seed does, so a
 * reset of it can be compared with a fresh clone.
 */
import { randomInt } from 'crypto';
import type { Pool } from 'pg';
import { clearTenantContext } from '../../src/db/rls-runtime-role';
import { demoBusinessName, seedDemoTenantFromFixture, type DemoFixtureDeps, type DemoTrade } from '../../src/demo/fixture';
import { demoPoolOwnerEmail, demoPoolOwnerId } from '../../src/demo/seed-pool';

export interface PoolSlotTenant {
  tenantId: string;
  slot: number;
}

export async function createPoolSlotTenant(
  pool: Pool,
  opts: { trade?: DemoTrade; seed?: DemoFixtureDeps } = {},
): Promise<PoolSlotTenant> {
  const trade = opts.trade ?? 'plumbing';
  const slot = randomInt(100_000, 1_000_000_000);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tenants (owner_id, owner_email, name, demo, demo_trade)
     VALUES ($1, $2, $3, true, $4) RETURNING id`,
    [demoPoolOwnerId(trade, slot), demoPoolOwnerEmail(trade, slot), demoBusinessName(trade, slot), trade],
  );
  const tenantId = rows[0].id;
  if (opts.seed) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await seedDemoTenantFromFixture(client, { tenantId, trade, slot }, opts.seed);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await clearTenantContext(client);
      client.release();
    }
  }
  return { tenantId, slot };
}
