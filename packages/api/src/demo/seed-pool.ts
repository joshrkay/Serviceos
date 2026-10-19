/**
 * U7 — the demo tenant pool: `DEMO_POOL_PER_TRADE` tenants per trade, each
 * `tenants.demo = true` with `demo_trade` naming its pack, seeded from the
 * fixture. Idempotent by `owner_id` (TEXT NOT NULL UNIQUE on tenants): a slot
 * that already exists is left exactly as it is, so re-running the script
 * after a pool grows or a deploy restarts never duplicates a tenant and never
 * re-seeds one a call may be holding.
 *
 * Each slot is one transaction: the tenants row and its fixture commit
 * together or not at all, so a crash mid-seed leaves no half-built tenant
 * for the lease picker to find.
 */
import type { Pool } from 'pg';
import { clearTenantContext } from '../db/rls-runtime-role';
import {
  DEMO_TRADES,
  buildDemoFixtureDeps,
  demoBusinessName,
  seedDemoTenantFromFixture,
  type DemoFixtureDeps,
  type DemoTrade,
} from './fixture';

export function demoPoolOwnerId(trade: DemoTrade, slot: number): string {
  return `demo:${trade}:${slot}`;
}

/** Non-deliverable by construction, like the platform tenant's. */
export function demoPoolOwnerEmail(trade: DemoTrade, slot: number): string {
  return `demo-${trade}-${slot}@invalid.rivet.local`;
}

export interface SeedDemoTenantPoolOptions {
  perTrade: number;
  log?: (line: string) => void;
  /** Injected by tests that share one set of repos; defaults to the real Pg repos. */
  deps?: DemoFixtureDeps;
}

export interface SeedDemoTenantPoolResult {
  /** Slots created on this run (0 on a replay). */
  created: number;
  /** Every pool tenant id, created now or found, in trade/slot order. */
  tenantIds: string[];
}

export async function seedDemoTenantPool(
  pool: Pool,
  options: SeedDemoTenantPoolOptions,
): Promise<SeedDemoTenantPoolResult> {
  const log = options.log ?? (() => undefined);
  const deps = options.deps ?? buildDemoFixtureDeps(pool);
  const result: SeedDemoTenantPoolResult = { created: 0, tenantIds: [] };

  for (const trade of DEMO_TRADES) {
    for (let slot = 1; slot <= options.perTrade; slot += 1) {
      const ownerId = demoPoolOwnerId(trade, slot);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO tenants (owner_id, owner_email, name, demo, demo_trade)
           VALUES ($1, $2, $3, true, $4)
           ON CONFLICT (owner_id) DO NOTHING
           RETURNING id`,
          [ownerId, demoPoolOwnerEmail(trade, slot), demoBusinessName(trade, slot), trade],
        );
        const created = inserted.rows.at(0);
        if (created) {
          await seedDemoTenantFromFixture(client, { tenantId: created.id, trade, slot }, deps);
          await client.query('COMMIT');
          result.created += 1;
          result.tenantIds.push(created.id);
          log(`seeded ${ownerId} as ${created.id}`);
          continue;
        }
        const existing = await client.query<{ id: string; demo: boolean }>(
          `SELECT id, demo FROM tenants WHERE owner_id = $1`,
          [ownerId],
        );
        await client.query('COMMIT');
        const row = existing.rows.at(0);
        if (!row || !row.demo) {
          throw new Error(`demo pool: owner_id ${ownerId} exists but is not a demo tenant`);
        }
        result.tenantIds.push(row.id);
        log(`kept ${ownerId} as ${row.id}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        await clearTenantContext(client);
        client.release();
      }
    }
  }
  return result;
}
