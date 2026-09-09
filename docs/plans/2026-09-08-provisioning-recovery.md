# Provisioning recovery — root provisioning enqueue skipped on webhook retry

2026-09-08 — Sonnet-executed fix, in two rounds. Scope:
`packages/api/src/webhooks/routes.ts` Clerk `user.created` handler, root
provisioning enqueue block only. Round 1 (below) closed the "gated on
`result.created`" retry gap; round 2 (**Follow-up**, further down) closed the
standalone-failure gap round 1 explicitly left open (see "Remaining gaps" #2
below) — a queue-outage failure with nothing else wrong on the same delivery
still returned 200 with no durable trace and no way to retry.

## Risk as assigned

> Root provisioning send is detached, error is logged, and only
> `result.created` enqueues. A persisted tenant can therefore skip root
> provisioning on retry.

## Investigation

- `createWebhookRouter`'s `/clerk` handler, `user.created` branch
  (`packages/api/src/webhooks/routes.ts:718-759` pre-fix): after
  `bootstrapTenant` runs, the root-provisioning message is sent via
  `void deps.provisioningQueue.send(...).then(...).catch(...)` — fire-and-forget,
  not awaited by the response — and only when `result.created` is true.
- `bootstrapTenant` (`packages/api/src/auth/clerk.ts:592`) is idempotent:
  `findByOwner` short-circuits with `created: false` once a tenant already
  exists for that Clerk user.
- The webhook-level dedup (`handleWebhookEvent` /
  `packages/api/src/webhooks/webhook-handler.ts`) marks an event `processed`
  once the handler returns 200, and a `processed` event can never re-enter the
  handler — but a `failed` event (any later step in the same request throwing,
  e.g. the owner-membership insert a few lines below) **is** retried by Clerk
  and re-enters this same code with the same `svix-id`.
- On that retry, `result.created` is now `false` (tenant already persisted from
  the first pass), so the `if (deps.provisioningQueue && result.created)` gate
  skips the enqueue — permanently, since the tenant will never again pass
  `created: true`. If the very first attempt's detached `send()` failed (queue
  outage, etc.), there is no other code path that ever retries it.
- Queue dedup (`packages/api/src/queues/queue.ts` `InMemoryQueue.send`,
  `packages/api/src/queues/pg-queue.ts` `PgQueue.send`) both no-op an
  `idempotencyKey` collision (`ON CONFLICT (idempotency_key) DO NOTHING` in
  Postgres). The enqueue call always uses the deterministic key
  `tenant-provisioning:${tenantId}`, so re-sending on every retry is safe
  whether or not the prior attempt already landed.
- No worker registered in `worker-registry.ts`/`workers/*` currently consumes
  `tenant.provisioning.root.requested`, and `provisioningQueue` is never wired
  into `webhookRouterDeps` in `packages/api/src/app.ts` — this whole path is
  presently dormant in production (dead code from the caller's perspective),
  not actively firing. The recovery bug is real in the code as written and
  matters as soon as `provisioningQueue` is wired up; it does not indicate the
  fix is exercised in prod today.

## Reproduction

Added `packages/api/test/webhooks/clerk-webhook-integration.test.ts` →
`describe('root provisioning enqueue — retry recovers a failed send')`, reusing
the existing `UuidTenantRepository` / fake-pool pattern from the adjacent
"owner membership insert" tests:

1. Attempt 1 (`svix_provisioning_retry_1`): tenant bootstraps
   (`created: true`); `provisioningQueue.send()` is called and rejects
   (simulated queue outage); the owner-insert then also fails (simulated
   transient DB error) → webhook 500s, event marked `failed`.
2. Attempt 2, same `svix-id` (Clerk retry): owner-insert now succeeds;
   `bootstrapTenant` returns `created: false` (idempotent). Webhook 200s.
3. Assertion: `provisioningQueue.send()` must have been called a second time
   on the retry.

Run against the pre-fix code, step 3 failed (`sendCalls` stayed at 1 — the
tenant is durably persisted with the owner able to sign in, but root
provisioning was never (re-)enqueued and never will be, since this event is
now `processed` and can't retry again). All 16 other tests in the file passed
unmodified, confirming this is an isolated gap, not a broader test-harness
issue.

## Fix

`packages/api/src/webhooks/routes.ts`: dropped the `&& result.created`
condition — the block now runs `if (deps.provisioningQueue)` on every pass
through this branch (fresh bootstrap or retry alike). At the time, the send
stayed fire-and-forget (`void ...then().catch()`) so the response would not
block on it, pinned by the then-pre-existing "returns signup response without
waiting for downstream provisioning enqueue" test. **Superseded by round 2,
below**: that non-blocking design was itself the standalone-failure gap
(remaining gap #2, originally) — the fire-and-forget send is now awaited, and
that test was rewritten to match the corrected contract.

## Tests / verification

- `npx vitest run test/webhooks/clerk-webhook-integration.test.ts` — 17/17
  pass (new test fails pre-fix, passes post-fix; all pre-existing tests
  unaffected).
- `npx vitest run test/webhooks/` — 22 files / 160 tests pass.
- `npx tsc --project tsconfig.build.json --noEmit` — clean, no errors.
- No DB/Docker-backed integration test was run or added — this fix touches
  only in-process control flow (no new SQL, no schema change), and the
  existing owner-insert tests this scenario is modeled on are themselves
  pool-mocked, not Docker-gated. **Gap**: no real-Postgres verification that
  `_queue_messages` actually enforces `ON CONFLICT (idempotency_key) DO
  NOTHING` end-to-end (Docker unavailable in this environment) — the
  `PgQueue.send` SQL was read directly (`packages/api/src/queues/pg-queue.ts:95-100`)
  rather than executed against a real database.

## Remaining gaps after round 1 (round 2 below closes #2)

1. **`provisioningQueue` is not wired in production.** `packages/api/src/app.ts`
   never sets `webhookRouterDeps.provisioningQueue`, so today this whole block
   is inert in the deployed app regardless of this fix. Wiring it up and
   building the consuming worker for `tenant.provisioning.root.requested` is a
   separate, larger piece of work. **Still open** after round 2.
2. ~~**A provisioning-only failure still can't self-heal.**~~ **Closed by
   round 2, below.** (Was: if the enqueue was the *only* thing that failed on
   a given delivery, the webhook still returned 200 and the event was marked
   `processed` — no way to retry.)

## Follow-up — a standalone enqueue failure was still swallowed (round 2)

### Risk as assigned

> The round-1 patch removed the `result.created` gate but left `send()`
> fire-and-forget: a standalone queue failure still returns 200 and no retry
> is guaranteed. Unresolved primary failure, not acceptable as fixed.

### Investigation

- Round 1 only removed the `&& result.created` gate; the enqueue call itself
  was still `void deps.provisioningQueue.send(...).then().catch((err) => {
  logger.error(...) })` — the `.catch()` swallows the rejection, the response
  had already gone out (or was about to, unblocked), and the webhook event was
  marked `processed`. Gap #2 above, on its own, with no other failure on the
  same delivery: the enqueue is attempted exactly once, fails, is logged, and
  is never retried — `processed` events never re-enter the handler.
- `deps.provisioningQueue.send()` (`WebhookRouterDeps.provisioningQueue`,
  `packages/api/src/webhooks/routes.ts:207-209`) is typed as
  `Promise<string>` and, in both real implementations
  (`InMemoryQueue.send`/`PgQueue.send`, `packages/api/src/queues/queue.ts` and
  `pg-queue.ts`), resolves once a single row is durably written (an
  `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`, in PgQueue's case) —
  not once a worker later receives or processes that row. Awaiting `send()`
  therefore waits only for the durable enqueue, never for downstream/worker
  completion (no worker even runs synchronously with this call).
- The pre-existing "returns signup response without waiting for downstream
  provisioning enqueue" test asserted the opposite of the corrected contract:
  it modeled `send()` itself as the slow/blocking thing and asserted the
  response must not wait for it. That conflated the fast, durable enqueue
  write with slow downstream orchestration work; under the corrected
  contract the response must wait for `send()` (so its failure can propagate),
  so this test's premise no longer holds and it was rewritten (see Tests,
  below) rather than kept passing against undurable work.

### Fix

`packages/api/src/webhooks/routes.ts`, same block:

- `deps.provisioningQueue.send(...)` is now `await`ed directly (no
  `.then()/.catch()`), still un-gated on `result.created` (round 1's fix).
- Wrapped in `Promise.race([send(...), enqueueTimedOut])` against a new
  `PROVISIONING_ENQUEUE_TIMEOUT_MS = 10_000` constant (same bound already used
  for the Clerk metadata PATCH calls a few lines below, and the same
  `Promise.race` timeout idiom already used elsewhere in this codebase for
  pool shutdown in `app.ts` and catalog resolution in
  `ai/voice-turn/session-catalog.ts`) — so a wedged queue client fails the
  webhook rather than hanging the response indefinitely.
- On failure (rejection or timeout), the error is logged and **rethrown** —
  propagating to the handler's existing outer `catch` (routes.ts:955), which
  marks the webhook event `failed` and returns 500, the same rethrow-to-retry
  contract already used by the owner-insert block a few lines below.
- The `tenant.signup.provisioning.enqueued` audit-event write moved out of the
  `.then()` callback into plain sequential code after the awaited `send()`
  succeeds; it is unchanged in content and, like the existing
  `tenant.signup.bootstrap.completed` audit call earlier in the same handler,
  is not specially guarded — an audit-write failure here also propagates and
  fails the webhook, which is the pre-existing convention in this function,
  not a new behavior introduced by this fix. This audit/log side effect does
  not affect provisioning safety: safety comes from the queue's idempotency
  key, so a duplicate audit write (or a retried one) is not a duplicate
  provisioning risk.
- Ordering consequence: the provisioning-enqueue block runs *before* the
  owner-insert block in source order, so a failed/timed-out enqueue now
  short-circuits the request before the owner-insert is ever attempted on
  that delivery. On the Clerk retry, the enqueue re-attempts first (safe
  no-op if it already landed, per the idempotency key), then the owner-insert
  runs. No reordering of the two blocks was made — this is a consequence of
  the enqueue throwing instead of swallowing, not a new code path.

### Tests

`packages/api/test/webhooks/clerk-webhook-integration.test.ts`:

- Rewrote "returns signup response without waiting for downstream
  provisioning enqueue" → "awaits the durable provisioning enqueue (not
  downstream worker processing) before responding". Asserts response
  resolution happens strictly after the (artificially delayed) `send()`
  resolves (`order` array assertion), and that the `provisioning.enqueued`
  audit event is present immediately on response with no manual
  flush/`setTimeout(0)` tick needed — the old test's tell that the send was
  detached.
- Renamed `describe('root provisioning enqueue — retry recovers a failed
  send')` → `describe('root provisioning enqueue — durable, awaited, and
  retry-safe')` and added two tests inside it:
  - **"a standalone enqueue failure (nothing else fails) still fails the
    webhook, and the retry lands the job"** — the round-2 regression test:
    owner-insert never fails in this test (isolates the enqueue as the only
    failing step, unlike the pre-existing test in this block which combined
    an enqueue failure with an owner-insert failure). Attempt 1: `send()`
    rejects, asserts `500`, asserts the owner-insert `INSERT INTO users`
    query was never issued (proves the enqueue failure short-circuits before
    reaching it), asserts the tenant row is still durably persisted. Attempt
    2 (same `svix-id`): `send()` succeeds, asserts `200`, asserts the
    owner-insert now runs, asserts the two `send()` calls carried the
    identical idempotency key.
  - **"a successful enqueue is deduped, not duplicated, when a later failure
    forces a retry"** — uses the real `InMemoryQueue` (imported from
    `src/queues/queue.ts`) as `provisioningQueue` instead of a call-counting
    mock, so the dedupe assertion exercises the actual `ON CONFLICT
    (idempotency_key) DO NOTHING` contract rather than restating it. Attempt
    1: enqueue succeeds (`queue.size() === 1`), owner-insert fails, forcing a
    retry. Attempt 2: owner-insert succeeds, the un-gated code re-sends with
    the same idempotency key, asserts `queue.size()` is **still** `1` — the
    real queue dedupes the retried send rather than producing a second
    message, even though `send()` "succeeds" both times.
  - Retained the pre-existing combined-failure test (enqueue fails on attempt
    1, owner-insert configured to fail too) as coverage that a genuinely
    simultaneous double-failure still resolves correctly across a retry, and
    removed its now-stale `await new Promise((resolve) => setTimeout(resolve,
    0))` "let the detached rejection settle" line — no longer needed, since
    the rejection is now synchronous with the request/response cycle, not
    detached.

### Verification

- Regression proof: temporarily reverted `routes.ts` to the round-1
  (fire-and-forget, un-gated) state — reconstructed as the committed `HEAD`
  file with only the `result.created` gate removed, matching exactly what
  round 1 shipped — and ran the new/changed tests against it. Both failed as
  expected: "a standalone enqueue failure..." got `200` instead of the
  expected `500` (the exact silent-swallow bug being fixed), and "awaits the
  durable provisioning enqueue..." got `['response-received']` instead of
  `['enqueue-settled', 'response-received']` (proving the old code does not
  wait for the enqueue). All other tests in the file were unaffected. Restored
  the round-2 `routes.ts` and re-ran: full pass.
- `npx vitest run test/webhooks/clerk-webhook-integration.test.ts` — 18/18
  pass.
- `npx vitest run test/webhooks/` — 22 files / 161 tests pass.
- `npx tsc --project tsconfig.build.json --noEmit` — clean, no errors.
- `npx tsc --noEmit -p tsconfig.json` (test-inclusive config) — no errors
  reported for either changed file. Not the mandatory production check, run
  as an extra sanity pass since a new production import
  (`InMemoryQueue`, only in the test file) was added.
- No DB/Docker-backed integration test was run or added — same rationale as
  round 1 (Docker unavailable in this environment). This fix touches only
  in-process control flow and error propagation, no new SQL. **Gap**: still
  no real-Postgres verification that `_queue_messages` enforces `ON CONFLICT
  (idempotency_key) DO NOTHING` end-to-end; the dedupe test added this round
  exercises `InMemoryQueue`'s in-process mirror of that contract (read
  directly from `queue.ts`), not `PgQueue` against a real database.

### Remaining gaps after round 2

1. **`provisioningQueue` is still not wired in production** — unchanged from
   round 1, gap #1 above. This whole path remains inert in the deployed app
   until `app.ts` wires a `provisioningQueue` and a worker is built for
   `tenant.provisioning.root.requested`.
2. **The 10s enqueue timeout is a fixed constant, not derived from any SLO or
   the webhook's own budget.** Clerk's own webhook delivery timeout (or any
   upstream request timeout) was not inspected — if either is shorter than
   10s, a slow-but-not-hung queue call could still be cut off by an upstream
   timeout before this bound fires, or this bound could fire well within
   Clerk's own patience, needlessly failing a call that would have succeeded.
   Not addressed here — no evidence was gathered on those external budgets in
   this pass, and the assigned scope was "bounded failure path using existing
   patterns," not new SLO derivation.
3. **No real-Postgres verification of `PgQueue`'s dedupe**, carried over from
   round 1 (Docker unavailable in this environment).
