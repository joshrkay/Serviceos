---
title: "Work that outlives a request inherits its AsyncLocalStorage pg client — and runs inside the NEXT tenant's transaction"
date: 2026-10-18
track: bug
problem_type: database-issues
module: packages/api/src/middleware/tenant-context.ts
tags: ["postgres", "rls", "tenant-context", "async-local-storage", "connection-pool", "background-jobs", "pgbouncer"]
related:
  - docs/solutions/architecture-patterns/sse-streams-bypass-request-transaction-under-pgbouncer.md
  - docs/runbooks/scaling.md
---

## Problem

`withTenantTransaction` (and `PgTenantTransactionRunner`, `runInTenantTransaction`)
publishes its pg client on `tenantContextStore` (AsyncLocalStorage), and
`PgBaseRepository.withTenantTransaction` reuses `ctx.client` whenever the tenant
matches. AsyncLocalStorage propagates into EVERYTHING spawned inside the scope —
`void` promises, `setTimeout` callbacks, after-commit hooks — and the entry was
never invalidated. So a write that landed after the response (the in-app summary's
`ai_runs` UPDATE, seconds after a 204) reused a client that was already back in the
pool. pg-pool hands idle clients out LIFO, so the next request — any tenant's — was
usually holding it: tenant A's UPDATE ran inside tenant B's transaction under B's
RLS identity (0 rows; the run stayed `pending` forever). Between COMMIT and release
it ran on a bare connection as the privileged principal with no tenant GUC.

## Symptoms

- `ai_runs` rows stuck `pending` with no tokens/cost after in-app voice sessions.
- Supervisor snapshot cached with platform-default rules and zero counters (its
  refresh read another tenant's RLS view) — spend/auto-approval caps failed open.
- Nothing in unit tests: mocked pools never model "this client now belongs to
  someone else".

## Solution (TI-01)

1. `TenantContext.closed` — every owner sets it when the settle STARTS (before
   COMMIT/ROLLBACK is enqueued — a statement queued behind the COMMIT runs outside
   the transaction), on the disconnect-rollback path and on BEGIN failure.
2. `currentTenantContext()` is the only reader; a closed entry reads as absent, so
   repos fall back to their own `BEGIN` + `applyTenantContext` connection. A
   structural test fails on any raw `tenantContextStore.getStore()` outside
   tenant-context.ts.
3. Detach known background work at the source with `runOutsideRequestTransaction`
   (= `tenantContextStore.exit`): `void runOutsideRequestTransaction(() => work())`.

## Prevention

- Spawning DB work you will not await from request code? Wrap it in
  `runOutsideRequestTransaction`. Timers armed in a request need it too.
- Never `await runOutsideRequestTransaction(...)` on a routine request path: at
  `DB_MAX_CONNECTIONS=1` the fresh checkout waits on the request's own client.
- `closed` cannot protect a client already CAPTURED by an in-flight repo callback
  (`withTenant(t, async (client) => { await a; await client.query(b) })` straddling
  the response). Keep request-scoped callbacks short and finish them before
  responding; detach anything that does not.
- Proof pattern: `test/integration/request-context-closed-after-settle.test.ts` —
  real middleware, app pool `max=1`, `RLS_RUNTIME_ROLE=true`, tenant B holding the
  reused connection while tenant A's late write is issued or queued.
