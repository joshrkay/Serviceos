/**
 * Two real request transactions on two pooled connections, interleaved on
 * purpose: the scripted-race pattern the onboarding draft tests share.
 *
 * `beginRequestTx` is exactly what `withTenantTransaction` does for one /api
 * request (BEGIN + applyTenantContext + tenantContextStore) without a response
 * to wait for; `waitUntilBlocked` polls pg_blocking_pids until the second
 * backend is parked on the first's row lock, so the test commits the first
 * only once the order is certain.
 */
import type { Pool } from 'pg';
import { applyTenantContext } from '../../src/db/rls-runtime-role';
import { tenantContextStore } from '../../src/middleware/tenant-context';

export interface RequestTx {
  pid: number;
  run<T>(fn: () => Promise<T>): Promise<T>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export async function beginRequestTx(pool: Pool, tenantId: string): Promise<RequestTx> {
  const client = await pool.connect();
  const slot = { done: false };
  await client.query('BEGIN');
  await applyTenantContext(client, tenantId, { transactional: true });
  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const finish = async (sql: 'COMMIT' | 'ROLLBACK') => {
    if (slot.done) return;
    slot.done = true;
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  };
  return {
    pid,
    run: (fn) => tenantContextStore.run({ client, tenantId }, fn),
    commit: () => finish('COMMIT'),
    rollback: () => finish('ROLLBACK'),
  };
}

export async function waitUntilBlocked(pool: Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const r = await pool.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid]);
    if (r.rows[0].blocked) return;
    if (Date.now() > deadline) throw new Error(`backend ${pid} never blocked on a row lock within 5s`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

/**
 * Run `first` in tx1 (uncommitted), start `second` in tx2, wait for it to park
 * on tx1's row lock, then commit tx1 and settle tx2 (commit on success, roll
 * back on a refusal). Returns both outcomes.
 */
export async function raceFirstThen<A, B>(
  pool: Pool,
  tenantId: string,
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<{ first: A; second: PromiseSettledResult<B> }> {
  const tx1 = await beginRequestTx(pool, tenantId);
  const tx2 = await beginRequestTx(pool, tenantId);
  try {
    const a = await tx1.run(first);
    const pending = tx2.run(second);
    const settled = pending.then(
      (value): PromiseSettledResult<B> => ({ status: 'fulfilled', value }),
      (reason): PromiseSettledResult<B> => ({ status: 'rejected', reason }),
    );
    await waitUntilBlocked(pool, tx2.pid);
    await tx1.commit();
    const b = await settled;
    if (b.status === 'fulfilled') await tx2.commit();
    else await tx2.rollback();
    return { first: a, second: b };
  } finally {
    await tx1.rollback();
    await tx2.rollback();
  }
}
