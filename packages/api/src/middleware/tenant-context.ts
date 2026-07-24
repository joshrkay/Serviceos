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
/**
 * Authenticated GET endpoints whose responses are long-lived SSE event streams
 * (dispatch board / escalation / voice-session events). The request-transaction
 * bypass in `withTenantTransaction` is restricted to these — NOT keyed off the
 * client-controlled `Accept` header — so a caller can't send
 * `Accept: text/event-stream` to a mutating route to skip the transaction and
 * lose multi-write atomicity (Codex P2). Suffix-anchored so they match whether
 * or not the `/api` mount prefix has been stripped from `req.path`. Adding a
 * new SSE route? add its matcher here; until then it keeps the (safe)
 * transactional path.
 */
const SSE_STREAM_ROUTES: readonly RegExp[] = [
  /\/escalations\/events$/,
  /\/dispatch\/board\/events$/,
  /\/voice\/sessions\/[^/]+\/events$/,
];

function isSseStreamRoute(req: { method: string; path: string }): boolean {
  return req.method === 'GET' && SSE_STREAM_ROUTES.some((re) => re.test(req.path));
}

/**
 * Per-request-transaction timeouts, applied via `set_config(..., is_local)`
 * so they reset at COMMIT/ROLLBACK — the only pooling-safe way to set these
 * under PgBouncer transaction mode (startup-packet GUCs and session SETs are
 * not). Without them a wedged query (statement_timeout) or a handler
 * awaiting a slow upstream while the transaction sits idle
 * (idle_in_transaction_session_timeout) pins this pooled connection — and in
 * prod a scarce PgBouncer server backend — indefinitely; enough of those
 * exhaust the pool and stall all of /api.
 */
function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const REQUEST_STATEMENT_TIMEOUT_MS = positiveIntEnv('DB_REQUEST_STATEMENT_TIMEOUT_MS', 30_000);
const REQUEST_IDLE_TX_TIMEOUT_MS = positiveIntEnv('DB_REQUEST_IDLE_TX_TIMEOUT_MS', 60_000);

/**
 * UC-2 — routes whose handlers await long LLM/gateway calls and must not hold
 * the request transaction for their whole life (each concurrent slow request
 * would pin a pooled connection — and under PgBouncer a server backend — for
 * the full call; ~`default_pool_size` slow chats stall all of /api). Every DB
 * touch on these routes goes through repos whose standalone path opens its own
 * short SET LOCAL transaction (U2b-2), with the tenantId passed explicitly —
 * the same shape the voice-action-router worker uses, where these handlers
 * already run with no request transaction. Method+path anchored (never a
 * client-controlled header), same rationale as SSE_STREAM_ROUTES. Trade-off,
 * accepted: multi-write atomicity across a single request is lost on these
 * routes — each proposal/conversation write commits independently, which is
 * already the contract on the voice path.
 */
const LLM_LONG_CALL_ROUTES: readonly { method: string; re: RegExp }[] = [
  { method: 'POST', re: /\/assistant\/chat$/ },
];

function isLlmLongCallRoute(req: { method: string; path: string }): boolean {
  return LLM_LONG_CALL_ROUTES.some((r) => r.method === req.method && r.re.test(req.path));
}

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
    // pool and stall normal /api requests. The streaming endpoints only
    // subscribe to in-process event buses and read `req.auth`, so they need no
    // request transaction; any incidental DB read self-manages a short,
    // pooling-safe `withTenant` transaction (U2b-2) using the tenantId its
    // caller passes explicitly — the request store only supplies connection
    // reuse, never the tenant scope. Enforce tenant presence (above) but skip
    // the long-held transaction for the explicit SSE allowlist (NOT a generic
    // Accept header — see SSE_STREAM_ROUTES). (Codex P1/P2, PR #628.)
    if (isSseStreamRoute(req) || isLlmLongCallRoute(req)) {
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
      await client.query(
        "SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)",
        [String(REQUEST_STATEMENT_TIMEOUT_MS), String(REQUEST_IDLE_TX_TIMEOUT_MS)],
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
      let committed = false;
      try {
        await client.query(commit ? 'COMMIT' : 'ROLLBACK');
        committed = commit;
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
      // Run after-commit hooks ONLY once the writes are durable. A rolled-back
      // (or failed-then-rolled-back) request never fires them, so side effects
      // like dispatch-board SSE notifications can't publish a revision for data
      // a reader would then fetch before it exists. Failure-isolated per hook.
      if (committed) {
        const hooks = res.locals?.afterCommitHooks as Array<() => void> | undefined;
        if (hooks) {
          for (const hook of hooks) {
            try {
              hook();
            } catch {
              /* a broken hook must not wedge cleanup */
            }
          }
        }
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
 * Defer a side effect until AFTER the request transaction commits.
 *
 * Under `/api` the `withTenantTransaction` middleware commits on `res.finish`,
 * so anything a route runs inline (e.g. publishing a dispatch-board SSE
 * revision) happens while the writes are still uncommitted — a reader woken by
 * that event can refetch and cache board contents that don't yet include the
 * new row, then never get a second event. Registering the effect here runs it
 * only once COMMIT succeeds; on rollback it never fires.
 *
 * Outside a request transaction (SSE stream routes, background workers, tests —
 * no tenant-context store) there is nothing to wait for, so the effect runs
 * immediately, preserving behavior for those callers.
 */
export function runAfterCommit(res: Response, effect: () => void): void {
  if (!tenantContextStore.getStore()) {
    effect();
    return;
  }
  const hooks = (res.locals.afterCommitHooks ??= []) as Array<() => void>;
  hooks.push(effect);
}

/**
 * Test-only helper: synchronously read the current store. Production
 * code should call this through PgBaseRepository.withTenant.
 */
export function currentTenantContext(): TenantContext | undefined {
  return tenantContextStore.getStore();
}

/**
 * Durably COMMIT everything the request has written so far, then open a
 * fresh transaction on the same request-scoped client (re-applying the
 * tenant GUC / RLS role and the per-transaction timeouts, all SET LOCAL).
 *
 * For routes that must make a local reservation durable BEFORE an
 * irreversible external call (e.g. account deletion's soft-delete stamp
 * before the Clerk user delete): if the process dies or the response-time
 * COMMIT fails after the external call, the reservation still holds —
 * without this, the stamp would roll back and the externally-deleted user
 * would transiently appear live, undermining guards that counted them.
 *
 * The middleware's response-time COMMIT/ROLLBACK then applies to the NEW
 * transaction only. Note the trade-off: writes made before this call are
 * permanent even if the request later fails — callers own that semantic
 * (pair a failure path with an explicit compensating write and
 * `res.locals.forceCommit` when responding >=400). Outside a request
 * transaction this is a no-op (standalone repo calls already
 * self-commit).
 */
export async function commitRequestTransactionAndBegin(): Promise<void> {
  const ctx = tenantContextStore.getStore();
  if (!ctx) return;
  const { client, tenantId } = ctx;
  await client.query('COMMIT');
  await client.query('BEGIN');
  await applyTenantContext(client, tenantId, { transactional: true });
  await client.query(
    "SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)",
    [String(REQUEST_STATEMENT_TIMEOUT_MS), String(REQUEST_IDLE_TX_TIMEOUT_MS)],
  );
}

/**
 * Run `fn` OUTSIDE the request-scoped transaction context: repository calls
 * inside it check out a fresh pool connection and self-commit, even when the
 * caller is mid-request. For compensation writes that must not depend on the
 * request client — e.g. after `commitRequestTransactionAndBegin` fails
 * post-COMMIT and the request client may be unusable. Note the pool-size
 * caveat: at DB_MAX_CONNECTIONS=1 (dev) a fresh checkout can wait on the
 * request client — reserve this for rare failure paths, never routine flow.
 */
export async function runOutsideRequestTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContextStore.exit(fn);
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
