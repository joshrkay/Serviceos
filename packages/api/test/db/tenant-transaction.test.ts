import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import {
  PgTenantTransactionRunner,
  InMemoryTransactionRunner,
} from '../../src/db/tenant-transaction';
import { tenantContextStore } from '../../src/middleware/tenant-context';

const tenantId = '550e8400-e29b-41d4-a716-446655440000';

interface QueryCall {
  text: string;
  params?: unknown[];
}

function fakePool(): { pool: Pool; calls: QueryCall[]; released: () => number } {
  const calls: QueryCall[] = [];
  let releaseCount = 0;
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return { rows: [] };
    },
    release: () => {
      releaseCount += 1;
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, calls, released: () => releaseCount };
}

describe('PgTenantTransactionRunner', () => {
  it('wraps work in BEGIN / set_config / COMMIT and releases the client', async () => {
    const { pool, calls, released } = fakePool();
    const runner = new PgTenantTransactionRunner(pool);

    const result = await runner.run(tenantId, async () => 'done');

    expect(result).toBe('done');
    const texts = calls.map((c) => c.text);
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toContain("set_config('app.current_tenant_id'");
    expect(calls[1].params).toEqual([tenantId]);
    expect(texts[texts.length - 1]).toBe('COMMIT');
    expect(texts).not.toContain('ROLLBACK');
    expect(released()).toBe(1);
  });

  it('exposes the transaction client via AsyncLocalStorage to nested repo calls', async () => {
    const { pool } = fakePool();
    const runner = new PgTenantTransactionRunner(pool);

    let seenTenant: string | undefined;
    await runner.run(tenantId, async () => {
      seenTenant = tenantContextStore.getStore()?.tenantId;
    });

    expect(seenTenant).toBe(tenantId);
  });

  it('takes a transaction-scoped advisory lock when lock() is called', async () => {
    const { pool, calls } = fakePool();
    const runner = new PgTenantTransactionRunner(pool);

    await runner.run(tenantId, async ({ lock }) => {
      await lock('book:2030-06-03T15:00:00.000Z');
    });

    const lockCall = calls.find((c) => c.text.includes('pg_advisory_xact_lock'));
    expect(lockCall).toBeDefined();
    expect(lockCall?.params).toHaveLength(2);
  });

  it('rolls back and rethrows when the unit of work throws', async () => {
    const { pool, calls, released } = fakePool();
    const runner = new PgTenantTransactionRunner(pool);

    await expect(
      runner.run(tenantId, async () => {
        throw new Error('write failed');
      }),
    ).rejects.toThrow('write failed');

    const texts = calls.map((c) => c.text);
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
    expect(released()).toBe(1);
  });
});

describe('InMemoryTransactionRunner', () => {
  it('runs the unit of work directly with a no-op lock', async () => {
    const runner = new InMemoryTransactionRunner();
    let locked = false;
    const result = await runner.run(tenantId, async ({ lock }) => {
      await lock('anything');
      locked = true;
      return 42;
    });
    expect(result).toBe(42);
    expect(locked).toBe(true);
  });
});
