/**
 * Postgres integration — S6-4 of the "pick, don't build" plan (U7 Approach,
 * "Release and reset"; Queued work, "Reset"; scenarios "Isolation (reset on
 * release)", "Isolation (heartbeat)", "Isolation (takeover during a slow
 * purge …)" and the Integration bullet's partial unique indexes and real
 * `_queue_messages` cancel).
 *
 * Everything runs on real Postgres with real connections: the claim, the
 * heartbeat, every fenced step, the shared purge walk, the fixture re-seed
 * and the release. Rows are seeded straight into a leased pool tenant; no
 * call is needed. The two injected pieces are the stored-object provider
 * (it records deletes, and fails one on demand) and the reset's hook
 * points, where a case pauses a resetter or injects a fault.
 *
 * Staleness is decided by the database's `now()` inside the takeover
 * statement, so a case ages `reset_heartbeat_at` in the row itself rather
 * than faking a process clock.
 *
 * Shared-DB rule: every case seeds its own plumbing demo tenants with
 * pool-shaped owner ids at random high slots, and ends with every lease it
 * took released.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getSharedTestDb } from './shared';
import { createPoolSlotTenant } from './demo-pool-tenant';
import {
  createDemoLeaseResetter,
  claimLease,
  takeOverStaleReset,
  DEMO_RESET_FAILED_RULE,
  type DemoResetHooks,
  type ResetStepName,
} from '../../src/demo/reset';
import { buildDemoFixtureDeps, demoBusinessName, type DemoFixtureDeps } from '../../src/demo/fixture';
import { insertLease } from '../../src/demo/lease';
import { DEMO_PLATFORM_TENANT_ID } from '../../src/demo/platform-tenant';
import { DevStorageProvider } from '../../src/files/storage-provider';
import { PgQueue } from '../../src/queues/pg-queue';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgEstimateTemplateRepository } from '../../src/templates/pg-estimate-template';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import type { OperatorAlert } from '../../src/monitoring/alert-operator';

const BATCH_ROWS = 2;

class RecordingStorage extends DevStorageProvider {
  deleted: string[] = [];
  failNext = 0;
  constructor() {
    super({ bucket: 'demo-bucket', publicUrlBase: 'http://localhost/storage-dev' });
  }
  override async deleteObject(bucket?: string, key?: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('object store unavailable');
    }
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

interface Stmt {
  seq: number;
  sql: string;
  rowCount: number;
}

/** A pool whose every statement (pool.query and each client's) is logged with a global sequence number once it resolves. */
function spyPool(pool: Pool, log: Stmt[], next: () => number): Pool {
  const record = (args: unknown[], res: { rowCount?: number | null } | undefined) => {
    const first = args[0] as string | { text?: string };
    log.push({ seq: next(), sql: typeof first === 'string' ? first : (first?.text ?? ''), rowCount: res?.rowCount ?? 0 });
  };
  const wrapClient = (c: PoolClient): PoolClient =>
    new Proxy(c, {
      get(t, p) {
        if (p === 'query') {
          return async (...args: unknown[]) => {
            const res = await (t.query as (...a: unknown[]) => Promise<{ rowCount?: number | null }>)(...args);
            record(args, res);
            return res;
          };
        }
        const v = Reflect.get(t, p, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  return new Proxy(pool, {
    get(t, p) {
      if (p === 'connect') return async () => wrapClient(await t.connect());
      if (p === 'query') {
        return async (...args: unknown[]) => {
          const res = await (t.query as (...a: unknown[]) => Promise<{ rowCount?: number | null }>)(...args);
          record(args, res);
          return res;
        };
      }
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql);

describe('Postgres integration — demo tenant reset and release (S6-4)', () => {
  let pool: Pool;
  let fixtureDeps: DemoFixtureDeps;
  let baselineTenant: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    fixtureDeps = buildDemoFixtureDeps(pool);
    baselineTenant = (await newDemoTenant()).tenantId;
  });

  const newDemoTenant = () => createPoolSlotTenant(pool, { seed: fixtureDeps });

  async function leaseOn(tenantId: string, expiresIn = '70 seconds'): Promise<{ id: string; generation: number }> {
    const { rows } = await pool.query<{ id: string; generation: string }>(
      `INSERT INTO demo_tenant_leases (tenant_id, visitor_phone_hash, expires_at)
       VALUES ($1, $2, now() + $3::interval) RETURNING id, generation`,
      [tenantId, `reset-test-${randomUUID()}`, expiresIn],
    );
    return { id: rows[0].id, generation: Number(rows[0].generation) };
  }

  /** What a live call leaves behind: a session, messages, a booking, a proposal, a customer, a stored file. */
  async function seedCallRows(tenantId: string): Promise<{ objects: string[] }> {
    const customerId = randomUUID();
    const locationId = randomUUID();
    const jobId = randomUUID();
    const conversationId = randomUUID();
    const key = `demo/${tenantId}/${randomUUID()}.wav`;
    await pool.query(`INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, 'Visitor Caller', 'demo')`, [
      customerId,
      tenantId,
    ]);
    for (let i = 0; i < 4; i += 1) {
      await pool.query(`INSERT INTO customers (tenant_id, display_name, created_by) VALUES ($1, $2, 'demo')`, [tenantId, `Extra ${i}`]);
    }
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
       VALUES ($1, $2, $3, '1 Main St', 'Austin', 'TX', '78701')`,
      [locationId, tenantId, customerId],
    );
    await pool.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
       VALUES ($1, $2, $3, $4, $5, 'Water heater', 'demo')`,
      [jobId, tenantId, customerId, locationId, `DEMO-${randomUUID().slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO appointments (tenant_id, job_id, created_by, timezone, scheduled_start, scheduled_end)
       VALUES ($1, $2, 'demo', 'America/New_York', now() + interval '1 day', now() + interval '1 day 1 hour')`,
      [tenantId, jobId],
    );
    await pool.query(`INSERT INTO voice_sessions (tenant_id, channel, state) VALUES ($1, 'voice_inbound', 'ended')`, [tenantId]);
    await pool.query(`INSERT INTO conversations (id, tenant_id, created_by) VALUES ($1, $2, 'demo')`, [conversationId, tenantId]);
    for (const role of ['customer', 'assistant']) {
      await pool.query(
        `INSERT INTO messages (tenant_id, conversation_id, sender_role, sender_id, message_type) VALUES ($1, $2, $3, 'x', 'text')`,
        [tenantId, conversationId, role],
      );
    }
    await pool.query(`INSERT INTO proposals (tenant_id, proposal_type, created_by, status) VALUES ($1, 'create_appointment', 'demo', 'draft')`, [tenantId]);
    await pool.query(
      `INSERT INTO files (tenant_id, filename, content_type, size_bytes, s3_bucket, s3_key, thumbnail_s3_key, uploaded_by)
       VALUES ($1, 'call.wav', 'audio/wav', 10, 'demo-bucket', $2, $3, 'demo')`,
      [tenantId, key, `${key}.thumb.jpg`],
    );
    await pool.query(
      `INSERT INTO audit_events (id, tenant_id, actor_id, actor_role, event_type, entity_type, entity_id, metadata, created_at)
       VALUES ($1, $2, 'demo', 'system', 'demo_reset.test_marker', 'tenant', $3, '{}'::jsonb, now())`,
      [randomUUID(), tenantId, tenantId],
    );
    return { objects: [`demo-bucket/${key}`, `demo-bucket/${key}.thumb.jpg`] };
  }

  /** Non-zero row counts per tenant_id table, except the two the reset keeps by design. */
  async function counts(tenantId: string): Promise<Record<string, number>> {
    const { rows: tables } = await pool.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name`,
    );
    const out: Record<string, number> = {};
    for (const { table_name } of tables) {
      if (table_name === 'audit_events' || table_name === 'demo_tenant_leases') continue;
      const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table_name}" WHERE tenant_id = $1`, [tenantId]);
      if (rows[0].n > 0) out[table_name] = rows[0].n;
    }
    return out;
  }

  async function shape(tenantId: string) {
    const s = await new PgSettingsRepository(pool).findByTenant(tenantId);
    const items = await new PgCatalogItemRepository(pool).listByTenant(tenantId);
    const templates = await new PgEstimateTemplateRepository(pool).findByTenant(tenantId);
    const packs = await new PgPackActivationRepository(pool).findByTenant(tenantId);
    return {
      timezone: s?.timezone,
      voiceId: s?.voiceId,
      packs: packs.map((p) => p.packId).sort(),
      activePacks: s?.activeVerticalPacks,
      items: items.map((i) => [i.name, i.unitPriceCents]).sort(),
      templates: templates.map((t) => t.name).sort(),
    };
  }

  /** The tenant equals a fresh clone: same row counts in every table but the two kept, same settings/catalog/templates. */
  async function expectEqualsFixture(tenant: { tenantId: string; slot: number }) {
    expect(await counts(tenant.tenantId)).toEqual(await counts(baselineTenant));
    const got = await shape(tenant.tenantId);
    expect(got.items.length).toBeGreaterThan(0);
    expect(got).toEqual(await shape(baselineTenant));
    const s = await new PgSettingsRepository(pool).findByTenant(tenant.tenantId);
    expect(s?.businessName).toBe(demoBusinessName('plumbing', tenant.slot));
  }

  async function leaseRow(id: string) {
    const { rows } = await pool.query(
      `SELECT state, released_at, reset_token, generation, expires_at <= now() AS expired FROM demo_tenant_leases WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function platformEvents(leaseId: string): Promise<string[]> {
    const { rows } = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2 ORDER BY created_at`,
      [DEMO_PLATFORM_TENANT_ID, leaseId],
    );
    return rows.map((r) => r.event_type);
  }

  /** The real lease pick in a transaction that is rolled back: which tenant would a visitor get now? */
  async function wouldPick(): Promise<string | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lease = await insertLease(client, { trade: 'plumbing', phoneHash: `reset-pick-${randomUUID()}` }, new Date());
      return lease?.tenantId ?? null;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  function resetter(
    opts: {
      hooks?: DemoResetHooks;
      storage?: RecordingStorage;
      alerts?: OperatorAlert[];
      pool?: Pool;
      heartbeatMs?: number;
      drainSeconds?: number;
    } = {},
  ) {
    const alerts = opts.alerts ?? [];
    return createDemoLeaseResetter({
      pool: opts.pool ?? pool,
      settings: { resetBatchRows: BATCH_ROWS, resetDrainSeconds: opts.drainSeconds ?? 1 },
      alert: async (a) => {
        alerts.push(a);
      },
      storage: opts.storage ?? new RecordingStorage(),
      fixtureDeps,
      heartbeatMs: opts.heartbeatMs ?? 3_600_000,
      drainPollMs: 20,
      hooks: opts.hooks,
    });
  }

  it('reset on release: the tenant equals a fresh clone, the lease is resetting and unleasable throughout and released only at the end', async () => {
    const tenant = await newDemoTenant();
    const { objects } = await seedCallRows(tenant.tenantId);
    const lease = await leaseOn(tenant.tenantId);
    const storage = new RecordingStorage();
    const observed: Array<{ step: ResetStepName; state: string; releasedAt: Date | null; picked: string | null }> = [];

    const outcome = await resetter({
      storage,
      hooks: {
        beforeStep: async (s) => {
          const row = await leaseRow(lease.id);
          observed.push({ step: s.name, state: row.state, releasedAt: row.released_at, picked: await wouldPick() });
        },
      },
    }).resetAndRelease(lease.id, { source: 'callback' });

    expect(outcome).toEqual({ kind: 'released', leaseId: lease.id, tenantId: tenant.tenantId });
    // Step order, each fenced step observed from outside.
    const order = observed.map((o) => o.step).filter((s, i, a) => i === 0 || a[i - 1] !== s);
    expect(order).toEqual(['queue_cancel', 'drain', 'queue_purge', 'object_delete', 'delete_batch', 'reseed', 'release']);
    for (const o of observed) {
      expect(o.state).toBe('resetting');
      expect(o.releasedAt).toBeNull();
      expect(o.picked).not.toBe(tenant.tenantId);
    }

    const after = await leaseRow(lease.id);
    expect(after.state).toBe('released');
    expect(after.released_at).not.toBeNull();
    expect(Number(after.generation)).toBeGreaterThan(lease.generation);
    await expectEqualsFixture(tenant);
    expect(storage.deleted.sort()).toEqual([...objects].sort());
    // The audit trail survives the reset; the lease's own events are on the platform tenant.
    const marker = await pool.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = 'demo_reset.test_marker'`, [
      tenant.tenantId,
    ]);
    expect(marker.rowCount).toBe(1);
    expect(await platformEvents(lease.id)).toEqual(['demo_lease_reset_started', 'demo_lease_released']);
    // Once released, the tenant is leasable again.
    expect((await pool.query(`SELECT 1 FROM demo_tenant_leases WHERE tenant_id = $1 AND released_at IS NULL`, [tenant.tenantId])).rowCount).toBe(0);
  });

  it('the queue cancel removes only unclaimed rows (delayed included); the drain waits for in-flight jobs and executing proposals; then every queue row of the tenant goes', async () => {
    const tenant = await newDemoTenant();
    const other = randomUUID();
    const lease = await leaseOn(tenant.tenantId);
    // Make sure the real queue table exists, as PgQueue creates it.
    await new PgQueue(pool).send('demo_reset_probe', { tenantId: other, label: 'neighbour-sent' }, `probe-${randomUUID()}`);
    const insert = (label: string, tenantId: string, attempts: number, visible: string, lastError: string | null = null) =>
      pool.query(
        `INSERT INTO _queue_messages (id, type, payload, attempts, max_attempts, idempotency_key, visible_at, last_error)
         VALUES ($1, 'demo_reset_probe', $2::jsonb, $3, 3, $4, now() + $5::interval, $6)`,
        [randomUUID(), JSON.stringify({ tenantId, label }), attempts, `probe-${randomUUID()}`, visible, lastError],
      );
    await insert('unclaimed', tenant.tenantId, 0, '0 seconds');
    await insert('delayed', tenant.tenantId, 0, '1 hour');
    await insert('claimed', tenant.tenantId, 1, '30 seconds');
    await insert('backoff', tenant.tenantId, 2, '120 seconds', 'boom');
    await insert('neighbour', other, 0, '0 seconds');
    await pool.query(
      `INSERT INTO demo_inflight_jobs (tenant_id, lease_id, generation, message_id) VALUES ($1, $2, $3, $4)`,
      [tenant.tenantId, lease.id, lease.generation, `msg-${randomUUID()}`],
    );
    const proposal = await pool.query<{ id: string }>(
      `INSERT INTO proposals (tenant_id, proposal_type, created_by, status) VALUES ($1, 'create_appointment', 'demo', 'executing') RETURNING id`,
      [tenant.tenantId],
    );
    const labels = async (tenantId: string) =>
      (
        await pool.query<{ label: string }>(
          `SELECT payload->>'label' AS label FROM _queue_messages WHERE payload->>'tenantId' = $1 ORDER BY 1`,
          [tenantId],
        )
      ).rows.map((r) => r.label);

    let atDrain: string[] | null = null;
    let polls = 0;
    const outcome = await resetter({
      drainSeconds: 30,
      hooks: {
        beforeStep: async (s) => {
          if (s.name === 'drain' && atDrain === null) atDrain = await labels(tenant.tenantId);
        },
        insideFence: async (s) => {
          if (s.name !== 'drain') return;
          polls += 1;
          if (polls === 2) await pool.query(`DELETE FROM demo_inflight_jobs WHERE lease_id = $1`, [lease.id]);
          if (polls === 4) await pool.query(`UPDATE proposals SET status = 'executed' WHERE id = $1`, [proposal.rows[0].id]);
        },
      },
    }).resetAndRelease(lease.id, { source: 'callback' });

    expect(outcome).toMatchObject({ kind: 'released' });
    expect(atDrain).toEqual(['backoff', 'claimed']);
    expect(polls).toBe(4);
    expect(await labels(tenant.tenantId)).toEqual([]);
    expect(await labels(other)).toEqual(['neighbour', 'neighbour-sent']);
    await pool.query(`DELETE FROM _queue_messages WHERE payload->>'tenantId' = $1`, [other]);
  });

  it('a handler still registered at the drain deadline fails the reset: alert, claim returned with expires_at = now(); the reaper retry then releases', async () => {
    const tenant = await newDemoTenant();
    const lease = await leaseOn(tenant.tenantId);
    await pool.query(
      `INSERT INTO demo_inflight_jobs (tenant_id, lease_id, generation, message_id) VALUES ($1, $2, $3, $4)`,
      [tenant.tenantId, lease.id, lease.generation, `msg-${randomUUID()}`],
    );
    const alerts: OperatorAlert[] = [];
    const failed = await resetter({ alerts, drainSeconds: 1 }).resetAndRelease(lease.id, { source: 'callback' });
    expect(failed).toMatchObject({ kind: 'failed', step: 'drain', claimReturned: true });
    const row = await leaseRow(lease.id);
    expect(row).toMatchObject({ state: 'active', released_at: null, expired: true });
    expect(alerts.map((a) => a.rule)).toEqual([DEMO_RESET_FAILED_RULE]);
    expect(await platformEvents(lease.id)).toEqual(['demo_lease_reset_started', 'demo_lease_reset_failed']);

    await pool.query(`DELETE FROM demo_inflight_jobs WHERE lease_id = $1`, [lease.id]);
    expect(await resetter().resetAndRelease(lease.id, { source: 'reaper' })).toMatchObject({ kind: 'released' });
    await expectEqualsFixture(tenant);
  });

  const faults: Array<[string, (storage: RecordingStorage) => DemoResetHooks, ResetStepName]> = [
    [
      'after the first delete batch',
      () => {
        let batches = 0;
        return {
          beforeStep: async (s) => {
            if (s.name === 'delete_batch' && ++batches === 2) throw new Error('injected fault');
          },
        };
      },
      'delete_batch',
    ],
    ['after the walk', () => ({ beforeStep: async (s) => { if (s.name === 'reseed') throw new Error('injected fault'); } }), 'reseed'],
    ['after the re-seed', () => ({ beforeStep: async (s) => { if (s.name === 'release') throw new Error('injected fault'); } }), 'release'],
    [
      'during object deletion',
      (storage) => {
        storage.failNext = 1;
        return {};
      },
      'object_delete',
    ],
  ];

  it.each(faults)('a fault %s stops the reset, returns the claim with expires_at = now(), and the reaper retry releases a tenant equal to the fixture', async (_label, arm, step) => {
    const tenant = await newDemoTenant();
    const { objects } = await seedCallRows(tenant.tenantId);
    const lease = await leaseOn(tenant.tenantId);
    const storage = new RecordingStorage();
    const alerts: OperatorAlert[] = [];

    const failed = await resetter({ storage, alerts, hooks: arm(storage) }).resetAndRelease(lease.id, { source: 'callback' });
    expect(failed).toMatchObject({ kind: 'failed', step, claimReturned: true });
    expect(await leaseRow(lease.id)).toMatchObject({ state: 'active', released_at: null, expired: true });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical', rule: DEMO_RESET_FAILED_RULE });
    expect(await wouldPick()).not.toBe(tenant.tenantId);

    const retried = await resetter({ storage }).resetAndRelease(lease.id, { source: 'reaper' });
    expect(retried).toMatchObject({ kind: 'released' });
    await expectEqualsFixture(tenant);
    // Every stored object was deleted, whichever attempt reached it.
    expect([...new Set(storage.deleted)].sort()).toEqual([...objects].sort());
    expect(await platformEvents(lease.id)).toEqual([
      'demo_lease_reset_started',
      'demo_lease_reset_failed',
      'demo_lease_reset_started',
      'demo_lease_released',
    ]);
  });

  it('the partial unique indexes reject a second unreleased lease on a resetting tenant and on its visitor hash', async () => {
    const tenant = await newDemoTenant();
    const second = await newDemoTenant();
    const lease = await leaseOn(tenant.tenantId);
    const claim = await claimLease(pool, lease.id, 'callback');
    expect(claim).not.toBeNull();
    const { rows } = await pool.query<{ visitor_phone_hash: string }>(`SELECT visitor_phone_hash FROM demo_tenant_leases WHERE id = $1`, [lease.id]);

    await expect(
      pool.query(`INSERT INTO demo_tenant_leases (tenant_id, visitor_phone_hash, expires_at) VALUES ($1, $2, now())`, [
        tenant.tenantId,
        `other-${randomUUID()}`,
      ]),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(`INSERT INTO demo_tenant_leases (tenant_id, visitor_phone_hash, expires_at) VALUES ($1, $2, now())`, [
        second.tenantId,
        rows[0].visitor_phone_hash,
      ]),
    ).rejects.toMatchObject({ code: '23505' });

    expect(await resetter().continueReset(lease.id, claim!.token)).toMatchObject({ kind: 'released' });
  });

  it('a no_call claim never takes a lease a callback has bound to a call; a callback claim does', async () => {
    const tenant = await newDemoTenant();
    const lease = await leaseOn(tenant.tenantId);
    await pool.query(`UPDATE demo_tenant_leases SET call_sid = $2 WHERE id = $1`, [lease.id, `CA${randomUUID().replace(/-/g, '')}`]);
    expect(await resetter().resetAndRelease(lease.id, { source: 'no_call' })).toEqual({ kind: 'not_claimed', leaseId: lease.id });
    expect(await leaseRow(lease.id)).toMatchObject({ state: 'active', released_at: null });
    expect(await resetter().resetAndRelease(lease.id, { source: 'callback' })).toMatchObject({ kind: 'released' });
  });

  it('heartbeat: a running reset renews reset_heartbeat_at from its own connection; a fresh heartbeat cannot be taken over', async () => {
    const tenant = await newDemoTenant();
    const lease = await leaseOn(tenant.tenantId);
    const gate = deferred();
    const paused = deferred();
    let hit = false;
    const run = resetter({
      heartbeatMs: 40,
      hooks: {
        beforeStep: async (s) => {
          if (s.name === 'queue_cancel' && !hit) {
            hit = true;
            paused.resolve();
            await gate.promise;
          }
        },
      },
    }).resetAndRelease(lease.id, { source: 'callback' });
    await paused.promise;
    await pool.query(`UPDATE demo_tenant_leases SET reset_heartbeat_at = now() - interval '30 seconds' WHERE id = $1`, [lease.id]);
    const aged = await pool.query<{ age: number }>(`SELECT extract(epoch FROM now() - reset_heartbeat_at)::float AS age FROM demo_tenant_leases WHERE id = $1`, [lease.id]);
    expect(aged.rows[0].age).toBeGreaterThanOrEqual(29);
    await new Promise((r) => {
      setTimeout(r, 250);
    });
    const renewed = await pool.query<{ age: number }>(`SELECT extract(epoch FROM now() - reset_heartbeat_at)::float AS age FROM demo_tenant_leases WHERE id = $1`, [lease.id]);
    expect(renewed.rows[0].age).toBeLessThan(5);
    expect(await takeOverStaleReset(pool, lease.id)).toBeNull();
    gate.resolve();
    expect(await run).toMatchObject({ kind: 'released' });
  });

  const pausePoints: ResetStepName[] = ['delete_batch', 'queue_cancel', 'reseed', 'release'];

  it.each(pausePoints)('takeover while A is paused before %s: A writes nothing after B holds the token, B finishes the reset', async (point) => {
    const tenant = await newDemoTenant();
    await seedCallRows(tenant.tenantId);
    const lease = await leaseOn(tenant.tenantId);
    const log: Stmt[] = [];
    let seq = 0;
    const gate = deferred();
    const paused = deferred();
    let hit = false;
    const a = resetter({
      pool: spyPool(pool, log, () => ++seq),
      hooks: {
        beforeStep: async (s) => {
          if (s.name === point && !hit) {
            hit = true;
            paused.resolve();
            await gate.promise;
          }
        },
      },
    });
    const aRun = a.resetAndRelease(lease.id, { source: 'callback' });
    await paused.promise;

    expect(await takeOverStaleReset(pool, lease.id)).toBeNull();
    await pool.query(`UPDATE demo_tenant_leases SET reset_heartbeat_at = now() - interval '61 seconds' WHERE id = $1`, [lease.id]);
    const tokenB = await takeOverStaleReset(pool, lease.id);
    expect(tokenB).toEqual(expect.any(String));
    const takenOverAt = ++seq;
    gate.resolve();

    expect(await aRun).toMatchObject({ kind: 'fenced_out', step: point });
    const writesAfter = log.filter((s) => s.seq > takenOverAt && isWrite(s.sql) && s.rowCount > 0);
    expect(writesAfter).toEqual([]);

    expect(await resetter().continueReset(lease.id, tokenB!)).toMatchObject({ kind: 'released' });
    await expectEqualsFixture(tenant);
    expect(await platformEvents(lease.id)).toEqual([
      'demo_lease_reset_started',
      'demo_lease_reset_taken_over',
      'demo_lease_released',
    ]);
  });

  it("B's takeover UPDATE waits on A's open FOR SHARE batch, and A's next step is fenced out", async () => {
    // A live resetter that starts its next batch at once re-takes the share
    // lock ahead of the waiting UPDATE (Postgres does not queue a share
    // locker behind a waiting updater once the old locker has committed).
    // That keeps the takeover waiting only while A is alive and writing,
    // which is never the case a takeover is for; the paused A below is.
    const tenant = await newDemoTenant();
    await seedCallRows(tenant.tenantId);
    const lease = await leaseOn(tenant.tenantId);
    const holdGate = deferred();
    const nextGate = deferred();
    const holding = deferred();
    const atNext = deferred();
    let batches = 0;
    const aRun = resetter({
      hooks: {
        beforeStep: async (s) => {
          if (s.name !== 'delete_batch' || s.table !== 'customers') return;
          batches += 1;
          // Age the heartbeat before the first batch takes its share lock.
          if (batches === 1) {
            await pool.query(`UPDATE demo_tenant_leases SET reset_heartbeat_at = now() - interval '61 seconds' WHERE id = $1`, [lease.id]);
          }
          // A stalls before its next batch's fence (no lock held).
          if (batches === 2) {
            atNext.resolve();
            await nextGate.promise;
          }
        },
        insideFence: async (s) => {
          if (s.name === 'delete_batch' && s.table === 'customers' && batches === 1) {
            holding.resolve();
            await holdGate.promise;
          }
        },
      },
    }).resetAndRelease(lease.id, { source: 'callback' });
    await holding.promise;

    let settled = false;
    const takeover = takeOverStaleReset(pool, lease.id).then((t) => {
      settled = true;
      return t;
    });
    await new Promise((r) => {
      setTimeout(r, 400);
    });
    expect(settled).toBe(false);
    const waiting = await pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%reset_token = gen_random_uuid()%'`,
    );
    expect(waiting.rowCount).toBeGreaterThanOrEqual(1);

    const before = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1`, [tenant.tenantId]);
    holdGate.resolve();
    await atNext.promise;
    const tokenB = await takeover;
    expect(tokenB).toEqual(expect.any(String));
    nextGate.resolve();
    expect(await aRun).toMatchObject({ kind: 'fenced_out', step: 'delete_batch' });
    // A's batch in flight committed before B held the token; nothing of A's after it.
    const afterA = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1`, [tenant.tenantId]);
    expect(afterA.rows[0].n).toBe(before.rows[0].n - BATCH_ROWS);

    expect(await resetter().continueReset(lease.id, tokenB!)).toMatchObject({ kind: 'released' });
    await expectEqualsFixture(tenant);
  });
});
