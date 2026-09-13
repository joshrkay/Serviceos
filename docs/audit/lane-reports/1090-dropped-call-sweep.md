# 1090 — dropped-call sweep / idle-in-transaction crash

Lane: Opus implementer, branch `fix/dropped-call-sweep-idle-txn` off `origin/main`
(`2a68465`). Issue: [#1090](https://github.com/joshrkay/Serviceos/issues/1090).

---

## Summary

The reported crash is real and reproduces at the runtime surface. The
**mechanism is not the one the issue hypothesised**: the dropped-call sweep
does **not** hold a transaction across the send-batch work — it already reads
the batch, commits, and only then sends. What actually happens is that a
connection Postgres kills **while it is checked out of the pool** never
reaches any `try/catch`, because `pg` delivers it as an EventEmitter `'error'`
event rather than as a rejected query promise, and `pg-pool` removes the only
`'error'` listener for exactly the checked-out lifetime. Node re-throws it as
`uncaughtException`, and `index.ts` treats that as FATAL and drains the
process. The sweep log lines in the incident (`send-batch fetch failed`,
`Cannot use a pool after calling end on the pool`, per-tenant `call_me_back
sweep: tenant failed`) are the *aftermath* — the crash handler closes the pool
while sweeps are still mid-flight.

Fixed at those two layers: checked-out clients now carry an `'error'`
listener, and shutdown drains in-flight sweeps before `pool.end()`.

---

## Mechanism, with evidence

### 1. Which transaction is held open across which network call — *not the sweep's*

The issue's shape ("the dropped-call sweep holds a transaction open while it
does the send-batch work") does not hold at any line:

- `packages/api/src/workers/dropped-call-worker.ts:143-170` — Phase 2 awaits
  `findDueTenantIds`, then the per-tenant flag checks, then
  `findDueForTenants` (`:164`). Each is a separate repository call.
- `packages/api/src/sms/recovery/scheduler.ts:479-518` —
  `findDueTenantIds` / `findDueForTenants` run through
  `PgBaseRepository.withCrossTenantSweep`.
- `packages/api/src/db/pg-base.ts:115-141` — that helper is
  `BEGIN` → `applyCrossTenantRole` → **one** `SELECT` → `COMMIT`, with no
  `await` of anything non-DB in between. The transaction cannot be idle for
  more than a statement round-trip.
- `packages/api/src/workers/dropped-call-worker.ts:172-187` — the compose /
  send / thread work (`handleDroppedCallRecovery`, and inside it
  `dropped-call-handler.ts` `deps.compose` and `deps.sendSms`) runs in the row
  loop, **after** Phase 2's transaction has committed. No transaction is open
  across the LLM or Twilio call.

Confirmed empirically, not just by reading. With the whole sweep wired for
real (3 tenants, 3 due rows, `dropped_call_recovery` platform flag ON so the
send path actually executed) against a real Postgres with
`ALTER DATABASE serviceos_test SET idle_in_transaction_session_timeout = '5s'`
— i.e. the managed-provider condition the issue worries about — a
`pg_stat_activity` sampler polling every 2s over the full run recorded **zero**
sessions in `idle in transaction` for longer than a statement, and the boot
logged zero FATAL lines:

```
{"message":"dropped-call recovery SMS sent", "tenantId":"9289bf33-…", "smsMessageSid":"mem-sms-1"}
{"message":"dropped-call recovery SMS sent", "tenantId":"1f9c0558-…", "smsMessageSid":"mem-sms-2"}
{"message":"dropped-call recovery SMS sent", "tenantId":"bebba865-…", "smsMessageSid":"mem-sms-3"}
{"message":"dropped-call sweep completed","due":3,"sent":3,"suppressed":0,"skipped":0,"expired":0,"failed":0}
--- FATAL lines: 0
--- pg_stat_activity samples in 'idle in transaction' beyond one statement: 0
```

The transaction that *is* held idle across a non-DB await is the **request**
transaction. `packages/api/src/middleware/tenant-context.ts:176-179` is the
only place in the repository that sets `idle_in_transaction_session_timeout`
at all (60s by default, `SET LOCAL` on every `/api` request transaction,
`DB_REQUEST_IDLE_TX_TIMEOUT_MS`), and a bare `pgvector/pgvector:pg16`
testcontainer leaves the server-side value at its default `0`. So on the gate
machine, the session Postgres terminated with *that* message can only have
been a request transaction — a handler awaiting a slow upstream while its
transaction sat idle, which is precisely the case the middleware's own comment
(`:81-90`) describes. Managed Postgres providers set the same GUC server-side,
which is what makes this a production risk and not a test artifact.

The sweep still has a related exposure worth naming even though it is not this
crash: `app.ts` `runAsLeader` (`:2267-2300`) holds a **pooled connection**
(session advisory lock) across the entire sweep, compose/send included. It is
not inside a transaction, so `idle_in_transaction_session_timeout` cannot kill
it — but an admin terminate, a failover, or a provider idle-session timeout
can, and before this fix that connection's death was the same
`uncaughtException`. The second test below pins exactly that shape.

### 2. Why the killed connection escapes to `uncaughtException` instead of the sweep's catch

Because it is never delivered to a promise. Three library facts, in order:

1. `node_modules/pg/lib/client.js:397-405` — `_handleErrorMessage` routes a
   backend `ErrorResponse` to the **active query**. A transaction that is idle
   has no active query, so it falls through to `_handleErrorEvent`.
2. `node_modules/pg/lib/client.js:387-393` — `_handleErrorEvent` does
   `this.emit('error', err)`. Then the socket closes and
   `client.js:179-198` emits a **second** one,
   `Connection terminated unexpectedly` — which is why the incident log shows
   the two FATALs paired (×2 and ×2).
3. `node_modules/pg-pool/index.js:344` — on checkout,
   `client.removeListener('error', idleListener)`; it is only re-attached on
   release (`:385`). So for the whole time a repository or worker holds the
   client, `'error'` has **no** listener.

An `'error'` event with no listener is re-thrown by Node as an uncaught
exception, and `packages/api/src/index.ts:86-89` prints `FATAL
uncaughtException:` and calls `gracefulShutdown(…, 1)`. No `try/catch` around
the sweep's `await` could ever have caught it. `packages/api/src/db/pool.ts`'s
existing `pool.on('error')` handler does not help either: that one only fires
for clients sitting **idle in the pool**, which are exactly the clients that
still have `idleListener` attached.

The RED test reproduced the incident's two messages verbatim, in order — see
RED output below.

### 3. Why `Cannot use a pool after calling end on the pool` follows

Both of the issue's candidate explanations are the same event: the crash
handler ends the pool while a sweep is mid-flight.

`index.ts:86-89` → `gracefulShutdown` → `app.gracefulDrain` →
`app.ts` `runShutdown`: it sets `shuttingDown` and clears every interval
(`:7088`), which stops the **next** tick, then closes Redis, then calls
`pool.end()`. Nothing waits for the tick that is **already running**. A sweep
sitting in a compose/send round-trip at that moment keeps going, and its next
repository call does `pool.connect()` on an ended pool — one failure per
remaining row/tenant. That is:

- `dropped-call sweep: send-batch fetch failed` — worker `:167`, the Phase 2
  catch.
- `call_me_back sweep: tenant failed`, ×3, one per tenant —
  `packages/api/src/workers/call-me-back-worker.ts:114-121`, the per-tenant
  catch inside a loop that awaits a send per tenant.

It is also a correctness problem, not only noise: a recovery SMS can go out to
a customer and then fail to be stamped `sent`, so the next boot re-sends it.

---

## The exact change

| File | Change |
| --- | --- |
| `packages/api/src/db/pool.ts:1-42, 82, 117` | New `guardClientErrors(pool, label)`: one permanent `'error'` listener per client, attached on the pool's `'connect'` event (emitted once per newly created client), applied to both `createPool()` and `createDirectPool()`. The event now always has a handler, whichever side of a checkout it arrives on. Nothing else changes — `pg` still marks the client unqueryable, still rejects in-flight queries, and still discards the client on release (`pg-pool` `_release` removes a client whose `_queryable` is false), so callers keep getting ordinary, catchable errors. |
| `packages/api/src/workers/inflight-sweeps.ts` (new) | `createInflightSweeps()` — `track(promise)` (returns the same promise, untouched), `size()`, and a bounded `drain(timeoutMs)` that also waits on work registered *during* the drain and reports `{ drained, remaining }`. |
| `packages/api/src/app.ts:230, 2265-2269, 7145-7155` | `runAsLeader` registers every leader-gated tick; `runShutdown` drains them (bounded by `SWEEP_DRAIN_TIMEOUT_MS`, default 5s) **before** `pool.end()`, and warns and proceeds if a sweep is wedged, so shutdown stays inside `index.ts`'s force-exit backstop. |

Deliberately **not** changed: the sweep's batch/send ordering (already correct
— §1), and the sweep's `try/catch` structure (already catches everything a
promise can deliver; the escape was never on that path — §2, and test 3 below
passed RED as well as GREEN, so it is kept as a regression pin).

No changes to telephony auth, money, pricing, RLS or migrations.

### Follow-on from review: the killed request transaction must not report success

A review finding on the PR (xhawk-ai, High/Correctness, anchored on the new
`pool.ts` guard) pointed at what the guard leaves behind, and it is right —
verified before fixing, with the RED below.

`withTenantTransaction` commits on `res.finish` and, when the COMMIT fails,
falls back to ROLLBACK and swallows both (`middleware/tenant-context.ts`
cleanup). That is correct for a constraint violation the handler already turned
into a >=400. It is wrong when Postgres terminated the backend: the handler can
do its last write, await a slow upstream past
`idle_in_transaction_session_timeout`, then send a **200** with no further query
— the caller reads success while Postgres has already rolled the writes back,
nothing is logged, and the after-commit hooks silently never run. Before the
pool guard this hid behind the process crash; now that a killed connection is
survivable, the silent false success is what is left, so it belongs here.

| File | Change |
| --- | --- |
| `packages/api/src/middleware/tenant-context.ts:169-200, 213-232, 245-258` | A scoped `client.on('error')` records the loss, logs it (it was entirely silent), and — while nothing has been sent yet — answers the request 500 instead of letting the handler's 2xx go out over discarded writes. `cleanup` then skips the COMMIT/ROLLBACK that can only fail, leaves `committed` false so after-commit hooks never fire, and removes the listener on every exit path (a pooled client would otherwise accumulate one per request). |
| `packages/api/test/middleware/tenant-context.test.ts` | The mock `PoolClient` is now an `EventEmitter`, which the real one is — the old mock had only `query`/`release`, so it could not have observed this class of failure at all (the CLAUDE.md rule about mocked-DB tests, in miniature). Plus a unit case pinning the skipped COMMIT, the un-fired hooks, and the removed listener. |

Not taken from the suggestion: destroying a response whose headers are already
committed. That window is microseconds wide (a finished response has already
run `cleanup` and dropped the listener, so it only covers a partially streamed
body), and tearing down an in-flight response changes the request lifecycle for
every `/api` route — a call for the repo owner, not a drive-by in this PR. That
case now logs.

---

## Tests

`packages/api/test/integration/dropped-call-sweep-idle-txn.test.ts` (new, real
Postgres) and `packages/api/test/workers/inflight-sweeps.test.ts` (new, unit).
Both integration tests that were RED assert on `uncaughtException` /
`unhandledRejection` listeners attached inside the test, so "the process stays
up" is an assertion rather than an inference.

### RED (test committed first, `0b7d434`)

```
$ cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
    --reporter=verbose test/integration/dropped-call-sweep-idle-txn.test.ts

 RUN  v4.1.10 /home/user/Serviceos/packages/api

pg pool background error: terminating connection due to administrator command
 × …  > a checked-out connection killed by idle-in-transaction timeout never reaches uncaughtException 1631ms
   → expected [ { …(2) }, { …(2) } ] to deeply equal []
 × …  > the sweep completes its batch when a connection it holds across the send is terminated 580ms
   → expected [ { …(2) }, { …(2) } ] to deeply equal []
 ✓ …  > reports the failure per tenant (and throws nothing) when the pool is ended mid-sweep 178ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  … > a checked-out connection killed by idle-in-transaction timeout never reaches uncaughtException
AssertionError: expected [ { …(2) }, { …(2) } ] to deeply equal []

- Expected
+ Received

- []
+ [
+   {
+     "kind": "uncaughtException",
+     "message": "terminating connection due to idle-in-transaction timeout",
+   },
+   {
+     "kind": "uncaughtException",
+     "message": "Connection terminated unexpectedly",
+   },
+ ]

 FAIL  … > the sweep completes its batch when a connection it holds across the send is terminated
AssertionError: expected [ { …(2) }, { …(2) } ] to deeply equal []

- Expected
+ Received

- []
+ [
+   {
+     "kind": "uncaughtException",
+     "message": "terminating connection due to administrator command",
+   },
+   {
+     "kind": "uncaughtException",
+     "message": "Connection terminated unexpectedly",
+   },
+ ]

 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

The RED output reproduces the incident's exact pair of FATAL messages, in the
incident's order.

### GREEN

```
$ cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
    --reporter=verbose test/integration/dropped-call-sweep-idle-txn.test.ts

 RUN  v4.1.10 /home/user/Serviceos/packages/api

pg pool client connection error: terminating connection due to idle-in-transaction timeout
pg pool client connection error: Connection terminated unexpectedly
pg pool client connection error: terminating connection due to administrator command
pg pool background error: terminating connection due to administrator command
pg pool client connection error: terminating connection due to administrator command
pg pool client connection error: Connection terminated unexpectedly
 ✓ …  > a checked-out connection killed by idle-in-transaction timeout never reaches uncaughtException 1623ms
 ✓ …  > the sweep completes its batch when a connection it holds across the send is terminated 582ms
 ✓ …  > reports the failure per tenant (and throws nothing) when the pool is ended mid-sweep 179ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

Same kills, same messages — now ordinary logged connection errors instead of
FATALs.

```
$ cd packages/api && npx vitest run test/workers/inflight-sweeps.test.ts --reporter=verbose
 ✓ createInflightSweeps > returns the caller’s promise untouched, resolution and rejection alike 4ms
 ✓ createInflightSweeps > drops a sweep from the registry once it settles 2ms
 ✓ createInflightSweeps > does not mint an unhandled rejection when a tracked sweep rejects unobserved 12ms
 ✓ createInflightSweeps > waits for a sweep that is still running, then reports it drained 41ms
 ✓ createInflightSweeps > waits for a sweep registered while the drain is already running 41ms
 ✓ createInflightSweeps > gives up at the deadline instead of holding shutdown open 52ms
 ✓ createInflightSweeps > is a no-op when nothing is in flight 0ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
```

```
$ cd packages/api && npx vitest run test/telephony test/workers
 Test Files  88 passed (88)
      Tests  1145 passed (1145)
   Duration  27.44s

$ cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
    test/integration/dropped-call-worker.test.ts test/integration/sweep-tenant-fanout.test.ts \
    test/integration/dropped-call-sweep-idle-txn.test.ts
 Test Files  3 passed (3)
      Tests  52 passed (52)
   Duration  13.75s

$ cd packages/api && npx tsc --project tsconfig.build.json --noEmit
(no output — exit 0)
```

---

## Runtime proof: two boots of the API webServer

Both boots are `packages/api`'s `npm run dev` command
(`node -r ts-node/register src/index.ts`) with `playwright.config.ts`'s
`apiWebServerEnv` (`NODE_ENV=dev`, `DEV_AUTH_BYPASS=true`) plus `LOG_LEVEL=info`,
against a real `pgvector/pgvector:pg16` container migrated with
`getMigrationSQL()` (the same image and migration path
`e2e/fixtures/setup-test-db.ts` / `test/integration/global-setup.ts` use), with
the same driver issuing one authenticated `/api` request every 10s.

One deliberate amplification, stated plainly: `DB_REQUEST_IDLE_TX_TIMEOUT_MS=1`.
That is production's **own** knob (`middleware/tenant-context.ts:95-96`,
default 60000) turned down so ordinary dev traffic reaches the condition inside
a 4-minute window instead of requiring a handler that stalls for a full minute.
Nothing else about the mechanism is simulated — it is Postgres terminating a
real request transaction's backend.

### main (`origin/main`, `2a68465` — `src/db/pool.ts` and `src/app.ts` restored from main)

Died 0.2s into the **first** `/api` request; never reached 4 minutes.

```
Rivet API running on http://localhost:3000
{"message":"Weekly feedback sweep completed","tenants":4,"sent":0,"failed":0}
{"message":"incoming request", …,"route":"/api/me","correlation_id":"314bb2d1-…"}
FATAL uncaughtException: error: terminating connection due to idle-in-transaction timeout
    at parseErrorMessage (/home/user/Serviceos/node_modules/pg-protocol/src/parser.ts:394:9)
    at Parser.handlePacket (/home/user/Serviceos/node_modules/pg-protocol/src/parser.ts:212:19)
    at Parser.parse (/home/user/Serviceos/node_modules/pg-protocol/src/parser.ts:105:30)
    …
[shutdown] uncaughtException received — closing HTTP server and draining
[app] uncaughtException received — stopping background loops, closing voice sessions and pg pool
[app] drain complete — 0 live session(s) still active at teardown
{"message":"request completed", …,"route":"/api/me","response":{"status":500,"latency_ms":24.75}}
```

Same error, same `parseErrorMessage (pg-protocol/src/parser.ts:394:9)` frame as
issue #1090's report. **FATAL count: 1** (the process was gone before a second
could land; the process exited non-zero ~24s after boot, and every subsequent
driver request returned `ERR fetch failed`).

### branch (`fix/dropped-call-sweep-idle-txn`)

Ran the **full 4 minutes** and exited only on the harness's `timeout` SIGTERM,
through the normal graceful path.

```
--- FATAL lines: 0
--- connections Postgres killed, absorbed instead of fatal:
     20  pg pool client connection error: terminating connection due to idle-in-transaction timeout
     31  pg pool client connection error: Connection terminated unexpectedly
--- driven /api requests: 23  (13 × 200, 9 × 500, 1 in flight at SIGTERM)
--- dropped-call sweeps completed: 7, first one draining the seeded backlog:
{"message":"dropped-call sweep completed","timestamp":"2026-09-13T03:04:58.360Z","service":"dropped-call-worker","due":3,"sent":3,"suppressed":0,"skipped":0,"expired":0,"failed":0}
{"message":"dropped-call sweep completed","timestamp":"2026-09-13T03:05:28.253Z","service":"dropped-call-worker","due":0,"sent":0,"suppressed":0,"skipped":0,"expired":0,"failed":0}
--- "dropped-call sweep: send-batch fetch failed":     0
--- "call_me_back sweep: tenant failed":               0
--- "Cannot use a pool after calling end on the pool": 0
--- sweeps still in flight at the drain deadline:      0
[shutdown] SIGTERM received — closing HTTP server and draining
[app] SIGTERM received — stopping background loops, closing voice sessions and pg pool
[app] drain complete — 0 live session(s) still active at teardown
[shutdown] HTTP server closed
```

### The two boots side by side

| | main (`2a68465`) | branch |
| --- | --- | --- |
| FATAL lines | **1**, at the first `/api` request | **0** |
| survived 4 minutes | no — process gone at ~24s | yes |
| connections killed by Postgres | 1 (then dead) | 51, all absorbed |
| `/api` requests served | 1 (500), then connection refused | 23 |
| dropped-call sweeps completed | 0 after the crash | 7 |
| aftermath lines (`send-batch fetch failed`, `tenant failed`, `Cannot use a pool…`) | n/a — process exited before the next tick | 0 |

The 500s on the branch are the correct new behavior: the request whose backend
Postgres killed now fails as one request, with a catchable error, instead of
taking the process down.

---

### RED/GREEN for the review follow-on

`packages/api/test/integration/request-transaction-connection-lost.test.ts`
drives the REAL middleware (mounted as app.ts mounts it) in front of a route
shaped exactly like the finding — write, wait past a 400ms
`DB_REQUEST_IDLE_TX_TIMEOUT_MS`, respond 200 without another query — against
real Postgres.

RED confirmed the finding precisely: the write WAS rolled back (`count = 0`)
and the after-commit hook did NOT run, yet the caller got a 200 —

```
pg pool client connection error: terminating connection due to idle-in-transaction timeout
pg pool client connection error: Connection terminated unexpectedly
 × … > fails the request rather than returning 2xx over rolled-back writes 2306ms
   → expected 200 to be greater than or equal to 500

AssertionError: expected 200 to be greater than or equal to 500
 ❯ test/integration/request-transaction-connection-lost.test.ts:163:26
```

GREEN — the loss is now logged and the request fails instead of lying:

```
pg pool client connection error: terminating connection due to idle-in-transaction timeout
request transaction connection lost — transaction rolled back by the server: terminating connection due to idle-in-transaction timeout
 ✓ … > fails the request rather than returning 2xx over rolled-back writes 708ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

```
$ cd packages/api && npx vitest run test/middleware/tenant-context.test.ts --reporter=verbose
 Test Files  1 passed (1)
      Tests  24 passed (24)
```

---

## Not done

- **The "which request holds the transaction idle for 60s" question is answered
  by class, not by route.** The evidence pins the killed session to a request
  transaction (§1) — the only place the GUC is set — but the gate machine's
  `.env`, seeded tenants and browser traffic are not reproducible here, so
  which specific `/api` handler stalled during `public-self-booking.spec.ts` is
  not identified. It does not change the fix: the crash is the escape path, and
  every request transaction is exposed to it. Worth a follow-up issue —
  `server.requestTimeout` is 60_000 (`index.ts:134`) and
  `DB_REQUEST_IDLE_TX_TIMEOUT_MS` defaults to 60_000, so *any* request that
  takes ~60s to respond races both, and before this fix the Postgres side of
  that race took the process down.
- **`runAsLeader` still holds a pooled connection across the whole sweep**
  (`app.ts:2276-2300`), compose/send included. That is the advisory lock's
  design and un-gating it needs `FOR UPDATE SKIP LOCKED` row claiming first
  (the correctness note at `app.ts:5888-5897`), so it is out of scope here. The
  crash it could cause is fixed; the connection-occupancy cost is not.
- **The app.ts shutdown wiring is not itself covered by an automated test** —
  the registry is unit-tested and the wiring is exercised by the 4-minute boot,
  but there is no test that boots `createApp()` and asserts the drain ordering.
- **A response whose headers are already out is not corrected**, only logged
  (the review follow-on above). The window is microseconds — a finished
  response has already run `cleanup` — so it covers only a partially streamed
  body, and destroying an in-flight response is a request-lifecycle decision
  for the repo owner rather than a drive-by in this PR.
- **No test pins `pg-pool`'s internals.** The GREEN tests assert the observable
  behavior (no escape to the process); if a future `pg` release changes when
  `idleListener` is attached, these tests still hold, but the explanatory
  comments in `pool.ts` would need re-checking.
