import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { PgVerticalPackRegistry } from '../../src/shared/pg-vertical-pack-registry';

describe('Postgres integration — verticals', () => {
  let pool: Pool;
  let verticalRepo: PgVerticalPackRegistry;
  let seededPackId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    verticalRepo = new PgVerticalPackRegistry(pool);

    // The vertical_packs table is global (not tenant-scoped) and starts
    // empty in the testcontainer. Seed one pack so list/findByVertical
    // assertions have something to find.
    seededPackId = crypto.randomUUID();
    // The repo stores `packId` in the `type` column, which is constrained
    // to 'hvac' or 'plumbing' by the CHECK in migration 032. The
    // verticalType is stored inside the terminology JSONB.
    await verticalRepo.register({
      id: seededPackId,
      packId: 'hvac',
      version: '1.0.0',
      verticalType: 'hvac',
      status: 'active',
      displayName: 'HVAC Residential',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('lists available vertical packs', async () => {
      const packs = await verticalRepo.list();
      expect(packs.length).toBeGreaterThanOrEqual(1);
    });

    it('retrieves pack by ID', async () => {
      const pack = await verticalRepo.get(seededPackId);
      expect(pack).not.toBeNull();
      expect(pack!.packId).toBe('hvac');
    });

    it('finds packs by vertical type', async () => {
      const hvacPacks = await verticalRepo.findByVertical('hvac' as any);
      expect(Array.isArray(hvacPacks)).toBe(true);
      expect(hvacPacks.length).toBeGreaterThanOrEqual(1);
    });
  });
});