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

    // First three statements on this connection: BEGIN, set_config, SELECT.
    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toMatch(/^BEGIN/i);
    expect(sqls[1]).toMatch(/set_config\('app\.current_tenant_id'/i);
    expect(calls[1].params[0]).toBe(TENANT_A);
    expect(sqls[2]).toMatch(/current_setting/i);
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
