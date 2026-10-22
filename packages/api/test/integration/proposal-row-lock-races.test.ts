/**
 * Writers of one proposal row that race each other, on real Postgres.
 *
 * Every writer here reads the row, builds a new payload/sourceContext from it,
 * and writes the whole thing back. Unless the write is built from the row as
 * it stands under the row lock (or refused when the row moved), the later
 * writer puts back what the earlier one removed and drops what it added.
 *
 * A4-3 (Codex P1 on #1794, thread 4352817489) — two entity picks on the same
 * draft clarification with several ambiguities queued. The first pick
 * deliberately leaves the row in `draft` (it only advances to the next
 * question), so a status re-check alone lets the second pick, which read the
 * row before the first committed and then waited on its row lock, overwrite
 * the first pick's resolution and the queue. A3-1 builds the patch from the
 * locked row; this pins exactly that interleaving: the second pick is
 * observed blocked on the lock in pg_stat_activity before the first commits.
 *
 * Real Postgres, RLS_RUNTIME_ROLE=true, the REAL request-transaction
 * middleware, the REAL proposals router, PgProposalRepository and
 * PgAuditRepository on an app pool with room for the concurrent requests.
 * The only instrumentation is a hold after a chosen repository read
 * returns, so a request can be parked at an exact point.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { createPool } from '../../src/db/pool';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { PgTenantTransactionRunner } from '../../src/db/tenant-transaction';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createProposal, type Proposal } from '../../src/proposals/proposal';
import { createProposalsRouter } from '../../src/routes/proposals';

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const APP_NAME = 'rivet_a4_row_lock_races';

function appPool(baseUrl: string): Pool {
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    DB_SSL: process.env.DB_SSL,
    DB_MAX_CONNECTIONS: process.env.DB_MAX_CONNECTIONS,
  };
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', APP_NAME);
  process.env.DATABASE_URL = url.toString();
  process.env.DB_SSL = 'false';
  // Room for every request in flight at once: a request waiting for a pool
  // connection must never be mistaken for one waiting on the row lock.
  process.env.DB_MAX_CONNECTIONS = '6';
  try {
    return createPool();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type ReadMethod = 'findById' | 'findByIdsForUpdate';

/** A parked request: `reached` once the read returned, held until `release`. */
interface Hold {
  methods: ReadMethod[];
  id: string;
  reached: Deferred;
  release: Deferred;
}

const CUST_A = '11111111-1111-4111-8111-111111111111';
const CUST_B = '22222222-2222-4222-8222-222222222222';
const JOB_A = '33333333-3333-4333-8333-333333333333';
const JOB_B = '44444444-4444-4444-8444-444444444444';
const APPT_A = '55555555-5555-4555-8555-555555555555';
const APPT_B = '66666666-6666-4666-8666-666666666666';

/**
 * "Invoice Bob for the Rodriguez job's Tuesday visit": three references, each
 * matching two records. The producer surfaces the first and queues the rest.
 */
function threeAmbiguities(tenantId: string, createdBy: string): Proposal {
  const customers = [
    { id: CUST_A, label: 'Bob Smith', score: 0.82 },
    { id: CUST_B, label: 'Bob Jones', score: 0.81 },
  ];
  return createProposal({
    tenantId,
    proposalType: 'voice_clarification',
    summary: 'Which customer? "Bob" matched 2 records',
    createdBy,
    payload: {
      transcript: "invoice Bob for the Rodriguez job's Tuesday visit",
      reason: 'ambiguous_entity',
      entityReference: 'Bob',
      entityCandidates: customers,
    },
    sourceContext: {
      source: 'voice',
      transcript: "invoice Bob for the Rodriguez job's Tuesday visit",
      entityKind: 'customer',
      entityReference: 'Bob',
      entityCandidates: customers.map((c) => ({ ...c, kind: 'customer' })),
      originalIntent: { intentType: 'create_invoice', extractedEntities: { customerName: 'Bob' } },
      pendingEntityAmbiguities: [
        {
          entityKind: 'job',
          reference: 'Rodriguez job',
          candidates: [
            { id: JOB_A, kind: 'job', label: 'Rodriguez - kitchen', score: 0.8 },
            { id: JOB_B, kind: 'job', label: 'Rodriguez - bath', score: 0.79 },
          ],
        },
        {
          entityKind: 'appointment',
          reference: 'Tuesday visit',
          candidates: [
            { id: APPT_A, kind: 'appointment', label: 'Tue 9:00', score: 0.7 },
            { id: APPT_B, kind: 'appointment', label: 'Tue 14:00', score: 0.69 },
          ],
        },
      ],
    },
  });
}

describe('proposal row writers that race each other (real Postgres)', () => {
  let harnessPool: Pool;
  let realAppPool: Pool;
  let server: Server;
  let baseUrl: string;
  let tenant: { tenantId: string; userId: string };
  let seedRepo: PgProposalRepository;
  let hold: Hold | null = null;

  beforeAll(async () => {
    expect(process.env.RLS_RUNTIME_ROLE, 'this proof needs the RLS runtime role on').toBe('true');
    harnessPool = await getSharedTestDb();
    const dbUrl = process.env.TEST_DB_URL as string;
    expect(dbUrl, 'TEST_DB_URL must be set by the integration globalSetup').toBeTruthy();
    tenant = await createTestTenant(harnessPool);
    seedRepo = new PgProposalRepository(harnessPool);

    realAppPool = appPool(dbUrl);
    const proposalRepo = new PgProposalRepository(realAppPool);
    for (const method of ['findById', 'findByIdsForUpdate'] as const) {
      const real = (proposalRepo[method] as (...args: unknown[]) => Promise<unknown>).bind(proposalRepo);
      (proposalRepo as unknown as Record<ReadMethod, (...args: unknown[]) => Promise<unknown>>)[method] = async (
        ...args: unknown[]
      ) => {
        const result = await real(...args);
        const ids = method === 'findById' ? [args[1]] : (args[1] as string[]);
        const armed = hold;
        if (armed && armed.methods.includes(method) && ids.includes(armed.id)) {
          hold = null;
          armed.reached.resolve();
          await armed.release.promise;
        }
        return result;
      };
    }

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const tenantId = req.headers['x-test-tenant'];
      if (typeof tenantId === 'string') {
        (req as unknown as { auth: Record<string, string> }).auth = {
          userId: String(req.headers['x-test-user']),
          sessionId: 'sess-a4',
          tenantId,
          role: 'owner',
        };
      }
      next();
    });
    app.use('/api', withTenantTransaction(realAppPool));
    app.use(
      '/api/proposals',
      createProposalsRouter(
        proposalRepo,
        new PgTenantTransactionRunner(realAppPool),
        undefined,
        new PgAuditRepository(realAppPool),
      ),
    );

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    hold?.release.resolve();
    await new Promise<void>((resolve) => {
      server?.closeAllConnections?.();
      if (server) server.close(() => resolve());
      else resolve();
    });
    await realAppPool?.end().catch(() => undefined);
    if (tenant) {
      await harnessPool.query('DELETE FROM audit_events WHERE tenant_id = $1', [tenant.tenantId]);
      await harnessPool.query('DELETE FROM proposals WHERE tenant_id = $1', [tenant.tenantId]);
    }
    await closeSharedTestDb();
  });

  /** Park the next request that reads `id` through one of `methods`, right after the read. */
  function parkAfter(methods: ReadMethod[], id: string): Hold {
    expect(hold, 'one hold at a time').toBeNull();
    hold = { methods, id, reached: deferred(), release: deferred() };
    return hold;
  }

  const send = (method: 'POST' | 'PUT', path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-test-tenant': tenant.tenantId,
        'x-test-user': tenant.userId,
      },
      body: JSON.stringify(body),
    });

  const pick = (id: string, candidateId: string) =>
    send('POST', `/api/proposals/${id}/resolve-entity`, { candidateId });

  /** Whether some app-pool backend is waiting on a lock (polled until `timeoutMs`). */
  async function sawLockWait(timeoutMs: number, stopWhen: () => boolean): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !stopWhen()) {
      const { rows } = await harnessPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name = $1 AND wait_event_type = 'Lock'`,
        [APP_NAME],
      );
      if (rows[0].n > 0) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  async function row(id: string) {
    const { rows } = await harnessPool.query<{
      proposal_type: string;
      status: string;
      payload: Record<string, unknown>;
      source_context: Record<string, unknown>;
    }>('SELECT proposal_type, status, payload, source_context FROM proposals WHERE id = $1', [id]);
    return rows[0];
  }

  async function audits(id: string, eventType: string): Promise<number> {
    const { rows } = await harnessPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE entity_type = 'proposal' AND entity_id = $1 AND event_type = $2`,
      [id, eventType],
    );
    return rows[0].n;
  }

  /**
   * The A4-3 interleaving. The second pick reads the row first and is parked;
   * the first pick takes the row lock and is parked holding it; the second is
   * released and is seen waiting on that lock; then the first commits.
   */
  async function secondPickWaitsOnTheFirst(id: string, first: string, second: string) {
    const secondRead = parkAfter(['findById'], id);
    const secondPick = pick(id, second);
    await secondRead.reached.promise;

    const firstLocked = parkAfter(['findByIdsForUpdate'], id);
    const firstPick = pick(id, first);
    await firstLocked.reached.promise;

    let secondSettled = false;
    const secondDone = secondPick.finally(() => {
      secondSettled = true;
    });
    secondRead.release.resolve();
    const secondWaitedOnTheLock = await sawLockWait(10_000, () => secondSettled);

    firstLocked.release.resolve();
    const [firstRes, secondRes] = await Promise.all([firstPick, secondDone]);
    return { firstRes, secondRes, secondWaitedOnTheLock };
  }

  it('A4-3: a second pick that read the draft before the first committed, then waited on its row lock, keeps the first pick and the queue as the first left them', async () => {
    const seeded = await seedRepo.create(threeAmbiguities(tenant.tenantId, tenant.userId));

    const { firstRes, secondRes, secondWaitedOnTheLock } = await secondPickWaitsOnTheFirst(seeded.id, CUST_A, CUST_B);

    // The interleaving really happened: the second pick sat on the lock.
    expect(secondWaitedOnTheLock).toBe(true);
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(409);
    expect(((await secondRes.json()) as { message: string }).message).toBe(
      'This was already handled, so that choice was not saved.',
    );

    // Exactly as the first pick left it: still a draft (an open question),
    // asking the second reference, with only the third still queued, and
    // only the first pick recorded.
    const r = await row(seeded.id);
    expect(r.proposal_type).toBe('voice_clarification');
    expect(r.status).toBe('draft');
    expect(r.payload.entityReference).toBe('Rodriguez job');
    expect((r.payload.entityCandidates as Array<{ id: string }>).map((c) => c.id)).toEqual([JOB_A, JOB_B]);
    expect(r.source_context.entityKind).toBe('job');
    expect(
      (r.source_context.pendingEntityAmbiguities as Array<{ reference: string }>).map((a) => a.reference),
    ).toEqual(['Tuesday visit']);
    expect((r.source_context.resolvedEntities as Array<{ id: string }>).map((e) => e.id)).toEqual([CUST_A]);
    expect(await audits(seeded.id, 'proposal.entity_resolved')).toBe(1);
  });

  it('A4-3: the same pick sent twice that way (a double tap) is one write: the second answers 200 and changes nothing', async () => {
    const seeded = await seedRepo.create(threeAmbiguities(tenant.tenantId, tenant.userId));

    const { firstRes, secondRes, secondWaitedOnTheLock } = await secondPickWaitsOnTheFirst(seeded.id, CUST_A, CUST_A);

    expect(secondWaitedOnTheLock).toBe(true);
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    const r = await row(seeded.id);
    expect(r.status).toBe('draft');
    expect(r.payload.entityReference).toBe('Rodriguez job');
    expect(
      (r.source_context.pendingEntityAmbiguities as Array<{ reference: string }>).map((a) => a.reference),
    ).toEqual(['Tuesday visit']);
    expect((r.source_context.resolvedEntities as Array<{ id: string }>).map((e) => e.id)).toEqual([CUST_A]);
    expect(await audits(seeded.id, 'proposal.entity_resolved')).toBe(1);
  });
});
