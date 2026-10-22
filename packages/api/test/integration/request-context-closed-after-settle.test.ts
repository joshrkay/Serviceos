/**
 * TI-01 — a write that outlives its request must never run on the request's
 * released pg client.
 *
 * `withTenantTransaction` publishes the request client on AsyncLocalStorage,
 * and anything spawned inside the request inherits that entry — e.g. the
 * in-app session summary (`void this.runSummary(session)`), whose
 * `gateway.complete` creates its ai_runs row inside the request and only
 * marks it `completed` seconds later, after the 204 has gone out. By then the
 * client is back in the pool, and pg-pool hands idle clients out LIFO, so the
 * next request — any tenant's — is usually holding that exact connection. The
 * late UPDATE then ran INSIDE that tenant's transaction, under its RLS
 * identity: the run matched 0 rows and stayed `pending` forever, and any late
 * INSERT would fail that tenant's WITH CHECK and poison its transaction.
 *
 * Real Postgres, RLS_RUNTIME_ROLE=true, the REAL middleware and the REAL
 * PgAiRunRepository, and an app pool of max=1 so the reuse is guaranteed
 * rather than likely. Deterministic: tenant B's request holds its transaction
 * open until tenant A's late write has either been issued (the defect: it
 * landed on B's connection) or is queued waiting for a connection of its own
 * (the fix) — no sleeps decide the outcome.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { createPool } from '../../src/db/pool';
import { currentTenantContext, withTenantTransaction } from '../../src/middleware/tenant-context';
import { PgAiRunRepository } from '../../src/ai/pg-ai-run';
import { createAiRun } from '../../src/ai/ai-run';

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

async function until(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface LoggedStatement {
  sql: string;
  params: unknown[];
}

/** The app pool, with every statement on every checked-out client logged in order. */
function loggingPool(realPool: Pool, log: LoggedStatement[]): Pool {
  const instrumented = new WeakSet<PoolClient>();
  const connect = async (): Promise<PoolClient> => {
    const client = await realPool.connect();
    if (!instrumented.has(client)) {
      instrumented.add(client);
      const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (
        ...args: unknown[]
      ) => {
        const sql = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text);
        log.push({ sql: sql.trim(), params: Array.isArray(args[1]) ? (args[1] as unknown[]) : [] });
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
  url.searchParams.set('application_name', 'rivet_ti01_late_write');
  process.env.DATABASE_URL = url.toString();
  process.env.DB_SSL = 'false';
  // ONE connection: tenant B's request is guaranteed to be holding the very
  // connection tenant A's request just released.
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

describe('TI-01 — a late background write after the response gets its own tenant transaction', () => {
  let harnessPool: Pool;
  let realAppPool: Pool;
  let server: Server;
  let baseUrl: string;
  let tenantA: string;
  let tenantB: string;
  const log: LoggedStatement[] = [];

  // Per-run coordination between the two requests.
  let bInsideItsTransaction: Deferred;
  let lateWrite: Promise<unknown> | undefined;
  let lateWriteError: unknown;

  beforeAll(async () => {
    expect(process.env.RLS_RUNTIME_ROLE, 'this proof needs the RLS runtime role on').toBe('true');
    harnessPool = await getSharedTestDb();
    const dbUrl = process.env.TEST_DB_URL as string;
    expect(dbUrl, 'TEST_DB_URL must be set by the integration globalSetup').toBeTruthy();
    ({ tenantId: tenantA } = await createTestTenant(harnessPool));
    ({ tenantId: tenantB } = await createTestTenant(harnessPool));

    realAppPool = appPool(dbUrl);
    const pool = loggingPool(realAppPool, log);
    const aiRunRepo = new PgAiRunRepository(pool);

    const app = express();
    app.use((req, _res, next) => {
      const tenantId = req.headers['x-test-tenant'];
      if (typeof tenantId === 'string') {
        (req as unknown as { auth: { tenantId: string } }).auth = { tenantId };
      }
      next();
    });
    app.use('/api', withTenantTransaction(pool));

    // Tenant A — what an in-app session end does: the ai_runs row is created
    // inside the request, the 204 goes out, and the run is marked completed
    // later by an un-awaited spawn that still carries this request's context.
    app.delete('/api/sessions/:id', (req, res) => {
      void (async () => {
        const tenantId = (req as unknown as { auth: { tenantId: string } }).auth.tenantId;
        const run = await aiRunRepo.create(
          createAiRun({
            tenantId,
            taskType: 'summarize_conversation',
            model: 'test-model',
            inputSnapshot: { sessionId: req.params.id },
            createdBy: 'ti01-test',
          }),
        );
        res.setHeader('x-run-id', run.id);
        lateWrite = bInsideItsTransaction.promise
          .then(() =>
            aiRunRepo.updateStatus(tenantId, run.id, 'completed', {
              outputSnapshot: { summary: 'Caller booked a tune-up.' },
              tokenUsage: { input: 10, output: 5, total: 15 },
              completedAt: new Date(),
              durationMs: 1200,
            }),
          )
          .catch((err: unknown) => {
            lateWriteError = err;
          });
        res.status(204).end();
      })();
    });

    // Tenant B — an ordinary write request that happens to check out the
    // connection A just released.
    app.post('/api/rows', (req, res) => {
      void (async () => {
        const client = currentTenantContext()!.client;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO dropped_call_recoveries (tenant_id, voice_session_id, caller_e164, scheduled_for)
           VALUES (current_setting('app.current_tenant_id')::uuid, $1, '+15125550177', NOW())
           RETURNING id`,
          [uuidv4()],
        );
        bInsideItsTransaction.resolve();
        // Hold B's transaction open until A's late write has either been
        // issued (it landed on this connection, inside this transaction) or is
        // queued for a connection of its own (pool max=1: it must wait for us).
        await until(
          () => log.some((s) => s.sql.startsWith('UPDATE ai_runs')) || realAppPool.waitingCount > 0,
          "tenant A's late write to be issued or queued",
        );
        res.status(201).json({ id: rows[0].id });
      })();
    });

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
    await harnessPool.query('DELETE FROM dropped_call_recoveries WHERE tenant_id = ANY($1)', [[tenantA, tenantB]]);
    await harnessPool.query('DELETE FROM ai_runs WHERE tenant_id = ANY($1)', [[tenantA, tenantB]]);
    await closeSharedTestDb();
  });

  it("A's late UPDATE lands in A's own transaction, and B's request on the reused connection commits normally", async () => {
    bInsideItsTransaction = deferred();
    log.length = 0;

    const ended = await fetch(`${baseUrl}/api/sessions/${uuidv4()}`, {
      method: 'DELETE',
      headers: { 'x-test-tenant': tenantA },
    });
    expect(ended.status).toBe(204);
    const runId = ended.headers.get('x-run-id')!;
    expect(runId).toBeTruthy();

    const bResponse = await fetch(`${baseUrl}/api/rows`, {
      method: 'POST',
      headers: { 'x-test-tenant': tenantB },
    });
    const bBody = (await bResponse.json()) as { id: string };
    await lateWrite;

    // B committed normally — its row is durable and its transaction was not
    // poisoned or rolled back by A's statement.
    expect(bResponse.status).toBe(201);
    const bRows = await harnessPool.query('SELECT tenant_id FROM dropped_call_recoveries WHERE id = $1', [bBody.id]);
    expect(bRows.rows).toEqual([{ tenant_id: tenantB }]);

    // A's run reached its terminal state (under B's RLS identity the UPDATE
    // matched 0 rows and the run stayed `pending` forever).
    expect(lateWriteError).toBeUndefined();
    const run = await harnessPool.query<{ status: string; tenant_id: string }>(
      'SELECT status, tenant_id FROM ai_runs WHERE id = $1',
      [runId],
    );
    expect(run.rows).toEqual([{ status: 'completed', tenant_id: tenantA }]);

    // And on the one physical connection, A's UPDATE ran only after B's
    // transaction ended, inside a transaction of its own scoped to tenant A.
    const sqls = log.map((s) => s.sql);
    const bTenantSet = log.findIndex(
      (s) => s.sql.includes("set_config('app.current_tenant_id'") && s.params[0] === tenantB,
    );
    const bCommit = sqls.indexOf('COMMIT', bTenantSet);
    const update = sqls.findIndex((s) => s.startsWith('UPDATE ai_runs'));
    expect(bTenantSet).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(bCommit);
    const lateTransaction = sqls.slice(bCommit + 1, update + 1);
    expect(lateTransaction[0]).toBe('BEGIN');
    expect(log[bCommit + 2].sql).toContain("set_config('app.current_tenant_id'");
    expect(log[bCommit + 2].params[0]).toBe(tenantA);
    expect(lateTransaction).toContain('SET LOCAL ROLE rls_app_runtime');
    expect(sqls.slice(update + 1)).toContain('COMMIT');
  });
});
