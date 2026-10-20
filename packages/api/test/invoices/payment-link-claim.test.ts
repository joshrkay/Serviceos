/**
 * S5a-5 (U8) — the Postgres pay-link claim (`claimNextPaymentLink`) over a
 * scripted client: statement order (cleanup mutex, payment-mode key shared,
 * mode read, candidate select, marker write), the superseded and done
 * exits, the follow-up enqueued on the claim's own client, the retry when a
 * concurrent writer moves the candidate, and the bounded give-up. The real
 * SQL against real Postgres (locks, lease, races) is pinned in
 * test/integration/payment-link-mode-switch.test.ts; this file pins the
 * control flow the integration suite cannot force deterministically.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  CLEANUP_LEASE_MS,
  DEACTIVATE_PAYMENT_LINKS_JOB_TYPE,
  PASS_2_DELAY_SECONDS,
  claimNextPaymentLink,
  createPgPaymentLinkClaimer,
  paymentCleanupLockKey,
} from '../../src/invoices/payment-mode-change';
import { PAYMENT_MODE_READ_SQL, paymentModeLockKey } from '../../src/invoices/payment-collection-mode';
import type { Queue } from '../../src/queues/queue';

const TENANT = '7d3c1a52-0d6e-4f53-9a2b-1c4e5f6a7b8c';
const INV_A = '00000000-0000-4000-8000-00000000000a';

interface Script {
  mode?: string | null;
  /** One entry per SELECT: the candidate row, or null for none. */
  candidates?: Array<{ id: string; stripe_payment_link_id: string } | null>;
  /** One entry per UPDATE: whether the marker write claimed the row. */
  claims?: boolean[];
}

function scriptedPool(script: Script) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const candidates = [...(script.candidates ?? [])];
  const claims = [...(script.claims ?? [])];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql === PAYMENT_MODE_READ_SQL) {
        return { rows: script.mode === null ? [] : [{ mode: script.mode ?? 'collect_on_site' }] };
      }
      if (sql.trimStart().startsWith('SELECT id, stripe_payment_link_id')) {
        const next = candidates.shift();
        return { rows: next ? [next] : [] };
      }
      if (sql.trimStart().startsWith('UPDATE invoices')) {
        return { rows: claims.shift() ? [{ id: params?.[1] }] : [] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, client, calls };
}

function fakeQueue() {
  const sendOn = vi.fn(async () => 'msg-1');
  return { queue: { sendOn } as unknown as Queue, sendOn };
}

/** The statements after BEGIN and the tenant context, before COMMIT/ROLLBACK. */
function claimStatements(calls: Array<{ sql: string }>): string[] {
  return calls
    .map((c) => c.sql.trim())
    .filter((s) => !/^(BEGIN|COMMIT|ROLLBACK|SET |SELECT set_config)/.test(s));
}

describe('claimNextPaymentLink', () => {
  it('takes the cleanup mutex, then the payment-mode key shared, then reads the mode, then claims', async () => {
    const { pool, client, calls } = scriptedPool({
      candidates: [{ id: INV_A, stripe_payment_link_id: 'plink_a' }],
      claims: [true],
    });
    const { queue, sendOn } = fakeQueue();

    const result = await claimNextPaymentLink(pool, queue, { tenantId: TENANT, afterId: null, followUpKey: null });

    expect(result).toEqual({ kind: 'claimed', invoiceId: INV_A, linkId: 'plink_a' });
    const stmts = claimStatements(calls);
    expect(stmts[0]).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
    expect(stmts[1]).toBe('SELECT pg_advisory_xact_lock_shared(hashtext($1))');
    expect(stmts[2]).toBe(PAYMENT_MODE_READ_SQL.trim());
    expect(stmts[3]).toMatch(/^SELECT id, stripe_payment_link_id FROM invoices/);
    expect(stmts[4]).toMatch(/^UPDATE invoices/);
    expect(calls.find((c) => c.sql.includes('pg_advisory_xact_lock(hashtext'))?.params).toEqual([
      paymentCleanupLockKey(TENANT),
    ]);
    expect(calls.find((c) => c.sql.includes('pg_advisory_xact_lock_shared'))?.params).toEqual([
      paymentModeLockKey(TENANT),
    ]);
    // The marker write pins the selected link id and the lease in seconds.
    const update = calls.find((c) => c.sql.trimStart().startsWith('UPDATE invoices'));
    expect(update?.params).toEqual([TENANT, INV_A, 'plink_a', CLEANUP_LEASE_MS / 1000]);
    expect(sendOn).not.toHaveBeenCalled();
    expect(calls.at(-1)?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('passes the keyset cursor and lease to the candidate select', async () => {
    const { pool, calls } = scriptedPool({ candidates: [null] });
    const { queue } = fakeQueue();

    await claimNextPaymentLink(pool, queue, { tenantId: TENANT, afterId: INV_A, followUpKey: null });

    const select = calls.find((c) => c.sql.trimStart().startsWith('SELECT id, stripe_payment_link_id'));
    expect(select?.params).toEqual([TENANT, INV_A, CLEANUP_LEASE_MS / 1000]);
  });

  it('stops as superseded when the policy now permits links, before any candidate is read', async () => {
    const { pool, calls } = scriptedPool({ mode: 'pay_link' });
    const { queue, sendOn } = fakeQueue();

    const result = await claimNextPaymentLink(pool, queue, {
      tenantId: TENANT,
      afterId: null,
      followUpKey: 'k:pass2',
    });

    expect(result).toEqual({ kind: 'superseded', modeRead: 'pay_link' });
    expect(sendOn).not.toHaveBeenCalled();
    expect(calls.some((c) => c.sql.includes('FROM invoices'))).toBe(false);
  });

  it('reads a missing mode row as pay_link (superseded)', async () => {
    const { pool } = scriptedPool({ mode: null });
    const { queue } = fakeQueue();

    const result = await claimNextPaymentLink(pool, queue, { tenantId: TENANT, afterId: null, followUpKey: null });

    expect(result).toEqual({ kind: 'superseded', modeRead: 'pay_link' });
  });

  it('enqueues the delayed pass-2 follow-up on the claim client after a collect_on_site read', async () => {
    const { pool, client } = scriptedPool({ candidates: [null] });
    const { queue, sendOn } = fakeQueue();

    const result = await claimNextPaymentLink(pool, queue, {
      tenantId: TENANT,
      afterId: null,
      followUpKey: 'deactivate-payment-links:t:x:pass2',
    });

    expect(result).toEqual({ kind: 'done' });
    expect(sendOn).toHaveBeenCalledWith(
      client,
      DEACTIVATE_PAYMENT_LINKS_JOB_TYPE,
      { tenantId: TENANT, pass: 2 },
      'deactivate-payment-links:t:x:pass2',
      { delaySeconds: PASS_2_DELAY_SECONDS },
    );
  });

  it('re-selects when a concurrent writer moved the candidate out of the set', async () => {
    const { pool, calls } = scriptedPool({
      candidates: [
        { id: INV_A, stripe_payment_link_id: 'plink_a' },
        { id: INV_A, stripe_payment_link_id: 'plink_a2' },
      ],
      claims: [false, true],
    });
    const { queue } = fakeQueue();

    const result = await claimNextPaymentLink(pool, queue, { tenantId: TENANT, afterId: null, followUpKey: null });

    expect(result).toEqual({ kind: 'claimed', invoiceId: INV_A, linkId: 'plink_a2' });
    expect(calls.filter((c) => c.sql.trimStart().startsWith('UPDATE invoices'))).toHaveLength(2);
  });

  it('gives up after bounded attempts and rolls the claim back', async () => {
    const row = { id: INV_A, stripe_payment_link_id: 'plink_a' };
    const { pool, client, calls } = scriptedPool({
      candidates: Array.from({ length: 10 }, () => row),
      claims: Array.from({ length: 10 }, () => false),
    });
    const { queue } = fakeQueue();

    await expect(
      claimNextPaymentLink(pool, queue, { tenantId: TENANT, afterId: null, followUpKey: null }),
    ).rejects.toThrow('payment link claim did not settle');
    expect(calls.filter((c) => c.sql.trimStart().startsWith('UPDATE invoices'))).toHaveLength(10);
    expect(calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('createPgPaymentLinkClaimer', () => {
  it('binds the pool and queue to claimNextPaymentLink', async () => {
    const { pool } = scriptedPool({ mode: 'pay_link' });
    const { queue } = fakeQueue();

    const claim = createPgPaymentLinkClaimer(pool, queue);

    await expect(claim({ tenantId: TENANT, afterId: null, followUpKey: null })).resolves.toEqual({
      kind: 'superseded',
      modeRead: 'pay_link',
    });
  });
});
