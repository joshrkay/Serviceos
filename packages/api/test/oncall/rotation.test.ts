import { describe, it, expect } from 'vitest';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import type { OnCallEntry } from '../../src/oncall/rotation';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function makeEntry(overrides: Partial<OnCallEntry> = {}): OnCallEntry {
  return {
    id: 'entry-1',
    userId: 'user-1',
    orderIndex: 0,
    ...overrides,
  };
}

describe('InMemoryOnCallRepository', () => {
  describe('getNextOnCall', () => {
    it('returns null for a tenant with no rotation entries', async () => {
      const repo = new InMemoryOnCallRepository();
      const result = await repo.getNextOnCall(TENANT_A);
      expect(result).toBeNull();
    });

    it('returns null for a tenant whose entries map is empty', async () => {
      const entries = new Map([[TENANT_A, [] as OnCallEntry[]]]);
      const repo = new InMemoryOnCallRepository(entries);
      const result = await repo.getNextOnCall(TENANT_A);
      expect(result).toBeNull();
    });

    it('returns the single entry when there is exactly one', async () => {
      const entry = makeEntry({ id: 'e1', userId: 'user-1', orderIndex: 0 });
      const entries = new Map([[TENANT_A, [entry]]]);
      const repo = new InMemoryOnCallRepository(entries);
      const result = await repo.getNextOnCall(TENANT_A);
      expect(result).toEqual(entry);
    });

    it('returns the entry with the lowest order_index when multiple exist', async () => {
      const e1 = makeEntry({ id: 'e1', userId: 'user-1', orderIndex: 2 });
      const e2 = makeEntry({ id: 'e2', userId: 'user-2', orderIndex: 0 });
      const e3 = makeEntry({ id: 'e3', userId: 'user-3', orderIndex: 1 });
      const entries = new Map([[TENANT_A, [e1, e2, e3]]]);
      const repo = new InMemoryOnCallRepository(entries);
      const result = await repo.getNextOnCall(TENANT_A);
      expect(result).toEqual(e2);
    });

    it('does not cross-contaminate tenants', async () => {
      const entryA = makeEntry({ id: 'eA', userId: 'user-a', orderIndex: 0 });
      const entries = new Map([[TENANT_A, [entryA]]]);
      const repo = new InMemoryOnCallRepository(entries);
      const result = await repo.getNextOnCall(TENANT_B);
      expect(result).toBeNull();
    });
  });

  describe('listRotation', () => {
    it('returns empty array for a tenant with no entries', async () => {
      const repo = new InMemoryOnCallRepository();
      const result = await repo.listRotation(TENANT_A);
      expect(result).toEqual([]);
    });

    it('returns all entries sorted by order_index ascending', async () => {
      const e1 = makeEntry({ id: 'e1', userId: 'user-1', orderIndex: 2 });
      const e2 = makeEntry({ id: 'e2', userId: 'user-2', orderIndex: 0 });
      const e3 = makeEntry({ id: 'e3', userId: 'user-3', orderIndex: 1 });
      const entries = new Map([[TENANT_A, [e1, e2, e3]]]);
      const repo = new InMemoryOnCallRepository(entries);
      const result = await repo.listRotation(TENANT_A);
      expect(result.map((e) => e.orderIndex)).toEqual([0, 1, 2]);
    });

    it('does not mutate the underlying array when sorting', async () => {
      const e1 = makeEntry({ id: 'e1', userId: 'user-1', orderIndex: 2 });
      const e2 = makeEntry({ id: 'e2', userId: 'user-2', orderIndex: 0 });
      const original = [e1, e2];
      const entries = new Map([[TENANT_A, original]]);
      const repo = new InMemoryOnCallRepository(entries);
      await repo.listRotation(TENANT_A);
      // Original order should be unchanged
      expect(original[0].orderIndex).toBe(2);
    });
  });
});
