/**
 * Postgres integration — PUT /api/settings/texting-registration (#1564, the
 * A2P 10DLC registration in Settings → Phone) writes the submission, its audit
 * row and the registration worker's job in ONE request transaction.
 *
 * The service saved the submission, enqueued the worker's job with
 * `queue.send` (committed on the queue's own connection) and only then wrote
 * its audit event. A submission that failed after that (the audit store down,
 * or anything else that rolls the request back) answered 500 and rolled back
 * the submission and its audit row, but the job had already committed: the
 * worker went to the carriers for a submission that was never stored (or with
 * the previous one's details). Its key carries the submission time, so the
 * owner's retry enqueued a second job beside the orphan.
 *
 * The service now writes the audit row first and then the job on the request
 * client (`withTenantClient` → `PgQueue.sendOn`, P0-009). The suite mounts the
 * real `withTenantTransaction` middleware, forces RLS_RUNTIME_ROLE on, uses a
 * real PgQueue and PgA2pRegistrationStore, and reads `_queue_messages` back.
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
import { createTextingRegistrationRouter } from '../../src/routes/texting-registration';
import {
  A2P_REGISTRATION_JOB_TYPE,
  createA2pRegistrationService,
} from '../../src/integrations/twilio/a2p-10dlc/service';
import { PgA2pRegistrationStore } from '../../src/integrations/twilio/a2p-10dlc/pg-store';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgQueue } from '../../src/queues/pg-queue';
import type { Queue, SendOptions } from '../../src/queues/queue';
import type { AuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const KEY = 'b'.repeat(64);
const AUDIT_EVENT = 'tenant.a2p_registration_submitted';

const body = {
  legalBusinessName: 'Acme Plumbing LLC',
  ein: '12-3456789',
  businessType: 'Limited Liability Corporation',
  businessIndustry: 'CONSTRUCTION',
  websiteUrl: 'https://acme-plumbing.example.com',
  address: { street: '1 Main St', street2: '', city: 'Austin', region: 'tx', postalCode: '78701' },
  contact: { firstName: 'Pat', lastName: 'Owner', email: 'pat@example.com', phone: '(512) 555-0100', title: 'Owner', jobPosition: 'CEO' },
};

let pool: Pool;
let probe: StatementRoleProbe;
let a: TestTenant;
let b: TestTenant;

async function registration(tenantId: string) {
  const { rows } = await pool.query<{ status: string; legal_business_name: string }>(
    `SELECT status, legal_business_name FROM a2p_registrations WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

/** The registration worker's jobs for `tenantId` in the real queue table. */
async function registrationJobs(tenantId: string): Promise<Array<{ key: string; payload: unknown }>> {
  const exists = await pool.query<{ t: string | null }>(`SELECT to_regclass('public._queue_messages')::text AS t`);
  if (!exists.rows[0].t) return [];
  const { rows } = await pool.query<{ key: string; payload: unknown }>(
    `SELECT idempotency_key AS key, payload FROM _queue_messages
      WHERE type = $1 AND payload->>'tenantId' = $2
      ORDER BY created_at`,
    [A2P_REGISTRATION_JOB_TYPE, tenantId],
  );
  return rows;
}

async function auditEvents(tenantId: string) {
  const events = await new PgAuditRepository(pool).findByEntity(tenantId, 'a2p_registration', tenantId);
  return events.filter((e) => e.eventType === AUDIT_EVENT);
}

const FAIL_AFTER_ENQUEUE = 'queue acknowledgement lost (simulated failure after the job row was written)';

/** A real PgQueue whose enqueue writes its row and then throws (see onboarding-phone-request-tx). */
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

/** A real PgQueue that counts each job's row from another connection right after enqueueing it. */
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
      sessionId: 'sess-a2p-tx',
      tenantId: actingTenant.tenantId,
      role: 'owner',
    };
    next();
  });
  app.use('/api', withTenantTransaction(probe.pool));
  app.use(
    '/api/settings/texting-registration',
    createTextingRegistrationRouter({
      service: createA2pRegistrationService({
        store: new PgA2pRegistrationStore(probe.pool),
        queue,
        auditRepo,
        encryptionKey: KEY,
        pool: probe.pool,
      }),
    }),
  );
  return app;
}

const submit = (app: express.Express) => request(app).put('/api/settings/texting-registration').send(body);

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(async () => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  probe = probeStatementRoles(pool, /INSERT INTO (a2p_registrations|_queue_messages)\b/);
  a = await createTestTenant(pool);
  b = await createTestTenant(pool);
});

afterEach(async () => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
  await deleteTenantQueueMessages(pool, [a.tenantId, b.tenantId]);
});

afterAll(async () => {
  await closeSharedTestDb();
});

describe('PUT /api/settings/texting-registration (real Postgres, request transaction)', () => {
  it('commits the submission, its audit row and one worker job together, on the request client under rls_app_runtime', async () => {
    const res = await submit(buildApp(new PgAuditRepository(probe.pool), a, new PgQueue(probe.pool)));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('submitted');
    expect(await registration(a.tenantId)).toEqual({ status: 'submitted', legal_business_name: 'Acme Plumbing LLC' });
    expect(await registration(b.tenantId)).toBeNull();
    expect(await auditEvents(a.tenantId)).toHaveLength(1);

    const jobs = await registrationJobs(a.tenantId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ tenantId: a.tenantId, poll: 0 });
    expect(jobs[0].key).toMatch(new RegExp(`^a2p-10dlc-${a.tenantId}-\\d+-0$`));
    expect(await registrationJobs(b.tenantId)).toEqual([]);

    // The submission AND the job row ran on the request's client: the RLS
    // role, the acting tenant's GUC. `queue.send` wrote the job on the
    // queue's own connection, as the connection principal with no tenant.
    const writes = probe.seen.filter((s) => /INSERT INTO (a2p_registrations|_queue_messages)/.test(s.sql));
    expect(writes.map((s) => s.sql.match(/INSERT INTO (\w+)/)?.[1])).toEqual(['a2p_registrations', '_queue_messages']);
    for (const write of writes) {
      expect(write).toMatchObject({ role: 'rls_app_runtime', tenantGuc: a.tenantId });
    }
  });

  it('rolls the submission back and leaves no job behind when its audit write fails', async () => {
    const auditRepo = new Tier2FailingAuditRepository(new PgAuditRepository(probe.pool), AUDIT_EVENT);
    const res = await submit(buildApp(auditRepo, a, new PgQueue(probe.pool)));

    expect(res.status).toBe(500);
    expect(auditRepo.attemptedTier2).toBe(1);
    expect(await registration(a.tenantId)).toBeNull();
    expect(await registrationJobs(a.tenantId)).toEqual([]);
  });

  it('leaves no job behind when the request rolls back after the job row was written', async () => {
    const res = await submit(buildApp(new PgAuditRepository(probe.pool), a, new FailAfterEnqueueQueue(probe.pool)));

    expect(res.status).toBe(500);
    expect(await registration(a.tenantId)).toBeNull();
    expect(await auditEvents(a.tenantId)).toEqual([]);
    expect(await registrationJobs(a.tenantId)).toEqual([]);
  });

  it('keeps the job out of the worker\'s sight until the request commits', async () => {
    const queue = new WorkerViewQueue(probe.pool);
    const res = await submit(buildApp(new PgAuditRepository(probe.pool), a, queue));

    expect(res.status).toBe(200);
    expect(queue.visibleToWorker).toEqual([0]);
    expect(await registrationJobs(a.tenantId)).toHaveLength(1);
  });

  it('a retry after a failed submission leaves exactly one job, for the stored submission', async () => {
    const failing = new Tier2FailingAuditRepository(new PgAuditRepository(probe.pool), AUDIT_EVENT);
    expect((await submit(buildApp(failing, a, new PgQueue(probe.pool)))).status).toBe(500);

    const retry = await submit(buildApp(new PgAuditRepository(probe.pool), a, new PgQueue(probe.pool)));

    expect(retry.status).toBe(200);
    expect(await registration(a.tenantId)).toMatchObject({ status: 'submitted' });
    expect(await auditEvents(a.tenantId)).toHaveLength(1);
    expect(await registrationJobs(a.tenantId)).toHaveLength(1);
  });

  it('a resubmission still enqueues its own job (unchanged)', async () => {
    const app = buildApp(new PgAuditRepository(probe.pool), a, new PgQueue(probe.pool));
    expect((await submit(app)).status).toBe(200);
    // The key carries the submission time in milliseconds.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    expect((await submit(app)).status).toBe(200);

    expect(await auditEvents(a.tenantId)).toHaveLength(2);
    const jobs = await registrationJobs(a.tenantId);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.key)).size).toBe(2);
  });
});
