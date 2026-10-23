import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import {
  PgTenantTransactionRunner,
  InMemoryTransactionRunner,
  withTenantConnection,
} from '../../src/db/tenant-transaction';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { PgBaseRepository } from '../../src/db/pg-base';

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

  it('TI-01 — work that outlives run() opens its own transaction instead of reusing the settled client', async () => {
    // A `void` spawn inside the unit of work inherits the runner's
    // AsyncLocalStorage entry. After COMMIT + release that client belongs to
    // whoever checks it out next, so a late repo call must start over.
    const { pool, calls } = fakePool();
    class LateRepo extends PgBaseRepository {
      touch(t: string): Promise<unknown> {
        return this.withTenant(t, (client) => client.query('UPDATE ai_runs SET status = $1', ['completed']));
      }
    }
    const repo = new LateRepo(pool);
    const runner = new PgTenantTransactionRunner(pool);

    let late: Promise<unknown> | undefined;
    await runner.run(tenantId, async () => {
      late = new Promise((r) => setTimeout(r, 5)).then(() => repo.touch(tenantId));
    });
    await late;

    const texts = calls.map((c) => c.text);
    const afterRunnerCommit = texts.slice(texts.indexOf('COMMIT') + 1);
    expect(afterRunnerCommit[0]).toBe('BEGIN');
    expect(afterRunnerCommit[1]).toContain("set_config('app.current_tenant_id'");
    expect(afterRunnerCommit).toContain('UPDATE ai_runs SET status = $1');
    expect(afterRunnerCommit).toContain('COMMIT');
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

  it('wraps savepoint work in SAVEPOINT / RELEASE without ending the outer tx', async () => {
    const { pool, calls } = fakePool();
    const runner = new PgTenantTransactionRunner(pool);

    await runner.run(tenantId, async ({ savepoint }) => {
      await savepoint(async () => undefined);
    });

    const texts = calls.map((c) => c.text);
    expect(texts).toContain('SAVEPOINT sp_1');
    expect(texts).toContain('RELEASE SAVEPOINT sp_1');
    expect(texts).not.toContain('ROLLBACK TO SAVEPOINT sp_1');
    expect(texts[texts.length - 1]).toBe('COMMIT');
  });

  it('rolls a failed savepoint back to itself, rethrows, and leaves the tx usable', async () => {
    const { pool, calls } = fakePool();
    const runner = new PgTenantTransactionRunner(pool);

    const result = await runner.run(tenantId, async ({ savepoint }) => {
      // First unit fails (e.g. a 23505) — only its savepoint rolls back.
      const code = await savepoint(async () => {
        throw Object.assign(new Error('dup'), { code: '23505' });
      }).catch((e) => (e as { code?: string }).code);
      expect(code).toBe('23505');
      // The transaction is still usable: a second unit commits normally.
      await savepoint(async () => undefined);
      return 'ok';
    });

    expect(result).toBe('ok');
    const texts = calls.map((c) => c.text);
    expect(texts).toContain('SAVEPOINT sp_1');
    expect(texts).toContain('ROLLBACK TO SAVEPOINT sp_1');
    expect(texts).toContain('SAVEPOINT sp_2'); // second unit got a fresh savepoint
    expect(texts).toContain('RELEASE SAVEPOINT sp_2');
    expect(texts[texts.length - 1]).toBe('COMMIT'); // whole tx still commits
    expect(texts).not.toContain('ROLLBACK'); // the OUTER tx never rolled back
  });
});

describe('withTenantConnection', () => {
  it('wraps work in BEGIN / set_config / COMMIT, returns the value, and releases', async () => {
    const { pool, calls, released } = fakePool();

    const result = await withTenantConnection(pool, tenantId, async (client) => {
      await client.query('SELECT 1');
      return 'value';
    });

    expect(result).toBe('value');
    const texts = calls.map((c) => c.text);
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toContain("set_config('app.current_tenant_id'");
    expect(calls[1].params).toEqual([tenantId]);
    expect(texts).toContain('SELECT 1');
    expect(texts[texts.length - 1]).toBe('COMMIT');
    expect(texts).not.toContain('ROLLBACK');
    expect(released()).toBe(1);
  });

  it('rolls back, rethrows, and still releases when the work throws', async () => {
    const { pool, calls, released } = fakePool();

    await expect(
      withTenantConnection(pool, tenantId, async () => {
        throw new Error('query failed');
      }),
    ).rejects.toThrow('query failed');

    const texts = calls.map((c) => c.text);
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
    expect(released()).toBe(1);
  });
});

describe('InMemoryTransactionRunner', () => {
  const otherTenantId = '550e8400-e29b-41d4-a716-446655440001';

  /** A promise plus the function that resolves it. */
  function gate(): { promise: Promise<void>; open: () => void } {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  /** Let every queued callback and timer run, so a waiter that could proceed has. */
  const settle = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });

  /** Fails fast with `what` instead of hanging until the test timeout. */
  async function within<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish`)), 1000);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  it('runs the unit of work directly and an uncontended lock resolves at once', async () => {
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

  it('serializes two runs that lock the same key: the second starts only after the first settles', async () => {
    const runner = new InMemoryTransactionRunner();
    const order: string[] = [];
    const firstHasLock = gate();
    const finishFirst = gate();

    const first = runner.run(tenantId, async ({ lock }) => {
      await lock('about');
      order.push('first:locked');
      firstHasLock.open();
      await finishFirst.promise;
      order.push('first:done');
      return 'first';
    });
    await firstHasLock.promise;

    const second = runner.run(tenantId, async ({ lock }) => {
      order.push('second:waiting');
      await lock('about');
      order.push('second:locked');
      return 'second';
    });
    await settle();
    expect(order).toEqual(['first:locked', 'second:waiting']);

    finishFirst.open();
    expect(await within(Promise.all([first, second]), 'the two runs')).toEqual(['first', 'second']);
    expect(order).toEqual(['first:locked', 'second:waiting', 'first:done', 'second:locked']);
  });

  it('shares the lock across runner instances, as advisory locks are database-wide', async () => {
    // public-booking and public-portal each get their own runner and lock the
    // same 'self-service-booking' key against each other.
    const order: string[] = [];
    const firstHasLock = gate();
    const finishFirst = gate();

    const first = new InMemoryTransactionRunner().run(tenantId, async ({ lock }) => {
      await lock('self-service-booking');
      firstHasLock.open();
      await finishFirst.promise;
      order.push('first:done');
    });
    await firstHasLock.promise;
    const second = new InMemoryTransactionRunner().run(tenantId, async ({ lock }) => {
      await lock('self-service-booking');
      order.push('second:locked');
    });
    await settle();
    expect(order).toEqual([]);

    finishFirst.open();
    await within(Promise.all([first, second]), 'the two runs');
    expect(order).toEqual(['first:done', 'second:locked']);
  });

  it('does not block a run that locks a different key, or the same key for another tenant', async () => {
    const runner = new InMemoryTransactionRunner();
    const firstHasLock = gate();
    const finishFirst = gate();

    const first = runner.run(tenantId, async ({ lock }) => {
      await lock('about');
      firstHasLock.open();
      await finishFirst.promise;
    });
    await firstHasLock.promise;

    const otherKey = runner.run(tenantId, async ({ lock }) => {
      await lock('booking');
      return 'other key';
    });
    const otherTenant = runner.run(otherTenantId, async ({ lock }) => {
      await lock('about');
      return 'other tenant';
    });
    // Both finish while the first run still holds tenantId's 'about' lock.
    expect(await within(Promise.all([otherKey, otherTenant]), 'the unrelated runs')).toEqual([
      'other key',
      'other tenant',
    ]);

    finishFirst.open();
    await first;
  });

  it('releases the lock when the run throws, so the next run waiting on it proceeds', async () => {
    const runner = new InMemoryTransactionRunner();
    const firstHasLock = gate();
    const failFirst = gate();

    const first = runner.run(tenantId, async ({ lock }) => {
      await lock('about');
      firstHasLock.open();
      await failFirst.promise;
      throw new Error('insert failed');
    });
    await firstHasLock.promise;
    const second = runner.run(tenantId, async ({ lock }) => {
      await lock('about');
      return 'second';
    });

    failFirst.open();
    await expect(first).rejects.toThrow('insert failed');
    expect(await within(second, 'the run after the failed one')).toBe('second');
    // And the key is free again for a later run.
    expect(await within(runner.run(tenantId, async ({ lock }) => lock('about').then(() => 'third')), 'a later run')).toBe(
      'third',
    );
  });

  it('lets a run lock a key it already holds again, as Postgres does within one transaction', async () => {
    const runner = new InMemoryTransactionRunner();
    const result = runner.run(tenantId, async ({ lock }) => {
      await lock('about');
      await lock('about');
      return 'relocked';
    });
    expect(await within(result, 'the relocking run')).toBe('relocked');
  });

  it('a second lock() of the same key in one run waits for the first to be granted', async () => {
    const runner = new InMemoryTransactionRunner();
    const order: string[] = [];
    const firstHasLock = gate();
    const finishFirst = gate();

    const holder = runner.run(tenantId, async ({ lock }) => {
      await lock('about');
      firstHasLock.open();
      await finishFirst.promise;
      order.push('holder:done');
    });
    await firstHasLock.promise;

    const waiter = runner.run(tenantId, async ({ lock }) => {
      await Promise.all([
        lock('about').then(() => order.push('waiter:first-lock')),
        lock('about').then(() => order.push('waiter:second-lock')),
      ]);
    });
    await settle();
    expect(order).toEqual([]);

    finishFirst.open();
    await within(Promise.all([holder, waiter]), 'the two runs');
    expect(order[0]).toBe('holder:done');
    expect(order.slice(1).sort()).toEqual(['waiter:first-lock', 'waiter:second-lock']);
  });

  it('refuses a lock() through a scope whose run has already settled, so it cannot be held forever', async () => {
    const runner = new InMemoryTransactionRunner();
    let escaped: ((key: string) => Promise<void>) | undefined;
    await runner.run(tenantId, async ({ lock }) => {
      escaped = lock;
    });

    await expect(escaped!('about')).rejects.toThrow(/settled/);
    const next = runner.run(tenantId, async ({ lock }) => {
      await lock('about');
      return 'next';
    });
    expect(await within(next, 'a later run of the same key')).toBe('next');
  });

  it('runs savepoint work directly and propagates its errors', async () => {
    const runner = new InMemoryTransactionRunner();

    const ok = await runner.run(tenantId, async ({ savepoint }) => savepoint(async () => 7));
    expect(ok).toBe(7);

    await expect(
      runner.run(tenantId, async ({ savepoint }) =>
        savepoint(async () => {
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
  });
});
