/**
 * A1 — POST /api/proposals/:id/resolve-entity must not hold a pooled
 * connection across the re-draft's LLM call, and its post-LLM writes must
 * still commit as one unit.
 *
 * The "which Bob?" pick re-runs the original drafting handler (an
 * InvoiceTaskHandler `gateway.complete`, seconds long) before it writes. Under
 * the /api request transaction that pinned one pooled connection - and under
 * PgBouncer one server backend - for the whole call, and a call over
 * `idle_in_transaction_session_timeout` 500'd. The route is now an
 * LLM_LONG_CALL_ROUTE (no request transaction), and resolveProposalEntity
 * commits the payload rewrite, the status promotion and the audit row in ONE
 * PgTenantTransactionRunner transaction opened after the LLM call returns.
 *
 * Real Postgres, RLS_RUNTIME_ROLE=true, the REAL middleware, the REAL
 * proposals router, PgProposalRepository / PgAuditRepository and the REAL
 * redraft handler factory, with a stub gateway that blocks until released and
 * an app pool of max=1 - so "another tenant's request completes while the LLM
 * call is in flight" is a hard proof (with the request transaction held there
 * is no second connection to hand out), not a likelihood.
 *
 * A-R3 - the annotate-only and next-ambiguity paths write no status, so
 * nothing re-checked the status they read before their transaction. A gate on
 * the pick's first proposal read lets a real reject commit in that gap; the
 * pick must then lose (409) and leave the rejected row exactly as it was.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { Pool, PoolClient } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { createPool } from '../../src/db/pool';
import { currentTenantContext, withTenantTransaction } from '../../src/middleware/tenant-context';
import { PgTenantTransactionRunner } from '../../src/db/tenant-transaction';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createProposal, type Proposal } from '../../src/proposals/proposal';
import { createProposalsRouter } from '../../src/routes/proposals';
import { createRedraftHandlerFactory } from '../../src/proposals/redraft-handler-factory';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

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

interface LoggedStatement {
  sql: string;
  params: unknown[];
}

/**
 * The app pool, with every statement on every checked-out client logged in
 * order. `failWhen` turns the next matching statement into a real Postgres
 * error (division_by_zero) - a database failure inside the transaction, not a
 * thrown JS stub.
 */
function loggingPool(
  realPool: Pool,
  log: LoggedStatement[],
  injection: { failWhen: RegExp | null },
): Pool {
  const instrumented = new WeakSet<PoolClient>();
  const connect = async (): Promise<PoolClient> => {
    const client = await realPool.connect();
    if (!instrumented.has(client)) {
      instrumented.add(client);
      const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (
        ...args: unknown[]
      ) => {
        const sql = (typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text)).trim();
        log.push({ sql, params: Array.isArray(args[1]) ? (args[1] as unknown[]) : [] });
        if (injection.failWhen?.test(sql)) {
          injection.failWhen = null;
          return realQuery('SELECT 1/0 AS injected_failure');
        }
        return realQuery(...args);
      };
    }
    return client;
  };
  return { connect } as unknown as Pool;
}

function appPool(baseUrl: string): Pool {
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    DB_SSL: process.env.DB_SSL,
    DB_MAX_CONNECTIONS: process.env.DB_MAX_CONNECTIONS,
  };
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', 'rivet_a1_resolve_entity');
  process.env.DATABASE_URL = url.toString();
  process.env.DB_SSL = 'false';
  // ONE connection: while tenant A's resolve-entity is in its LLM call, tenant
  // B's request can only get a connection if A is not holding one.
  process.env.DB_MAX_CONNECTIONS = '1';
  try {
    return createPool();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CUST_A = '11111111-1111-4111-8111-111111111111';
const CUST_B = '22222222-2222-4222-8222-222222222222';

function clarificationFor(tenantId: string, createdBy: string): Proposal {
  const candidates = [
    { id: CUST_A, label: 'Bob Smith', score: 0.82 },
    { id: CUST_B, label: 'Bob Jones', score: 0.81 },
  ];
  return createProposal({
    tenantId,
    proposalType: 'voice_clarification',
    summary: 'Which customer? "Bob" matched 2 records',
    createdBy,
    payload: {
      transcript: 'invoice Bob for the water heater',
      reason: 'ambiguous_entity',
      entityReference: 'Bob',
      entityCandidates: candidates,
    },
    sourceContext: {
      source: 'voice',
      transcript: 'invoice Bob for the water heater',
      entityKind: 'customer',
      entityReference: 'Bob',
      entityCandidates: candidates.map((c) => ({ ...c, kind: 'customer' })),
      originalIntent: {
        intentType: 'create_invoice',
        extractedEntities: { customerName: 'Bob' },
      },
    },
  });
}

const JOB_A = '33333333-3333-4333-8333-333333333333';
const JOB_B = '44444444-4444-4444-8444-444444444444';

/** No originalIntent: resolution annotates the pick in place (no re-draft). */
function annotateOnlyClarificationFor(
  tenantId: string,
  createdBy: string,
  sourceContext: Record<string, unknown> = {},
): Proposal {
  const base = clarificationFor(tenantId, createdBy);
  const annotateOnly: Record<string, unknown> = { ...base.sourceContext, ...sourceContext };
  delete annotateOnly.originalIntent;
  return { ...base, sourceContext: annotateOnly };
}

describe('A1 — resolve-entity holds no connection across its LLM call and commits its writes as one unit', () => {
  let harnessPool: Pool;
  let realAppPool: Pool;
  let server: Server;
  let baseUrl: string;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };
  let seedRepo: PgProposalRepository;
  const log: LoggedStatement[] = [];
  const injection: { failWhen: RegExp | null } = { failWhen: null };

  // A-R3 — holds the pick right after its first read of the armed proposal,
  // so a concurrent request can commit before the pick's own transaction.
  const readGate: { armedFor: string | null; reached: Deferred; release: Deferred } = {
    armedFor: null,
    reached: deferred(),
    release: deferred(),
  };

  // Per-test gateway control.
  let llmEntered: Deferred;
  let releaseLlm: Deferred;
  const llmProbes: Array<{ store: unknown; checkedOut: number }> = [];

  beforeAll(async () => {
    expect(process.env.RLS_RUNTIME_ROLE, 'this proof needs the RLS runtime role on').toBe('true');
    harnessPool = await getSharedTestDb();
    const dbUrl = process.env.TEST_DB_URL as string;
    expect(dbUrl, 'TEST_DB_URL must be set by the integration globalSetup').toBeTruthy();
    tenantA = await createTestTenant(harnessPool);
    tenantB = await createTestTenant(harnessPool);
    seedRepo = new PgProposalRepository(harnessPool);

    realAppPool = appPool(dbUrl);
    const pool = loggingPool(realAppPool, log, injection);
    const proposalRepo = new PgProposalRepository(pool);
    const realFindById = proposalRepo.findById.bind(proposalRepo);
    proposalRepo.findById = async (tenantId: string, id: string) => {
      const found = await realFindById(tenantId, id);
      if (readGate.armedFor === id) {
        readGate.armedFor = null;
        readGate.reached.resolve();
        await readGate.release.promise;
      }
      return found;
    };
    const auditRepo = new PgAuditRepository(pool);

    // The drafting LLM: records what it can see, then blocks until released.
    const gateway = {
      complete: async (): Promise<LLMResponse> => {
        llmProbes.push({
          store: currentTenantContext(),
          checkedOut: realAppPool.totalCount - realAppPool.idleCount,
        });
        llmEntered.resolve();
        await releaseLlm.promise;
        return {
          content: JSON.stringify({
            customerId: CUST_B,
            lineItems: [{ description: 'Water heater service', quantity: 1, unitPrice: 45000, category: 'labor' }],
          }),
          model: 'stub-model',
          provider: 'stub',
          tokenUsage: { input: 10, output: 20, total: 30 },
          latencyMs: 1,
        };
      },
    } as unknown as LLMGateway;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const tenantId = req.headers['x-test-tenant'];
      if (typeof tenantId === 'string') {
        (req as unknown as { auth: Record<string, string> }).auth = {
          userId: String(req.headers['x-test-user']),
          sessionId: 'sess-a1',
          tenantId,
          role: 'owner',
        };
      }
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.use(
      '/api/proposals',
      createProposalsRouter(
        proposalRepo,
        new PgTenantTransactionRunner(pool),
        undefined,
        auditRepo,
        undefined,
        undefined,
        undefined,
        createRedraftHandlerFactory({ gateway }),
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
    await new Promise<void>((resolve) => {
      server?.closeAllConnections?.();
      if (server) server.close(() => resolve());
      else resolve();
    });
    await realAppPool?.end().catch(() => undefined);
    const tenants = [tenantA?.tenantId, tenantB?.tenantId].filter(Boolean);
    await harnessPool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1)', [tenants]);
    await harnessPool.query('DELETE FROM proposals WHERE tenant_id = ANY($1)', [tenants]);
    await closeSharedTestDb();
  });

  const post = (path: string, tenant: { tenantId: string; userId: string }, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-tenant': tenant.tenantId,
        'x-test-user': tenant.userId,
      },
      body: JSON.stringify(body),
    });

  async function proposalRow(id: string) {
    const { rows } = await harnessPool.query<{
      proposal_type: string;
      status: string;
      payload: Record<string, unknown>;
      source_context: Record<string, unknown>;
    }>('SELECT proposal_type, status, payload, source_context FROM proposals WHERE id = $1', [id]);
    return rows[0];
  }

  async function resolvedAudits(id: string): Promise<number> {
    const { rows } = await harnessPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE entity_type = 'proposal' AND entity_id = $1 AND event_type = 'proposal.entity_resolved'`,
      [id],
    );
    return rows[0].n;
  }

  it("while the re-draft's LLM call blocks, tenant B's request on the 1-connection pool completes; after release A's writes land in one transaction", async () => {
    llmEntered = deferred();
    releaseLlm = deferred();
    llmProbes.length = 0;
    log.length = 0;
    const clarification = await seedRepo.create(clarificationFor(tenantA.tenantId, tenantA.userId));
    const bProposal = await seedRepo.create(
      createProposal({
        tenantId: tenantB.tenantId,
        proposalType: 'voice_clarification',
        summary: 'B: an unrelated clarification',
        createdBy: tenantB.userId,
        payload: { transcript: 'something else', reason: 'unknown_intent' },
      }),
    );

    let aSettled = false;
    const aResponse = post(`/api/proposals/${clarification.id}/resolve-entity`, tenantA, {
      candidateId: CUST_B,
    }).finally(() => {
      aSettled = true;
    });
    await llmEntered.promise;

    // Mid-LLM: no request-scoped client, and nothing checked out of the pool.
    expect(llmProbes).toEqual([{ store: undefined, checkedOut: 0 }]);

    // Tenant B's ordinary transactional write completes on the one connection.
    const bResponse = await post(`/api/proposals/${bProposal.id}/reject`, tenantB, {
      reason: 'not needed',
    });
    expect(bResponse.status).toBe(200);
    expect((await proposalRow(bProposal.id)).status).toBe('rejected');
    expect(aSettled).toBe(false);
    // B's request ran in its own request transaction, scoped to B.
    const bTenantSet = log.findIndex(
      (s) => s.sql.includes("set_config('app.current_tenant_id'") && s.params[0] === tenantB.tenantId,
    );
    expect(bTenantSet).toBeGreaterThan(0);
    expect(log[bTenantSet - 1].sql).toBe('BEGIN');

    const releasedAt = log.length;
    releaseLlm.resolve();
    const aResult = await aResponse;
    expect(aResult.status).toBe(200);
    const body = (await aResult.json()) as Proposal;
    expect(body.proposalType).toBe('draft_invoice');
    expect(body.status).toBe('ready_for_review');

    // The writes landed: re-drafted, promoted for review (never approved), audited.
    const row = await proposalRow(clarification.id);
    expect(row.proposal_type).toBe('draft_invoice');
    expect(row.status).toBe('ready_for_review');
    expect(row.payload.customerId).toBe(CUST_B);
    expect(await resolvedAudits(clarification.id)).toBe(1);

    // ...and all three in ONE tenant-A transaction opened after the LLM call.
    const after = log.slice(releasedAt).map((s) => s.sql);
    const begin = after.indexOf('BEGIN');
    const commit = after.indexOf('COMMIT', begin);
    const tx = after.slice(begin, commit + 1);
    expect(log[releasedAt + begin + 1].params[0]).toBe(tenantA.tenantId);
    expect(tx).toContain('SET LOCAL ROLE rls_app_runtime');
    const payloadWrite = tx.findIndex((s) => s.startsWith('UPDATE proposals SET updated_at = NOW(), proposal_type'));
    const statusWrite = tx.findIndex((s) => s.startsWith('UPDATE proposals SET status'));
    const auditWrite = tx.findIndex((s) => s.startsWith('INSERT INTO audit_events'));
    expect(payloadWrite).toBeGreaterThan(0);
    expect(statusWrite).toBeGreaterThan(payloadWrite);
    expect(auditWrite).toBeGreaterThan(statusWrite);
    expect(tx.filter((s) => s === 'COMMIT')).toHaveLength(1);
  });

  it('a database failure in the second post-LLM write rolls back the first: no partial re-draft, no audit, and the pick can be retried', async () => {
    llmEntered = deferred();
    releaseLlm = deferred();
    releaseLlm.resolve(); // no need to hold the LLM here
    llmProbes.length = 0;
    log.length = 0;
    const clarification = await seedRepo.create(clarificationFor(tenantA.tenantId, tenantA.userId));

    // The status promotion's UPDATE - after the payload rewrite in the same transaction.
    injection.failWhen = /^UPDATE proposals SET status/;
    const failed = await post(`/api/proposals/${clarification.id}/resolve-entity`, tenantA, {
      candidateId: CUST_B,
    });
    expect(failed.status).toBe(500);
    expect(injection.failWhen).toBeNull(); // the injected failure fired

    // The payload rewrite ran, then the transaction rolled back.
    const sqls = log.map((s) => s.sql);
    const payloadWrite = sqls.findIndex((s) => s.startsWith('UPDATE proposals SET updated_at = NOW(), proposal_type'));
    expect(payloadWrite).toBeGreaterThan(0);
    const settle = sqls.slice(payloadWrite).find((s) => s === 'COMMIT' || s === 'ROLLBACK');
    expect(settle).toBe('ROLLBACK');

    // Nothing partial survived: still the clarification, still awaiting the pick.
    const row = await proposalRow(clarification.id);
    expect(row.proposal_type).toBe('voice_clarification');
    expect(row.status).toBe('draft');
    expect(row.payload.entityCandidates).toHaveLength(2);
    expect(row.payload.customerId).toBeUndefined();
    expect(await resolvedAudits(clarification.id)).toBe(0);

    // A safe failure state: the same pick succeeds on retry.
    const retried = await post(`/api/proposals/${clarification.id}/resolve-entity`, tenantA, {
      candidateId: CUST_B,
    });
    expect(retried.status).toBe(200);
    const done = await proposalRow(clarification.id);
    expect(done.proposal_type).toBe('draft_invoice');
    expect(done.status).toBe('ready_for_review');
    expect(await resolvedAudits(clarification.id)).toBe(1);
  });

  /**
   * Runs the pick with a real reject committed between the pick's read and its
   * transaction, and returns the pick's response and the SQL it sent after
   * the gate opened.
   */
  async function pickRacingAReject(proposalId: string) {
    log.length = 0;
    readGate.reached = deferred();
    readGate.release = deferred();
    readGate.armedFor = proposalId;
    const pick = post(`/api/proposals/${proposalId}/resolve-entity`, tenantA, { candidateId: CUST_B });
    await readGate.reached.promise;

    // The owner dismisses it from another screen, and that commits first.
    const rejected = await post(`/api/proposals/${proposalId}/reject`, tenantA, { reason: 'not needed' });
    expect(rejected.status).toBe(200);
    expect((await proposalRow(proposalId)).status).toBe('rejected');

    const releasedAt = log.length;
    readGate.release.resolve();
    const response = await pick;
    return { response, after: log.slice(releasedAt).map((s) => s.sql) };
  }

  const LOCK_ROW = /^SELECT \* FROM proposals WHERE tenant_id = \$1 AND id = ANY\(\$2::uuid\[\]\) ORDER BY id FOR UPDATE$/;

  it('annotate-only: a reject that commits after the pick read its ready_for_review row wins; the pick is refused and patches nothing', async () => {
    const seeded = await seedRepo.create(annotateOnlyClarificationFor(tenantA.tenantId, tenantA.userId));
    await seedRepo.updateStatus(tenantA.tenantId, seeded.id, 'ready_for_review');
    const before = await proposalRow(seeded.id);

    const { response, after } = await pickRacingAReject(seeded.id);

    expect(response.status).toBe(409);
    // The rejected row is exactly as the reject left it: no resolved id, the
    // picker still there, no resolution audit.
    const row = await proposalRow(seeded.id);
    expect(row.status).toBe('rejected');
    expect(row.payload).toEqual(before.payload);
    expect(row.source_context).toEqual(before.source_context);
    expect(row.payload.customerId).toBeUndefined();
    expect(await resolvedAudits(seeded.id)).toBe(0);

    // The pick took the row lock first thing in its own transaction, saw the
    // reject, and rolled back without writing.
    const begin = after.indexOf('BEGIN');
    const lock = after.findIndex((s) => LOCK_ROW.test(s));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(after.slice(begin, lock)).toContain('SET LOCAL ROLE rls_app_runtime');
    expect(after[lock + 1]).toBe('ROLLBACK');
    expect(after.some((s) => s.startsWith('UPDATE proposals'))).toBe(false);
    expect(after.some((s) => s.startsWith('INSERT INTO audit_events'))).toBe(false);
  });

  it('next ambiguity: a reject that commits after the pick read its draft row wins; the row is not advanced to the next picker', async () => {
    const seeded = await seedRepo.create(
      annotateOnlyClarificationFor(tenantA.tenantId, tenantA.userId, {
        pendingEntityAmbiguities: [
          {
            entityKind: 'job',
            reference: 'Rodriguez job',
            candidates: [
              { id: JOB_A, kind: 'job', label: 'Rodriguez - kitchen', score: 0.8 },
              { id: JOB_B, kind: 'job', label: 'Rodriguez - bath', score: 0.79 },
            ],
          },
        ],
      }),
    );
    const before = await proposalRow(seeded.id);

    const { response, after } = await pickRacingAReject(seeded.id);

    expect(response.status).toBe(409);
    const row = await proposalRow(seeded.id);
    expect(row.status).toBe('rejected');
    expect(row.payload).toEqual(before.payload);
    expect(row.payload.entityReference).toBe('Bob');
    expect(row.source_context).toEqual(before.source_context);
    expect(await resolvedAudits(seeded.id)).toBe(0);
    const lock = after.findIndex((s) => LOCK_ROW.test(s));
    expect(lock).toBeGreaterThan(after.indexOf('BEGIN'));
    expect(after[lock + 1]).toBe('ROLLBACK');
    expect(after.some((s) => s.startsWith('UPDATE proposals'))).toBe(false);
  });

  it('annotate-only, no race: the row lock comes first, then the patch and the audit, in one transaction', async () => {
    const seeded = await seedRepo.create(annotateOnlyClarificationFor(tenantA.tenantId, tenantA.userId));
    await seedRepo.updateStatus(tenantA.tenantId, seeded.id, 'ready_for_review');
    log.length = 0;

    const response = await post(`/api/proposals/${seeded.id}/resolve-entity`, tenantA, { candidateId: CUST_B });

    expect(response.status).toBe(200);
    const row = await proposalRow(seeded.id);
    expect(row.status).toBe('ready_for_review');
    expect(row.payload.customerId).toBe(CUST_B);
    expect(row.payload.entityCandidates).toBeUndefined();
    expect(await resolvedAudits(seeded.id)).toBe(1);

    const sqls = log.map((s) => s.sql);
    const lock = sqls.findIndex((s) => LOCK_ROW.test(s));
    const begin = sqls.lastIndexOf('BEGIN', lock);
    const commit = sqls.indexOf('COMMIT', lock);
    const tx = sqls.slice(begin, commit + 1);
    const lockAt = tx.findIndex((s) => LOCK_ROW.test(s));
    const patchAt = tx.findIndex((s) => s.startsWith('UPDATE proposals SET updated_at = NOW(), payload'));
    const auditAt = tx.findIndex((s) => s.startsWith('INSERT INTO audit_events'));
    expect(lockAt).toBeGreaterThan(0);
    expect(patchAt).toBeGreaterThan(lockAt);
    expect(auditAt).toBeGreaterThan(patchAt);
    expect(tx.filter((s) => s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK')).toEqual(['BEGIN', 'COMMIT']);
  });
});
