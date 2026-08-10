/**
 * Review follow-up (2026-08-09) — SQL-shape pins for
 * `PgMaterialItemRepository.listPending`.
 *
 * These complement (never replace) test/integration/material-items.test.ts,
 * which runs the same queries against a real Postgres in PR CI. What a
 * mocked pool CAN prove cheaply, on every `npm test`, is the two things
 * that made the Pg backend silently diverge from InMemory:
 *
 *   J1 — the date-scoped ORDER BY had no `created_at` key, so two rows
 *        sharing a `needed_by` (the NORMAL case: add-material-handler.ts
 *        writes every spoken `needed_by` at exact UTC midnight) fell
 *        straight through to `id ASC`, a random v4 UUID, while InMemory's
 *        stable sort yielded insertion order. Under lookup_materials's
 *        5-item spoken cap the two backends spoke DIFFERENT SUBSETS.
 *   J2 — a non-`Date` `neededByBefore` (an ISO string that crossed a
 *        queue/JSON boundary) failed the `instanceof Date` gate, so Pg
 *        emitted NO date predicate at all and answered a date-scoped
 *        question with the tenant's whole pending list.
 */
import { describe, it, expect } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { PgMaterialItemRepository } from '../../src/materials/pg-material-item';

const TENANT = '11111111-1111-4111-8111-111111111111';

interface Captured {
  text: string;
  values: unknown[];
}

/**
 * Minimal fake pool: records every statement and returns no rows. Enough
 * to assert the SELECT text/params `listPending` builds without a DB.
 */
function fakePool(): { pool: Pool; queries: Captured[] } {
  const queries: Captured[] = [];
  const client = {
    query: async (text: unknown, values?: unknown[]) => {
      queries.push({ text: String(text), values: values ?? [] });
      return { rows: [] };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, queries };
}

function selectStatement(queries: Captured[]): Captured {
  const found = queries.find((q) => q.text.includes('FROM material_items'));
  if (!found) throw new Error(`no SELECT captured; saw: ${queries.map((q) => q.text).join(' | ')}`);
  return found;
}

describe('PgMaterialItemRepository.listPending — SQL shape', () => {
  it('breaks needed_by ties on created_at BEFORE id, matching the InMemory backend', async () => {
    const { pool, queries } = fakePool();
    const repo = new PgMaterialItemRepository(pool);

    await repo.listPending(TENANT, { neededByBefore: new Date('2026-06-13T00:00:00.000Z') });

    expect(selectStatement(queries).text).toContain(
      'ORDER BY needed_by ASC, created_at ASC, id ASC',
    );
  });

  it('keeps the default (undated) ordering unchanged', async () => {
    const { pool, queries } = fakePool();
    const repo = new PgMaterialItemRepository(pool);

    await repo.listPending(TENANT);

    expect(selectStatement(queries).text).toContain('ORDER BY created_at ASC, id ASC');
  });

  it('emits a needed_by lower bound (inclusive) when neededByFrom is given', async () => {
    const { pool, queries } = fakePool();
    const repo = new PgMaterialItemRepository(pool);

    await repo.listPending(TENANT, {
      neededByFrom: new Date('2026-06-12T00:00:00.000Z'),
      neededByBefore: new Date('2026-06-13T00:00:00.000Z'),
    });

    const stmt = selectStatement(queries);
    expect(stmt.text).toContain('needed_by >=');
    expect(stmt.text).toContain('needed_by <');
    expect(stmt.values).toContain(TENANT);
  });

  // J2 — the `jobId` precedent, applied to the date bound: a malformed
  // filter value returns [], NEVER the tenant's whole pending list.
  it('returns [] for a non-Date neededByBefore instead of silently dropping the filter', async () => {
    const { pool, queries } = fakePool();
    const repo = new PgMaterialItemRepository(pool);

    const rows = await repo.listPending(TENANT, {
      neededByBefore: '2026-06-13T00:00:00.000Z' as unknown as Date,
    });

    expect(rows).toEqual([]);
    expect(queries.filter((q) => q.text.includes('FROM material_items'))).toEqual([]);
  });

  it('returns [] for an Invalid Date neededByBefore (instanceof Date, NaN time)', async () => {
    const { pool, queries } = fakePool();
    const repo = new PgMaterialItemRepository(pool);

    const rows = await repo.listPending(TENANT, { neededByBefore: new Date('nonsense') });

    expect(rows).toEqual([]);
    expect(queries.filter((q) => q.text.includes('FROM material_items'))).toEqual([]);
  });
});
