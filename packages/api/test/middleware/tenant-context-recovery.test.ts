/**
 * CLERK-META-2026-09-27 — request-time recovery for a valid Clerk session
 * whose JWT lacks tenant_id (dropped Clerk metadata write).
 *
 * - DB knows the subject → the request is served from the DB-derived tenant
 *   and Clerk's public_metadata is backfilled (self-service recovery).
 * - Backfill failure does NOT fail the request (DB is authoritative).
 * - DB has no row → 403 with a distinct ACCOUNT_SETUP_INCOMPLETE code so the
 *   client can route to a "finish setup" screen instead of a dead end.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = '11111111-1111-1111-1111-111111111111';

const emptyResult = { rows: [], rowCount: 0 } as unknown as QueryResult;

function makeClient(): PoolClient {
  const c: any = Object.assign(new EventEmitter(), {
    query: vi.fn(async () => emptyResult),
    release: vi.fn(),
    on: EventEmitter.prototype.on,
    off: EventEmitter.prototype.off,
  });
  return c as PoolClient;
}

/** Fake pool: `query` answers the recovery lookup; `connect` opens the request tx. */
function makePool(usersRow: { id: string; tenant_id: string; role: string } | null) {
  const query = vi.fn(async (sql: string) => {
    if (/FROM users/.test(sql)) {
      return (usersRow
        ? { rows: [usersRow], rowCount: 1 }
        : emptyResult) as unknown as QueryResult;
    }
    return emptyResult;
  });
  const connect = vi.fn(async () => makeClient());
  return { pool: { query, connect } as unknown as Pool, query, connect };
}

function clerkFetchOk() {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })) as unknown as typeof fetch;
}

function buildApp(
  pool: Pool,
  auth: AuthenticatedRequest['auth'],
  opts: { clerkSecretKey?: string; clerkFetch?: typeof fetch } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).auth = auth;
    next();
  });
  app.use(
    '/protected',
    withTenantTransaction(pool, {
      clerkSecretKey: opts.clerkSecretKey ?? 'sk_test',
      clerkFetch: opts.clerkFetch ?? clerkFetchOk(),
    }),
  );
  app.get('/protected/echo', (req, res) => {
    const a = (req as AuthenticatedRequest).auth!;
    res.json({ tenantId: a.tenantId, role: a.role, canonicalUserId: a.canonicalUserId });
  });
  return app;
}

const tenantlessAuth = {
  userId: 'user_1',
  sessionId: 'sess_1',
  tenantId: undefined as unknown as string,
  role: '',
};

const ownerRow = { id: 'uuid-user-1', tenant_id: TENANT, role: 'owner' };

describe('withTenantTransaction — missing-JWT-tenant_id recovery', () => {
  it('recovers from the DB row, backfills Clerk, and serves the request', async () => {
    const { pool, query, connect } = makePool(ownerRow);
    const clerkFetch = clerkFetchOk();
    const app = buildApp(pool, { ...tenantlessAuth }, { clerkFetch });

    const r = await request(app).get('/protected/echo');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ tenantId: TENANT, role: 'owner', canonicalUserId: 'uuid-user-1' });

    // Recovery issued the users lookup…
    expect(query).toHaveBeenCalled();
    // …backfilled Clerk with the DB truth…
    expect(clerkFetch).toHaveBeenCalledOnce();
    const [url, init] = (clerkFetch as any).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.clerk.com/v1/users/user_1');
    expect(JSON.parse(init.body as string)).toEqual({
      public_metadata: { tenant_id: TENANT, role: 'owner' },
    });
    // …and the request ran under the recovered tenant (transaction opened).
    expect(connect).toHaveBeenCalled();
  });

  it('serves the request even when the Clerk backfill fails', async () => {
    const { pool } = makePool(ownerRow);
    const clerkFetch = vi.fn(async () => ({
      ok: false, status: 500, text: async () => 'boom',
    })) as unknown as typeof fetch;
    const app = buildApp(pool, { ...tenantlessAuth }, { clerkFetch });

    const r = await request(app).get('/protected/echo');
    expect(r.status).toBe(200);
    expect(r.body.tenantId).toBe(TENANT);
  });

  it('recovers without a Clerk backfill when no secret key is configured', async () => {
    const { pool } = makePool(ownerRow);
    const clerkFetch = clerkFetchOk();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = { ...tenantlessAuth };
      next();
    });
    // No clerkSecretKey and CLERK_SECRET_KEY unset in test env → backfill skipped.
    delete process.env.CLERK_SECRET_KEY;
    app.use('/protected', withTenantTransaction(pool, { clerkFetch }));
    app.get('/protected/echo', (req, res) => {
      res.json({ tenantId: (req as AuthenticatedRequest).auth!.tenantId });
    });

    const r = await request(app).get('/protected/echo');
    expect(r.status).toBe(200);
    expect(r.body.tenantId).toBe(TENANT);
    expect(clerkFetch).not.toHaveBeenCalled();
  });

  it('returns ACCOUNT_SETUP_INCOMPLETE when the DB has no row for the subject', async () => {
    const { pool, query, connect } = makePool(null);
    const app = buildApp(pool, { ...tenantlessAuth });

    const r = await request(app).get('/protected/echo');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('ACCOUNT_SETUP_INCOMPLETE');
    expect(query).toHaveBeenCalled(); // recovery was attempted
    expect(connect).not.toHaveBeenCalled(); // but no transaction was opened
  });

  it('keeps the legacy FORBIDDEN shape when there is no authenticated principal at all', async () => {
    const { pool, query, connect } = makePool(null);
    const app = express();
    app.use(express.json());
    // No auth middleware — req.auth stays undefined.
    app.use('/protected', withTenantTransaction(pool, { clerkSecretKey: 'sk_test' }));
    app.get('/protected/echo', (_req, res) => {
      res.json({ ok: true });
    });

    const r = await request(app).get('/protected/echo');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('FORBIDDEN');
    expect(query).not.toHaveBeenCalled(); // nothing to recover without a subject
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not attempt recovery when the JWT already carries tenant_id', async () => {    const { pool, query } = makePool(null);
    const app = buildApp(pool, {
      userId: 'user_1', sessionId: 'sess_1', tenantId: TENANT, role: 'owner',
    });

    const r = await request(app).get('/protected/echo');
    expect(r.status).toBe(200);
    expect(r.body.tenantId).toBe(TENANT);
    expect(query).not.toHaveBeenCalled();
  });
});
