/**
 * Postgres integration — POST /api/onboarding/phone/change, /phone/claim and
 * /phone/retry write their marker on the twilio row, their audit row and their
 * provision-twilio job in ONE request transaction.
 *
 * Each route enqueued the job with `queue.send`, which commits the row on the
 * queue's own connection, and only then wrote its audit event. A request that
 * failed after that (the audit store down, or anything else that rolls the
 * request back) answered 500 and rolled back its marker and audit row, but the
 * job had already committed: the worker bought or swapped a number for a
 * request that, on the record, never happened. The committed job was also
 * visible to the worker before the marker it reads (pendingChange /
 * pendingPick) had committed.
 *
 * The routes now write the audit row first and then the job on the request
 * client (`PgQueue.sendOn`, the P0-009 transactional enqueue), the shape
 * POST /ai-check/retry took in #1813. The suite mounts the real
 * `withTenantTransaction` middleware, forces RLS_RUNTIME_ROLE on, uses a real
 * PgQueue, reads `_queue_messages` back, and asks Postgres (statement-role-probe)
 * which role and tenant each write ran under.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { Pool, PoolClient } from 'pg';
import {
  closeSharedTestDb,
  createTestTenant,
  deleteTenantQueueMessages,
  getSharedTestDb,
  type TestTenant,
} from './shared';
import { probeStatementRoles, type StatementRoleProbe } from './statement-role-probe';
import { Tier2FailingAuditRepository } from './tier2-failing-audit';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgQueue } from '../../src/queues/pg-queue';
import type { Queue, SendOptions } from '../../src/queues/queue';
import { PROVISION_TWILIO_JOB_TYPE } from '../../src/workers/provision-twilio';
import type { AuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const ORIGINAL_PUBLIC_API_URL = process.env.PUBLIC_API_URL;
const BASE_URL = 'https://api.phone-request-tx.test';

let pool: Pool;
let probe: StatementRoleProbe;
let a: TestTenant;
let b: TestTenant;

// A DID is unique across tenants (migration 274) and the database outlives a
// run, so every number is fresh: a per-run prefix plus a per-call sequence.
const RUN = String(Math.floor(Math.random() * 90000) + 10000);
let numberSeq = 0;
function freshNumber(): string {
  return `+1737${RUN}${String(numberSeq++ % 100).padStart(2, '0')}`;
}
const digits = (e164: string) => e164.replace(/\D/g, '');

async function seedLine(
  tenantId: string,
  status: 'full_readiness' | 't0_requested',
  providerData: Record<string, unknown>,
): Promise<void> {
  // Superuser fixture writes (bypass RLS): billing is live and the twilio row
  // is in the state the route under test acts from.
  await pool.query(`UPDATE tenants SET subscription_status = 'trialing' WHERE id = $1`, [tenantId]);
  await pool.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, status, provider_data)
     VALUES ($1, 'twilio', $2, $3::jsonb)`,
    [tenantId, status, JSON.stringify(providerData)],
  );
}

async function readLine(tenantId: string) {
  const { rows } = await pool.query<{ status: string; provider_data: Record<string, unknown> }>(
    `SELECT status, provider_data FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'twilio'`,
    [tenantId],
  );
  return rows[0];
}

/** The provision-twilio jobs for `tenantId` in the real queue table. */
async function provisionJobs(tenantId: string): Promise<Array<{ key: string; payload: unknown }>> {
  const exists = await pool.query<{ t: string | null }>(`SELECT to_regclass('public._queue_messages')::text AS t`);
  if (!exists.rows[0].t) return [];
  const { rows } = await pool.query<{ key: string; payload: unknown }>(
    `SELECT idempotency_key AS key, payload FROM _queue_messages
      WHERE type = $1 AND payload->>'tenantId' = $2
      ORDER BY created_at`,
    [PROVISION_TWILIO_JOB_TYPE, tenantId],
  );
  return rows;
}

async function auditEvents(tenantId: string, eventType: string) {
  const events = await new PgAuditRepository(pool).findByEntity(tenantId, 'tenant_integrations', tenantId);
  return events.filter((e) => e.eventType === eventType);
}

const FAIL_AFTER_ENQUEUE = 'queue acknowledgement lost (simulated failure after the job row was written)';

/**
 * A real PgQueue whose enqueue writes its row and then throws, so the request
 * rolls back AFTER the job row exists — the shape of any failure later in the
 * request. Overrides both paths: `send` (its own connection, already committed
 * when it throws) and `sendOn` (the caller's open transaction).
 */
class FailAfterEnqueueQueue extends PgQueue {
  override async send<T>(type: string, payload: T, key?: string, options?: SendOptions): Promise<string> {
    await super.send(type, payload, key, options);
    throw new Error(FAIL_AFTER_ENQUEUE);
  }

  override async sendOn<T>(
    client: PoolClient,
    type: string,
    payload: T,
    key: string,
    options?: SendOptions,
  ): Promise<string> {
    await super.sendOn(client, type, payload, key, options);
    throw new Error(FAIL_AFTER_ENQUEUE);
  }
}

/**
 * A real PgQueue that, right after each enqueue, counts the job's row from a
 * DIFFERENT connection (the provisioning worker's view) while the request is
 * still open.
 */
class WorkerViewQueue extends PgQueue {
  readonly visibleToWorker: number[] = [];

  private async look(key: string | undefined): Promise<void> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM _queue_messages WHERE idempotency_key = $1`,
      [key],
    );
    this.visibleToWorker.push(rows[0].n);
  }

  override async send<T>(type: string, payload: T, key?: string, options?: SendOptions): Promise<string> {
    const id = await super.send(type, payload, key, options);
    await this.look(key);
    return id;
  }

  override async sendOn<T>(
    client: PoolClient,
    type: string,
    payload: T,
    key: string,
    options?: SendOptions,
  ): Promise<string> {
    const id = await super.sendOn(client, type, payload, key, options);
    await this.look(key);
    return id;
  }
}

function buildApp(auditRepo: AuditRepository, actingTenant: TestTenant, queue: Queue) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: actingTenant.userId,
      sessionId: 'sess-phone-tx',
      tenantId: actingTenant.tenantId,
      role: 'owner',
    };
    next();
  });
  app.use('/api', withTenantTransaction(probe.pool));
  app.use(
    '/api/onboarding',
    createOnboardingRouter({
      settingsRepo: new PgSettingsRepository(probe.pool),
      packActivationRepo: new PgPackActivationRepository(probe.pool),
      auditRepo,
      pool: probe.pool,
      queue,
    }),
  );
  return app;
}

/** One phone route, arranged for a tenant: what it is sent and what it must leave behind. */
interface Arranged {
  body: Record<string, unknown>;
  /** The marker the route writes on the twilio row, as provider_data keys. */
  marker: Record<string, unknown>;
  /** provider_data as seeded — what a rolled-back request leaves. */
  seeded: Record<string, unknown>;
  jobKey: string;
  jobPayload: Record<string, unknown>;
  okBody: Record<string, unknown>;
  auditMetadata?: Record<string, unknown>;
}

interface PhoneRouteCase {
  name: string;
  path: string;
  auditEvent: string;
  failCode: string;
  arrange(t: TestTenant): Promise<Arranged>;
  /** What a second identical request answers while the first one's job is pending. */
  repeat: { status: number; error?: string; auditRows: number };
}

const CASES: PhoneRouteCase[] = [
  {
    name: 'POST /phone/change',
    path: '/api/onboarding/phone/change',
    auditEvent: 'tenant.phone_number_change_requested',
    failCode: 'PHONE_CHANGE_FAILED',
    async arrange(t) {
      const current = freshNumber();
      const next = freshNumber();
      const seeded = { phoneE164: current };
      await seedLine(t.tenantId, 'full_readiness', seeded);
      return {
        body: { phoneNumber: next },
        marker: { pendingChange: next, phoneE164: current },
        seeded,
        jobKey: `provision-twilio-change-${t.tenantId}-${digits(next)}`,
        jobPayload: { tenantId: t.tenantId, region: null, baseUrl: BASE_URL, changeTo: next },
        okBody: { ok: true, enqueued: true, phoneNumber: next },
        auditMetadata: { from: current, to: next },
      };
    },
    // The compare-and-set allows one change in flight.
    repeat: { status: 409, error: 'PHONE_CHANGE_IN_PROGRESS', auditRows: 1 },
  },
  {
    name: 'POST /phone/claim',
    path: '/api/onboarding/phone/claim',
    auditEvent: 'tenant.phone_number_claimed',
    failCode: 'PHONE_CLAIM_FAILED',
    async arrange(t) {
      const pick = freshNumber();
      const seeded = { awaitingPick: true };
      await seedLine(t.tenantId, 't0_requested', seeded);
      return {
        body: { phoneNumber: pick },
        marker: { pendingPick: pick, awaitingPick: false },
        seeded,
        jobKey: `provision-twilio-claim-${t.tenantId}-${digits(pick)}`,
        jobPayload: { tenantId: t.tenantId, region: null, baseUrl: BASE_URL, phoneNumber: pick },
        okBody: { ok: true, enqueued: true, phoneNumber: pick },
        auditMetadata: { phoneNumber: pick },
      };
    },
    // Re-claiming the same number collapses onto the pending job (#1563).
    repeat: { status: 200, auditRows: 2 },
  },
  {
    name: 'POST /phone/retry',
    path: '/api/onboarding/phone/retry',
    auditEvent: 'tenant.phone_provisioning_retry',
    failCode: 'PHONE_RETRY_FAILED',
    async arrange(t) {
      const seeded = { awaitingPick: true };
      await seedLine(t.tenantId, 't0_requested', seeded);
      return {
        body: {},
        marker: { pendingPick: 'auto', awaitingPick: false },
        seeded,
        jobKey: `provision-twilio-autopick-${t.tenantId}`,
        jobPayload: { tenantId: t.tenantId, region: null, baseUrl: BASE_URL, autoPick: true },
        okBody: { ok: true, enqueued: true },
      };
    },
    // A second "Pick one for me" collapses onto the pending autopick job.
    repeat: { status: 200, auditRows: 2 },
  },
];

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(async () => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  process.env.PUBLIC_API_URL = BASE_URL;
  probe = probeStatementRoles(pool, /(UPDATE|INSERT INTO) (tenant_integrations|_queue_messages)\b/);
  a = await createTestTenant(pool);
  b = await createTestTenant(pool);
});

afterEach(async () => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
  if (ORIGINAL_PUBLIC_API_URL === undefined) delete process.env.PUBLIC_API_URL;
  else process.env.PUBLIC_API_URL = ORIGINAL_PUBLIC_API_URL;
  await deleteTenantQueueMessages(pool, [a.tenantId, b.tenantId]);
});

afterAll(async () => {
  await closeSharedTestDb();
});

describe.each(CASES)('$name (real Postgres, request transaction)', (route) => {
  it('commits its marker, its audit row and one provision job together, on the request client under rls_app_runtime', async () => {
    const arranged = await route.arrange(a);
    const other = await route.arrange(b);
    const res = await request(buildApp(new PgAuditRepository(probe.pool), a, new PgQueue(probe.pool)))
      .post(route.path)
      .send(arranged.body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(arranged.okBody);

    expect((await readLine(a.tenantId)).provider_data).toMatchObject(arranged.marker);
    expect((await readLine(b.tenantId)).provider_data).toEqual(other.seeded);

    const audits = await auditEvents(a.tenantId, route.auditEvent);
    expect(audits).toHaveLength(1);
    if (arranged.auditMetadata) expect(audits[0].metadata).toMatchObject(arranged.auditMetadata);

    expect(await provisionJobs(a.tenantId)).toEqual([{ key: arranged.jobKey, payload: arranged.jobPayload }]);
    expect(await provisionJobs(b.tenantId)).toEqual([]);

    // The marker write AND the job row ran on the request's client: the RLS
    // role, the acting tenant's GUC. `queue.send` wrote the job on the
    // queue's own connection, as the connection principal with no tenant.
    const jobWrites = probe.seen.filter((s) => /_queue_messages/.test(s.sql));
    const markerWrites = probe.seen.filter((s) => /tenant_integrations/.test(s.sql));
    expect(jobWrites).toHaveLength(1);
    expect(markerWrites).toHaveLength(1);
    for (const write of [...markerWrites, ...jobWrites]) {
      expect(write).toMatchObject({ role: 'rls_app_runtime', tenantGuc: a.tenantId });
    }
  });

  it('rolls its marker back and leaves no job behind when its audit write fails', async () => {
    const arranged = await route.arrange(a);
    const auditRepo = new Tier2FailingAuditRepository(new PgAuditRepository(probe.pool), route.auditEvent);
    const res = await request(buildApp(auditRepo, a, new PgQueue(probe.pool)))
      .post(route.path)
      .send(arranged.body);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe(route.failCode);
    expect(auditRepo.attemptedTier2).toBe(1);
    expect((await readLine(a.tenantId)).provider_data).toEqual(arranged.seeded);
    expect(await provisionJobs(a.tenantId)).toEqual([]);
  });

  it('leaves no job behind when the request rolls back after the job row was written', async () => {
    const arranged = await route.arrange(a);
    const res = await request(buildApp(new PgAuditRepository(probe.pool), a, new FailAfterEnqueueQueue(probe.pool)))
      .post(route.path)
      .send(arranged.body);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe(route.failCode);
    expect((await readLine(a.tenantId)).provider_data).toEqual(arranged.seeded);
    expect(await auditEvents(a.tenantId, route.auditEvent)).toEqual([]);
    expect(await provisionJobs(a.tenantId)).toEqual([]);
  });

  it('keeps the job out of the worker\'s sight until the request commits', async () => {
    const arranged = await route.arrange(a);
    const queue = new WorkerViewQueue(probe.pool);
    const res = await request(buildApp(new PgAuditRepository(probe.pool), a, queue))
      .post(route.path)
      .send(arranged.body);

    expect(res.status).toBe(200);
    // Uncommitted while the request was open, so the worker could not claim
    // it before the marker it reads had committed …
    expect(queue.visibleToWorker).toEqual([0]);
    // … and there once the request committed.
    expect(await provisionJobs(a.tenantId)).toEqual([{ key: arranged.jobKey, payload: arranged.jobPayload }]);
  });

  it('a retry after a failed attempt enqueues exactly one job (idempotency unchanged)', async () => {
    const arranged = await route.arrange(a);
    const failing = new Tier2FailingAuditRepository(new PgAuditRepository(probe.pool), route.auditEvent);
    const first = await request(buildApp(failing, a, new PgQueue(probe.pool))).post(route.path).send(arranged.body);
    expect(first.status).toBe(500);

    const retry = await request(buildApp(new PgAuditRepository(probe.pool), a, new PgQueue(probe.pool)))
      .post(route.path)
      .send(arranged.body);

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(arranged.okBody);
    expect((await readLine(a.tenantId)).provider_data).toMatchObject(arranged.marker);
    expect(await auditEvents(a.tenantId, route.auditEvent)).toHaveLength(1);
    expect(await provisionJobs(a.tenantId)).toEqual([{ key: arranged.jobKey, payload: arranged.jobPayload }]);
  });

  it('a repeat request while the job is pending collapses onto it (idempotency unchanged)', async () => {
    const arranged = await route.arrange(a);
    const app = buildApp(new PgAuditRepository(probe.pool), a, new PgQueue(probe.pool));
    const first = await request(app).post(route.path).send(arranged.body);
    const second = await request(app).post(route.path).send(arranged.body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(route.repeat.status);
    if (route.repeat.error) expect(second.body.error).toBe(route.repeat.error);
    expect(await auditEvents(a.tenantId, route.auditEvent)).toHaveLength(route.repeat.auditRows);
    expect(await provisionJobs(a.tenantId)).toEqual([{ key: arranged.jobKey, payload: arranged.jobPayload }]);
  });
});
