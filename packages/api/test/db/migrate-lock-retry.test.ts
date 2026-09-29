/**
 * Dev deploy 2026-09-29 (Railway deployment 29f482c8) died at boot with
 * `Migration failed: error: deadlock detected` (40P01): the corpus runs as one
 * implicit transaction that re-takes table locks every boot, and live traffic
 * writing ai_runs → audit_events crossed it. Postgres rolls the losing
 * transaction back completely, so a transient lock conflict must be retried,
 * not turned into a failed deploy.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { applyMigrations } from '../../src/db/migrate';
import { getMigrationSQL } from '../../src/db/schema';

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * A client that fails the corpus statement with `failures` (in order), then
 * succeeds; every other query (SETs, constraint verification) returns a row
 * shape that passes verification.
 */
function fakeClient(failures: Error[]) {
  const corpus = getMigrationSQL();
  let corpusCalls = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql === corpus) {
      corpusCalls += 1;
      const f = failures.shift();
      if (f) throw f;
      return { rows: [], rowCount: 0 };
    }
    return { rows: [{ exists: true, present: true, count: 1 }], rowCount: 1 };
  });
  return { client: { query } as unknown as PoolClient, corpusCalls: () => corpusCalls };
}

describe('applyMigrations — transient lock conflicts', () => {
  it('retries the corpus after a deadlock (40P01) and succeeds', async () => {
    const { client, corpusCalls } = fakeClient([pgError('40P01', 'deadlock detected')]);

    await expect(applyMigrations(client, { retryDelayMs: 0 })).resolves.toBeUndefined();

    expect(corpusCalls()).toBe(2);
  });

  it('retries after a lock_timeout (55P03)', async () => {
    const { client, corpusCalls } = fakeClient([
      pgError('55P03', 'canceling statement due to lock timeout'),
    ]);

    await applyMigrations(client, { retryDelayMs: 0 });

    expect(corpusCalls()).toBe(2);
  });

  it('gives up after the attempt budget and surfaces the lock error', async () => {
    const { client, corpusCalls } = fakeClient([
      pgError('40P01', 'deadlock detected'),
      pgError('40P01', 'deadlock detected'),
      pgError('40P01', 'deadlock detected'),
    ]);

    await expect(applyMigrations(client, { retryDelayMs: 0, maxAttempts: 3 })).rejects.toMatchObject({
      code: '40P01',
    });
    expect(corpusCalls()).toBe(3);
  });

  it('does not retry a real migration error', async () => {
    const { client, corpusCalls } = fakeClient([pgError('42601', 'syntax error at or near "TABLEE"')]);

    await expect(applyMigrations(client, { retryDelayMs: 0 })).rejects.toMatchObject({ code: '42601' });
    expect(corpusCalls()).toBe(1);
  });
});
