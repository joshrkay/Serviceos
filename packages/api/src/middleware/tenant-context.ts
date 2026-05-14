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
 *  - Commit happens on `res.finish` (response fully flushed); rollback
 *    happens on `res.close` if it fires before `finish` (client
 *    disconnect, error). A boolean guard ensures release fires exactly
 *    once.
 */
import type { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import type { AuthenticatedRequest } from '../auth/clerk';

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
      // Parameterized so a malicious tenantId can't break out of the
      // SQL string. SET LOCAL is required: without it the GUC would
      // outlive the transaction and leak to the next request that
      // checked out this pooled connection.
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantId],
      );
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

    // Commit/rollback are wired to the response lifecycle via a single
    // idempotent `cleanup()` — the `cleanedUp` flag prevents a
    // COMMIT-after-ROLLBACK race that would otherwise execute a query on
    // a client that's already back in the pool.
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
    // Commit BEFORE the response is flushed to the client. `res.finish`
    // fires only after the bytes are already on the wire, so committing
    // there lets a fast client issue a follow-up request before the
    // COMMIT lands and read stale, pre-commit data — an intermittent
    // read-after-write 404. Wrapping `res.end` is the single chokepoint
    // (res.json / res.send / res.sendFile all funnel through it): the
    // COMMIT is awaited, then the original end runs, so the client never
    // sees the response until the transaction is durable.
    if (typeof res.end === 'function') {
      const originalEnd = res.end.bind(res) as (...endArgs: unknown[]) => Response;
      let ending = false;
      res.end = function patchedEnd(...endArgs: unknown[]): Response {
        if (ending || cleanedUp || released) {
          return originalEnd(...endArgs);
        }
        ending = true;
        void cleanup(true).finally(() => {
          originalEnd(...endArgs);
        });
        return res;
      } as typeof res.end;
    }
    // Safety net: a client disconnect before `res.end` is ever called
    // tears the socket down — roll back rather than leak the connection.
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

// Re-export Request for tests that want to attach req.auth.
export type { Request };
