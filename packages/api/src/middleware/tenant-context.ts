/**
 * P0-024 — Request-scoped RLS tenant context.
 *
 * Goal: when a request hits an authenticated /api route, open a single
 * Postgres transaction, set `app.current_tenant_id` LOCAL to that
 * transaction, and reuse the same client for every query the route
 * handlers issue. The previous implementation set the GUC per query on a
 * fresh connection — that still enforced RLS, but it duplicated work and
 * left a small (test-only, not pooled) risk if a non-LOCAL SET ever
 * leaked.
 *
 * Threading the per-request client into PgBaseRepository.withTenant()
 * happens via an AsyncLocalStorage. Repos call getStore() and prefer the
 * stored client; if absent (e.g. background workers, public routes) they
 * fall back to opening a connection from the pool.
 *
 * Critical correctness rules:
 *  - The SET LOCAL inside the transaction is required. A plain `SET`
 *    would persist on a pooled connection across requests — a cross-tenant
 *    data exposure. SET LOCAL is automatically reset at COMMIT/ROLLBACK.
 *  - Public routes (health, /e/:viewToken, /pay/:viewToken, public
 *    payments) MUST NOT receive this middleware: they have no tenantId.
 *    app.ts is responsible for mounting it only on protected routes.
 *  - On `res.finish` (response fully flushed) we COMMIT only when the
 *    status is < 400; a >=400 response rolls back so partial writes from
 *    a failed request never persist. Rollback also happens on `res.close`
 *    if it fires before `finish` (client disconnect). A boolean guard
 *    ensures release fires exactly once. Routes that must commit despite
 *    a >=400 status can set `res.locals.forceCommit = true`.
 */
import type { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import type { AuthenticatedRequest } from '../auth/clerk';
import { applyTenantContext } from '../db/rls-runtime-role';

export interface TenantContext {
  client: PoolClient;
  tenantId: string;
}

/**
 * Module-level AsyncLocalStorage. The middleware sets the value via
 * `als.run(...)` so every async hop inside `next()` sees the same store
 * entry. Consumers (PgBaseRepository.withTenant) read it with
 * `tenantContextStore.getStore()`.
 */
export const tenantContextStore = new AsyncLocalStorage<TenantContext>();

/**
 * Express middleware: opens a transaction, sets the tenant GUC LOCAL to
 * that transaction, and stashes the PoolClient on AsyncLocalStorage so
 * downstream repository calls reuse the same connection.
 *
 * Returns 403 when no tenantId is present on the authenticated request —
 * this is a programmer error (the middleware should only be mounted
 * after auth on routes that require a tenant), but we'd rather emit 403
 * than crash the database with a missing GUC.
 */
export function withTenantTransaction(pool: Pool) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Tenant context required',
      });
      return;
    }

    // SSE / long-lived streams: a `text/event-stream` response keeps the HTTP
    // request open indefinitely (heartbeats), and `res.finish` — which commits
    // and releases the transaction below — does not fire until the stream
    // closes. Holding a BEGIN open that long pins one pooled connection, and
    // under PgBouncer transaction pooling one Postgres server backend, for the
    // entire stream; ~`default_pool_size` idle dashboards would exhaust the
    // pool and stall normal /api requests. The streaming routes (dispatch
    // board / escalation / voice-session event streams) only subscribe to
    // in-process event buses and read `req.auth`, so they need no request
    // transaction; any incidental DB read self-manages a short `withTenant`
    // transaction (pooling-safe since U2b-2) using the tenantId its caller
    // passes explicitly — the request store only supplies connection reuse,
    // never the tenant scope. Enforce tenant presence (above) but skip the
    // long-held transaction. The web SSE hooks all send
    // `Accept: text/event-stream`. (Codex P1, PR #628.)
    if ((req.headers?.accept ?? '').includes('text/event-stream')) {
      next();
      return;
    }

    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      next(err);
      return;
    }

    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      client.release();
    };

    try {
      await client.query('BEGIN');
      // Parameterized so a malicious tenantId can't break out of the SQL
      // string. SET LOCAL (config + RLS runtime role, when enabled) is
      // required: without it the GUC/role would outlive the transaction and
      // leak to the next request that checked out this pooled connection.
      await applyTenantContext(client, tenantId, { transactional: true });
    } catch (err) {
      // BEGIN or SET failed — roll back (best effort) and release.
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      releaseOnce();
      next(err);
      return;
    }

    // Wire commit/rollback to the response lifecycle. `finish` fires
    // after the last byte of the response is flushed; `close` fires
    // when the underlying connection is torn down. They can fire in
    // either order on different runtimes (and `close` MAY fire even
    // when finish has already happened). Both flow through a single
    // `cleanup()` that's idempotent — the `cleanedUp` flag prevents
    // a COMMIT-after-ROLLBACK race that would otherwise execute a
    // query on a client that's already back in the pool.
    let cleanedUp = false;
    const cleanup = async (commit: boolean) => {
      if (cleanedUp || released) return;
      cleanedUp = true;
      try {
        await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      } catch {
        // If commit fails, fall back to rollback so the connection is
        // returned to the pool in a clean state. Swallow rollback
        // errors — there is nothing actionable from this layer.
        if (commit) {
          try {
            await client.query('ROLLBACK');
          } catch {
            /* ignore */
          }
        }
      } finally {
        releaseOnce();
      }
    };
    res.once('finish', () => {
      // Commit only on a success status. `async-route` converts a thrown
      // handler error into a >=400 response (which still fires `finish`),
      // so committing unconditionally here would persist partial writes
      // from a request that failed midway — e.g. the first of two writes
      // succeeding while the second throws. Roll back on any >=400.
      //
      // Escape hatch: a route that intentionally writes *and* returns a
      // client error (rare — e.g. recording an attempt while returning
      // 409) can force the commit with `res.locals.forceCommit = true`.
      const commit = res.statusCode < 400 || res.locals?.forceCommit === true;
      void cleanup(commit);
    });
    res.once('close', () => {
      void cleanup(false);
    });

    // Run the rest of the request inside the AsyncLocalStorage scope so
    // every downstream `withTenant` call observes the request-scoped
    // client.
    tenantContextStore.run({ client, tenantId }, () => {
      next();
    });
  };
}

/**
 * Test-only helper: synchronously read the current store. Production
 * code should call this through PgBaseRepository.withTenant.
 */
export function currentTenantContext(): TenantContext | undefined {
  return tenantContextStore.getStore();
}

let requestSavepointSeq = 0;

/**
 * Run `fn` inside a SAVEPOINT when executing within a request-scoped
 * transaction (the `/api` `withTenantTransaction` middleware put a shared
 * client in the store). A statement that throws — e.g. a 23505 the caller
 * intends to catch and skip past — then rolls back only `fn` and leaves the
 * surrounding transaction usable, instead of aborting the whole request
 * transaction (which would silently roll back unrelated writes at COMMIT).
 * Outside a request transaction (background workers, in-memory tests) there is
 * no shared client to poison, so `fn` runs directly. The original error is
 * always re-thrown for the caller to inspect.
 */
export async function withRequestSavepoint<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = tenantContextStore.getStore();
  if (!ctx) return fn();
  const { client } = ctx;
  const name = `sp_req_${(requestSavepointSeq += 1)}`;
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`).catch(() => undefined);
    throw err;
  }
}

// Re-export Request for tests that want to attach req.auth.
export type { Request };
