---
title: "SSE streams must bypass the request-scoped DB transaction (route allowlist, not Accept header) under PgBouncer"
date: 2026-06-29
track: knowledge
problem_type: architecture-patterns
module: packages/api/src/middleware/tenant-context.ts
tags: ["pgbouncer", "sse", "rls", "connection-pool", "tenant-context", "scaling"]
related: ["docs/solutions/architecture-patterns/rls-exempt-tables-read-before-tenant-context.md", "docs/runbooks/scaling.md"]
---

## Context

The authenticated `/api` surface is blanketed by `withTenantTransaction`
(`app.use('/api', withTenantTransaction(pool))`): it opens one Postgres
transaction per request, sets the tenant GUC `SET LOCAL`, and commits/releases
on `res.finish`. This is correct and pooling-safe for normal request/response —
the transaction is short, so PgBouncer (transaction mode) can multiplex N
replica pools onto a bounded Postgres `max_connections`.

But several routes are **Server-Sent Events** streams (dispatch board /
escalation / voice-session events): `Content-Type: text/event-stream`, kept open
indefinitely with heartbeats. `res.finish` does not fire until the stream
closes, so the request transaction — and the pooled connection — stays open for
the entire stream. Under PgBouncer that pins one Postgres **server backend** per
open stream; ~`default_pool_size` (e.g. 25) idle dashboards exhaust the pool and
stall all normal `/api` requests. (Found by review on PR #628.)

## Guidance

A request-scoped transaction middleware must **not** wrap long-lived streaming
responses. Skip the transaction for SSE endpoints — they only subscribe to
in-process event buses and read `req.auth`; any incidental DB read self-manages
a short `withTenant` transaction (which is itself pooling-safe).

Gate the skip on an **explicit allowlist of the SSE routes**, restricted to
`GET`, anchored on the path — **not** on the client-supplied `Accept` header:

```ts
// suffix-anchored so it matches whether or not the `/api` mount prefix was
// stripped from req.path by app.use('/api', ...)
const SSE_STREAM_ROUTES: readonly RegExp[] = [
  /\/escalations\/events$/,
  /\/dispatch\/board\/events$/,
  /\/voice\/sessions\/[^/]+\/events$/,
];
function isSseStreamRoute(req: { method: string; path: string }): boolean {
  return req.method === 'GET' && SSE_STREAM_ROUTES.some((re) => re.test(req.path));
}
// inside withTenantTransaction, AFTER the tenant-presence (403) guard:
if (isSseStreamRoute(req)) { next(); return; }
```

Tenant presence is still enforced (the 403 guard runs first); only the
long-held transaction is skipped. Adding a new SSE route = add a matcher; until
then it keeps the (safe) transactional path.

## Why This Matters

- **Pool exhaustion is silent and topology-dependent.** With direct Postgres,
  an open SSE transaction "only" holds one app-pool slot (`DB_MAX_CONNECTIONS`);
  under PgBouncer the same code pins a scarce server backend, so the bug doesn't
  appear until the pooled multi-replica topology is live (Phase 5), exactly when
  it's hardest to debug.
- **The request store supplies connection reuse, never the tenant scope.**
  `PgBaseRepository.withTenant(tenantId, fn)` always gets the tenantId from its
  caller; the AsyncLocalStorage store only lets it reuse the request client.
  Skipping the middleware therefore loses no tenant isolation — downstream reads
  open their own short `SET LOCAL` transaction.

## When to Apply

Any time a route-scoped transaction (or any per-request connection-holding)
middleware sits in front of a long-lived response: SSE, chunked streaming,
WebSocket upgrade handlers, hanging-GET long-poll. The longer the response, the
longer the backend is pinned.

## Examples

### What didn't work — keying the bypass on the `Accept` header

The first fix skipped the transaction when
`req.headers.accept?.includes('text/event-stream')`. It worked for the
dashboards but opened a **security/atomicity hole**: the header is
client-controlled, so any authenticated caller could send
`Accept: text/event-stream` to a *mutating* route (e.g. `POST /api/jobs`) and
skip the request transaction — making multi-write operations (job write + audit
event, in separate repo calls) commit independently, so a second-write failure
returns an error without rolling back the first. (Caught as a follow-up P2.)

**Lesson:** never let a client-supplied header decide whether server work runs
in a transaction. Authority for "is this a stream" belongs to the route table,
not the request headers. The allowlist + `GET` gate closes it — a mutating route
can never bypass, regardless of what `Accept` it sends.

### Verifying

Mock the pool's `connect`/`query`; assert an allowlisted SSE `GET` issues
**zero** `pool.connect()` and **no** `BEGIN`, while a `POST` with
`Accept: text/event-stream` still issues a `BEGIN` (transaction NOT skipped).
See `packages/api/test/middleware/tenant-context.test.ts`.
