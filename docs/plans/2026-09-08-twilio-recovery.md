# Twilio recovery — subaccount provisioning enqueue skipped on webhook retry

2026-09-08 — Sonnet-executed fix. Scope: `packages/api/src/webhooks/routes.ts`
Clerk `user.created` handler, Twilio subaccount provisioning enqueue block
only (`deps.queue.send(PROVISION_TWILIO_JOB_TYPE, ...)`). Distinct from
`docs/plans/2026-09-08-provisioning-recovery.md` (PR #980), which fixed the
same gate pattern on the separate `deps.provisioningQueue` ("root
provisioning") block a little further down in the same handler. This pass
found and closed the identical gap on the actual Twilio number-provisioning
path — the one that matters for buying real numbers.

## Risk as assigned

> Investigate and fix the active Twilio provisioning enqueue retry gap in
> Clerk `user.created`, on this branch based on merged PR #980.

## Investigation

- `createWebhookRouter`'s `/clerk` handler, `user.created` branch
  (`packages/api/src/webhooks/routes.ts`, pre-fix line 658-683): after
  `bootstrapTenant` runs, `deps.queue.send(PROVISION_TWILIO_JOB_TYPE, payload,
  'provision-twilio-${tenantId}')` is gated `if (result.created && deps.queue)`
  — awaited (not fire-and-forget), but conditioned on `result.created`.
- `bootstrapTenant` (`packages/api/src/auth/clerk.ts`) is idempotent:
  `findByOwner` short-circuits with `created: false` once a tenant already
  exists for that Clerk user — same idempotent-recheck behavior documented in
  the PR #980 plan for the root-provisioning block.
- Webhook-level dedup (`packages/api/src/webhooks/webhook-handler.ts`) marks
  an event `processed` once the handler returns 200; a `processed` event never
  re-enters the handler. A `failed` event (any later step in the same request
  throwing — e.g. the owner-membership insert further down) **is** retried by
  Clerk and re-enters this same code with the same `svix-id`.
- On that retry, `result.created` is `false` (tenant already persisted from
  the first pass), so `if (result.created && deps.queue)` skips the Twilio
  enqueue — permanently, since the tenant never again passes `created: true`.
  If the very first attempt's Twilio `send()` itself failed (queue outage),
  there is no other code path that ever retries it — this is the exact same
  bug class PR #980 closed for `deps.provisioningQueue`, just left open on
  `deps.queue`'s Twilio call, which sits a few lines earlier in the same
  branch and was not in that PR's scope.
- The call is already `await`ed with no local `try/catch`, so a rejection
  already propagates to the handler's existing outer `catch`
  (`routes.ts`, marks the webhook event `failed`, returns 500) — the
  fire-and-forget half of the PR #980 gap (round 2) did not apply here; only
  the `result.created` gate did.
- **Idempotency/duplicate-purchase check before touching the gate**
  (`packages/api/src/workers/provision-twilio.ts`,
  `createProvisionTwilioWorker`):
  - Early-returns if `tenant_integrations.status === 'full_readiness'`
    (already active) — a stale re-enqueue after success is a no-op.
  - Reuses a persisted `subaccount_sid` instead of creating a second
    subaccount.
  - Before purchasing a number, calls `listSubaccountPhoneNumbers` and reuses
    any number already owned by the tenant's subaccount ("Recovered orphaned
    phone number from previous attempt") — explicitly built to recover from
    crash-after-purchase-before-persist, which is exactly the shape of a
    re-enqueue after a first attempt got partway through. Subaccounts are
    tenant-scoped, so this list can only ever contain numbers this tenant's
    prior attempts purchased.
  - These checks support sequential replay recovery. They do not establish
    a guarantee against duplicate purchases under concurrent worker execution
    or every provider failure window; no live provider test was run.
  - Queue-level dedup: the enqueue's idempotency key
    (`provision-twilio-${tenantId}`) is per-tenant and unchanged by this fix;
    `InMemoryQueue.send`/`PgQueue.send` both no-op a collision against a still
    queued message (`ON CONFLICT (idempotency_key) DO NOTHING` in Postgres),
    same contract already relied on by the PR #980 fix.

## Reproduction

Added `packages/api/test/webhooks/clerk-webhook-integration.test.ts` →
`describe('Twilio subaccount provisioning enqueue — retry recovers a failed
send')`:

1. **"a standalone Twilio enqueue failure still fails the webhook, and the
   retry lands the job (not permanently skipped)"** — Attempt 1
   (`svix_twilio_retry_1`): tenant bootstraps (`created: true`);
   `deps.queue.send()` for the Twilio job rejects (simulated queue outage) →
   webhook 500s, tenant durably persisted, exactly one `send()` call recorded.
   Attempt 2, same `svix-id` (Clerk retry): `bootstrapTenant` returns
   `created: false` (idempotent) — asserts the Twilio enqueue is
   re-attempted (not permanently skipped), webhook 200s, still exactly one
   tenant, and both `send()` calls carried the identical idempotency key.

   Run against the pre-fix code: step "Attempt 2" failed —
   `expected [ { …(2) } ] to have a length of 2 but got 1` (`sendCalls`
   stayed at 1 — the tenant is durably persisted with the owner able to sign
   in, but the Twilio subaccount/number was never (re-)enqueued and never
   would be, since the event is now `processed` and can't retry again).

2. **"a successful Twilio enqueue is deduped, not duplicated, when a later
   failure forces a retry"** — uses the real `InMemoryQueue` (not a
   call-counting mock) as `deps.queue`, forces a retry via an owner-insert
   failure (unrelated to the Twilio enqueue itself, isolating the dedupe
   assertion), and asserts `queue.size()` after the retry equals the size
   after the first attempt — no growth, i.e. the retry's re-send of
   `provision-twilio-${tenantId}` is deduped by the queue's own `ON CONFLICT`
   contract, not merely by application logic. This test passed against both
   pre- and post-fix code (gate removal doesn't change dedupe behavior; it
   restores the *sending*, not the *dedupe*), included as durable coverage
   proving the retry path can't over-enqueue now that it's un-gated.

Running just the new tests pre-fix: 1 failed (as above), 1 passed. All other
19 pre-existing tests in the file passed unmodified, confirming this is an
isolated gap, not a broader test-harness issue.

## Fix

`packages/api/src/webhooks/routes.ts`: dropped the `result.created &&`
condition on the Twilio subaccount provisioning enqueue — the block now runs
`if (deps.queue)` on every pass through this branch (fresh bootstrap or
retry alike), mirroring the pattern PR #980 already established for
`deps.provisioningQueue` a few lines below. No other change: the call stays
`await`ed with no local `try/catch` (a rejection already propagates to the
outer catch → 500 → Clerk retry, which was already correct), the idempotency
key is unchanged (`provision-twilio-${tenantId}`), and the worker itself was
not touched.

## Tests / verification

- `npx vitest run test/webhooks/clerk-webhook-integration.test.ts` — 20/20
  pass (new tests: 1 fails pre-fix / passes post-fix, 1 passes both; all 19
  pre-existing tests unaffected).
- `npx vitest run test/webhooks/` — 22 files / 163 tests pass.
- `npx vitest run test/workers/provision-twilio.test.ts test/workers/` — 49
  files / 577 tests pass (worker itself unmodified; confirms no regression
  from the routes.ts change on anything that consumes it).
- `npx tsc --project tsconfig.build.json --noEmit` — clean, no errors.
- No DB/Docker-backed integration test was run or added — this fix touches
  only in-process control flow (removing a boolean condition on an
  already-correct await/throw path), no new SQL, no schema change, matching
  the round-1 rationale in `docs/plans/2026-09-08-provisioning-recovery.md`.
  `test/integration/provision-twilio-vapi.test.ts` (Docker-gated,
  DB-touching) exists for the worker's own purchase-idempotency contract but
  was not run in this environment (Docker unavailable) — not required here,
  since the worker was not modified.

## Attempted but dropped: fake-timer regression for PROVISIONING_ENQUEUE_TIMEOUT_MS

Tried to add a deterministic regression test for the existing (PR #980)
`Promise.race([provisioningQueue.send(...), timeout])` 10s bound on the
*root*-provisioning block, using `vi.useFakeTimers()` + a never-settling
`send()` + `vi.advanceTimersByTimeAsync(10_000)`. It hung for the real 30s
Vitest test timeout instead of resolving once the fake timer fired — the
supertest request goes over a real loopback socket, and something in that
path did not settle purely off the advanced fake clock in the time available
to debug it here. Dropped rather than land a flaky/slow test file under the
12-minute budget; not required for this fix (the root-provisioning block was
not touched). Worth a follow-up with more time, e.g. driving the handler
directly (bypassing supertest/HTTP) so only application-level timers are in
play.

## Remaining gaps / real-environment prerequisites

1. **The queue this fix affects (`deps.queue`) IS wired in production**
   (`packages/api/src/app.ts:1035`, `webhookRouterDeps.queue = queue`) — this
   fix is live on the deployed path once shipped, unlike the separate
   `deps.provisioningQueue` ("root provisioning") block, which
   `docs/plans/2026-09-08-provisioning-recovery.md` documents as still
   unwired in `app.ts` and was explicitly out of scope here (not touched).
   Real-environment Twilio provisioning still requires
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TENANT_ENCRYPTION_KEY` set
   (the worker throws without them in any `isTwilioDeploymentEnv`
   environment) — none of that was touched, verified live, or exercised
   here; this pass is control-flow-only against mocked/in-memory queues and
   a mocked pool.
2. **No real-Postgres verification of `PgQueue`'s dedupe for this specific
   idempotency key**, same caveat as PR #980's round 1/2: `PgQueue.send`'s
   `ON CONFLICT (idempotency_key) DO NOTHING` was read, not executed against
   a real database (Docker unavailable in this environment).
3. **The Docker-gated worker integration test
   (`test/integration/provision-twilio-vapi.test.ts`) was not run** — it
   exercises the worker's own real-DB purchase-idempotency path, which this
   fix relies on but did not modify or newly verify.
4. No live Twilio calls, number purchases, secret reads, deploys, or pushes
   were made in this pass, per assignment constraints.
