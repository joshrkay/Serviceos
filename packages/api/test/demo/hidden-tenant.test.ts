/**
 * The cache contract of the hidden-tenant check (U7). The real columns
 * (`tenants.demo`, `tenants.platform`) are pinned on Postgres by
 * test/integration/demo-tenants-excluded.test.ts ("product analytics drop a
 * hidden tenant's events"); this file pins only what the check does with the
 * answer, against a recording query function.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHiddenTenantCheck } from '../../src/demo/hidden-tenant';

function fakePool(table: Record<string, boolean>) {
  const query = vi.fn(async (_sql: string, params: unknown[]) => {
    const id = params[0] as string;
    return { rows: id in table ? [{ hidden: table[id] }] : [] };
  });
  return { query } as unknown as { query: typeof query } & Parameters<typeof createHiddenTenantCheck>[0];
}

describe('createHiddenTenantCheck', () => {
  it('answers from the row and reads each known tenant once', async () => {
    const pool = fakePool({ demo: true, owner: false });
    const isHidden = createHiddenTenantCheck(pool);
    expect(await isHidden('demo')).toBe(true);
    expect(await isHidden('demo')).toBe(true);
    expect(await isHidden('owner')).toBe(false);
    expect(await isHidden('owner')).toBe(false);
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('treats an unknown tenant as not hidden and reads it again next time', async () => {
    const pool = fakePool({});
    const isHidden = createHiddenTenantCheck(pool);
    expect(await isHidden('later')).toBe(false);
    expect(await isHidden('later')).toBe(false);
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('throws on a failed read and does not cache the failure', async () => {
    let fail = true;
    const query = vi.fn(async () => {
      if (fail) throw new Error('db down');
      return { rows: [{ hidden: true }] };
    });
    const isHidden = createHiddenTenantCheck({ query } as never);
    await expect(isHidden('demo')).rejects.toThrow('db down');
    fail = false;
    expect(await isHidden('demo')).toBe(true);
  });
});
