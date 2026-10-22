/**
 * S6-4 (U7 Approach, "Release and reset") — the shape of `resetAndRelease`:
 * the order of its steps, the walk's keep-list, the fence that opens every
 * step's own transaction, the fenced-out stop, and the return-claim path.
 *
 * The pool here is a script that answers each statement and records which
 * connection ran it, so ordering and transaction boundaries are visible. It
 * proves nothing about the SQL itself: the claim, the fence's FOR SHARE
 * against a takeover, the walk, the re-seed and the release are proven on
 * real Postgres (test/integration/demo-reset-fencing.test.ts,
 * test/integration/demo-tenant-leases.test.ts).
 */
import { describe, it, expect } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  createDemoLeaseResetter,
  DEMO_RESET_FAILED_RULE,
  DEMO_RESET_KEEP_TABLES,
  parseDemoSlot,
  type DemoTenantIdentity,
} from '../../src/demo/reset';
import type { OperatorAlert } from '../../src/monitoring/alert-operator';
import type { DemoFixtureDeps } from '../../src/demo/fixture';
import { DevStorageProvider } from '../../src/files/storage-provider';

const LEASE = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const TOKEN = '33333333-3333-4333-8333-333333333333';

interface Entry {
  conn: number;
  sql: string;
  params: unknown[];
}

interface Script {
  /** Fence answers, in order; missing entries pass. */
  fence?: number[];
  /** drainPredicate answers, in order; missing entries are 0. */
  drain?: number[];
  ownerId?: string;
  tables?: string[];
  files?: Array<{ s3_bucket: string; s3_key: string; thumbnail_s3_key: string | null }>;
  claimed?: boolean;
  claimError?: { code: string };
}

function scriptedPool(script: Script): Pool & { log: Entry[] } {
  const log: Entry[] = [];
  let conns = 0;
  let fences = 0;
  let drains = 0;
  const answer = (conn: number, sql: string, params: unknown[] = []) => {
    log.push({ conn, sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    const ok = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });
    if (/SET state = 'resetting'/.test(s)) {
      if (script.claimError) throw Object.assign(new Error('lock timeout'), script.claimError);
      return script.claimed === false ? ok([]) : ok([{ reset_token: TOKEN, tenant_id: TENANT, generation: '9' }]);
    }
    if (/FOR SHARE$/.test(s)) {
      const n = script.fence?.[fences] ?? 1;
      fences += 1;
      return ok(n ? [{ '?column?': 1 }] : [], n);
    }
    if (/to_regclass/.test(s)) return ok([{ present: true }]);
    if (/FROM demo_inflight_jobs/.test(s)) {
      const n = script.drain?.[drains] ?? 0;
      drains += 1;
      return ok([{ n }]);
    }
    if (/FROM files WHERE tenant_id/.test(s)) return ok(script.files ?? []);
    if (/information_schema\.columns/.test(s)) {
      return ok((script.tables ?? ['audit_events', 'customers', 'demo_inflight_jobs', 'demo_tenant_leases', 'jobs', 'tenants']).map((t) => ({ table_name: t })));
    }
    if (/SELECT demo, demo_trade, owner_id FROM tenants/.test(s)) {
      return ok([{ demo: true, demo_trade: 'plumbing', owner_id: script.ownerId ?? 'demo:plumbing:7' }]);
    }
    if (/^DELETE FROM "/.test(s)) return ok([], 0);
    if (/SET state = 'released'/.test(s) || /SET state = 'active'/.test(s)) return ok([], 1);
    return ok([], 0);
  };
  const pool = {
    log,
    async query(sql: string, params?: unknown[]) {
      return answer(0, sql, params);
    },
    async connect() {
      conns += 1;
      const conn = conns;
      return {
        query: async (sql: string, params?: unknown[]) => answer(conn, sql, params),
        release: () => undefined,
      } as unknown as PoolClient;
    },
  };
  return pool as unknown as Pool & { log: Entry[] };
}

function resetterOn(pool: Pool, opts: { alerts?: OperatorAlert[]; reseeds?: DemoTenantIdentity[]; storage?: DevStorageProvider } = {}) {
  return createDemoLeaseResetter({
    pool,
    settings: { resetBatchRows: 1000, resetDrainSeconds: 2 },
    alert: async (a) => {
      opts.alerts?.push(a);
    },
    storage: opts.storage ?? new DevStorageProvider({ bucket: 'demo-bucket', publicUrlBase: 'http://localhost/storage-dev' }),
    fixtureDeps: {} as DemoFixtureDeps,
    reseed: async (client, tenant) => {
      await client.query('-- reseed');
      opts.reseeds?.push(tenant);
    },
    heartbeatMs: 3_600_000,
    drainPollMs: 1_000,
    sleep: async () => undefined,
  });
}

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const isFence = (sql: string) => /FOR SHARE$/.test(flat(sql));
const FULL_ORDER = ['claim', 'queue_cancel', 'drain', 'queue_purge', 'object_keys', 'delete:customers', 'delete:jobs', 'reseed', 'release'];

/** Each transaction (BEGIN … COMMIT/ROLLBACK on one connection), in the order it opened. */
function transactions(log: Entry[]): Entry[][] {
  const open = new Map<number, Entry[]>();
  const out: Entry[][] = [];
  for (const e of log) {
    if (e.sql === 'BEGIN') {
      const tx: Entry[] = [];
      open.set(e.conn, tx);
      out.push(tx);
      continue;
    }
    const tx = open.get(e.conn);
    if (!tx) continue;
    if (e.sql === 'COMMIT' || e.sql === 'ROLLBACK') {
      tx.push(e);
      open.delete(e.conn);
      continue;
    }
    tx.push(e);
  }
  return out;
}

/** What a transaction did, named by its first statement that is not tenant-context plumbing or the fence. */
function label(tx: Entry[]): string {
  const body = tx.filter(
    (e) => !isFence(e.sql) && !/set_config|SET LOCAL|^COMMIT$|^ROLLBACK$|to_regclass/.test(flat(e.sql)),
  );
  const s = flat(body[0]?.sql ?? '');
  if (/SET state = 'resetting'/.test(s)) return 'claim';
  if (/_queue_messages .* attempts = 0/.test(s)) return 'queue_cancel';
  if (/FROM demo_inflight_jobs/.test(s)) return 'drain';
  if (/DELETE FROM _queue_messages/.test(s)) return 'queue_purge';
  if (/FROM files/.test(s)) return 'object_keys';
  if (/^DELETE FROM "(\w+)"/.test(s)) return `delete:${/^DELETE FROM "(\w+)"/.exec(s)![1]}`;
  if (/reseed/.test(s)) return 'reseed';
  if (/SET state = 'released'/.test(s)) return 'release';
  if (/SET state = 'active'/.test(s)) return 'return_claim';
  if (!s && tx.some((e) => isFence(e.sql))) return 'fenced';
  return s.slice(0, 40) || '(empty)';
}

describe('resetAndRelease — step order and the fence', () => {
  it('claims, then runs each step in its own transaction in plan order, and releases last', async () => {
    const pool = scriptedPool({});
    const reseeds: DemoTenantIdentity[] = [];
    const out = await resetterOn(pool, { reseeds }).resetAndRelease(LEASE, { source: 'callback' });

    expect(out).toEqual({ kind: 'released', leaseId: LEASE, tenantId: TENANT });
    expect(transactions(pool.log).map(label)).toEqual(FULL_ORDER);
    expect(reseeds).toEqual([{ tenantId: TENANT, trade: 'plumbing', slot: 7 }]);
  });

  it('the walk keeps the tenant row, the lease table, the in-flight registry and the audit trail', async () => {
    expect([...DEMO_RESET_KEEP_TABLES].sort()).toEqual(['audit_events', 'demo_inflight_jobs', 'demo_tenant_leases', 'tenants']);
    const pool = scriptedPool({});
    await resetterOn(pool).resetAndRelease(LEASE, { source: 'callback' });
    const deleted = pool.log.map((e) => /^DELETE FROM "(\w+)"/.exec(flat(e.sql))?.[1]).filter(Boolean);
    expect(deleted).toEqual(['customers', 'jobs']);
  });

  it('every step but the claim and the release opens with the fence on the lease and its token, before it writes', async () => {
    const pool = scriptedPool({});
    await resetterOn(pool).resetAndRelease(LEASE, { source: 'callback' });
    const steps = transactions(pool.log).filter((tx) => !['claim', 'release'].includes(label(tx)));
    expect(steps.length).toBe(7);
    for (const tx of steps) {
      const fenceAt = tx.findIndex((e) => isFence(e.sql));
      expect(fenceAt, label(tx)).toBeGreaterThanOrEqual(0);
      expect(tx[fenceAt].params).toEqual([LEASE, TOKEN]);
      const firstWork = tx.findIndex((e) => /^(DELETE|INSERT|UPDATE|-- reseed|SELECT \(SELECT count|SELECT s3_bucket)/.test(flat(e.sql)));
      expect(firstWork, label(tx)).toBeGreaterThan(fenceAt);
    }
    // The release is a single statement fenced by the token in its own WHERE.
    const release = transactions(pool.log).find((tx) => label(tx) === 'release')!;
    const update = release.find((e) => /SET state = 'released'/.test(e.sql))!;
    expect(flat(update.sql)).toMatch(/state = 'resetting' AND reset_token = \$2/);
    expect(update.params).toEqual([LEASE, TOKEN]);
  });

  it.each([
    ['queue_cancel', 0],
    ['drain', 1],
    ['delete:customers', 4],
    ['reseed', 6],
  ] as const)('a fence that finds the token gone at %s stops the reset there: no later write, no alert, no claim returned', async (at, fenceIndex) => {
    const fence = Array.from({ length: 10 }, (_v, i) => (i === fenceIndex ? 0 : 1));
    const pool = scriptedPool({ fence });
    const alerts: OperatorAlert[] = [];
    const out = await resetterOn(pool, { alerts }).resetAndRelease(LEASE, { source: 'reaper' });

    expect(out).toMatchObject({ kind: 'fenced_out', leaseId: LEASE });
    expect(alerts).toEqual([]);
    // Every step before it ran; its own transaction saw the fence fail and
    // wrote nothing; nothing after it ran (no release, no returned claim).
    expect(transactions(pool.log).map(label)).toEqual([...FULL_ORDER.slice(0, FULL_ORDER.indexOf(at)), 'fenced']);
    const last = transactions(pool.log).at(-1)!;
    expect(last.at(-1)!.sql).toBe('ROLLBACK');
  });

  it('a lease another path holds is not claimed and nothing else runs', async () => {
    const pool = scriptedPool({ claimed: false });
    expect(await resetterOn(pool).resetAndRelease(LEASE, { source: 'callback' })).toEqual({ kind: 'not_claimed', leaseId: LEASE });
    expect(transactions(pool.log).map(label)).toEqual(['claim']);
  });

  it('a claim that times out on the row lock counts as not claimed', async () => {
    const pool = scriptedPool({ claimError: { code: '55P03' } });
    expect(await resetterOn(pool).resetAndRelease(LEASE, { source: 'reaper' })).toEqual({ kind: 'not_claimed', leaseId: LEASE });
    const claim = transactions(pool.log)[0];
    expect(claim.map((e) => flat(e.sql))).toContain("SET LOCAL lock_timeout = '5s'");
  });
});

describe('resetAndRelease — a failed step returns the claim', () => {
  it('work still in flight at the drain deadline: alert once, return the claim fenced by the token with expires_at = now(), stop', async () => {
    const pool = scriptedPool({ drain: [1, 1, 1, 1, 1, 1] });
    const alerts: OperatorAlert[] = [];
    const out = await resetterOn(pool, { alerts }).resetAndRelease(LEASE, { source: 'callback' });

    expect(out).toMatchObject({ kind: 'failed', step: 'drain', claimReturned: true });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical', rule: DEMO_RESET_FAILED_RULE });
    const labels = transactions(pool.log).map(label);
    // Polled once per second up to DEMO_RESET_DRAIN_SECONDS (2), then given up.
    expect(labels).toEqual(['claim', 'queue_cancel', 'drain', 'drain', 'drain', 'return_claim']);
    const ret = transactions(pool.log).at(-1)!.find((e) => /SET state = 'active'/.test(e.sql))!;
    expect(flat(ret.sql)).toMatch(/expires_at = now\(\) WHERE id = \$1 AND state = 'resetting' AND reset_token = \$2/);
    expect(ret.params).toEqual([LEASE, TOKEN]);
  });

  it('a stored object that will not delete fails the step before the row walk, so the retry still finds its key', async () => {
    const storage = new DevStorageProvider({ bucket: 'demo-bucket', publicUrlBase: 'http://localhost/storage-dev' });
    storage.deleteObject = async () => {
      throw new Error('object store unavailable');
    };
    const pool = scriptedPool({ files: [{ s3_bucket: 'b', s3_key: 'k', thumbnail_s3_key: null }] });
    const out = await resetterOn(pool, { storage }).resetAndRelease(LEASE, { source: 'callback' });
    expect(out).toMatchObject({ kind: 'failed', step: 'object_delete', claimReturned: true });
    expect(transactions(pool.log).map(label).some((l) => l.startsWith('delete:'))).toBe(false);
  });

  it('a demo tenant whose owner id is not a pool slot fails before anything is deleted (nothing to re-seed it from)', async () => {
    const pool = scriptedPool({ ownerId: 'someone-else' });
    const alerts: OperatorAlert[] = [];
    const out = await resetterOn(pool, { alerts }).resetAndRelease(LEASE, { source: 'callback' });
    expect(out).toMatchObject({ kind: 'failed', step: 'reseed', claimReturned: true });
    expect(alerts).toHaveLength(1);
    expect(transactions(pool.log).map(label)).toEqual(['claim', 'return_claim']);
  });
});

describe('parseDemoSlot', () => {
  it.each([
    ['demo:plumbing:1', 'plumbing', 1],
    ['demo:plumbing:42', 'plumbing', 42],
    ['demo:plumbing:1826601086', 'plumbing', 1826601086],
    ['demo:hvac:3', 'plumbing', null],
    ['demo:plumbing:0', 'plumbing', null],
    ['demo:plumbing:x', 'plumbing', null],
    ['demo-calls-test:abc', 'plumbing', null],
  ] as const)('%s for %s → %s', (ownerId, trade, slot) => {
    expect(parseDemoSlot(ownerId, trade)).toBe(slot);
  });
});
