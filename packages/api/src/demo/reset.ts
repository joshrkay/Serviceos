/**
 * U7 (S6-4) — end a demo tenant lease: reset the tenant, then release it
 * (plan Approach, "Release and reset"; Queued work, "Reset").
 *
 * Three callers can end one lease (a terminal status callback, the reaper
 * once `expires_at` passes, and the start service when the `Calls` request
 * provably created no call), and a reset can outlive the process that began
 * it. So every end of a lease goes through `resetAndRelease`, built on:
 *
 *   1. A claim: `active` → `resetting` with a fresh `reset_token` (the
 *      resetter's fencing token) and a fresh `generation` (which invalidates
 *      every job stamped before it). Zero rows means another path holds the
 *      lease or it is already released, and this one does nothing. Under
 *      `lock_timeout = 5s`; a timeout counts as zero rows.
 *   2. A heartbeat every 10 s from its own pooled connection. Zero rows
 *      means a takeover happened, and the heartbeat stops. Only the reaper
 *      takes over, and only once the heartbeat is 60 s stale.
 *   3. Fenced steps: every side effect is its own short transaction that
 *      opens with `SELECT 1 … AND reset_token = $token FOR SHARE`, so a
 *      takeover's token UPDATE waits for a step in flight to commit, and no
 *      write of an old resetter lands after its successor holds the token.
 *      Order: queue cancel, drain, queue purge, stored objects, the row
 *      walk (bounded batches; keep-list below), the fixture re-seed. The
 *      tenant's trade and pool slot (what the re-seed needs) are read
 *      before any of them, so a tenant that could not be re-seeded fails
 *      with nothing deleted. The fence runs on the connection principal
 *      (the lease table is RLS-exempt and rls_app_runtime holds no grant on
 *      it); a step that reads the tenant's own rows (the drain's executing
 *      proposals, the stored-object keys) then takes the tenant's context
 *      and reads them as rls_app_runtime (`fencedTenant`). The queue
 *      statements (`_queue_messages` has no RLS), the in-flight registry
 *      read (RLS-exempt) and the walk's fence stay on the principal, and the
 *      re-seed applies its own context.
 *   4. The release, fenced by the same token in its UPDATE. `released_at`
 *      is set only here, so the tenant stays unleasable through every step.
 *
 * Any failure alerts the operator and returns the claim (`active`,
 * `expires_at = now()`, fenced), so nothing can start under it and the
 * reaper's next sweep retries the whole reset from the top; every step is
 * safe to repeat. A step that finds its fence gone stops without writing.
 *
 * Plan correction: stored objects are deleted before the walk, not after
 * the re-seed. Their keys live only in `files` rows, which the walk deletes;
 * a fault after that point would leave the retry nothing to find. A reset
 * never restores rows, so deleting the objects first loses nothing.
 */
import type { Pool, PoolClient } from 'pg';
import type { StorageProvider } from '../files/file-service';
import type { Logger } from '../logging/logger';
import type { AlertOperatorFn } from '../monitoring/alert-operator';
import { applyTenantContext, clearTenantContext } from '../db/rls-runtime-role';
import { purgeTenantRows } from '../tenants/purge-walk';
import {
  buildDemoFixtureDeps,
  isDemoTrade,
  seedDemoTenantFromFixture,
  type DemoFixtureDeps,
  type DemoTrade,
} from './fixture';
import { setPlatformTenantContext, writePlatformAudit } from './platform-audit';

/**
 * Who is ending the lease. `reaper` claims only a lease past `expires_at`
 * (a renewal that committed after the sweep read leaves the claim zero
 * rows); `no_call` claims only a lease no callback has bound to a call;
 * `callback` (a terminal status) claims whenever it arrives.
 */
export type ResetSource = 'callback' | 'reaper' | 'no_call';

/**
 * The walk's keep-list: the tenant row, the lease table (its `tenant_id`
 * names this very tenant; deleting it mid-reset would make the tenant look
 * free while dirty), the in-flight registry the drain reads, and the
 * append-only audit trail (it stays, flagged by `tenants.demo`).
 */
export const DEMO_RESET_KEEP_TABLES = ['tenants', 'demo_tenant_leases', 'demo_inflight_jobs', 'audit_events'] as const;

export const DEMO_RESET_HEARTBEAT_MS = 10_000;
export const DEMO_RESET_DRAIN_POLL_MS = 1_000;
/** The reaper takes over a reset whose heartbeat is older than this (six missed beats). */
export const DEMO_RESET_STALE_SECONDS = 60;
/** Stored objects deleted per fenced transaction. */
export const DEMO_RESET_OBJECT_BATCH = 100;

export const DEMO_LEASE_RESET_STARTED_EVENT = 'demo_lease_reset_started';
export const DEMO_LEASE_RELEASED_EVENT = 'demo_lease_released';
export const DEMO_LEASE_RESET_FAILED_EVENT = 'demo_lease_reset_failed';
export const DEMO_LEASE_RESET_TAKEN_OVER_EVENT = 'demo_lease_reset_taken_over';
export const DEMO_RESET_FAILED_RULE = 'demo_reset_failed';

export type ResetStepName =
  | 'queue_cancel'
  | 'drain'
  | 'queue_purge'
  | 'object_delete'
  | 'delete_batch'
  | 'reseed'
  | 'release';

export interface ResetStep {
  name: ResetStepName;
  /** The table a `delete_batch` step deletes from. */
  table?: string;
}

/**
 * Observation and fault points around each fenced step (tests pause and
 * fail the reset here; production passes none). `beforeStep` runs before
 * the step's transaction opens; `insideFence` runs on it, after the fence
 * passed and before the step writes.
 */
export interface DemoResetHooks {
  beforeStep?(step: ResetStep): Promise<void>;
  insideFence?(step: ResetStep, client: PoolClient): Promise<void>;
}

export interface DemoTenantIdentity {
  tenantId: string;
  trade: DemoTrade;
  slot: number;
}

export interface DemoResetDeps {
  pool: Pool;
  /** `DEMO_RESET_BATCH_ROWS` and `DEMO_RESET_DRAIN_SECONDS` (demo/config.ts). */
  settings: { resetBatchRows: number; resetDrainSeconds: number };
  alert: AlertOperatorFn;
  storage: StorageProvider;
  /** Default: the real Pg repos (`buildDemoFixtureDeps(pool)`). */
  fixtureDeps?: DemoFixtureDeps;
  /** Default: `seedDemoTenantFromFixture` with the tenant's own trade and slot. */
  reseed?: (client: PoolClient, tenant: DemoTenantIdentity, fixtureDeps: DemoFixtureDeps) => Promise<void>;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
  heartbeatMs?: number;
  drainPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  hooks?: DemoResetHooks;
}

export type ResetOutcome =
  | { kind: 'released'; leaseId: string; tenantId: string }
  | { kind: 'not_claimed'; leaseId: string }
  | { kind: 'fenced_out'; leaseId: string; step: ResetStepName }
  | { kind: 'failed'; leaseId: string; step: ResetStepName; error: string; claimReturned: boolean };

export interface DemoLeaseResetter {
  /** Claim the lease for `source`, reset the tenant, release the lease. */
  resetAndRelease(leaseId: string, opts: { source: ResetSource }): Promise<ResetOutcome>;
  /** Run the reset from the top under a token the caller already holds (the reaper's takeover). */
  continueReset(leaseId: string, token: string): Promise<ResetOutcome>;
}

/** The fence found the lease released, returned or taken over: stop without writing. */
export class ResetFencedOutError extends Error {
  constructor(readonly step: ResetStepName) {
    super(`demo reset fenced out at ${step}`);
    this.name = 'ResetFencedOutError';
  }
}

class ResetStepError extends Error {
  constructor(
    readonly step: ResetStepName,
    original: unknown,
  ) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'ResetStepError';
  }
}

const sleepReal = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The drain's predicate: work that could still write for the tenant. Every
 * in-flight registry row of the tenant (any generation) and every proposal
 * still `executing`; the drain waits until their sum is zero. S6-8 extends
 * these two reads (D7 terminalization). Never reads `visible_at` or
 * `attempts`.
 *
 * Two statements because the two tables answer to different roles: the
 * registry is an RLS-exempt platform table that rls_app_runtime holds no
 * grant on (migration 317), read on the principal before the step's tenant
 * context; `proposals` is under FORCE RLS, read after it as rls_app_runtime.
 * Under READ COMMITTED each takes its own snapshot (the one statement before
 * them took one for both). The step stays READ COMMITTED: REPEATABLE READ
 * would give the two reads one snapshot, but the step's first statement is
 * the fence's FOR SHARE on the lease row, and under REPEATABLE READ that
 * fails with a serialization error (40001) whenever the reset's own
 * heartbeat UPDATE of the row commits while the fence waits on it.
 *
 * The second snapshot matters only once something writes demo_inflight_jobs:
 * nothing in src does yet (S6-8 adds job-guard's registration and D7's for
 * proposal executions), so today the registry count is 0 and the drain waits
 * on the proposals count alone. Once it is written, a job missing from the
 * first read must not be live at the second. S6-8 must re-check that: every
 * registry INSERT stays in the same transaction as the generation check's
 * FOR SHARE on the lease row (so nothing registers once the reset has
 * claimed the lease), and a D7 execution registers in the same transaction
 * that moves its proposal to `executing`. If either stops holding, re-read
 * the registry after the proposals count.
 */
async function inFlightJobCount(client: PoolClient, tenantId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*) AS n FROM demo_inflight_jobs WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function executingProposalCount(client: PoolClient, tenantId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*) AS n FROM proposals WHERE tenant_id = $1 AND status = 'executing'`,
    [tenantId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** `owner_id` of a pool slot is `demo:<trade>:<slot>` (seed-pool.ts). */
export function parseDemoSlot(ownerId: string, trade: string): number | null {
  const m = /^demo:([a-z]+):(\d{1,15})$/.exec(ownerId);
  if (!m || m[1] !== trade) return null;
  const slot = Number(m[2]);
  return Number.isSafeInteger(slot) && slot >= 1 ? slot : null;
}

function claimSql(source: ResetSource): string {
  const extra =
    source === 'reaper' ? ' AND expires_at <= now()' : source === 'no_call' ? ' AND call_sid IS NULL' : '';
  return `UPDATE demo_tenant_leases
     SET state = 'resetting', reset_started_at = now(), reset_heartbeat_at = now(),
         reset_token = gen_random_uuid(), generation = nextval('demo_lease_generation_seq')
   WHERE id = $1 AND state = 'active'${extra}
   RETURNING reset_token, tenant_id, generation`;
}

const FENCE_SQL = `SELECT 1 FROM demo_tenant_leases
  WHERE id = $1 AND state = 'resetting' AND reset_token = $2 FOR SHARE`;

const LOCK_NOT_AVAILABLE = '55P03';

async function inPlatformTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setPlatformTenantContext(client);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The claim. Null when another path holds the lease, it is released, the
 * source's own condition fails, or the row lock did not come within 5 s.
 */
export async function claimLease(
  pool: Pool,
  leaseId: string,
  source: ResetSource,
): Promise<{ token: string; tenantId: string } | null> {
  try {
    return await inPlatformTransaction(pool, async (client) => {
      await client.query("SET LOCAL lock_timeout = '5s'");
      const { rows } = await client.query<{ reset_token: string; tenant_id: string; generation: string }>(
        claimSql(source),
        [leaseId],
      );
      const row = rows[0];
      if (!row) return null;
      await writePlatformAudit(client, {
        eventType: DEMO_LEASE_RESET_STARTED_EVENT,
        entityType: 'demo_tenant_lease',
        entityId: leaseId,
        metadata: { source, tenantId: row.tenant_id, generation: row.generation },
      });
      return { token: row.reset_token, tenantId: row.tenant_id };
    });
  } catch (err) {
    if ((err as { code?: string }).code === LOCK_NOT_AVAILABLE) return null;
    throw err;
  }
}

/**
 * The reaper's takeover of a reset whose heartbeat is stale. The age of the
 * claim never justifies one; only missed heartbeats do. Returns the new
 * token, or null when the heartbeat is fresh or the lease is not resetting.
 */
export async function takeOverStaleReset(
  pool: Pool,
  leaseId: string,
  staleSeconds: number = DEMO_RESET_STALE_SECONDS,
): Promise<string | null> {
  return inPlatformTransaction(pool, async (client) => {
    const { rows } = await client.query<{ reset_token: string; tenant_id: string }>(
      `UPDATE demo_tenant_leases SET reset_token = gen_random_uuid(), reset_heartbeat_at = now()
        WHERE id = $1 AND state = 'resetting'
          AND reset_heartbeat_at < now() - make_interval(secs => $2)
        RETURNING reset_token, tenant_id`,
      [leaseId, staleSeconds],
    );
    const row = rows[0];
    if (!row) return null;
    await writePlatformAudit(client, {
      eventType: DEMO_LEASE_RESET_TAKEN_OVER_EVENT,
      entityType: 'demo_tenant_lease',
      entityId: leaseId,
      metadata: { tenantId: row.tenant_id },
    });
    return row.reset_token;
  });
}

export function createDemoLeaseResetter(deps: DemoResetDeps): DemoLeaseResetter {
  const { pool } = deps;
  const hooks = deps.hooks ?? {};
  const sleep = deps.sleep ?? sleepReal;
  const heartbeatMs = deps.heartbeatMs ?? DEMO_RESET_HEARTBEAT_MS;
  const drainPollMs = deps.drainPollMs ?? DEMO_RESET_DRAIN_POLL_MS;
  let fixtureDeps = deps.fixtureDeps;
  const reseed =
    deps.reseed ??
    (async (client: PoolClient, tenant: DemoTenantIdentity, fd: DemoFixtureDeps) => {
      await seedDemoTenantFromFixture(client, tenant, fd);
    });

  /**
   * One fenced step: its own transaction, the fence first, then `fn` on the
   * principal client. The fence is a FOR SHARE read of the RLS-exempt lease
   * row, which rls_app_runtime holds no grant on (migration 317), so it runs
   * before any tenant context; its row lock is the transaction's and holds
   * until COMMIT / ROLLBACK whatever role the step's later statements take.
   */
  async function fenced<T>(
    leaseId: string,
    token: string,
    step: ResetStep,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    await hooks.beforeStep?.(step);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fence = await client.query(FENCE_SQL, [leaseId, token]);
      if (fence.rowCount !== 1) throw new ResetFencedOutError(step.name);
      await hooks.insideFence?.(step, client);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await clearTenantContext(client);
      client.release();
    }
  }

  /**
   * A fenced step on the tenant's own rows: `fenced`, then `principal` (if
   * any) for what only the principal may read, then the tenant's context, so
   * `tenant` runs as rls_app_runtime and the policies bind. The context is
   * transaction-local (the step's COMMIT / ROLLBACK ends it, and `fenced`
   * still clears the client before release).
   */
  function fencedTenant<T, P = undefined>(
    leaseId: string,
    token: string,
    step: ResetStep,
    tenantId: string,
    phases: {
      principal?: (client: PoolClient) => Promise<P>;
      tenant: (client: PoolClient, principal: P | undefined) => Promise<T>;
    },
  ): Promise<T> {
    return fenced(leaseId, token, step, async (client) => {
      const before = phases.principal ? await phases.principal(client) : undefined;
      await applyTenantContext(client, tenantId, { transactional: true });
      return phases.tenant(client, before);
    });
  }

  function startHeartbeat(leaseId: string, token: string): () => void {
    let stopped = false;
    const timer = setInterval(() => {
      void pool
        .query(
          `UPDATE demo_tenant_leases SET reset_heartbeat_at = now()
            WHERE id = $1 AND state = 'resetting' AND reset_token = $2`,
          [leaseId, token],
        )
        .then((res) => {
          if (res.rowCount === 0 && !stopped) {
            stopped = true;
            clearInterval(timer);
            deps.logger?.warn('demo reset: heartbeat found the lease taken over or released; stopping', { leaseId });
          }
        })
        .catch((err: unknown) => {
          deps.logger?.warn('demo reset: heartbeat failed', {
            leaseId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, heartbeatMs);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async function step<T>(name: ResetStepName, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ResetFencedOutError || err instanceof ResetStepError) throw err;
      throw new ResetStepError(name, err);
    }
  }

  async function queueStatement(client: PoolClient, sql: string, tenantId: string): Promise<void> {
    const exists = await client.query<{ present: boolean }>(
      `SELECT to_regclass('public._queue_messages') IS NOT NULL AS present`,
    );
    if (exists.rows[0]?.present) await client.query(sql, [tenantId]);
  }

  async function runSteps(leaseId: string, token: string, identity: DemoTenantIdentity): Promise<void> {
    const { tenantId } = identity;
    // (ii) Queue cancel: the tenant's unclaimed jobs, delayed ones included.
    await step('queue_cancel', () =>
      fenced(leaseId, token, { name: 'queue_cancel' }, (c) =>
        queueStatement(c, `DELETE FROM _queue_messages WHERE payload->>'tenantId' = $1 AND attempts = 0`, tenantId),
      ),
    );

    // (iii) Drain: wait for in-flight work, polling, up to the deadline.
    await step('drain', async () => {
      const polls = Math.max(1, Math.ceil((deps.settings.resetDrainSeconds * 1000) / drainPollMs));
      for (let i = 0; ; i += 1) {
        const pending = await fencedTenant(leaseId, token, { name: 'drain' }, tenantId, {
          principal: (c) => inFlightJobCount(c, tenantId),
          tenant: async (c, inFlight) => (inFlight ?? 0) + (await executingProposalCount(c, tenantId)),
        });
        if (pending === 0) return;
        if (i >= polls) {
          throw new Error(`in-flight work still running after ${deps.settings.resetDrainSeconds}s (${pending} left)`);
        }
        await sleep(drainPollMs);
      }
    });

    // (iv) Every queue row left for the tenant.
    await step('queue_purge', () =>
      fenced(leaseId, token, { name: 'queue_purge' }, (c) =>
        queueStatement(c, `DELETE FROM _queue_messages WHERE payload->>'tenantId' = $1`, tenantId),
      ),
    );

    // Stored objects, while the files rows that name them still exist.
    await step('object_delete', async () => {
      const objects = await fencedTenant(leaseId, token, { name: 'object_delete' }, tenantId, {
        tenant: async (c) => {
          const { rows } = await c.query<{ s3_bucket: string; s3_key: string; thumbnail_s3_key: string | null }>(
            `SELECT s3_bucket, s3_key, thumbnail_s3_key FROM files WHERE tenant_id = $1 ORDER BY id`,
            [tenantId],
          );
          const found: Array<{ bucket: string; key: string }> = [];
          for (const row of rows) {
            if (!row.s3_bucket) continue;
            if (row.s3_key) found.push({ bucket: row.s3_bucket, key: row.s3_key });
            if (row.thumbnail_s3_key && row.thumbnail_s3_key !== row.s3_key) {
              found.push({ bucket: row.s3_bucket, key: row.thumbnail_s3_key });
            }
          }
          return found;
        },
      });
      for (let i = 0; i < objects.length; i += DEMO_RESET_OBJECT_BATCH) {
        const batch = objects.slice(i, i + DEMO_RESET_OBJECT_BATCH);
        await fenced(leaseId, token, { name: 'object_delete' }, async () => {
          for (const o of batch) await deps.storage.deleteObject(o.bucket, o.key);
        });
      }
    });

    // The row walk, one fenced batch at a time.
    await step('delete_batch', async () => {
      try {
        await purgeTenantRows(pool, tenantId, {
          keep: DEMO_RESET_KEEP_TABLES,
          batchRows: deps.settings.resetBatchRows,
          // Runs on each batch's own transaction: the hook point before the
          // fence (no lock held yet), then the fence, then the hook inside it.
          beforeStep: async (client, table) => {
            const s: ResetStep = { name: 'delete_batch', table };
            await hooks.beforeStep?.(s);
            const fence = await client.query(FENCE_SQL, [leaseId, token]);
            if (fence.rowCount !== 1) throw new ResetFencedOutError('delete_batch');
            await hooks.insideFence?.(s, client);
          },
        });
      } catch (err) {
        if (err instanceof ResetFencedOutError) throw err;
        throw new ResetStepError('delete_batch', err);
      }
    });

    // The re-seed, in one fenced transaction (the walk emptied the tables).
    await step('reseed', async () => {
      fixtureDeps ??= buildDemoFixtureDeps(pool);
      const fd = fixtureDeps;
      await fenced(leaseId, token, { name: 'reseed' }, (c) => reseed(c, identity, fd));
    });
  }

  async function readIdentity(tenantId: string): Promise<DemoTenantIdentity> {
    const { rows } = await pool.query<{ demo: boolean; demo_trade: string | null; owner_id: string }>(
      `SELECT demo, demo_trade, owner_id FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const t = rows[0];
    if (!t || !t.demo) throw new Error(`tenant ${tenantId} is not a demo tenant`);
    if (!t.demo_trade || !isDemoTrade(t.demo_trade)) throw new Error(`demo tenant ${tenantId} has no known trade`);
    const slot = parseDemoSlot(t.owner_id, t.demo_trade);
    if (slot === null) throw new Error(`demo tenant ${tenantId} owner id is not a pool slot`);
    return { tenantId, trade: t.demo_trade, slot };
  }

  async function release(leaseId: string, token: string, tenantId: string): Promise<boolean> {
    await hooks.beforeStep?.({ name: 'release' });
    return inPlatformTransaction(pool, async (client) => {
      await hooks.insideFence?.({ name: 'release' }, client);
      const res = await client.query(
        `UPDATE demo_tenant_leases SET state = 'released', released_at = now()
          WHERE id = $1 AND state = 'resetting' AND reset_token = $2`,
        [leaseId, token],
      );
      if (res.rowCount !== 1) return false;
      await writePlatformAudit(client, {
        eventType: DEMO_LEASE_RELEASED_EVENT,
        entityType: 'demo_tenant_lease',
        entityId: leaseId,
        metadata: { tenantId },
      });
      return true;
    });
  }

  async function returnClaim(leaseId: string, token: string, tenantId: string, failed: ResetStepError): Promise<boolean> {
    return inPlatformTransaction(pool, async (client) => {
      const res = await client.query(
        `UPDATE demo_tenant_leases SET state = 'active', expires_at = now()
          WHERE id = $1 AND state = 'resetting' AND reset_token = $2`,
        [leaseId, token],
      );
      if (res.rowCount !== 1) return false;
      await writePlatformAudit(client, {
        eventType: DEMO_LEASE_RESET_FAILED_EVENT,
        entityType: 'demo_tenant_lease',
        entityId: leaseId,
        metadata: { tenantId, step: failed.step, error: failed.message },
      });
      return true;
    });
  }

  async function run(leaseId: string, token: string, tenantId: string): Promise<ResetOutcome> {
    const stopHeartbeat = startHeartbeat(leaseId, token);
    try {
      // What the re-seed needs is read first: a tenant that could not be
      // re-seeded is failed before anything of it is deleted.
      const identity = await step('reseed', () => readIdentity(tenantId));
      await runSteps(leaseId, token, identity);
      if (!(await release(leaseId, token, tenantId))) throw new ResetFencedOutError('release');
      deps.logger?.info('demo reset: lease released', { leaseId, tenantId });
      return { kind: 'released', leaseId, tenantId };
    } catch (err) {
      if (err instanceof ResetFencedOutError) {
        deps.logger?.warn('demo reset: fenced out; another resetter holds the lease', { leaseId, step: err.step });
        return { kind: 'fenced_out', leaseId, step: err.step };
      }
      const failed = err instanceof ResetStepError ? err : new ResetStepError('release', err);
      deps.logger?.error('demo reset failed; returning the claim', { leaseId, tenantId, step: failed.step, error: failed.message });
      await deps.alert({
        severity: 'critical',
        rule: DEMO_RESET_FAILED_RULE,
        summary: 'A demo tenant reset failed; the lease is held and the reaper will retry it',
        details: { lease_id: leaseId, tenant_id: tenantId, step: failed.step, error: failed.message.slice(0, 200) },
      });
      let claimReturned = false;
      try {
        claimReturned = await returnClaim(leaseId, token, tenantId, failed);
      } catch (returnErr) {
        deps.logger?.error('demo reset: returning the claim failed; the heartbeat will lapse and the reaper takes over', {
          leaseId,
          error: returnErr instanceof Error ? returnErr.message : String(returnErr),
        });
      }
      return { kind: 'failed', leaseId, step: failed.step, error: failed.message, claimReturned };
    } finally {
      stopHeartbeat();
    }
  }

  async function tenantOf(leaseId: string): Promise<string | null> {
    const { rows } = await pool.query<{ tenant_id: string }>(`SELECT tenant_id FROM demo_tenant_leases WHERE id = $1`, [leaseId]);
    return rows[0]?.tenant_id ?? null;
  }

  return {
    async resetAndRelease(leaseId, { source }) {
      const claim = await claimLease(pool, leaseId, source);
      if (!claim) return { kind: 'not_claimed', leaseId };
      return run(leaseId, claim.token, claim.tenantId);
    },
    async continueReset(leaseId, token) {
      const tenantId = await tenantOf(leaseId);
      if (!tenantId) return { kind: 'not_claimed', leaseId };
      return run(leaseId, token, tenantId);
    },
  };
}
