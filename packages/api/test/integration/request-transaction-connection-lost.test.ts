/**
 * #1090 follow-on (review finding on PR #1112) — a request transaction whose
 * connection Postgres kills must not report success.
 *
 * `withTenantTransaction` commits on `res.finish` and, when the COMMIT fails,
 * falls back to ROLLBACK and swallows both. That is right when the failure is a
 * constraint violation the handler already turned into a >=400. It is wrong
 * when Postgres terminated the backend mid-request: the handler can do its last
 * write, await a slow upstream past `idle_in_transaction_session_timeout`, then
 * send a 200 with no further query — the response claims success while Postgres
 * has already rolled the writes back, nothing is logged, and the after-commit
 * hooks silently never run.
 *
 * Before #1090's pool guard this was hidden behind a process crash. Now that a
 * killed connection is survivable, the silent false success is what is left, so
 * it belongs to this PR.
 *
 * Real Postgres, because the whole point is a backend Postgres itself kills.
 * The module is imported dynamically so `DB_REQUEST_IDLE_TX_TIMEOUT_MS` is in
 * place first — `tenant-context.ts` reads it once at module load.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { createPool } from '../../src/db/pool';
import { asyncRoute } from '../../src/middleware/async-route';
import { toErrorResponse } from '../../src/shared/errors';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How long the request transaction may sit idle before Postgres kills it. */
const IDLE_TX_MS = 400;

type TenantContextModule = typeof import('../../src/middleware/tenant-context');
let tenantContext: TenantContextModule;

interface Harness {
  url: string;
  close: () => Promise<void>;
}

/**
 * The REAL middleware mounted the way app.ts mounts it (`app.use('/api', …)`),
 * in front of one route shaped like the finding: write, wait past the
 * idle-transaction timeout, then respond 200 without another query.
 */
async function startHarness(
  pool: Pool,
  tenantId: string,
  onAfterCommit: () => void,
): Promise<Harness> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { auth: { tenantId: string } }).auth = { tenantId };
    next();
  });
  app.use('/api', tenantContext.withTenantTransaction(pool));
  app.post('/api/slow-write', (req, res) => {
    void (async () => {
      const ctx = tenantContext.currentTenantContext();
      await ctx!.client.query(
        `INSERT INTO dropped_call_recoveries
           (tenant_id, voice_session_id, caller_e164, scheduled_for)
         VALUES (current_setting('app.current_tenant_id')::uuid, $1, $2, NOW())`,
        [uuidv4(), '+15125550188'],
      );
      tenantContext.runAfterCommit(res, onAfterCommit);
      // The slow upstream, with the transaction idle. Postgres terminates the
      // backend at idle_in_transaction_session_timeout.
      await sleep(IDLE_TX_MS * 5);
      // …and the handler reports success without touching the DB again.
      try {
        res.status(200).json({ ok: true });
      } catch {
        // Headers may already be gone if the request was failed for us — that
        // is the fixed behavior, not an error in the handler.
      }
    })();
  });

  return listen(app);
}

/**
 * The second shape, from the Codex review: a query IS in flight when the
 * backend dies. `pg` then raises BOTH ways at once — `_errorAllQueries`
 * rejects the handler's await (which flows through the real `asyncRoute` into
 * the error pipeline) AND the client 'error' event fires. The caller must end
 * up with exactly ONE complete response.
 *
 * The route is wrapped in the production `asyncRoute`, and the app carries a
 * replica of app.ts's global error handler WITHOUT its `headersSent` guard —
 * deliberately the adversarial version, so this proves the middleware alone
 * keeps the pipeline single-writer rather than leaning on that guard.
 *
 * What is asserted is the server-side symptom, because the client-side one is
 * invisible here: a second write into a committed response throws
 * ERR_HTTP_HEADERS_SENT, and Express answers that by destroying the socket —
 * but a 500 body this small is already flushed, so `fetch` still resolves. The
 * trailing error handler records whatever the replica throws.
 */
async function startInFlightHarness(
  pool: Pool,
  tenantId: string,
  serverErrors: unknown[],
): Promise<Harness> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { auth: { tenantId: string } }).auth = { tenantId };
    next();
  });
  app.use('/api', tenantContext.withTenantTransaction(pool));
  app.post(
    '/api/in-flight',
    asyncRoute(async (_req, res) => {
      const ctx = tenantContext.currentTenantContext();
      // Still running when the backend is terminated below.
      await ctx!.client.query('SELECT pg_sleep(5)');
      res.status(200).json({ ok: true });
    }),
  );
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    },
  );
  // Express routes a throw from the handler above into the NEXT error handler,
  // so this is where a second write into a committed response shows up.
  app.use(
    (err: Error, _req: express.Request, _res: express.Response, _next: express.NextFunction) => {
      serverErrors.push(err);
    },
  );
  return listen(app);
}

async function listen(app: express.Express): Promise<Harness> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function appPool(baseUrl: string): Pool {
  const previousUrl = process.env.DATABASE_URL;
  const previousSsl = process.env.DB_SSL;
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', 'rivet_1090_reqtxn');
  process.env.DATABASE_URL = url.toString();
  process.env.DB_SSL = 'false';
  try {
    return createPool();
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousSsl === undefined) delete process.env.DB_SSL;
    else process.env.DB_SSL = previousSsl;
  }
}

describe('#1090 — a killed request transaction must not report success', () => {
  let harnessPool: Pool;
  let baseUrl: string;
  let tenantId: string;
  let previousIdleEnv: string | undefined;

  beforeAll(async () => {
    harnessPool = await getSharedTestDb();
    baseUrl = process.env.TEST_DB_URL as string;
    expect(baseUrl, 'TEST_DB_URL must be set by the integration globalSetup').toBeTruthy();
    ({ tenantId } = await createTestTenant(harnessPool));

    previousIdleEnv = process.env.DB_REQUEST_IDLE_TX_TIMEOUT_MS;
    process.env.DB_REQUEST_IDLE_TX_TIMEOUT_MS = String(IDLE_TX_MS);
    tenantContext = await import('../../src/middleware/tenant-context');
  });

  afterAll(async () => {
    if (previousIdleEnv === undefined) delete process.env.DB_REQUEST_IDLE_TX_TIMEOUT_MS;
    else process.env.DB_REQUEST_IDLE_TX_TIMEOUT_MS = previousIdleEnv;
    await closeSharedTestDb();
  });

  afterEach(async () => {
    await harnessPool.query('DELETE FROM dropped_call_recoveries WHERE tenant_id = $1', [
      tenantId,
    ]);
  });

  it('fails the request rather than returning 2xx over rolled-back writes', async () => {
    const pool = appPool(baseUrl);
    let afterCommitRan = false;
    const harness = await startHarness(pool, tenantId, () => {
      afterCommitRan = true;
    });

    try {
      const res = await fetch(`${harness.url}/api/slow-write`, { method: 'POST' });
      await sleep(250);

      const { rows } = await harnessPool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM dropped_call_recoveries WHERE tenant_id = $1',
        [tenantId],
      );

      // Postgres rolled the write back when it killed the backend…
      expect(rows[0].n).toBe(0);
      // …so the after-commit hooks must not have run…
      expect(afterCommitRan).toBe(false);
      // …and the response must not claim success.
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await harness.close();
      await pool.end().catch(() => undefined);
    }
  });

  it('answers exactly once when a query is in flight as the backend dies', async () => {
    const pool = appPool(baseUrl);
    const serverErrors: unknown[] = [];
    const harness = await startInFlightHarness(pool, tenantId, serverErrors);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const pending = fetch(`${harness.url}/api/in-flight`, { method: 'POST' });
      // Let the request open its transaction and get pg_sleep running.
      await sleep(500);
      await harnessPool.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
        ['rivet_1090_reqtxn'],
      );

      const res = await pending;
      expect(res.status).toBeGreaterThanOrEqual(500);
      await expect(res.json()).resolves.toBeTruthy();

      await sleep(300);
      // Exactly one writer reached the response. A second one throws
      // ERR_HTTP_HEADERS_SENT and Express destroys the socket to answer it.
      expect(
        (serverErrors as Array<{ code?: string }>).map((e) => e?.code ?? String(e)),
      ).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await harness.close();
      await pool.end().catch(() => undefined);
    }
  });
});
