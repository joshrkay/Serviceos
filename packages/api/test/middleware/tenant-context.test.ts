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
import { EventEmitter, once } from 'node:events';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Pool, PoolClient, QueryResult } from 'pg';
import {
  withTenantTransaction,
  tenantContextStore,
  currentTenantContext,
  withRequestSavepoint,
  runAfterCommit,
  commitRequestTransactionAndBegin,
  type TenantContext,
} from '../../src/middleware/tenant-context';
import { PgBaseRepository } from '../../src/db/pg-base';
import { asyncRoute } from '../../src/middleware/async-route';
import { escalationEventsRouter } from '../../src/escalations/events-route';
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
function makeMockPool(
  opts: {
    maxClients?: number;
    /** Runs inside every COMMIT before it resolves — delay it, emit on the client, or throw. */
    onCommit?: (client: PoolClient) => Promise<void>;
  } = {},
) {
  const calls: CapturedQuery[] = [];
  const clients: Array<PoolClient & { _gucTenant?: string; _released: boolean; _id: number }> = [];
  let connectCount = 0;
  let releaseCount = 0;

  const makeClient = (id: number): PoolClient => {
    // A real PoolClient is an EventEmitter, and the middleware listens for
    // 'error' on it (#1090 — a backend Postgres kills mid-request is delivered
    // as an event, never as a rejected query). Mock it as one so this harness
    // keeps matching the contract it stands in for.
    const c: any = Object.assign(new EventEmitter(), {
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
          if (opts.onCommit) await opts.onCommit(c);
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
    });
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

  describe('TI-02 — in-request LLM routes bypass the request transaction (method + path anchored)', () => {
    async function probe(method: 'get' | 'post' | 'put' | 'delete', path: string) {
      const { pool, calls } = makeMockPool();
      let storeAtHandler: unknown = 'unset';
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as AuthenticatedRequest).auth = { userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner' };
        next();
      });
      app.use('/api', withTenantTransaction(pool));
      app.all('/api/*splat', (_req, res) => {
        storeAtHandler = currentTenantContext();
        res.json({ ok: true });
      });
      const response = await request(app)[method](path).send({});
      expect(response.status).toBe(200);
      return {
        connects: (pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
        began: calls.some((c) => /^\s*BEGIN/i.test(c.sql)),
        storeAtHandler,
      };
    }

    it.each([
      ['post', '/api/voice/sessions'],
      ['post', '/api/voice/sessions/3f1c9a52-0000-4000-8000-000000000001/input'],
      ['delete', '/api/voice/sessions/3f1c9a52-0000-4000-8000-000000000001'],
      ['post', '/api/conversations/3f1c9a52-0000-4000-8000-000000000002/suggest-reply'],
      ['post', '/api/estimates/suggest'],
      ['post', '/api/onboarding/conversation/turn'],
      // A1 — the "which Bob?" pick re-drafts through the task handler's LLM call.
      ['post', '/api/proposals/3f1c9a52-0000-4000-8000-000000000004/resolve-entity'],
      // The website "About us" draft awaits the tenant_site_about LLM call.
      ['post', '/api/tenant-site/about/draft'],
      // Speech synthesis: each clip awaits the TTS provider (30s timeout each).
      ['post', '/api/voice/tts'],
      ['post', '/api/voice/tts/batch'],
      // Speech-to-text: the upload, then the Whisper call (60s timeout).
      ['post', '/api/voice/transcribe'],
      // The Deepgram grant fetch has no deadline of its own.
      ['post', '/api/voice/stream-token'],
    ] as const)('%s %s holds no request transaction', async (method, path) => {
      const seen = await probe(method, path);
      expect(seen).toEqual({ connects: 0, began: false, storeAtHandler: undefined });
    });

    it.each([
      // Same paths, other methods.
      ['get', '/api/voice/sessions/3f1c9a52-0000-4000-8000-000000000001'],
      ['put', '/api/voice/sessions/3f1c9a52-0000-4000-8000-000000000001/input'],
      ['get', '/api/onboarding/conversation/turn'],
      ['delete', '/api/conversations/3f1c9a52-0000-4000-8000-000000000002/suggest-reply'],
      // Mutating siblings that must keep multi-write atomicity.
      ['post', '/api/voice/sessions/3f1c9a52-0000-4000-8000-000000000001/other'],
      ['delete', '/api/voice/sessions/3f1c9a52-0000-4000-8000-000000000001/input'],
      ['post', '/api/conversations/3f1c9a52-0000-4000-8000-000000000002/reply'],
      ['post', '/api/estimates'],
      ['post', '/api/estimates/3f1c9a52-0000-4000-8000-000000000003/send'],
      ['post', '/api/estimates/suggest/extra'],
      ['post', '/api/onboarding/pack'],
      // A1 — approval and the other proposal mutations keep the request
      // transaction (approve's row lock is held to commit).
      ['post', '/api/proposals/3f1c9a52-0000-4000-8000-000000000004/approve'],
      ['post', '/api/proposals/3f1c9a52-0000-4000-8000-000000000004/resolve-line'],
      ['get', '/api/proposals/3f1c9a52-0000-4000-8000-000000000004/resolve-entity'],
      ['post', '/api/proposals/3f1c9a52-0000-4000-8000-000000000004/resolve-entity/extra'],
      // The rest of the website routes keep the request transaction.
      ['get', '/api/tenant-site/about'],
      ['get', '/api/tenant-site/about/draft'],
      ['post', '/api/tenant-site/publish'],
      ['post', '/api/tenant-site/about/draft/extra'],
      // A nested router sharing the suffix does not inherit the bypass.
      ['post', '/api/admin/voice/sessions'],
      ['post', '/api/leads/estimates/suggest'],
      ['post', '/api/admin/proposals/3f1c9a52-0000-4000-8000-000000000004/resolve-entity'],
      ['post', '/api/admin/tenant-site/about/draft'],
      // The cached-clip read and the other voice routes keep it.
      ['get', '/api/voice/tts/clip/0123abcd'],
      ['get', '/api/voice/tts'],
      ['post', '/api/voice/tts/batch/extra'],
      ['post', '/api/voice/recordings'],
      ['post', '/api/admin/voice/tts'],
      ['get', '/api/voice/transcribe'],
      ['post', '/api/voice/transcribe/extra'],
      ['post', '/api/admin/voice/transcribe'],
      ['get', '/api/voice/stream-token'],
      ['post', '/api/admin/voice/stream-token'],
    ] as const)('%s %s still opens the transaction', async (method, path) => {
      const seen = await probe(method, path);
      expect(seen.connects).toBe(1);
      expect(seen.began).toBe(true);
    });

    // A-R4 — Express routing is not strict and not case-sensitive, so
    // `/resolve-entity/` and `/Resolve-Entity` reach the same handler as
    // `/resolve-entity`. If the bypass missed those forms, the request would
    // run inside the request transaction AND (resolve-entity) its runner would
    // take a second pooled connection inside it.
    it.each([
      ['post', '/api/assistant/chat/'],
      ['post', '/api/voice/quality/grade'],
      ['post', '/api/voice/quality/grade/'],
      ['post', '/api/voice/sessions/'],
      ['post', '/api/voice/sessions/3f1c9a52-0000-4000-8000-000000000001/input/'],
      ['delete', '/api/voice/sessions/3f1c9a52-0000-4000-8000-000000000001/'],
      ['post', '/api/conversations/3f1c9a52-0000-4000-8000-000000000002/suggest-reply/'],
      ['post', '/api/estimates/suggest/'],
      ['post', '/api/onboarding/conversation/turn/'],
      ['post', '/api/proposals/3f1c9a52-0000-4000-8000-000000000004/resolve-entity/'],
      ['post', '/api/Proposals/3f1c9a52-0000-4000-8000-000000000004/Resolve-Entity'],
      ['post', '/api/ASSISTANT/CHAT/'],
      ['post', '/api/tenant-site/about/draft/'],
      ['post', '/api/Tenant-Site/About/Draft'],
      ['post', '/api/voice/tts/'],
      ['post', '/api/Voice/TTS/Batch/'],
      ['post', '/api/voice/Transcribe/'],
      ['post', '/api/Voice/Stream-Token/'],
    ] as const)('%s %s (trailing slash / letter case) holds no request transaction', async (method, path) => {
      const seen = await probe(method, path);
      expect(seen).toEqual({ connects: 0, began: false, storeAtHandler: undefined });
    });

    it.each([
      // The optional slash is one slash at the very end, nothing more.
      ['get', '/api/proposals/3f1c9a52-0000-4000-8000-000000000004/resolve-entity/'],
      ['post', '/api/proposals/3f1c9a52-0000-4000-8000-000000000004/resolve-entity//'],
      ['post', '/api/proposals/3f1c9a52-0000-4000-8000-000000000004/resolve-entity/extra/'],
      ['post', '/api/proposals/resolve-entity/'],
      ['post', '/api/voice/sessions//'],
      ['put', '/api/voice/sessions/3f1c9a52-0000-4000-8000-000000000001/'],
      ['post', '/api/voice/sessions/3f1c9a52-0000-4000-8000-000000000001/input/extra/'],
      ['post', '/api/estimates/suggest/extra/'],
      ['get', '/api/assistant/chat/'],
      ['post', '/api/assistant/chat/extra'],
      ['post', '/api/assistant/chat/extra/'],
      ['post', '/api/voice/quality/grade/extra/'],
      // Nested routers sharing a suffix inherit nothing, with or without it.
      ['post', '/api/admin/assistant/chat'],
      ['post', '/api/admin/assistant/chat/'],
      ['post', '/api/admin/voice/quality/grade'],
      ['post', '/api/admin/voice/quality/grade/'],
      ['post', '/api/admin/voice/sessions/'],
      ['post', '/api/admin/proposals/3f1c9a52-0000-4000-8000-000000000004/resolve-entity/'],
      ['post', '/api/tenant-site/about/draft//'],
      ['post', '/api/tenant-site/about/draft/extra/'],
      ['post', '/api/admin/tenant-site/about/draft/'],
      ['post', '/api/voice/tts//'],
      ['post', '/api/voice/tts/batch/extra/'],
      ['post', '/api/voice/transcribe//'],
      ['post', '/api/voice/stream-token/extra'],
    ] as const)('%s %s still opens the transaction', async (method, path) => {
      const seen = await probe(method, path);
      expect(seen.connects).toBe(1);
      expect(seen.began).toBe(true);
    });

    it.each([
      '/api/proposals/3f1c9a52-0000-4000-8000-000000000004/resolve-entity/',
      '/api/proposals/3f1c9a52-0000-4000-8000-000000000004/Resolve-Entity',
    ])('Express routes POST %s to the resolve-entity handler, and it runs with no request transaction', async (path) => {
      const { pool, calls } = makeMockPool();
      let reachedWith: string | undefined;
      let storeAtHandler: unknown = 'unset';
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as AuthenticatedRequest).auth = { userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner' };
        next();
      });
      app.use('/api', withTenantTransaction(pool));
      const proposals = express.Router();
      proposals.post('/:id/resolve-entity', (req, res) => {
        reachedWith = req.params.id;
        storeAtHandler = currentTenantContext();
        res.json({ ok: true });
      });
      app.use('/api/proposals', proposals);

      const response = await request(app).post(path).send({ candidateId: 'c1' });

      expect(response.status).toBe(200);
      expect(reachedWith).toBe('3f1c9a52-0000-4000-8000-000000000004');
      expect(storeAtHandler).toBeUndefined();
      expect((pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
      expect(calls.some((c) => /^\s*BEGIN/i.test(c.sql))).toBe(false);
    });
  });

  // A3-5 — the SSE stream bypass had the A-R4 gap: its patterns were
  // suffix-only and case-sensitive with no trailing slash. Express reaches the
  // same stream handler for `/escalations/events/` and `/Escalations/Events`,
  // and those forms held a request transaction and a pooled connection for
  // the whole life of the stream - the pool-exhaustion shape the bypass
  // exists to prevent. Suffix-only also let a nested router sharing the
  // suffix inherit the bypass.
  describe('A3-5 — SSE stream routes bypass the request transaction the way Express routes them', () => {
    const SESSION = '3f1c9a52-0000-4000-8000-000000000005';

    async function probe(method: 'get' | 'head' | 'post', path: string) {
      const { pool, calls } = makeMockPool();
      let storeAtHandler: unknown = 'unset';
      const app = express();
      app.use((req, _res, next) => {
        (req as AuthenticatedRequest).auth = { userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner' };
        next();
      });
      app.use('/api', withTenantTransaction(pool));
      app.all('/api/*splat', (_req, res) => {
        storeAtHandler = currentTenantContext();
        res.json({ ok: true });
      });
      const response = await request(app)[method](path);
      expect(response.status).toBe(200);
      return {
        connects: (pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
        began: calls.some((c) => /^\s*BEGIN/i.test(c.sql)),
        storeAtHandler,
      };
    }

    it.each([
      '/api/escalations/events',
      '/api/escalations/events/',
      '/api/Escalations/Events',
      '/api/ESCALATIONS/EVENTS/',
      '/api/dispatch/board/events',
      '/api/dispatch/board/events/',
      '/api/Dispatch/Board/Events',
      `/api/voice/sessions/${SESSION}/events`,
      `/api/voice/sessions/${SESSION}/events/`,
      `/api/Voice/Sessions/${SESSION}/EVENTS`,
    ])('GET %s holds no request transaction', async (path) => {
      const seen = await probe('get', path);
      expect(seen).toEqual({ connects: 0, began: false, storeAtHandler: undefined });
    });

    // R-1 — Express sends HEAD to a route's GET handler when the route has no
    // HEAD handler of its own, so HEAD reaches the same stream handler. Inside
    // the request transaction it held a pooled connection until the client
    // closed the socket, one per keep-alive socket.
    it.each([
      '/api/escalations/events',
      '/api/escalations/events/',
      '/api/Escalations/Events',
      '/api/dispatch/board/events',
      '/api/dispatch/board/events/',
      '/api/Dispatch/Board/Events',
      `/api/voice/sessions/${SESSION}/events`,
      `/api/voice/sessions/${SESSION}/events/`,
      `/api/Voice/Sessions/${SESSION}/EVENTS`,
    ])('HEAD %s holds no request transaction', async (path) => {
      const seen = await probe('head', path);
      expect(seen).toEqual({ connects: 0, began: false, storeAtHandler: undefined });
    });

    it.each([
      // Other methods, with or without the slash.
      ['post', '/api/escalations/events'],
      ['post', '/api/escalations/events/'],
      ['post', '/api/dispatch/board/events/'],
      ['post', `/api/voice/sessions/${SESSION}/events/`],
      // The optional slash is one slash at the very end, nothing more.
      ['get', '/api/escalations/events//'],
      ['get', '/api/escalations/events/extra'],
      ['get', '/api/dispatch/board/events/extra/'],
      ['get', `/api/voice/sessions/${SESSION}/events/extra`],
      // The session id is exactly one segment.
      ['get', '/api/voice/sessions/events'],
      ['get', '/api/voice/sessions//events'],
      ['get', `/api/voice/sessions/${SESSION}/x/events`],
      // Nested routers sharing a suffix inherit nothing, with or without it.
      ['get', '/api/admin/escalations/events'],
      ['get', '/api/admin/escalations/events/'],
      ['get', '/api/admin/dispatch/board/events'],
      ['get', '/api/reports/dispatch/board/events/'],
      ['get', `/api/admin/voice/sessions/${SESSION}/events`],
      ['get', `/api/admin/voice/sessions/${SESSION}/events/`],
      // HEAD gets the GET bypass and nothing wider.
      ['head', '/api/escalations/events//'],
      ['head', '/api/escalations/events/extra'],
      ['head', `/api/voice/sessions/${SESSION}/x/events`],
      ['head', '/api/admin/escalations/events'],
      ['head', '/api/admin/dispatch/board/events/'],
      ['head', `/api/admin/voice/sessions/${SESSION}/events`],
    ] as const)('%s %s still opens the transaction', async (method, path) => {
      const seen = await probe(method, path);
      expect(seen.connects).toBe(1);
      expect(seen.began).toBe(true);
    });

    /**
     * The production mounts: each stream's router at its /api/<name> prefix
     * with a GET handler only, as app.ts mounts them, plus a nested router
     * that shares every suffix. Requests go through Express's own routing
     * (not strict, not case-sensitive, HEAD served by the GET handler).
     */
    async function routeThroughProductionMounts(method: 'get' | 'head', path: string) {
      const { pool, calls } = makeMockPool();
      const reached: { stream: string; method: string; inTx: boolean }[] = [];
      const app = express();
      app.use((req, _res, next) => {
        (req as AuthenticatedRequest).auth = { userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner' };
        next();
      });
      app.use('/api', withTenantTransaction(pool));
      const handler = (name: string) => (req: express.Request, res: express.Response) => {
        reached.push({
          stream: req.params.id ? `${name}:${req.params.id}` : name,
          method: req.method,
          inTx: currentTenantContext() !== undefined,
        });
        res.json({ ok: true });
      };
      const escalations = express.Router();
      escalations.get('/events', handler('escalations'));
      const dispatch = express.Router();
      dispatch.get('/board/events', handler('dispatch'));
      const voice = express.Router();
      voice.get('/:id/events', handler('voice'));
      const admin = express.Router();
      admin.get('/escalations/events', handler('admin-escalations'));
      admin.get('/dispatch/board/events', handler('admin-dispatch'));
      admin.get('/voice/sessions/:id/events', handler('admin-voice'));
      app.use('/api/escalations', escalations);
      app.use('/api/dispatch', dispatch);
      app.use('/api/voice/sessions', voice);
      app.use('/api/admin', admin);

      const response = await request(app)[method](path);

      expect(response.status).toBe(200);
      return {
        reached,
        connects: (pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
        began: calls.some((c) => /^\s*BEGIN/i.test(c.sql)),
      };
    }

    it.each([
      ['escalations', '/api/escalations/events/'],
      ['escalations', '/api/Escalations/Events'],
      ['dispatch', '/api/dispatch/board/events/'],
      ['dispatch', '/api/DISPATCH/board/EVENTS'],
      ['voice', `/api/voice/sessions/${SESSION}/events/`],
      ['voice', `/api/Voice/Sessions/${SESSION}/Events`],
    ] as const)('Express routes GET %s stream %s to its handler, and it runs with no request transaction', async (stream, path) => {
      const seen = await routeThroughProductionMounts('get', path);
      expect(seen).toEqual({
        reached: [{ stream: stream === 'voice' ? `voice:${SESSION}` : stream, method: 'GET', inTx: false }],
        connects: 0,
        began: false,
      });
    });

    it.each([
      ['escalations', '/api/escalations/events'],
      ['escalations', '/api/escalations/events/'],
      ['escalations', '/api/Escalations/Events'],
      ['dispatch', '/api/dispatch/board/events'],
      ['dispatch', '/api/dispatch/board/events/'],
      ['dispatch', '/api/DISPATCH/board/EVENTS'],
      ['voice', `/api/voice/sessions/${SESSION}/events`],
      ['voice', `/api/voice/sessions/${SESSION}/events/`],
      ['voice', `/api/Voice/Sessions/${SESSION}/Events`],
    ] as const)('Express routes HEAD %s stream %s to its GET handler, and it runs with no request transaction', async (stream, path) => {
      const seen = await routeThroughProductionMounts('head', path);
      expect(seen).toEqual({
        reached: [{ stream: stream === 'voice' ? `voice:${SESSION}` : stream, method: 'HEAD', inTx: false }],
        connects: 0,
        began: false,
      });
    });

    // The real escalation stream handler flushes its headers and never ends
    // the response. Before R-1, a HEAD to it held the request transaction's
    // pooled connection until the client closed the socket.
    it('HEAD to the real escalation stream holds no pooled connection while the stream stays open', async () => {
      const { pool, calls } = makeMockPool();
      const unsubscribe = vi.fn();
      let subscribed = false;
      const app = express();
      app.use((req, _res, next) => {
        (req as AuthenticatedRequest).auth = { userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner' };
        next();
      });
      app.use('/api', withTenantTransaction(pool));
      app.use(
        '/api/escalations',
        escalationEventsRouter({
          authUserIdFromRequest: async () => 'u1',
          authTenantIdFromRequest: async () => TENANT_A,
          subscribeToVoiceEvents: () => {
            subscribed = true;
            return unsubscribe;
          },
        }),
      );
      const server = app.listen(0);
      try {
        await once(server, 'listening');
        const { port } = server.address() as AddressInfo;
        const req = httpRequest({ method: 'HEAD', host: '127.0.0.1', port, path: '/api/escalations/events' });
        req.end();
        const [res] = (await once(req, 'response')) as [IncomingMessage];

        // Headers are out and the stream is open: the handler subscribed and
        // has not ended the response.
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/event-stream/);
        expect(subscribed).toBe(true);
        expect(unsubscribe).not.toHaveBeenCalled();
        expect((pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
        expect(calls.some((c) => /^\s*BEGIN/i.test(c.sql))).toBe(false);

        req.destroy();
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });

    it.each([
      ['admin-escalations', '/api/admin/escalations/events'],
      ['admin-escalations', '/api/admin/escalations/events/'],
      ['admin-dispatch', '/api/admin/dispatch/board/events'],
      ['admin-dispatch', '/api/Admin/Dispatch/Board/Events/'],
      ['admin-voice', `/api/admin/voice/sessions/${SESSION}/events`],
      ['admin-voice', `/api/admin/voice/sessions/${SESSION}/events/`],
    ] as const)('HEAD to the nested %s router at %s still runs inside the request transaction', async (stream, path) => {
      const seen = await routeThroughProductionMounts('head', path);
      expect(seen).toEqual({
        reached: [{ stream: stream === 'admin-voice' ? `admin-voice:${SESSION}` : stream, method: 'HEAD', inTx: true }],
        connects: 1,
        began: true,
      });
    });
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

  it('#1090 — a client that errors mid-request skips COMMIT, skips after-commit hooks, and drops its listener', async () => {
    const { pool, calls, clients, getReleaseCount } = makeMockPool();

    const res = new EventEmitter() as unknown as express.Response & EventEmitter;
    (res as any).statusCode = 200;
    (res as any).locals = {};
    (res as any).headersSent = false;
    (res as any).writableEnded = false;
    (res as any).status = vi.fn(() => res);
    (res as any).json = vi.fn(() => res);

    const req = {
      auth: { userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner' },
    } as unknown as AuthenticatedRequest;

    const next = vi.fn();
    await withTenantTransaction(pool)(req, res as unknown as express.Response, next);

    // What runAfterCommit() parks on res.locals from inside the request scope.
    let hookRan = false;
    (res as any).locals.afterCommitHooks = [
      () => {
        hookRan = true;
      },
    ];

    const client = clients[0] as unknown as EventEmitter;
    // Exactly what Postgres killing this backend looks like to `pg`: an
    // 'error' event on a checked-out client, with no query in flight.
    client.emit('error', new Error('terminating connection due to idle-in-transaction timeout'));

    // The answer is deferred by one turn so the route's OWN error — when pg
    // rejected an in-flight query alongside this event — reaches the error
    // pipeline first and stays the single writer.
    expect((res as any).status).not.toHaveBeenCalled();
    await new Promise((r) => {
      setImmediate(r);
    });

    // Nothing else answered, so the middleware answers rather than let a 2xx
    // go out over writes the server already rolled back.
    expect((res as any).status).toHaveBeenCalledWith(500);

    (res as unknown as EventEmitter).emit('finish');
    await new Promise((r) => setImmediate(r));

    const sqls = calls.map((c) => c.sql);
    // COMMIT and ROLLBACK can only fail on a dead connection; the server
    // already rolled back. Neither is attempted, and the client is released.
    expect(sqls).not.toContain('COMMIT');
    expect(sqls.filter((s) => s === 'ROLLBACK')).toHaveLength(0);
    expect(getReleaseCount()).toBe(1);
    // After-commit hooks must not fire for a transaction that never committed.
    expect(hookRan).toBe(false);
    // The listener must come off the POOLED client — otherwise every request
    // through this connection adds one and they accumulate for its lifetime.
    expect(client.listenerCount('error')).toBe(0);
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

describe('#1133 — the request transaction settles BEFORE the response leaves', () => {
  const nextMacrotask = () =>
    new Promise<void>((r) => {
      setImmediate(r);
    });

  it('COMMIT has completed before the response is flushed (finish)', async () => {
    const order: string[] = [];
    const { pool } = makeMockPool({
      onCommit: async () => {
        // A COMMIT that takes real time: it resolves on a later macrotask.
        await nextMacrotask();
        order.push('COMMIT done');
      },
    });
    const app = buildApp(pool, async (_req, res) => {
      await currentTenantContext()!.client.query('INSERT INTO things (id) VALUES (11)');
      res.on('finish', () => order.push('response flushed'));
      res.status(201).json({ id: 11 });
    });

    const response = await request(app).get('/protected/echo').set('x-test-tenant', TENANT_A);
    await nextMacrotask();

    expect(response.status).toBe(201);
    expect(order).toEqual(['COMMIT done', 'response flushed']);
  });

  it('a COMMIT that fails answers 500 instead of the handler 2xx, and skips after-commit hooks', async () => {
    const { pool, calls } = makeMockPool({
      onCommit: async () => {
        throw Object.assign(new Error('deferred constraint violated at COMMIT'), { code: '23505' });
      },
    });
    let hookRan = false;
    const app = buildApp(pool, async (_req, res) => {
      await currentTenantContext()!.client.query('INSERT INTO things (id) VALUES (12)');
      runAfterCommit(res, () => {
        hookRan = true;
      });
      res.setHeader('Location', '/things/12');
      res.status(201).json({ id: 12 });
    });

    const response = await request(app).get('/protected/echo').set('x-test-tenant', TENANT_A);
    await nextMacrotask();

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: 'INTERNAL_ERROR' });
    // The handler's representation of the success must not leak onto the 500.
    expect(response.headers.location).toBeUndefined();
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(hookRan).toBe(false);
  });

  it('#1112 — a connection lost while the COMMIT is in flight answers one 500 and drops its listener', async () => {
    const { pool, clients } = makeMockPool({
      onCommit: async (client) => {
        const err = new Error('terminating connection due to administrator command');
        // What pg does: reject the in-flight query AND emit on the client.
        setImmediate(() => (client as unknown as EventEmitter).emit('error', err));
        await nextMacrotask();
        throw err;
      },
    });
    const app = buildApp(pool, async (_req, res) => {
      await currentTenantContext()!.client.query('INSERT INTO things (id) VALUES (13)');
      res.status(200).json({ ok: true });
    });

    const response = await request(app).get('/protected/echo').set('x-test-tenant', TENANT_A);
    await nextMacrotask();

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: 'INTERNAL_ERROR' });
    expect((clients[0] as unknown as EventEmitter).listenerCount('error')).toBe(0);
  });

  it('a late writer while the COMMIT is pending can neither replace nor corrupt the response', async () => {
    const { pool } = makeMockPool({ onCommit: nextMacrotask });
    let headersSentAfterRespond: boolean | undefined;
    const app = express();
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = { userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner' };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.post(
      '/api/things',
      asyncRoute(async (_req, res) => {
        await currentTenantContext()!.client.query('INSERT INTO things (id) VALUES (14)');
        res.status(201).json({ id: 14, name: 'the real response' });
        headersSentAfterRespond = res.headersSent;
        // Work after responding that throws: asyncRoute forwards it because
        // headers count as sent…
        throw new Error('post-response failure');
      }),
    );
    // …to a global handler WITHOUT a headersSent guard (app.ts on main), which
    // tries to write a second, differently-sized response.
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message, padding: 'x'.repeat(64) });
    });

    const response = await request(app).post('/api/things');
    await nextMacrotask();

    expect(headersSentAfterRespond).toBe(true);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: 14, name: 'the real response' });
  });
});

describe('runAfterCommit', () => {
  it('runs the effect AFTER the transaction COMMITs (2xx)', async () => {
    const { pool, calls } = makeMockPool();
    let hookRan = false;
    let commitSeenWhenHookRan: boolean | undefined;
    const app = buildApp(pool, async (_req, res) => {
      const ctx = currentTenantContext();
      await ctx!.client.query('INSERT INTO things (id) VALUES (9)');
      runAfterCommit(res, () => {
        hookRan = true;
        // The effect must observe COMMIT already issued on the connection.
        commitSeenWhenHookRan = calls.some((c) => /^COMMIT/i.test(c.sql));
      });
      res.json({ ok: true });
    });

    const response = await request(app).get('/protected/echo').set('x-test-tenant', TENANT_A);
    expect(response.status).toBe(200);
    await new Promise((r) => setImmediate(r));

    expect(hookRan).toBe(true);
    expect(commitSeenWhenHookRan).toBe(true);
  });

  it('does NOT run the effect when the request rolls back (4xx)', async () => {
    const { pool } = makeMockPool();
    let hookRan = false;
    const app = buildApp(pool, async (_req, res) => {
      const ctx = currentTenantContext();
      await ctx!.client.query('INSERT INTO things (id) VALUES (10)');
      runAfterCommit(res, () => {
        hookRan = true;
      });
      res.status(409).json({ error: 'CONFLICT' });
    });

    const response = await request(app).get('/protected/echo').set('x-test-tenant', TENANT_A);
    expect(response.status).toBe(409);
    await new Promise((r) => setImmediate(r));

    expect(hookRan).toBe(false);
  });

  it('runs the effect immediately when there is no request transaction (no store)', () => {
    let ran = false;
    const res = { locals: {} } as unknown as express.Response;
    runAfterCommit(res, () => {
      ran = true;
    });
    expect(ran).toBe(true);
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

/**
 * TI-01 — work that outlives the request (a `void` spawn such as the in-app
 * session summary, or route code still running after it responded) inherits
 * the request's AsyncLocalStorage entry. From the moment the transaction
 * starts settling, that entry's client is no longer the request's to use:
 * COMMIT is already queued on it, and once it is released pg-pool hands it
 * (LIFO) to the next checkout — often another tenant's transaction, under
 * that tenant's RLS identity. A closed entry must read as absent, so every
 * reuse site falls back to its own pooled transaction.
 */
describe('TI-01 — a settled request context is never reused', () => {
  class LateRepo extends PgBaseRepository {
    markCompleted(tenantId: string): Promise<unknown> {
      return this.withTenant(tenantId, (client) =>
        client.query("UPDATE ai_runs SET status = 'completed' WHERE tenant_id = $1", [tenantId]),
      );
    }
  }
  const isLateUpdate = (c: CapturedQuery): boolean => c.sql.startsWith('UPDATE ai_runs');

  function expectOwnTenantTransaction(calls: CapturedQuery[], client: PoolClient, tenantId: string): void {
    const own = calls.filter((c) => c.client === client);
    expect(own[0].sql).toBe('BEGIN');
    expect(own[1].sql).toMatch(/set_config\('app\.current_tenant_id'/i);
    expect(own[1].params[0]).toBe(tenantId);
    expect(own.map((c) => c.sql)).toContain('COMMIT');
  }

  it('a write that lands after the response opens its own tenant transaction, never the released request client', async () => {
    const { pool, calls, clients } = makeMockPool();
    const repo = new LateRepo(pool);
    let late: Promise<unknown> | undefined;
    const app = buildApp(pool, async (req, res) => {
      const tenantId = req.auth!.tenantId;
      // What `void this.runSummary(session)` does: a background write that
      // lands after the route has answered (gateway.complete → updateStatus).
      late = new Promise((r) => setTimeout(r, 5)).then(() => repo.markCompleted(tenantId));
      res.json({ ok: true });
    });

    const response = await request(app).get('/protected/echo').set('x-test-tenant', TENANT_A);
    await late;

    expect(response.status).toBe(200);
    const requestClient = clients[0];
    const update = calls.find(isLateUpdate)!;
    expect(update.client).not.toBe(requestClient);
    // Nothing reached the request client after its COMMIT.
    const onRequestClient = calls.filter((c) => c.client === requestClient).map((c) => c.sql);
    expect(onRequestClient[onRequestClient.length - 1]).toBe('COMMIT');
    expectOwnTenantTransaction(calls, update.client, TENANT_A);
  });

  it('closes when the settle STARTS: a statement issued while COMMIT is in flight is not queued behind it', async () => {
    // Between COMMIT being enqueued and release() the client still belongs to
    // the request, but a statement queued now would run AFTER the COMMIT — on
    // a bare connection, as the privileged principal with no tenant GUC.
    const { pool, calls, clients } = makeMockPool({
      onCommit: () =>
        new Promise<void>((r) => {
          setImmediate(r);
        }),
    });
    const repo = new LateRepo(pool);
    let late: Promise<unknown> | undefined;
    const app = buildApp(pool, async (req, res) => {
      res.json({ ok: true });
      // `res.json` → `res.end` has just enqueued COMMIT on the request client.
      late = repo.markCompleted(req.auth!.tenantId);
    });

    await request(app).get('/protected/echo').set('x-test-tenant', TENANT_A);
    await late;

    const update = calls.find(isLateUpdate)!;
    expect(update.client).not.toBe(clients[0]);
    expectOwnTenantTransaction(calls, update.client, TENANT_A);
  });

  it('a request rolled back by a client disconnect does not hand its client to work still running', async () => {
    const { pool, calls, clients } = makeMockPool();
    const repo = new LateRepo(pool);
    const res = new EventEmitter() as unknown as express.Response & EventEmitter;
    (res as any).statusCode = 200;
    (res as any).locals = {};
    const req = {
      auth: { userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner' },
    } as unknown as AuthenticatedRequest;

    let late: Promise<unknown> | undefined;
    const next = vi.fn(() => {
      late = new Promise((r) => setTimeout(r, 5)).then(() => repo.markCompleted(TENANT_A));
    });
    await withTenantTransaction(pool)(req, res as unknown as express.Response, next);
    (res as unknown as EventEmitter).emit('close');
    await late;

    expect(calls.filter((c) => c.client === clients[0]).map((c) => c.sql)).toContain('ROLLBACK');
    const update = calls.find(isLateUpdate)!;
    expect(update.client).not.toBe(clients[0]);
    expectOwnTenantTransaction(calls, update.client, TENANT_A);
  });

  it('BEGIN failure: the error pipeline runs with no tenant context to reuse', async () => {
    const failingClient = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN') throw new Error('connection refused mid-handshake');
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const pool = { connect: vi.fn(async () => failingClient) } as unknown as Pool;
    let ctxInErrorHandler: unknown = 'unset';
    const app = express();
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = { userId: 'u1', sessionId: 's1', tenantId: TENANT_A, role: 'owner' };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.get('/api/x', (_req, res) => res.json({ reached: true }));
    app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      ctxInErrorHandler = currentTenantContext();
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    });

    const response = await request(app).get('/api/x');

    expect(response.status).toBe(500);
    expect(ctxInErrorHandler).toBeUndefined();
    expect(failingClient.release).toHaveBeenCalledTimes(1);
  });

  describe('reuse sites treat a closed context as absent', () => {
    const closedCtx = (client: PoolClient): TenantContext => ({ client, tenantId: TENANT_A, closed: true });
    const unusableClient = {
      query: vi.fn(async () => {
        throw new Error('released client must not be queried');
      }),
    } as unknown as PoolClient;

    it('currentTenantContext hides a closed context', () => {
      const seen = tenantContextStore.run(closedCtx(unusableClient), () => currentTenantContext());
      expect(seen).toBeUndefined();
    });

    it('PgBaseRepository.withTenantTransaction opens its own connection', async () => {
      const { pool, calls, clients } = makeMockPool();
      const repo = new LateRepo(pool);
      await tenantContextStore.run(closedCtx(unusableClient), () => repo.markCompleted(TENANT_A));
      expect((pool.connect as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      expectOwnTenantTransaction(calls, clients[0], TENANT_A);
    });

    it('runAfterCommit runs the effect immediately (a hook parked now would never fire)', () => {
      let ran = false;
      const res = { locals: {} } as unknown as express.Response;
      tenantContextStore.run(closedCtx(unusableClient), () =>
        runAfterCommit(res, () => {
          ran = true;
        }),
      );
      expect(ran).toBe(true);
      expect(res.locals.afterCommitHooks).toBeUndefined();
    });

    it('withRequestSavepoint runs fn directly, with no SAVEPOINT on the released client', async () => {
      const out = await tenantContextStore.run(closedCtx(unusableClient), () =>
        withRequestSavepoint(async () => 'ran'),
      );
      expect(out).toBe('ran');
    });

    it('commitRequestTransactionAndBegin refuses rather than COMMIT/BEGIN a client it no longer owns', async () => {
      await expect(
        tenantContextStore.run(closedCtx(unusableClient), () => commitRequestTransactionAndBegin()),
      ).rejects.toThrow(/settled/);
    });

    it('commitRequestTransactionAndBegin is still a no-op outside any request transaction', async () => {
      await expect(commitRequestTransactionAndBegin()).resolves.toBeUndefined();
    });
  });

  it('structural guard: production code reads the store only through the closed-aware accessor', () => {
    // A raw `tenantContextStore.getStore()` reuses ctx.client without the
    // closed check — the exact defect above. Route every reuse through
    // `currentTenantContext()`; tenant-context.ts itself is the one owner.
    const SRC = join(__dirname, '..', '..', 'src');
    const sourceFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sourceFiles(path);
        return path.endsWith('.ts') ? [path] : [];
      });
    const offenders = sourceFiles(SRC)
      .filter((file) => relative(SRC, file) !== join('middleware', 'tenant-context.ts'))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${relative(SRC, file)}:${i + 1}` }))
          .filter(({ line }) => /tenantContextStore\.getStore\(/.test(line))
          .map(({ at }) => at),
      );
    expect(offenders).toEqual([]);
  });
});
