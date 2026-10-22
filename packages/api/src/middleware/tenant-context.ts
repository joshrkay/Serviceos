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
 * happens via an AsyncLocalStorage. Repos call currentTenantContext() and
 * prefer the stored client; if absent (e.g. background workers, public routes,
 * or work that outlived the request — TI-01) they fall back to opening a
 * connection from the pool.
 *
 * Critical correctness rules:
 *  - The SET LOCAL inside the transaction is required. A plain `SET`
 *    would persist on a pooled connection across requests — a cross-tenant
 *    data exposure. SET LOCAL is automatically reset at COMMIT/ROLLBACK.
 *  - Public routes (health, /e/:viewToken, /pay/:viewToken, public
 *    payments) MUST NOT receive this middleware: they have no tenantId.
 *    app.ts is responsible for mounting it only on protected routes.
 *  - When the route ends its response (`res.end`, which res.json/send/
 *    redirect/sendStatus all go through) we settle the transaction FIRST
 *    and only then let the response out (#1133): COMMIT only when the
 *    status is < 400; a >=400 response rolls back so partial writes from
 *    a failed request never persist. A COMMIT that fails turns a success
 *    response into a 500. Rollback also happens on `res.close` if the
 *    client disconnects before the route responds; `res.finish` remains a
 *    backstop. A boolean guard ensures release fires exactly once. Routes
 *    that must commit despite a >=400 status can set
 *    `res.locals.forceCommit = true`.
 */
import type { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import type { AuthenticatedRequest } from '../auth/clerk';
import { applyTenantContext } from '../db/rls-runtime-role';
import { createLogger } from '../logging/logger';
import {
  writeClerkUserMetadata,
  describeClerkFailure,
} from '../auth/clerk-user-metadata';

const tenantContextLogger = createLogger({
  service: 'tenant-context',
  environment: process.env.NODE_ENV || 'dev',
});

export interface TenantContext {
  client: PoolClient;
  tenantId: string;
  /**
   * TI-01 — set by the owner the moment it starts settling the transaction
   * (before COMMIT/ROLLBACK is enqueued). AsyncLocalStorage keeps handing this
   * entry to anything spawned inside the scope (a `void` background write, a
   * route still running after it responded), but from then on `client` is not
   * theirs: a statement queued now runs after the COMMIT on a bare connection,
   * or — once released, since pg-pool reuses idle clients LIFO — inside the
   * next checkout's transaction, often another tenant's. Readers go through
   * `currentTenantContext()`, which treats a closed entry as absent.
   */
  closed?: boolean;
}

/**
 * CLERK-META-2026-09-27 — self-service recovery for a dropped Clerk metadata
 * write (see webhooks/routes.ts `user.created`).
 *
 * The request arrived with a valid Clerk session (verified upstream) but the
 * JWT carries no tenant_id. When the DB has a non-deleted users row for this
 * Clerk subject, that row is authoritative: return its tenant, role, and
 * canonical id, and best-effort backfill Clerk's public_metadata so the NEXT
 * session token carries tenant_id. A backfill failure does NOT fail the
 * recovery — the reconciliation sweep alerts if the metadata stays broken.
 *
 * When one Clerk subject has rows in several tenants, the oldest row wins:
 * that is the tenant bootstrapped at signup, whose metadata write this
 * recovery is healing.
 */
export interface TenantRecovery {
  tenantId: string;
  role: string;
  canonicalUserId: string;
}

export async function recoverTenantFromUsersRow(
  pool: Pool,
  clerkUserId: string | undefined,
  opts: WithTenantTransactionOptions = {},
): Promise<TenantRecovery | null> {
  if (!clerkUserId) return null;
  // System-level read (no tenant GUC set yet — there is no tenant to scope
  // to). The WHERE on clerk_user_id makes cross-tenant leakage impossible.
  const r = await pool.query<{ id: string; tenant_id: string; role: string }>(
    `SELECT id, tenant_id, role
       FROM users
      WHERE clerk_user_id = $1 AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1`,
    [clerkUserId],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];

  const secretKey = opts.clerkSecretKey ?? process.env.CLERK_SECRET_KEY;
  if (secretKey) {
    const sync = await writeClerkUserMetadata(
      { secretKey, fetchFn: opts.clerkFetch, logger: tenantContextLogger },
      clerkUserId,
      { tenant_id: row.tenant_id, role: row.role },
    );
    if (sync.ok) {
      tenantContextLogger.info('Recovered missing JWT tenant_id — backfilled Clerk metadata', {
        clerkUserId,
        tenantId: row.tenant_id,
      });
    } else {
      tenantContextLogger.warn('Recovered missing JWT tenant_id but Clerk backfill failed — request proceeds on DB truth', {
        clerkUserId,
        tenantId: row.tenant_id,
        detail: describeClerkFailure(sync),
      });
    }
  }

  return { tenantId: row.tenant_id, role: row.role, canonicalUserId: row.id };
}

export interface WithTenantTransactionOptions {
  /**
   * Overrides process.env.CLERK_SECRET_KEY for the recovery backfill.
   * Tests inject a dummy key + clerkFetch; production reads the env.
   */
  clerkSecretKey?: string;
  clerkFetch?: typeof fetch;
}

/**
 * Module-level AsyncLocalStorage. The middleware sets the value via
 * `als.run(...)` so every async hop inside `next()` sees the same store
 * entry. Consumers (PgBaseRepository.withTenant) read it with
 * `currentTenantContext()` — never a raw `getStore()`, which would reuse a
 * client whose transaction has already settled (TI-01).
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
 * Authenticated GET/HEAD endpoints whose responses are long-lived SSE event
 * streams (dispatch board / escalation / voice-session events). The
 * request-transaction bypass in `withTenantTransaction` is restricted to
 * these — NOT keyed off the client-controlled `Accept` header — so a caller
 * can't send `Accept: text/event-stream` to a mutating route to skip the
 * transaction and lose multi-write atomicity (Codex P2). Adding a new SSE
 * route? add its matcher here; until then it keeps the (safe) transactional
 * path.
 *
 * A3-5 — the same treatment as LLM_LONG_CALL_ROUTES (TI-02, A-R4): anchored at
 * both ends (the `/api` mount prefix optional, as it is stripped from
 * req.path) so a nested router sharing the suffix inherits nothing, with one
 * optional trailing slash and any letter case because that is how Express
 * routes. Otherwise `/escalations/events/` reached the same stream handler
 * INSIDE the request transaction and held a pooled connection for the whole
 * life of the stream.
 *
 * HEAD too: Express sends HEAD to a route's GET handler when the route has no
 * HEAD handler of its own, and these routes have none. The stream handler
 * flushes its headers and never ends the response, so a HEAD inside the
 * request transaction held a pooled connection until the client closed the
 * socket. HEAD reaches only the GET handlers here, never a mutating route.
 */
const SSE_STREAM_ROUTES: readonly RegExp[] = [
  /^(?:\/api)?\/escalations\/events\/?$/i,
  /^(?:\/api)?\/dispatch\/board\/events\/?$/i,
  /^(?:\/api)?\/voice\/sessions\/[^/]+\/events\/?$/i,
];

function isSseStreamRoute(req: { method: string; path: string }): boolean {
  return (
    (req.method === 'GET' || req.method === 'HEAD') &&
    SSE_STREAM_ROUTES.some((re) => re.test(req.path))
  );
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
 *
 * TI-02 — every pattern is anchored at both ends (the `/api` mount prefix
 * optional, as it is stripped from req.path) so no other router can inherit
 * the bypass by sharing a suffix. A-R4 — and every pattern matches the way
 * Express routes: one optional trailing slash (routing is not strict) and any
 * letter case (routing is not case-sensitive). Otherwise `/resolve-entity/`
 * reached the same handler INSIDE the request transaction, where the
 * handler's own runner then took a second pooled connection.
 */
const LLM_LONG_CALL_ROUTES: readonly { method: string; re: RegExp }[] = [
  { method: 'POST', re: /^(?:\/api)?\/assistant\/chat\/?$/i },
  // #1602 — the owner's call-quality grading trigger: a named call is up to
  // 13 judge calls in-request, and the sampling pass is kicked off detached
  // (outside tenantContextStore) — neither may hold a request transaction.
  { method: 'POST', re: /^(?:\/api)?\/voice\/quality\/grade\/?$/i },
  // In-app voice: a turn holds classify, drafting, entity resolution and TTS
  // synthesis (seconds each); start speaks a greeting; end kicks off the
  // summary. The entity resolver also takes its OWN pooled connection, so
  // inside a request transaction every turn held two — ~DB_MAX_CONNECTIONS
  // overlapping turns deadlocked on checkout and 500'd every tenant's /api.
  // Every write the adapter makes is a repo call with an explicit tenantId,
  // the contract the telephony voice path already runs under.
  { method: 'POST', re: /^(?:\/api)?\/voice\/sessions\/?$/i },
  { method: 'POST', re: /^(?:\/api)?\/voice\/sessions\/[^/]+\/input\/?$/i },
  { method: 'DELETE', re: /^(?:\/api)?\/voice\/sessions\/[^/]+\/?$/i },
  // AI drafts awaited in-request: a suggested reply (reads + one draft call,
  // no writes), an estimate suggestion (one draft proposal row), and an
  // onboarding conversation turn (extractor calls; its writes commit together
  // in the orchestrator's own short transaction).
  { method: 'POST', re: /^(?:\/api)?\/conversations\/[^/]+\/suggest-reply\/?$/i },
  { method: 'POST', re: /^(?:\/api)?\/estimates\/suggest\/?$/i },
  { method: 'POST', re: /^(?:\/api)?\/onboarding\/conversation\/turn\/?$/i },
  // A1 — the "which Bob?" pick re-runs the original drafting handler (an
  // invoice/estimate LLM call) before it writes. Its post-LLM writes commit
  // together in one short tenant transaction of its own (resolve-entity.ts).
  { method: 'POST', re: /^(?:\/api)?\/proposals\/[^/]+\/resolve-entity\/?$/i },
];

function isLlmLongCallRoute(req: { method: string; path: string }): boolean {
  return LLM_LONG_CALL_ROUTES.some((r) => r.method === req.method && r.re.test(req.path));
}

/**
 * Headers that describe the route's success body. Stripped when a success
 * response is replaced by a 500 because its COMMIT did not happen (#1133), so
 * the error does not carry the created resource's Location, a download's
 * Content-Disposition, or a stale ETag. Everything else (CORS, security and
 * rate-limit headers set by earlier middleware) stays.
 */
const SUCCESS_REPRESENTATION_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'content-encoding',
  'etag',
  'last-modified',
  'location',
] as const;

export function withTenantTransaction(pool: Pool, opts: WithTenantTransactionOptions = {}) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    let tenantId = req.auth?.tenantId;
    if (!tenantId) {
      // CLERK-META-2026-09-27 — recover instead of a dead 403. The session
      // is valid but the JWT lacks tenant_id (dropped metadata write); if
      // the DB knows this subject, heal the link and serve the request.
      const recovered = await recoverTenantFromUsersRow(pool, req.auth?.userId, {
        clerkSecretKey: opts.clerkSecretKey,
        clerkFetch: opts.clerkFetch,
      });
      if (recovered) {
        tenantId = recovered.tenantId;
        // Downstream gates read req.auth.tenantId, so publish the recovery.
        // Role + canonical id come from the DB row, not the stale claim.
        if (req.auth) {
          req.auth.tenantId = recovered.tenantId;
          req.auth.role = recovered.role;
          req.auth.canonicalUserId = recovered.canonicalUserId;
        }
      } else {
        // No users row for this subject. Authenticated-but-tenantless (e.g.
        // the signup webhook hasn't been processed yet) gets a distinct
        // code so the client can route to a "finish setup" screen instead of
        // a dead end; with no authenticated principal at all, preserve the
        // legacy shape (requireAuth normally 401s before this middleware).
        res.status(403).json(
          req.auth
            ? {
                error: 'ACCOUNT_SETUP_INCOMPLETE',
                message: 'Your account is not linked to a business yet. Finish setup to continue.',
              }
            : {
                error: 'FORBIDDEN',
                message: 'Tenant context required',
              },
        );
        return;
      }
    }

    // SSE / long-lived streams: a `text/event-stream` response keeps the HTTP
    // request open indefinitely (heartbeats), and `res.end` — which commits
    // and releases the transaction below — does not run until the stream
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

    // TI-01 — the one store entry this request publishes. Closed (below) the
    // moment the transaction starts settling, so nothing that outlives the
    // request can reuse `client` after it stops being ours.
    const ctx: TenantContext = { client, tenantId };

    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      client.release();
    };

    // #1090 — Postgres can terminate this backend mid-request: the
    // `idle_in_transaction_session_timeout` set below (a handler awaiting a
    // slow upstream leaves the transaction idle), an admin terminate, a
    // failover. `pg` delivers that as an 'error' EVENT on the client, never as
    // a rejected query — see db/pool.ts `guardClientErrors` — so nothing on
    // the handler's await path learns about it. Left unhandled that is a
    // SILENT FALSE SUCCESS: Postgres has already rolled the transaction back,
    // `cleanup`'s COMMIT below can only fail (and is swallowed), and a handler
    // that did its last write, awaited, and then responded 200 without another
    // query reports success over writes that no longer exist.
    //
    // So record it and answer the request ourselves while we still can. A
    // handler that later tries to respond hits `res.headersSent`, which
    // asyncRoute already guards. If the route has already ended its response,
    // `res.headersSent` reads true while that response waits on its COMMIT
    // (#1133, below), so this stands down and the settle path — whose COMMIT
    // fails on the dead connection — answers the 500 instead. If a streamed
    // body has already put a status on the wire there is nothing left to
    // correct, so we log and let `cleanup` skip the doomed COMMIT.
    let connectionLost: Error | undefined;
    const onConnectionLost = (err: Error): void => {
      if (connectionLost) return;
      connectionLost = err;
      process.stderr.write(
        `request transaction connection lost — transaction rolled back by the server: ${err.message}\n`,
      );
      setImmediate(() => {
        if (cleanedUp || released) return;
        if (res.headersSent || res.writableEnded) return;
        res.status(500).json({
          error: 'INTERNAL_ERROR',
          message: 'Database connection was terminated; the request was rolled back',
        });
      });
    };
    client.on('error', onConnectionLost);

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
      // BEGIN or SET failed — roll back (best effort) and release. The entry
      // was never published (the store is entered only after this block), but
      // close it anyway so that stays true if the order ever changes.
      ctx.closed = true;
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      client.off('error', onConnectionLost);
      releaseOnce();
      // `onConnectionLost` may already have answered this request (the
      // connection died during BEGIN/SET); handing the same request to the
      // error pipeline again would only destroy a response the caller has.
      if (res.headersSent) return;
      next(err);
      return;
    }

    // Settle (COMMIT/ROLLBACK) and release. Reached from the response
    // lifecycle below; `close` and `finish` can also fire, in either order on
    // different runtimes (and `close` MAY fire even when finish has already
    // happened). All paths flow through this single idempotent `cleanup()` —
    // the `cleanedUp` flag prevents a COMMIT-after-ROLLBACK race that would
    // otherwise execute a query on a client that's already back in the pool.
    // Resolves `true` only when the COMMIT is durable.
    let cleanedUp = false;
    const cleanup = async (commit: boolean): Promise<boolean> => {
      if (cleanedUp || released) return false;
      cleanedUp = true;
      // TI-01 — close BEFORE enqueuing COMMIT/ROLLBACK, not at release: a
      // statement queued behind the COMMIT would run outside the transaction,
      // as the connection principal with no tenant GUC.
      ctx.closed = true;
      let committed = false;
      if (connectionLost) {
        // #1090 — the server already ended this transaction (rolling it back)
        // and the client is unqueryable, so COMMIT and ROLLBACK can only
        // fail. Skip straight to release; `committed` stays false, so the
        // after-commit hooks below correctly never fire.
        client.off('error', onConnectionLost);
        releaseOnce();
        return false;
      }
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
        client.off('error', onConnectionLost);
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
      return committed;
    };

    // Commit only on a success status. `async-route` converts a thrown
    // handler error into a >=400 response, so committing unconditionally
    // would persist partial writes from a request that failed midway — e.g.
    // the first of two writes succeeding while the second throws. Roll back
    // on any >=400.
    //
    // Escape hatch: a route that intentionally writes *and* returns a client
    // error (rare — e.g. recording an attempt while returning 409) can force
    // the commit with `res.locals.forceCommit = true`.
    const shouldCommit = (): boolean => res.statusCode < 400 || res.locals?.forceCommit === true;

    // #1133 — settle the transaction BEFORE the response can reach the client.
    // Committing from `finish` raced the client: Node emits `finish` only after
    // the response has been handed to the socket, so a client could hold the
    // 201 and fire its dependent request into a transaction that cannot see
    // the row yet (observed: `POST /api/jobs → 404 Location not found` 9 ms
    // after the location's 201). Every response body leaves through `res.end`,
    // so hold that call until COMMIT/ROLLBACK has returned, then run the real
    // `end`.
    //
    // From the moment the route calls `end` its response is decided, so while
    // the settle is pending it behaves as already sent: `res.headersSent`
    // reads true (asyncRoute, `onConnectionLost` and error handlers stand down
    // on it), a second `end` is ignored, and the status and headers the route
    // set are restored before the real `end` — a late writer can neither
    // replace nor corrupt the response. A success response whose COMMIT did
    // not happen becomes a 500: reporting success over writes Postgres
    // discarded is the #1090 silent false success. (SSE streams and the
    // LLM-long-call routes never get here — they bypass the transaction above.)
    const originalEnd = res.end as unknown as (...args: unknown[]) => Response;
    let settling = false;
    const endAfterSettling = (...args: unknown[]): Response => {
      if (settling) return res;
      if (cleanedUp || released) return originalEnd.apply(res, args);
      settling = true;
      const commit = shouldCommit();
      const decided = {
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        headers: res.getHeaders(),
      };
      const ownHeadersSent = Object.getOwnPropertyDescriptor(res, 'headersSent');
      Object.defineProperty(res, 'headersSent', { configurable: true, get: () => true });

      void cleanup(commit)
        .then((committed) => {
          if (ownHeadersSent) Object.defineProperty(res, 'headersSent', ownHeadersSent);
          else delete (res as { headersSent?: boolean }).headersSent;
          settling = false;
          if (res.headersSent) {
            // A streamed body (`res.write` before `end`) already put its status
            // on the wire, so it cannot be turned into a 500 — but it must not
            // complete as a success over writes that did not commit either.
            if (commit && !committed) res.destroy();
            else originalEnd.apply(res, args);
            return;
          }
          res.statusCode = decided.statusCode;
          res.statusMessage = decided.statusMessage;
          for (const name of res.getHeaderNames()) {
            if (!(name in decided.headers)) res.removeHeader(name);
          }
          for (const [name, value] of Object.entries(decided.headers)) {
            if (value !== undefined) res.setHeader(name, value);
          }
          if (commit && !committed) {
            process.stderr.write(
              `request transaction did not commit — answering 500 instead of ${decided.statusCode}\n`,
            );
            for (const name of SUCCESS_REPRESENTATION_HEADERS) res.removeHeader(name);
            res.status(500).json({
              error: 'INTERNAL_ERROR',
              message: 'The request could not be committed; nothing was saved',
            });
            return;
          }
          originalEnd.apply(res, args);
        })
        .catch((err: unknown) => {
          process.stderr.write(
            `request transaction response could not be sent: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          res.destroy();
        });
      return res;
    };
    res.end = endAfterSettling as unknown as Response['end'];

    // Backstops. `finish` only matters if a response ever ends without going
    // through `res.end` above; `close` before the route responds is a client
    // disconnect, so roll back.
    res.once('finish', () => {
      void cleanup(shouldCommit());
    });
    res.once('close', () => {
      void cleanup(false);
    });

    // Run the rest of the request inside the AsyncLocalStorage scope so
    // every downstream `withTenant` call observes the request-scoped
    // client.
    tenantContextStore.run(ctx, () => {
      next();
    });
  };
}

/**
 * Defer a side effect until AFTER the request transaction commits.
 *
 * Under `/api` the `withTenantTransaction` middleware commits when the route
 * ends its response, so anything a route runs inline before that (e.g.
 * publishing a dispatch-board SSE revision) happens while the writes are
 * still uncommitted — a reader woken by
 * that event can refetch and cache board contents that don't yet include the
 * new row, then never get a second event. Registering the effect here runs it
 * only once COMMIT succeeds; on rollback it never fires.
 *
 * Outside a request transaction (SSE stream routes, background workers, tests —
 * no tenant-context store) there is nothing to wait for, so the effect runs
 * immediately, preserving behavior for those callers. The same holds once the
 * request transaction has started settling (TI-01): a hook parked after the
 * hooks are read would never fire, and work still running after the response
 * self-commits its writes on its own connection. So register effects BEFORE
 * responding (every caller does) — one registered after `res.end` runs at once,
 * possibly before the request's COMMIT has landed.
 */
export function runAfterCommit(res: Response, effect: () => void): void {
  if (!currentTenantContext()) {
    effect();
    return;
  }
  const hooks = (res.locals.afterCommitHooks ??= []) as Array<() => void>;
  hooks.push(effect);
}

/**
 * The tenant context whose transaction is still OPEN, or undefined — the only
 * way to read the store (repositories reach it through
 * PgBaseRepository.withTenant). A closed entry reads as absent (TI-01): its
 * client is settling or already back in the pool, so callers take the same
 * fresh-connection path they take outside any request.
 */
export function currentTenantContext(): TenantContext | undefined {
  const ctx = tenantContextStore.getStore();
  return ctx && !ctx.closed ? ctx : undefined;
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
 * self-commit). Once the request transaction has settled it throws (TI-01):
 * the client is no longer the request's, and the writes it was asked to make
 * durable already committed or rolled back with the response — the caller
 * must not go on to the irreversible step as if the reservation held.
 */
export async function commitRequestTransactionAndBegin(): Promise<void> {
  if (!tenantContextStore.getStore()) return;
  const ctx = currentTenantContext();
  if (!ctx) {
    throw new Error('The request transaction has already settled; nothing left to commit');
  }
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
 * post-COMMIT and the request client may be unusable. And for background
 * work the request does not await — a `void` spawn or a timer that outlives
 * the response (TI-01) — so it never inherits a client that will be back in
 * the pool by the time it runs. Note the pool-size caveat: at
 * DB_MAX_CONNECTIONS=1 (dev) a fresh checkout can wait on the request client,
 * so a request must never AWAIT this on its routine path — only on rare
 * failure paths; an un-awaited spawn simply waits for the release.
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
 * Outside a request transaction (background workers, in-memory tests) — or
 * once it has settled (TI-01), when `fn`'s repo calls open their own — there is
 * no shared client to poison, so `fn` runs directly. The original error is
 * always re-thrown for the caller to inspect.
 */
export async function withRequestSavepoint<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = currentTenantContext();
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
