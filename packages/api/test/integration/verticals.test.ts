import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { PgVerticalPackRegistry } from '../../src/shared/pg-vertical-pack-registry';

describe('Postgres integration — verticals', () => {
  let pool: Pool;
  let verticalRepo: PgVerticalPackRegistry;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    verticalRepo = new PgVerticalPackRegistry(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('lists available vertical packs', async () => {
      const packs = await verticalRepo.list();
      expect(Array.isArray(packs)).toBe(true);
    });

    it('retrieves pack by ID', async () => {
      const allPacks = await verticalRepo.list();
      if (allPacks.length > 0) {
        const pack = await verticalRepo.get(allPacks[0].id);
        expect(pack).not.toBeNull();
        expect(pack!.packId).toBe(allPacks[0].packId);
      }
    });

    it('finds packs by vertical type', async () => {
      const hvacPacks = await verticalRepo.findByVertical('hvac' as any);
      expect(Array.isArray(hvacPacks)).toBe(true);
    });
  });
});