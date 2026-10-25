/**
 * Postgres integration — the demo reset's tenant reads run under the RLS
 * runtime role (raw-pg audit 2026-10-23 §4 P1.12).
 *
 * Each reset step is its own transaction that opens with the fence, a
 * `SELECT … FROM demo_tenant_leases … FOR SHARE` on the RLS-exempt lease row.
 * Two steps read the tenant's own rows: the drain (its executing proposals,
 * beside the RLS-exempt in-flight registry) and the stored-object read (its
 * files). Both set only `app.current_tenant_id` on the fenced principal
 * client, with no role, so the policies did not bind and `WHERE tenant_id =
 * $1` was the only boundary. With RLS_RUNTIME_ROLE on, this suite proves:
 *
 *   1. the proposals count and the files read report `rls_app_runtime` with
 *      the lease tenant's GUC; the fence, the in-flight registry read and the
 *      queue statements stay on the connection principal (the role holds no
 *      grant on the two demo tables, and `_queue_messages` has no RLS);
 *   2. with the tenant pin widened to the demo tenant and another, RLS alone
 *      keeps the other tenant's executing proposal out of the drain and its
 *      stored objects out of the delete (control: as the principal the drain
 *      waits on the other tenant's proposal until it fails, and the other
 *      tenant's object is deleted);
 *   3. the evidence for each table's role: after migration 219 the role keeps
 *      SELECT on proposals and files and holds none on demo_tenant_leases or
 *      demo_inflight_jobs; none of those three platform tables has RLS;
 *   4. the fence is as strong as before: while a tenant-context step runs
 *      under the role, the step still holds the lease row's share lock, so a
 *      takeover's UPDATE cannot land;
 *   5. a failure inside a tenant-context step rolls only that step back and
 *      returns the claim, the pooled connection carries no role or GUC, and
 *      the reaper's retry releases the tenant; a resetter that dies inside
 *      one leaves the lease resetting under its token with nothing of the
 *      step committed, and the reaper takes over once the heartbeat is stale;
 *   6. the cost: the stored-object step is the same seven statements with the
 *      context in place of the GUC; the drain adds one (the two counts are
 *      two statements now), on the same one checkout.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, TENANT_CONTEXT_WITH_ROLE_SQL } from './shared';
import { createPoolSlotTenant } from './demo-pool-tenant';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { createDemoLeaseResetter, takeOverStaleReset, type DemoResetHooks } from '../../src/demo/reset';
import { buildDemoFixtureDeps, type DemoFixtureDeps } from '../../src/demo/fixture';
import { DevStorageProvider } from '../../src/files/storage-provider';
import { PgQueue } from '../../src/queues/pg-queue';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const FENCE = /FROM demo_tenant_leases\s+WHERE id = \$1 AND state = 'resetting' AND reset_token = \$2 FOR SHARE/;
const INFLIGHT = /FROM demo_inflight_jobs WHERE tenant_id = \$1/;
const EXECUTING = /FROM proposals WHERE tenant_id = \$1 AND status = 'executing'/;
const FILES = /FROM files WHERE tenant_id = \$1/;
const QUEUE = /_queue_messages/;
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

type QueryFn = (text: unknown, values?: unknown) => Promise<QueryResult>;

class RecordingStorage extends DevStorageProvider {
  deleted: string[] = [];
  constructor() {
    super({ bucket: 'demo-bucket', publicUrlBase: 'http://localhost/storage-dev' });
  }
  override async deleteObject(bucket?: string, key?: string): Promise<void> {
    this.deleted.push(`${bucket}/${key}`);
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A pool whose clients run `before(client)` ahead of the first statement
 * matching `target` (once), on the same connection, then the statement.
 */
function interceptOnce(real: Pool, target: RegExp, before: (client: PoolClient) => Promise<void>): Pool {
  let fired = false;
  const connect = async (): Promise<PoolClient> => {
    const client = await real.connect();
    const inner = client.query as unknown as QueryFn;
    (client as unknown as { query: QueryFn }).query = async (text, values) => {
      const sql = typeof text === 'string' ? text : '';
      if (!fired && target.test(sql)) {
        fired = true;
        await before(client);
      }
      return inner.call(client, text, values);
    };
    const innerRelease = client.release;
    client.release = (err?: Error | boolean) => {
      delete (client as unknown as { query?: QueryFn }).query;
      return innerRelease(err);
    };
    return client;
  };
  return new Proxy(real, {
    get(t, p) {
      if (p === 'connect') return connect;
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

let pool: Pool;
let principal: string;
let fixtureDeps: DemoFixtureDeps;
const otherTenants: string[] = [];

const newDemoTenant = () => createPoolSlotTenant(pool, { seed: fixtureDeps });

async function leaseOn(tenantId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO demo_tenant_leases (tenant_id, visitor_phone_hash, expires_at)
     VALUES ($1, $2, now() + interval '70 seconds') RETURNING id`,
    [tenantId, `reset-ctx-${randomUUID()}`],
  );
  return rows[0].id;
}

/** A stored file row of the tenant; returns its object's `bucket/key`. */
async function seedFile(tenantId: string): Promise<string> {
  const key = `demo/${tenantId}/${randomUUID()}.wav`;
  await pool.query(
    `INSERT INTO files (tenant_id, filename, content_type, size_bytes, s3_bucket, s3_key, uploaded_by)
     VALUES ($1, 'call.wav', 'audio/wav', 10, 'demo-bucket', $2, 'demo')`,
    [tenantId, key],
  );
  return `demo-bucket/${key}`;
}

async function seedProposal(tenantId: string, status: string): Promise<void> {
  await pool.query(
    `INSERT INTO proposals (tenant_id, proposal_type, created_by, status) VALUES ($1, 'create_appointment', 'demo', $2)`,
    [tenantId, status],
  );
}

/** A tenant outside the demo pool, for the widened predicates to reach. */
async function otherTenant(): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  otherTenants.push(tenantId);
  return tenantId;
}

async function leaseRow(id: string) {
  const { rows } = await pool.query(
    `SELECT state, released_at, reset_token, expires_at <= now() AS expired FROM demo_tenant_leases WHERE id = $1`,
    [id],
  );
  return rows[0];
}

function resetter(opts: { pool?: Pool; storage?: RecordingStorage; hooks?: DemoResetHooks; drainSeconds?: number; fixtureDeps?: DemoFixtureDeps } = {}) {
  return createDemoLeaseResetter({
    pool: opts.pool ?? pool,
    settings: { resetBatchRows: 1000, resetDrainSeconds: opts.drainSeconds ?? 1 },
    alert: async () => undefined,
    storage: opts.storage ?? new RecordingStorage(),
    fixtureDeps: opts.fixtureDeps ?? fixtureDeps,
    heartbeatMs: 3_600_000,
    drainPollMs: 20,
    hooks: opts.hooks,
  });
}

beforeAll(async () => {
  pool = await getSharedTestDb();
  principal = (await pool.query<{ u: string }>('SELECT current_user AS u')).rows[0].u;
  fixtureDeps = buildDemoFixtureDeps(pool);
  // The queue table exists as PgQueue creates it, so the queue steps run their DELETEs.
  await new PgQueue(pool).send('demo_reset_ctx_probe', { tenantId: randomUUID() }, `reset-ctx-${randomUUID()}`);
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  await pool.query(`DELETE FROM _queue_messages WHERE type = 'demo_reset_ctx_probe'`).catch(() => undefined);
  for (const id of otherTenants) {
    for (const table of ['proposals', 'files', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('demo reset — which role each step statement runs as (real Postgres)', () => {
  it("the executing-proposals count and the files read run as rls_app_runtime with the lease tenant's GUC; the fence, the in-flight registry read and the queue statements stay on the principal", async () => {
    const tenant = await newDemoTenant();
    await seedFile(tenant.tenantId);
    await seedProposal(tenant.tenantId, 'draft');
    const leaseId = await leaseOn(tenant.tenantId);
    const probe = probeStatementRoles(pool, new RegExp([FENCE, INFLIGHT, EXECUTING, FILES, QUEUE].map((r) => r.source).join('|')));

    expect(await resetter({ pool: probe.pool }).resetAndRelease(leaseId, { source: 'callback' })).toMatchObject({ kind: 'released' });

    const as = (re: RegExp) => probe.seen.filter((s) => re.test(s.sql)).map((s) => [s.role, s.tenantGuc]);
    const tenantRole = ['rls_app_runtime', tenant.tenantId];
    expect(as(EXECUTING)).toEqual([tenantRole]);
    expect(as(FILES)).toEqual([tenantRole]);
    expect(as(INFLIGHT).length).toBeGreaterThan(0);
    for (const [role] of [...as(INFLIGHT), ...as(FENCE), ...as(QUEUE)]) expect(role).toBe(principal);
    // The fence opened every step: queue cancel, drain, queue purge, the
    // stored-object read and batch, every walk batch, the re-seed.
    expect(as(FENCE).length).toBeGreaterThanOrEqual(6);
  });
});

describe('demo reset — RLS alone keeps another tenant out of the drain and the object delete (real Postgres)', () => {
  async function widenedDrain(asPrincipal: boolean) {
    const tenant = await newDemoTenant();
    const other = await otherTenant();
    await seedProposal(other, 'executing');
    const leaseId = await leaseOn(tenant.tenantId);
    const widened = widenTenantPredicates(pool, { target: EXECUTING, tenants: [tenant.tenantId, other], asPrincipal });

    const outcome = await resetter({ pool: widened.pool }).resetAndRelease(leaseId, { source: 'callback' });

    expect(widened.rewritten.length).toBeGreaterThan(0);
    return { outcome, leaseId };
  }

  it("with the drain's tenant pin widened to the demo tenant and another, the other tenant's executing proposal does not hold the reset", async () => {
    const { outcome } = await widenedDrain(false);
    expect(outcome).toMatchObject({ kind: 'released' });
  });

  it("control: the same widened count as the connection principal waits on the other tenant's proposal until the drain fails", async () => {
    const { outcome, leaseId } = await widenedDrain(true);
    expect(outcome).toMatchObject({ kind: 'failed', step: 'drain', claimReturned: true });
    // Leave the lease released for the shared database.
    expect(await resetter().resetAndRelease(leaseId, { source: 'reaper' })).toMatchObject({ kind: 'released' });
  });

  async function widenedFiles(asPrincipal: boolean) {
    const tenant = await newDemoTenant();
    const own = await seedFile(tenant.tenantId);
    const other = await otherTenant();
    const theirs = await seedFile(other);
    const leaseId = await leaseOn(tenant.tenantId);
    const widened = widenTenantPredicates(pool, { target: FILES, tenants: [tenant.tenantId, other], asPrincipal });
    const storage = new RecordingStorage();

    expect(await resetter({ pool: widened.pool, storage }).resetAndRelease(leaseId, { source: 'callback' })).toMatchObject({
      kind: 'released',
    });

    expect(widened.rewritten).toHaveLength(1);
    return { deleted: storage.deleted, own, theirs };
  }

  it("with the files read's tenant pin widened, only the demo tenant's stored objects are deleted", async () => {
    const r = await widenedFiles(false);
    expect(r.deleted).toEqual([r.own]);
  });

  it("control: the same widened read as the connection principal deletes the other tenant's object too", async () => {
    const r = await widenedFiles(true);
    expect(r.deleted.sort()).toEqual([r.own, r.theirs].sort());
  });
});

describe('demo reset — the evidence for each table the steps touch', () => {
  it('after migration 219 the role keeps SELECT on proposals and files and holds none on the lease table or the in-flight registry', async () => {
    expect(
      await runtimeRoleGrantsMissingAfter219(pool, [
        ['proposals', 'SELECT'],
        ['files', 'SELECT'],
        ['demo_tenant_leases', 'SELECT'],
        ['demo_inflight_jobs', 'SELECT'],
      ]),
    ).toEqual(['demo_tenant_leases:SELECT', 'demo_inflight_jobs:SELECT']);
  });

  it('the lease table, the in-flight registry and the queue table have no RLS and no policy; only the queue table has no tenant_id column', async () => {
    const { rows } = await pool.query<{ relname: string; rls: boolean; policies: number; tenant_col: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies,
              EXISTS (SELECT 1 FROM information_schema.columns col
                       WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id') AS tenant_col
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relname IN ('demo_tenant_leases', 'demo_inflight_jobs', '_queue_messages', 'proposals', 'files')
        ORDER BY c.relname`,
    );
    expect(rows).toEqual([
      { relname: '_queue_messages', rls: false, policies: 0, tenant_col: false },
      { relname: 'demo_inflight_jobs', rls: false, policies: 0, tenant_col: true },
      { relname: 'demo_tenant_leases', rls: false, policies: 0, tenant_col: true },
      { relname: 'files', rls: true, policies: 1, tenant_col: true },
      { relname: 'proposals', rls: true, policies: 1, tenant_col: true },
    ]);
  });
});

describe('demo reset — the fence is as strong under the role (real Postgres)', () => {
  it.each([
    ['drain', EXECUTING],
    ['object_delete', FILES],
  ] as const)("while the %s step reads the tenant's rows, the step still holds the lease row's share lock: a takeover UPDATE cannot land", async (_step, target) => {
    const tenant = await newDemoTenant();
    await seedFile(tenant.tenantId);
    const leaseId = await leaseOn(tenant.tenantId);
    const paused = deferred();
    const gate = deferred();
    const run = resetter({
      pool: interceptOnce(pool, target, async () => {
        paused.resolve();
        await gate.promise;
      }),
    }).resetAndRelease(leaseId, { source: 'callback' });
    await paused.promise;

    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query("SET LOCAL lock_timeout = '300ms'");
      await expect(
        other.query(`UPDATE demo_tenant_leases SET reset_token = gen_random_uuid() WHERE id = $1`, [leaseId]),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      other.release();
    }

    gate.resolve();
    expect(await run).toMatchObject({ kind: 'released' });
  });
});

describe('demo reset — failure and crash inside a tenant-context step (real Postgres)', () => {
  it('a failed tenant read rolls back only its step and returns the claim; the connection goes back with no role or GUC; the reaper retry releases the tenant', async () => {
    const tenant = await newDemoTenant();
    const own = await seedFile(tenant.tenantId);
    const leaseId = await leaseOn(tenant.tenantId);
    // One connection, so the client the failed step returns is the one read below.
    const single = new Pool({ connectionString: process.env.TEST_DB_URL, max: 1 });
    try {
      const failing = interceptOnce(single, FILES, async (client) => {
        await client.query('SELECT 1 FROM no_such_table_for_the_reset_test');
      });
      const failed = await resetter({ pool: failing }).resetAndRelease(leaseId, { source: 'callback' });
      expect(failed).toMatchObject({ kind: 'failed', step: 'object_delete', claimReturned: true });

      const { rows } = await single.query<{ role: string; guc: string | null }>(
        `SELECT current_user AS role, current_setting('app.current_tenant_id', true) AS guc`,
      );
      expect(rows[0].role).toBe(principal);
      expect(rows[0].guc ?? '').toBe('');
    } finally {
      await single.end();
    }
    expect(await leaseRow(leaseId)).toMatchObject({ state: 'active', released_at: null, expired: true });
    const { rows: files } = await pool.query(`SELECT 1 FROM files WHERE tenant_id = $1`, [tenant.tenantId]);
    expect(files).toHaveLength(1);

    const storage = new RecordingStorage();
    expect(await resetter({ storage }).resetAndRelease(leaseId, { source: 'reaper' })).toMatchObject({ kind: 'released' });
    expect(storage.deleted).toEqual([own]);
  });

  it('a resetter that dies inside a tenant-context step leaves the lease resetting under its token with nothing of the step committed; the reaper takes over once the heartbeat is stale and finishes', async () => {
    const tenant = await newDemoTenant();
    await seedFile(tenant.tenantId);
    const leaseId = await leaseOn(tenant.tenantId);
    const paused = deferred<number>();
    const gate = deferred();
    const run = resetter({
      pool: interceptOnce(pool, FILES, async (client) => {
        // The process "dies" here: its backend goes away mid-step.
        client.on('error', () => undefined);
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        paused.resolve(rows[0].pid);
        await gate.promise;
      }),
    }).resetAndRelease(leaseId, { source: 'callback' });
    const pid = await paused.promise;
    const held = await leaseRow(leaseId);
    expect(held).toMatchObject({ state: 'resetting', released_at: null });

    await pool.query('SELECT pg_terminate_backend($1)', [pid]);
    // What a dead resetter leaves: the lease still resetting under its token,
    // no row of the tenant removed by the step, and no lock left behind.
    expect(await leaseRow(leaseId)).toMatchObject({ state: 'resetting', released_at: null, reset_token: held.reset_token });
    expect((await pool.query(`SELECT 1 FROM files WHERE tenant_id = $1`, [tenant.tenantId])).rows).toHaveLength(1);

    await pool.query(`UPDATE demo_tenant_leases SET reset_heartbeat_at = now() - interval '61 seconds' WHERE id = $1`, [leaseId]);
    const tokenB = await takeOverStaleReset(pool, leaseId);
    expect(tokenB).toEqual(expect.any(String));
    expect(await resetter().continueReset(leaseId, tokenB!)).toMatchObject({ kind: 'released' });
    expect((await pool.query(`SELECT 1 FROM files WHERE tenant_id = $1`, [tenant.tenantId])).rows).toHaveLength(0);

    // The old run, let go, finds its connection gone and writes nothing.
    gate.resolve();
    expect(await run).toMatchObject({ kind: 'failed', step: 'object_delete', claimReturned: false });
    expect(await leaseRow(leaseId)).toMatchObject({ state: 'released' });
  });
});

describe('demo reset — cost (real Postgres, RLS_RUNTIME_ROLE=true)', () => {
  it('the stored-object step is the same seven statements with the context in place of the GUC; the drain adds one, on the same checkout; the reset keeps its checkouts (10, plus one per walk batch) and never holds two connections', async () => {
    const tenant = await newDemoTenant();
    await seedFile(tenant.tenantId);
    const leaseId = await leaseOn(tenant.tenantId);
    const traffic = countPoolTraffic(pool);

    expect(
      await resetter({ pool: traffic.pool, fixtureDeps: buildDemoFixtureDeps(traffic.pool) }).resetAndRelease(leaseId, {
        source: 'callback',
      }),
    ).toMatchObject({ kind: 'released' });

    const ran = traffic.statements().map(flat);
    /** The step's statements, from its BEGIN to the RESETs after its COMMIT. */
    const stepAt = (re: RegExp) => {
      const at = ran.findIndex((s) => re.test(s));
      expect(at).toBeGreaterThan(0);
      return ran.slice(ran.lastIndexOf('BEGIN', at), ran.indexOf('RESET app.current_tenant_id', at) + 1);
    };
    const fence = expect.stringMatching(FENCE);
    expect(stepAt(EXECUTING)).toEqual([
      'BEGIN',
      fence,
      expect.stringMatching(INFLIGHT),
      TENANT_CONTEXT_WITH_ROLE_SQL,
      expect.stringMatching(EXECUTING),
      'COMMIT',
      'RESET ROLE',
      'RESET app.current_tenant_id',
    ]);
    expect(stepAt(FILES)).toEqual([
      'BEGIN',
      fence,
      TENANT_CONTEXT_WITH_ROLE_SQL,
      expect.stringMatching(FILES),
      'COMMIT',
      'RESET ROLE',
      'RESET app.current_tenant_id',
    ]);
    // No reset step sets the tenant GUC without the role: what is left is
    // the claim's and the release's platform GUC and the walk's own batch GUC
    // (purge-walk.ts, §4 P3.3).
    const walkBatches = ran.filter((s) => /session_replication_role/.test(s)).length;
    expect(ran.filter((s) => s === "SELECT set_config('app.current_tenant_id', $1, true)").length).toBe(walkBatches + 2);
    // The checkouts are the base's: the claim, the identity read, queue cancel,
    // drain, queue purge, the object read and its batch, the walk's table list,
    // the re-seed, the release (10), plus one per walk batch; one open at a time.
    expect({ checkouts: traffic.checkouts() - walkBatches, maxOpen: traffic.maxOpen(), open: traffic.open() }).toEqual({
      checkouts: 10,
      maxOpen: 1,
      open: 0,
    });
  });
});
