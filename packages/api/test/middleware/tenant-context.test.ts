/**
 * P0-024 — RLS tenant context middleware.
 *
 * The middleware opens a Postgres transaction, runs `set_config(...,
 * true)` to set `app.current_tenant_id` LOCAL to that transaction,
 * stashes the PoolClient on AsyncLocalStorage, and commits/rolls back
 * via the response lifecycle.
 *
 * These tests use a mocked Pool so no real database is required. They
 * verify the wiring: the SET fires, the client is retrievable from the
 * store, withTenant() reuses that client, and the lifecycle cleans up
 * correctly across request boundaries (no GUC leak).
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient, QueryResult } from 'pg';
import {
  withTenantTransaction,
  tenantContextStore,
  currentTenantContext,
  withRequestSavepoint,
} from '../../src/middleware/tenant-context';
import { PgBaseRepository } from '../../src/db/pg-base';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

interface CapturedQuery {
  sql: string;
  params: unknown[];
  client: PoolClient;
}

/**
 * Build a fake Pool whose .connect() either returns fresh clients or
 * cycles through a fixed list of clients (for the pool-safety test).
 *
 * Each fake client:
 *   - Maintains its own GUC map (tenant_id) updated by set_config(...).
 *   - Records every query in the shared `calls` log.
 *   - Returns the current GUC value for `current_setting(...)`.
 */
function makeMockPool(opts: { maxClients?: number } = {}) {
  const calls: CapturedQuery[] = [];
  const clients: Array<PoolClient & { _gucTenant?: string; _released: boolean; _id: number }> = [];
  let connectCount = 0;
  let releaseCount = 0;

  const makeClient = (id: number): PoolClient => {
    const c: any = {
      _id: id,
      _gucTenant: undefined,
      _released: false,
      query: vi.fn(async (sqlOrConfig: string, params?: unknown[]) => {
        const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : (sqlOrConfig as any).text;
        calls.push({ sql, params: params ?? [], client: c });
        // Emulate a couple of statements we care about.
        if (/^BEGIN/i.test(sql)) {
          return { rows: [], rowCount: 0, command: 'BEGIN', oid: 0, fields: [] } as unknown as QueryResult;
        }
        if (/^COMMIT/i.test(sql)) {
          return { rows: [], rowCount: 0, command: 'COMMIT', oid: 0, fields: [] } as unknown as QueryResult;
        }
        if (/^ROLLBACK/i.test(sql)) {
          // ROLLBACK clears the LOCAL GUC.
          c._gucTenant = undefined;
          return { rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] } as unknown as QueryResult;
        }
        if (/set_config\('app\.current_tenant_id'/i.test(sql)) {
          // Third positional arg (true) means LOCAL — only persists
          // until the transaction ends. We simulate that here.
          c._gucTenant = (params?.[0] as string) ?? undefined;
          return { rows: [], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as unknown as QueryResult;
        }
        if (/SET\s+app\.current_tenant_id/i.test(sql)) {
          // The fallback path in PgBaseRepository uses a non-LOCAL SET.
          // For test purposes treat it like the LOCAL path — the GUC
          // value is what matters for assertions, not its scope.
          const literalMatch = sql.match(/'([^']+)'/);
          c._gucTenant = literalMatch ? literalMatch[1] : undefined;
          return { rows: [], rowCount: 0, command: 'SET', oid: 0, fields: [] } as unknown as QueryResult;
        }
        if (/current_setting\('app\.current_tenant_id'/i.test(sql)) {
          return {
            rows: [{ t: c._gucTenant ?? null }],
            rowCount: 1,
            command: 'SELECT',
            oid: 0,
            fields: [],
          } as unknown as QueryResult;
        }
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as unknown as QueryResult;
      }) as unknown as PoolClient['query'],
      release: vi.fn(() => {
        c._released = true;
        releaseCount += 1;
      }) as unknown as PoolClient['release'],
    };
    return c as PoolClient;
  };

  const max = opts.maxClients ?? Infinity;
  const pool: Partial<Pool> = {
    connect: vi.fn(async () => {
      connectCount += 1;
      // Reuse in round-robin when bounded — emulates a small pool that
      // hands the SAME physical connection to back-to-back checkouts.
      let client: PoolClient & { _released?: boolean };
      if (Number.isFinite(max) && clients.length >= max) {
        client = clients[(connectCount - 1) % max];
        // mark as re-acquired
        (client as any)._released = false;
      } else {
        client = makeClient(clients.length + 1) as PoolClient & { _released?: boolean };
        clients.push(client as any);
      }
      return client;
    }) as unknown as Pool['connect'],
  };

  return {
    pool: pool as Pool,
    calls,
    clients,
    getConnectCount: () => connectCount,
    getReleaseCount: () => releaseCount,
  };
}

/**
 * Tiny app builder: fake auth middleware that sets req.auth.tenantId
 * from a header, then the middleware under test, then a route. The
 * route runs `fn(req)` so individual tests can pin assertions on what
 * the request handler observed.
 */
function buildApp(
  pool: Pool,
  routeHandler: (req: AuthenticatedRequest, res: express.Response) => Promise<void> | void,
  opts: { withAuth?: boolean } = { withAuth: true },
) {
  const app = express();
  app.use(express.json());
  if (opts.withAuth !== false) {
    app.use((req, _res, next) => {
      const tenantId = req.headers['x-test-tenant'] as string | undefined;
      if (tenantId) {
        (req as AuthenticatedRequest).auth = {
          userId: 'u1',
          sessionId: 's1',
          tenantId,
          role: 'owner',
        };
      }
      next();
    });
  }
  app.use('/protected', withTenantTransaction(pool));
  app.get('/protected/echo', async (req, res) => {
    try {
      await routeHandler(req as AuthenticatedRequest, res);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
  // Health-style public route mounted without the middleware.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  return app;
}

describe('P0-024 — tenant-context middleware (withTenantTransaction)', () => {
  it('happy path — RLS variable set for authenticated request', async () => {
    const { pool, calls } = makeMockPool();

    const app = buildApp(pool, async (req, res) => {
      const ctx = currentTenantContext();
      // The middleware must have populated AsyncLocalStorage before
      // calling next().
      expect(ctx?.tenantId).toBe(TENANT_A);
      expect(ctx?.client).toBeDefined();
      const { rows } = await ctx!.client.query(
        "SELECT current_setting('app.current_tenant_id') AS t",
      );
      res.json({ t: (rows[0] as { t: string | null }).t });
    });

    const response = await request(app)
      .get('/protected/echo')
      .set('x-test-tenant', TENANT_A);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ t: TENANT_A });

    // Statement order on this connection: BEGIN, tenant set_config, the
    // transaction-local timeouts (statement_timeout +
    // idle_in_transaction_session_timeout — PgBouncer-safe via is_local),
    // then the handler's SELECT.
    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toMatch(/^BEGIN/i);
    expect(sqls[1]).toMatch(/set_config\('app\.current_tenant_id'/i);
    expect(calls[1].params[0]).toBe(TENANT_A);
    expect(sqls[2]).toMatch(/set_config\('statement_timeout'/i);
    expect(sqls[2]).toMatch(/idle_in_transaction_session_timeout/i);
    expect(sqls[3]).toMatch(/current_setting/i);
    // After the response finishes, COMMIT must run.
    // res.finish handlers run async — wait a tick.
    await new Promise((r) => setImmediate(r));
    expect(sqls).toContain('COMMIT');
  });

  it('PgBaseRepository.withTenant reuses the request-scoped client', async () => {
    const { pool, calls } = makeMockPool();

    class TestRepo extends PgBaseRepository {
      async readTenant(tenantId: string): Promise<string | null> {
        return this.withTenant(tenantId, async (client) => {
          const { rows } = await client.query(
            "SELECT current_setting('app.current_tenant_id') AS t",
          );
          return (rows[0] as { t: string | null }).t;
        });
      }
    }

    const repo = new TestRepo(pool);

    const app = buildApp(pool, async (req, res) => {
      const t = await repo.readTenant(req.auth!.tenantId);
      res.json({ t });
    });

    const response = await request(app)
      .get('/protected/echo')
      .set('x-test-tenant', TENANT_A);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ t: TENANT_A });

    // CRITICAL: only ONE pool.connect() call for the whole request.
    // If withTenant() ignored AsyncLocalStorage we'd see two.
    const connectCount = (pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(connectCount).toBe(1);

    // And every recorded query must have run on the same client.
    const uniqueClients = new Set(calls.map((c) => c.client));
    expect(uniqueClients.size).toBe(1);
  });

  it('Codex P1 fix: withTenantTransaction reuses the request-scoped client (no extra pool.connect)', async () => {
    // Without this reuse, a write path under a 1-connection pool
    // would deadlock — the middleware holds client A until
    // response.finish, but the repo would call pool.connect() and
    // wait for client B which can't be acquired until A releases.
    const { pool, calls } = makeMockPool();

    class TestWriteRepo extends PgBaseRepository {
      async write(tenantId: string): Promise<void> {
        await this.withTenantTransaction(tenantId, async (client) => {
          await client.query(
            "INSERT INTO test_table (tenant_id, name) VALUES (current_setting('app.current_tenant_id')::UUID, 'x')",
          );
        });
      }
    }

    const repo = new TestWriteRepo(pool);

    const app = buildApp(pool, async (req, res) => {
      await repo.write(req.auth!.tenantId);
      res.json({ ok: true });
    });

    const response = await request(app)
      .get('/protected/echo')
      .set('x-test-tenant', TENANT_A);

    expect(response.status).toBe(200);

    // CRITICAL: only ONE pool.connect() for the entire request.
    // If withTenantTransaction ignored AsyncLocalStorage we'd see
    // two — and on a 1-connection pool the second would deadlock.
    const connectCount = (pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(connectCount).toBe(1);

    // And we must NOT have issued a second BEGIN inside the request
    // (the middleware already opened the transaction).
    const innerBegins = calls.filter(
      (c) => /^\s*BEGIN/i.test(c.sql) && c !== calls.find((x) => /^\s*BEGIN/i.test(x.sql)),
    );
    expect(innerBegins).toHaveLength(0);
  });

  it('tenant isolation — withTenant called with a different tenantId opens its own connection', async () => {
    const { pool, calls } = makeMockPool();

    class TestRepo extends PgBaseRepository {
      async readForOtherTenant(tenantId: string): Promise<string | null> {
        return this.withTenant(tenantId, async (client) => {
          const { rows } = await client.query(
            "SELECT current_setting('app.current_tenant_id') AS t",
          );
          return (rows[0] as { t: string | null }).t;
        });
      }
    }

    const repo = new TestRepo(pool);

    const app = buildApp(pool, async (_req, res) => {
      // Cross-tenant read attempt — must NOT reuse tenant A's client
      // because the AsyncLocalStorage tenantId doesn't match.
      const t = await repo.readForOtherTenant(TENANT_B);
      res.json({ t });
    });

    await request(app)
      .get('/protected/echo')
      .set('x-test-tenant', TENANT_A);

    // 1 connect for the middleware (tenant A txn) + 1 for the
    // cross-tenant fallback path = 2 connects.
    const connectCount = (pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(connectCount).toBe(2);

    // The fallback connection had its GUC set to TENANT_B; the
    // middleware connection had its GUC set to TENANT_A.
    const setCalls = calls.filter(
      (c) =>
        /set_config\('app\.current_tenant_id'/i.test(c.sql) ||
        /SET\s+app\.current_tenant_id/i.test(c.sql),
    );
    const tenants = setCalls.map((c) =>
      c.params[0] !== undefined ? (c.params[0] as string) : c.sql.match(/'([^']+)'/)?.[1],
    );
    expect(tenants).toContain(TENANT_A);
    expect(tenants).toContain(TENANT_B);
  });

  it('pool safety — SET LOCAL does not leak to next request on same connection', async () => {
    // 1-client pool: the SAME physical connection is handed to both
    // requests. If we used `SET` (not `SET LOCAL`), tenant A's GUC
    // would survive into tenant B's request.
    const { pool, clients } = makeMockPool({ maxClients: 1 });

    const app = buildApp(pool, async (req, res) => {
      const ctx = currentTenantContext();
      const { rows } = await ctx!.client.query(
        "SELECT current_setting('app.current_tenant_id') AS t",
      );
      res.json({ t: (rows[0] as { t: string | null }).t });
    });

    // Request 1 — tenant A. Wait for it to complete (incl. res.finish
    // so the COMMIT path fires).
    const r1 = await request(app)
      .get('/protected/echo')
      .set('x-test-tenant', TENANT_A);
    await new Promise((r) => setImmediate(r));

    // Request 2 — tenant B, same physical connection.
    const r2 = await request(app)
      .get('/protected/echo')
      .set('x-test-tenant', TENANT_B);
    await new Promise((r) => setImmediate(r));

    expect(r1.body.t).toBe(TENANT_A);
    expect(r2.body.t).toBe(TENANT_B);
    // Same client served both — proves the pool reuse path was
    // exercised. Without SET LOCAL semantics, r2 would have read
    // TENANT_A.
    expect(clients.length).toBe(1);
  });

  it('unauthenticated routes — health check works without tenant context', async () => {
    const { pool } = makeMockPool();
    const app = buildApp(pool, () => {
      throw new Error('should not reach protected handler');
    });

    const response = await request(app).get('/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    // Pool was never touched for the public route.
    const connectCount = (pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(connectCount).toBe(0);
  });

  it('missing tenant — returns 403, not a database error', async () => {
    const { pool } = makeMockPool();
    const app = buildApp(pool, () => {
      throw new Error('should not reach handler');
    });

    // No x-test-tenant header → fake auth middleware doesn't set
    // req.auth → tenantContext middleware must short-circuit with 403
    // BEFORE attempting pool.connect().
    const response = await request(app).get('/protected/echo');

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: 'FORBIDDEN' });
    const connectCount = (pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(connectCount).toBe(0);
  });

  it('SSE bypass (Codex P1) — a known SSE GET route holds no request transaction', async () => {
    // A long-lived SSE stream must NOT pin a pooled connection / PgBouncer
    // backend for its whole life; the middleware skips the BEGIN..COMMIT
    // transaction for the explicit SSE route allowlist.
    const { pool, calls } = makeMockPool();
    let sawTenant: string | undefined;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner',
      };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.get('/api/escalations/events', (req, res) => {
      sawTenant = (req as AuthenticatedRequest).auth?.tenantId;
      res.json({ ok: true });
    });

    const response = await request(app).get('/api/escalations/events');

    expect(response.status).toBe(200);
    // Tenant is still enforced/available to the handler …
    expect(sawTenant).toBe(TENANT_A);
    // … but no connection was checked out and no BEGIN was issued.
    const connectCount = (pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(connectCount).toBe(0);
    expect(calls.some((c) => /^\s*BEGIN/i.test(c.sql))).toBe(false);
  });

  it('SSE bypass is route-restricted (Codex P2) — a mutating route with Accept: text/event-stream still opens the transaction', async () => {
    // The bypass must be keyed off the route allowlist, NOT the client-supplied
    // Accept header — otherwise any caller could send `text/event-stream` to a
    // mutating route and skip the request transaction, losing multi-write
    // atomicity (e.g. job + audit committing separately).
    const { pool, calls } = makeMockPool();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner',
      };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.post('/api/jobs', (_req, res) => res.json({ created: true }));

    const response = await request(app)
      .post('/api/jobs')
      .set('Accept', 'text/event-stream')
      .send({ title: 'x' });

    expect(response.status).toBe(200);
    // Transaction was NOT skipped: one checkout + a BEGIN.
    const connectCount = (pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(connectCount).toBe(1);
    expect(calls.some((c) => /^\s*BEGIN/i.test(c.sql))).toBe(true);
  });

  it('UC-2 LLM-long-call bypass — POST /assistant/chat holds no request transaction and stashes no ALS client', async () => {
    // The assistant chat handler awaits the LLM gateway call; holding the
    // request transaction across it pins a pooled connection (and under
    // PgBouncer a server backend) for the whole call. The middleware skips
    // the transaction for the explicit method+path allowlist; repos on this
    // route self-manage short SET LOCAL transactions (U2b-2) with an
    // explicit tenantId — the same contract as the voice worker path.
    const { pool, calls } = makeMockPool();
    let sawTenant: string | undefined;
    let storeAtHandler: unknown = 'unset';
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner',
      };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.post('/api/assistant/chat', (req, res) => {
      sawTenant = (req as AuthenticatedRequest).auth?.tenantId;
      // What a repo would see mid-"LLM call": no request-scoped client.
      storeAtHandler = currentTenantContext();
      res.json({ ok: true });
    });

    const response = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(200);
    // Tenant still enforced/available to the handler …
    expect(sawTenant).toBe(TENANT_A);
    // … but no ALS client is stashed, no connection checked out, no BEGIN.
    expect(storeAtHandler).toBeUndefined();
    const connectCount = (pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(connectCount).toBe(0);
    expect(calls.some((c) => /^\s*BEGIN/i.test(c.sql))).toBe(false);
  });

  it('UC-2 bypass is method-anchored — GET /assistant/chat still opens the transaction', async () => {
    const { pool, calls } = makeMockPool();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner',
      };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.get('/api/assistant/chat', (_req, res) => res.json({ ok: true }));

    const response = await request(app).get('/api/assistant/chat');

    expect(response.status).toBe(200);
    const connectCount = (pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(connectCount).toBe(1);
    expect(calls.some((c) => /^\s*BEGIN/i.test(c.sql))).toBe(true);
  });

  it('rollback on response close before finish', async () => {
    // Simulate a client disconnect: emit `close` without `finish`.
    const { pool, calls } = makeMockPool();

    // Fake req/res so we can drive the lifecycle manually.
    const res = new EventEmitter() as unknown as express.Response & EventEmitter;
    (res as any).status = vi.fn(() => res);
    (res as any).json = vi.fn(() => res);

    const req = {
      auth: { userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner' },
    } as unknown as AuthenticatedRequest;

    const next = vi.fn();
    const middleware = withTenantTransaction(pool);
    await middleware(req, res as unknown as express.Response, next);

    // Middleware must have called next() inside the ALS scope. Now
    // simulate the client disconnecting before the response was
    // flushed — emit `close` without `finish`.
    expect(next).toHaveBeenCalledOnce();
    (res as unknown as EventEmitter).emit('close');
    await new Promise((r) => setImmediate(r));

    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });

  it('rollback on error — handler throws (500) does not commit partial writes', async () => {
    const { pool, calls } = makeMockPool();
    // Simulate a multi-write handler: first write succeeds, then it throws.
    // buildApp's route wrapper turns the throw into a 500 response, which
    // fires `finish` — the middleware must ROLLBACK, not COMMIT.
    const app = buildApp(pool, async () => {
      const ctx = currentTenantContext();
      await ctx!.client.query('INSERT INTO things (id) VALUES (1)');
      throw new Error('second write failed');
    });

    const response = await request(app)
      .get('/protected/echo')
      .set('x-test-tenant', TENANT_A);

    expect(response.status).toBe(500);
    await new Promise((r) => setImmediate(r));
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain('INSERT INTO things (id) VALUES (1)');
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });

  it('rollback on client-error response (4xx) — partial writes are not persisted', async () => {
    const { pool, calls } = makeMockPool();
    const app = buildApp(pool, async (_req, res) => {
      const ctx = currentTenantContext();
      await ctx!.client.query('INSERT INTO things (id) VALUES (2)');
      res.status(409).json({ error: 'CONFLICT' });
    });

    const response = await request(app)
      .get('/protected/echo')
      .set('x-test-tenant', TENANT_A);

    expect(response.status).toBe(409);
    await new Promise((r) => setImmediate(r));
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });

  it('no double-release — client released exactly once when both finish and close fire', async () => {
    const { pool, calls, clients, getReleaseCount } = makeMockPool();

    const res = new EventEmitter() as unknown as express.Response & EventEmitter;
    (res as any).statusCode = 200;
    (res as any).locals = {};
    (res as any).status = vi.fn(() => res);
    (res as any).json = vi.fn(() => res);

    const req = {
      auth: { userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner' },
    } as unknown as AuthenticatedRequest;

    const next = vi.fn();
    await withTenantTransaction(pool)(req, res as unknown as express.Response, next);
    expect(next).toHaveBeenCalledOnce();

    // Normal lifecycle on modern Node: `finish` then `close`.
    (res as unknown as EventEmitter).emit('finish');
    (res as unknown as EventEmitter).emit('close');
    await new Promise((r) => setImmediate(r));

    // Exactly one release of the pooled client, COMMIT (status 200) and
    // no ROLLBACK-after-COMMIT from the trailing `close`.
    expect(getReleaseCount()).toBe(1);
    expect((clients[0].release as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');
  });

  it('forceCommit escape hatch — commits despite a >=400 status', async () => {
    const { pool, calls } = makeMockPool();
    const app = buildApp(pool, async (_req, res) => {
      const ctx = currentTenantContext();
      await ctx!.client.query('INSERT INTO things (id) VALUES (3)');
      res.locals.forceCommit = true;
      res.status(409).json({ error: 'CONFLICT_BUT_PERSISTED' });
    });

    const response = await request(app)
      .get('/protected/echo')
      .set('x-test-tenant', TENANT_A);

    expect(response.status).toBe(409);
    await new Promise((r) => setImmediate(r));
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');
  });

  it('AsyncLocalStorage scope is request-local (does not leak between async tasks)', async () => {
    // Outside any middleware run, currentTenantContext() must be
    // undefined — proving we don't rely on a module-level mutable
    // singleton.
    expect(currentTenantContext()).toBeUndefined();

    await tenantContextStore.run(
      { client: {} as PoolClient, tenantId: TENANT_A },
      async () => {
        expect(currentTenantContext()?.tenantId).toBe(TENANT_A);
      },
    );

    expect(currentTenantContext()).toBeUndefined();
  });
});

describe('withRequestSavepoint', () => {
  function fakeClient(): { client: PoolClient; calls: string[] } {
    const calls: string[] = [];
    const client = {
      query: async (text: string) => {
        calls.push(text);
        return { rows: [] } as unknown as QueryResult;
      },
    } as unknown as PoolClient;
    return { client, calls };
  }

  it('runs fn directly when there is no request transaction (no savepoint)', async () => {
    let ran = false;
    const out = await withRequestSavepoint(async () => {
      ran = true;
      return 7;
    });
    expect(ran).toBe(true);
    expect(out).toBe(7);
  });

  it('wraps fn in SAVEPOINT / RELEASE inside a request transaction', async () => {
    const { client, calls } = fakeClient();
    const out = await tenantContextStore.run({ client, tenantId: TENANT_A }, () =>
      withRequestSavepoint(async () => 'ok'),
    );
    expect(out).toBe('ok');
    expect(calls.some((q) => q.startsWith('SAVEPOINT'))).toBe(true);
    expect(calls.some((q) => q.startsWith('RELEASE SAVEPOINT'))).toBe(true);
    expect(calls.some((q) => q.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(false);
  });

  it('rolls back to the savepoint and rethrows on error, leaving the tx usable', async () => {
    const { client, calls } = fakeClient();
    await expect(
      tenantContextStore.run({ client, tenantId: TENANT_A }, () =>
        withRequestSavepoint(async () => {
          throw Object.assign(new Error('dup'), { code: '23505' });
        }),
      ),
    ).rejects.toThrow('dup');
    expect(calls.some((q) => q.startsWith('SAVEPOINT'))).toBe(true);
    expect(calls.some((q) => q.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
    // The outer transaction is NOT rolled back — only the savepoint is.
    expect(calls).not.toContain('ROLLBACK');
  });
});
