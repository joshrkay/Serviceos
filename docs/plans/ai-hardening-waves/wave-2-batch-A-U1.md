# Wave 2 — Batch A — U1 Tenant DB connection safety

**Branch:** `fix/ai-hardening-tenant-db`  
**Execution plan:** `docs/plans/2026-10-18-003-chore-ai-hardening-execution-plan.md` (E3 protocol)  
**Technical plan:** `docs/plans/2026-10-18-002-fix-ai-enterprise-hardening-plan.md` unit U1 (PR #1695)  
**Audit baseline:** `origin/main` `20637e004`. Every file:line below is against that commit; re-verify before editing.

## Findings in this batch

| ID | Severity (verified) | Verdict | Title |
|---|---|---|---|
| TI-02 | high | confirmed | In-app voice, suggest-reply, estimate-suggest and onboarding turns hold the shared request connection across LLM and TTS calls, and also take a second connection inside it, so one tenant's AI traffic can exhaust the replica's DB pool for every tenant |
| TI-01 | medium | partial | Background AI work keeps using the request's pg client after it has been released to the pool, so tenant A's SQL runs inside whichever transaction picks that connection up next (often another tenant's, under that tenant's RLS identity) |

## Build order and sequencing

Build order inside the batch:

1. **TI-02** first: the six method-and-path-anchored `LLM_LONG_CALL_ROUTES` entries (same idiom as
   the SSE allowlist, see `docs/solutions/architecture-patterns/sse-streams-bypass-request-transaction-under-pgbouncer.md`),
   and the onboarding `withSessionLock` holding no main-pool connection across LLM calls, safe under
   PgBouncer transaction mode (smallest correct option, justified in the commit message). This
   removes the in-app instances of TI-01.
2. **TI-01**: close the ALS context when the settle STARTS (before COMMIT/ROLLBACK is enqueued, and
   on the BEGIN-failure path); guard every reuse site (`PgBaseRepository.withTenantTransaction`,
   `withRequestSavepoint`, `commitRequestTransactionAndBegin`, `runAfterCommit`); same in
   `PgTenantTransactionRunner.run` and `command-runner.ts`; detach the known background spawns
   (`runSummary`, supervisor `refresh`, `writeAiRunForCacheHit`) with the existing
   `runOutsideRequestTransaction` / `tenantContextStore.exit` idiom; grep for other `void this.` /
   `void (async` spawns in request-scoped code that touch the DB.

## File ownership and hot spots

- `packages/api/src/middleware/tenant-context.ts`, `db/pg-base.ts`, `db/tenant-transaction.ts`,
  `commands/command-runner.ts` are yours alone.
- `packages/api/src/ai/gateway/cache.ts` (`writeAiRunForCacheHit` detach): one hunk; batch C owns
  the rest of the gateway in wave 3.
- No migration in this batch.

## The unit as ruled in the technical plan (verbatim; this ruling wins)

### U1. Tenant DB connection safety — batch A, `fix/ai-hardening-tenant-db`

- **Goal:** background AI work can never run on a released or foreign connection, and long LLM calls
  never hold request connections.
- **Requirements:** R1, R3, R4
- **Dependencies:** none
- **Findings:** TI-01 (medium, partial) and TI-02 (high)
- **Files:**
  - `packages/api/src/middleware/tenant-context.ts`
  - `packages/api/src/db/pg-base.ts`
  - `packages/api/src/db/tenant-transaction.ts`
  - `packages/api/src/commands/command-runner.ts`
  - `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts` (the `runSummary` spawns)
  - `packages/api/src/proposals/supervisor/service.ts` (`refresh`)
  - `packages/api/src/ai/gateway/cache.ts` (`writeAiRunForCacheHit`)
  - the onboarding conversation session lock
  - Tests:
    - `packages/api/test/db/pg-base.test.ts`
    - `packages/api/test/middleware/tenant-context.test.ts`
    - a new `packages/api/test/integration/` file
- **Approach — TI-01:**
  - Close the ALS context when the settle *starts*: before COMMIT/ROLLBACK is enqueued, and on the
    BEGIN-failure path. Closing only at release is not enough.
  - Guard every reuse site: `PgBaseRepository.withTenantTransaction`, `withRequestSavepoint`,
    `commitRequestTransactionAndBegin`, `runAfterCommit`.
  - Close the context the same way in `PgTenantTransactionRunner.run` and `command-runner.ts`.
  - Detach the known background spawns with the existing `runOutsideRequestTransaction` /
    `tenantContextStore.exit` idiom (`packages/api/src/routes/voice-quality.ts:185-189`).
  - Grep for other `void this.` / `void (async` spawns in request-scoped code that touch the DB.
- **Approach — TI-02:**
  - Add method- and path-anchored `LLM_LONG_CALL_ROUTES` entries:
    - `POST /voice/sessions$`
    - `POST /voice/sessions/[^/]+/input$`
    - `DELETE /voice/sessions/[^/]+$`
    - `POST /conversations/[^/]+/suggest-reply$`
    - `POST /estimates/suggest$`
    - `POST /onboarding/conversation/turn$`
  - Make the onboarding `withSessionLock` hold no main-pool connection across LLM calls, and make it
    safe under PgBouncer transaction mode. Use either the direct pool, or a transaction-scoped lock
    held only around the writes. Pick the smallest correct option and justify it in the commit
    message.
- **Patterns to follow:**
  - `packages/api/src/routes/voice-quality.ts` (detached pass)
  - `packages/api/test/integration/request-transaction-commit-before-response.test.ts`
- **Test scenarios:**
  - **Unit:** a closed context forces a fresh `pool.connect()`, BEGIN and set_config for a late call.
    The released client is never queried while another request owns it.
  - **Unit:** after `endSession`, the summary's `gateway.complete` runs with no ALS store.
  - **Integration** (`RLS_RUNTIME_ROLE=true`, pool max=1): request A's delayed `ai_runs` status update
    after its 204 lands in A's own transaction and ends `completed`. Tenant B's concurrent request
    commits normally.
  - **Integration:** concurrent suggest-reply calls under a small pool do not starve another tenant's
    request.
- **Verification:** the integration test fails on `main` and passes on the branch.

## Per-finding work packages

Precedence for each finding: the plan ruling above, then the verifier's corrected fix, then the auditor's fix. Trigger, impact, evidence and reasoning are quoted in full from the audit so the implementer and the reviewer trace the same production path.

### TI-02 — In-app voice, suggest-reply, estimate-suggest and onboarding turns hold the shared request connection across LLM and TTS calls, and also take a second connection inside it, so one tenant's AI traffic can exhaust the replica's DB pool for every tenant

- **Severity:** high (auditor said high). **Verdict:** confirmed. **Dimension:** tenant.
- **Locations (audit baseline):**
  - `packages/api/src/middleware/tenant-context.ts:183-209`
  - `packages/api/src/middleware/tenant-context.ts:287`
  - `packages/api/src/routes/voice-sessions.ts:71-130`
  - `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts:652-670`
  - `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts:984`
  - `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts:2063`
  - `packages/api/src/ai/resolution/pg-entity-resolver.ts:665`
  - `packages/api/src/db/tenant-transaction.ts:23-30`
  - `packages/api/src/routes/conversations.ts:307-372`
  - `packages/api/src/routes/estimates.ts:880-903`
  - `packages/api/src/routes/onboarding-conversation.ts:50-66`
  - `packages/api/src/ai/orchestration/onboarding-conversation.ts:171-189`
  - `packages/api/src/db/pool.ts:54-56`

**Trigger (the real production path):**

Concurrent in-app voice turns (POST /api/voice/sessions/:id/input, routes/voice-sessions.ts:96-115) or AI drafts (POST /api/conversations/:id/suggest-reply, conversations.ts:307; POST /api/estimates/suggest, estimates.ts:880; POST /api/onboarding/conversation/turn) all run inside the /api request transaction. The bypass list holds only two routes: `LLM_LONG_CALL_ROUTES = [{ method: 'POST', re: /\/assistant\/chat$/ }, { method: 'POST', re: /\/voice\/quality\/grade$/ }]` (tenant-context.ts:199-205). Each in-app turn holds that connection through classify (inapp-adapter.ts:984; 4s default, 12s recommended in prod, config/ai-routing.ts:110-121), drafting (standard 4s / complex 8s), entity resolution and TTS synthesis (inapp-adapter.ts:2063). Entity resolution goes through PgEntityResolver (inapp-adapter.ts:652-670, app.ts:2831-2835), which calls `withTenantConnection(this.pool, …)` (pg-entity-resolver.ts:665). That always runs `const client = await pool.connect();` (tenant-transaction.ts:28) and never reuses the request client. The onboarding turn likewise takes a second connection for its advisory lock (onboarding-conversation.ts:175 `await pool.connect()`) and holds it across the extractor LLM calls. The pool is `max: DB_MAX_CONNECTIONS || '20'` with `connectionTimeoutMillis: 5000` (pool.ts:54-56). About 20 overlapping AI turns on one replica saturate it: for example ten tenants each with two dispatchers talking at once, or one enterprise tenant whose turns overlap in the drafting and TTS stages. Per-tenant LLM quotas (classifier 2, standard 8 concurrent) limit concurrent LLM calls, but not how long a turn holds its connection.

**Impact:**

Each saturating request holds connection #1 and blocks on pool.connect() for connection #2, which no one can release, until the 5s timeout. Meanwhile every other tenant's /api request on that replica blocks in withTenantTransaction's `pool.connect()` and fails with a 500. One tenant's AI usage takes down unrelated tenants. When telephony runs on the same service (the voice service is an optional split per railway.voice.toml), Twilio webhook DB lookups such as resolveInboundTenantId's phoneNumberRepo.findByNumber share this pool, so live-call answering degrades too. Under PgBouncer each open transaction also pins a server backend for the whole AI turn.

**Evidence:**

The middleware's own comment describes this failure: `routes whose handlers await long LLM/gateway calls and must not hold the request transaction for their whole life (each concurrent slow request would pin a pooled connection — and under PgBouncer a server backend — for the full call; ~default_pool_size slow chats stall all of /api)` (tenant-context.ts:183-198). docs/runbooks/scaling.md:78-87 says: `Adding another LLM-heavy route? add it to LLM_LONG_CALL_ROUTES and keep its DB work repo-scoped.` None of the in-app voice, suggest-reply, estimate-suggest or onboarding-turn routes was added. The nested acquire is visible in tenant-transaction.ts:23-30 (`withTenantConnection … const client = await pool.connect(); … BEGIN … applyTenantContext`), which pg-entity-resolver.ts uses for every query (e.g. :665, :759, :832).

**Verifier's reasoning (what is real, what was narrowed):**

Confirmed by reading the code.

The routes are inside the request tx:
- LLM_LONG_CALL_ROUTES holds only POST /assistant/chat and POST /voice/quality/grade (tenant-context.ts:199-205).
- The voice-sessions, estimates, conversations and onboarding-conversation routers are all mounted under /api after `withTenantTransaction` (app.ts:5092 vs 5437, 5883, 6092, 7482).
- None of these paths is in IDEMPOTENT_CREATE_PATHS, which matches `/api/estimates` exactly, not `/suggest`.

Each handler awaits LLM work inline while the request connection sits idle-in-transaction:
- suggest-reply awaits repo reads, then `task.suggest` (conversations.ts:307-372).
- estimates/suggest awaits `handler.handle` (estimates.ts:880+).
- In-app input awaits classify, drafting and TTS (inapp-adapter.ts:984, 2063).
- Onboarding turn awaits up to six extractor gateway calls (onboarding-conversation.ts:381-431).

The nested acquire is real:
- Prod injects `sharedEntityResolver` = AliasFirstEntityResolver(PgEntityResolver) (app.ts:2831-2835). Both use `withTenantConnection(this.pool, …)` (alias-first-entity-resolver.ts:128, pg-entity-resolver.ts:665, …). That always calls `pool.connect()` (tenant-transaction.ts:28) while the request still holds its own client.
- The onboarding `withSessionLock` takes a second main-pool connection (onboarding-conversation.ts:175) and holds it across the extractor calls.
- Pool: max 20, connectionTimeoutMillis 5000 (pool.ts:54-56). Under saturation, every holder waits on a second checkout that nothing frees until the 5s timeout. Other tenants' requests queue and fail.
- The codebase states this rule itself: the tenant-context.ts:185-198 comment and docs/runbooks/scaling.md ('Adding another LLM-heavy route? add it to LLM_LONG_CALL_ROUTES').
- Under PgBouncer (default_pool_size e.g. 25, cluster-wide), the ceiling is shared across replicas, which makes saturation easier.

One caveat. Per-tenant quotas reject immediately beyond 2 concurrent classifier and 8 concurrent standard calls (tenant-quota.ts: TenantConcurrencyExceededError). A single tenant's LLM-stage holds are therefore bounded at about 10. The realistic trigger is several tenants at once, or one large tenant overlapping the non-quota'd TTS and resolver stages. The auditor's examples already account for this.

The bypass is safe for these handlers. Their DB work goes through repos with an explicit tenantId. None of them uses runAfterCommit, withRequestSavepoint or commitRequestTransactionAndBegin. The store consumers I found are elsewhere: users, jobs, appointments, onboarding.ts, invoices, the onboarding draft repo.

High is fair for multi-tenant availability isolation in an enterprise deployment.

**Fix to implement (verifier's corrected fix):**

1) Add the auditor's method- and path-anchored entries to LLM_LONG_CALL_ROUTES: POST /voice/sessions$, POST /voice/sessions/[^/]+/input$, DELETE /voice/sessions/[^/]+$, POST /conversations/[^/]+/suggest-reply$, POST /estimates/suggest$, POST /onboarding/conversation/turn$. This is correct as proposed. It also removes the in-app instances of TI-01. TI-01's own fix is still needed, because the supervisor refresh runs on every transactional proposal-creating route.

2) The onboarding bypass is not enough on its own. `withSessionLock` still holds a main-pool connection across the LLM extractor calls. Its session-level `pg_advisory_lock`/`unlock` pair is also unsafe on a PgBouncer transaction-mode DATABASE_URL: lock and unlock can land on different backends, which leaks the lock. Move this lock to the direct pool (createDirectPool / DATABASE_DIRECT_URL, as the scaling runbook prescribes for session advisory locks), or replace it with a version/row check. Side benefit of the bypass: today the lock is released before the request tx commits, so a second tab can read uncommitted-stale state. With the bypass, the repo writes commit before the lock is released.

3) The route list may be incomplete. Add a test that enumerates the routers given `gateway`/aiDeps and fails if one is neither on the bypass list nor explicitly allowlisted as short.

**Auditor's original fix (superseded where the corrected fix differs):**

Add the in-request LLM routes to LLM_LONG_CALL_ROUTES, method and path anchored like the existing entries: POST /voice/sessions$, POST /voice/sessions/[^/]+/input$, DELETE /voice/sessions/[^/]+$, POST /conversations/[^/]+/suggest-reply$, POST /estimates/suggest$, POST /onboarding/conversation/turn$. Their DB work already goes through repos with an explicit tenantId, which open short self-managed SET LOCAL transactions. This is the contract the assistant-chat route and the voice worker already rely on, so no repo changes are needed. It also removes the in-app manifestation of TI-01, because no request-scoped client remains in AsyncLocalStorage.

**Test specification (from the audit):**

Unit test (test/middleware/tenant-context.test.ts): add bypass cases asserting that no pool.connect()/BEGIN happens for each new method and path, and that mutating sibling routes (e.g. POST /voice/sessions/:id/other) stay transactional. Route-level probe test, same pattern as the existing /assistant/chat probe: for in-app input and suggest-reply, assert no pooled client is checked out while the mocked gateway is awaited. Docker-gated integration test (test/integration/) with DB_MAX_CONNECTIONS=3: three concurrent in-app input turns against a slow mocked gateway, plus one concurrent GET from another tenant. The GET must succeed well inside connectionTimeoutMillis.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names TI-02 in the body and ends with the session trailers.

### TI-01 — Background AI work keeps using the request's pg client after it has been released to the pool, so tenant A's SQL runs inside whichever transaction picks that connection up next (often another tenant's, under that tenant's RLS identity)

- **Severity:** medium (auditor said high). **Verdict:** partial. **Dimension:** tenant.
- **Locations (audit baseline):**
  - `packages/api/src/middleware/tenant-context.ts:300-305`
  - `packages/api/src/middleware/tenant-context.ts:531`
  - `packages/api/src/db/pg-base.ts:68-71`
  - `packages/api/src/db/tenant-transaction.ts:127-139`
  - `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts:2095`
  - `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts:2280`
  - `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts:3062-3082`
  - `packages/api/src/ai/skills/summarize-session.ts:198`
  - `packages/api/src/ai/gateway/gateway.ts:651`
  - `packages/api/src/ai/pg-ai-run.ts:118-121`
  - `packages/api/src/proposals/supervisor/service.ts:139`
  - `packages/api/src/proposals/supervisor/service.ts:277-295`
  - `packages/api/src/proposals/supervisor/budget-counters-repo.ts:71-81`
  - `packages/api/src/ai/gateway/cache.ts:138`

**Trigger (the real production path):**

An operator ends an in-app voice session: DELETE /api/voice/sessions/:id (routes/voice-sessions.ts:228-229 `await deps.adapter.endSession(...); res.status(204).end();`). The route runs inside the /api request transaction (app.ts:5092; it is not on the SSE or LLM_LONG_CALL bypass lists). _endSessionLocked does `// Run summary in background — the route returns 204 immediately. void this.runSummary(session)` (inapp-adapter.ts:2280; same on the FSM-ended turn path at :2095). runSummary calls summarizeSession, then gateway.complete (summarize-session.ts:198), which waits seconds on the provider and then calls `await this.aiRunRepo.updateStatus(tenantId, aiRun.id, 'completed', …)` (gateway.ts:651). That reaches PgAiRunRepository.withTenant, then PgBaseRepository.withTenantTransaction, which does `const ctx = tenantContextStore.getStore(); if (ctx && ctx.tenantId === tenantId) { return fn(ctx.client); }` (pg-base.ts:68-71). The AsyncLocalStorage store set at tenant-context.ts:531 (`tenantContextStore.run({ client, tenantId }, …)`) is never invalidated. By the time the UPDATE runs, the middleware has already COMMITted and called `client.release()` (tenant-context.ts:300-305). pg-pool hands out idle clients LIFO (node_modules/pg-pool/index.js:158 `this._idle.pop()`, :427 `this._idle.push(...)`), so the next /api request of ANY tenant is usually holding that exact connection. A second path is the supervisor policy refresh: createProposal (proposals/proposal.ts:1266-1268) calls supervisor evaluate(), which runs `void this.refresh(input.tenantId)` (service.ts:139). Its later sequential reads (getActive at :277, counters.read at :284) can be issued after a short proposal-creating request has already committed and released.

**Impact:**

Tenant A's statement runs with no BEGIN and no applyTenantContext of its own, in one of two states. (a) Inside tenant B's open transaction, under B's `app.current_tenant_id` GUC and the rls_app_runtime role. (b) On an idle connection as the BYPASSRLS connection principal with no tenant GUC at all. The in-app summary path hits this on every session end. When the connection is in B's RLS transaction, A's `UPDATE ai_runs … WHERE tenant_id=A` matches 0 rows, so A's ai_run is left 'pending' forever with no output, tokens or cost (admin/pg-tenant-usage.ts reads ai_runs.cost_micro_cents). The supervisor path is a race. getActive(A) reads null and counters.read(A) reads 0 under B's RLS. So A's snapshot is cached for 30s (DEFAULT_SNAPSHOT_TTL_MS, service.ts:93) with platform-default rules and dailySpendCents/autoApprovalsThisHour = 0, which resets the daily-spend and hourly auto-approval caps on AI auto-approvals. Any late INSERT on this path would fail B's RLS WITH CHECK and abort B's whole transaction (B's request becomes a 500 and its writes roll back). Any late read that relies on RLS alone and lands on an idle client (knowledge_chunks.search has no tenant_id predicate) would read across all tenants. A tenant's SQL executing inside another tenant's DB session is a security-review blocker in itself. The same hazard exists for workers: PgTenantTransactionRunner.run sets the same store and then releases (tenant-transaction.ts:127-139).

**Evidence:**

I reproduced this with a scratch probe outside the repo (<scratch>). It drives the REAL withTenantTransaction middleware and PgBaseRepository against a one-connection mock pool with RLS_RUNTIME_ROLE=true. Request A (tenant 1111…) spawns `void (async()=>{ await sleep(50); await repo.withTenant(A, …UPDATE ai_runs…) })()` and ends its response. Request B (tenant 2222…) then checks out the connection. Output: `[owner=A-request] COMMIT / --- release() --- / BEGIN / set_config('app.current_tenant_id', ['2222…']) / SET LOCAL ROLE rls_app_runtime / … / [owner=B-request] UPDATE ai_runs SET status=$3 WHERE tenant_id=$1 AND id=$2 ['1111…','run-1','completed'] / [owner=B-request] COMMIT`. Tenant A's statement ran inside tenant B's transaction with no BEGIN or tenant context of its own. The codebase already states the rule this breaks, at routes/voice-quality.ts:185-189: `Detached, and OUTSIDE the request's tenant context: the pass must not inherit the request-scoped pg client, which is released when this response ends.` The existing tests test/db/pg-base.test.ts and test/middleware/tenant-context.test.ts (33 pass) do not cover reuse after release.

**Verifier's reasoning (what is real, what was narrowed):**

I confirmed the mechanism myself. The scope of the damage is narrower than the finding says.

What is real:
- The middleware runs `tenantContextStore.run({ client, tenantId }, …)` at tenant-context.ts:531 and never invalidates it. `releaseOnce` (:300-305) only flips a local boolean and calls `client.release()`.
- PgBaseRepository.withTenantTransaction (pg-base.ts:68-71) reuses `ctx.client` whenever the tenantId matches. It does not check whether that client is still owned.
- pg-pool 3.14.0 is LIFO (`_idle.pop()` at index.js:158, `_idle.push` at :427). pg does not stop a query on a released client.
- RLS_RUNTIME_ROLE=true is a required prod boot var (SEC-01, docs/runbooks/rls-runtime-role-rollout.md). ai_runs, supervisor_policies and tenant_budget_counters are all ENABLE+FORCE RLS (schema.ts:196-198, 3258, 4215-4228).
- Trigger: DELETE /api/voice/sessions/:id is mounted under the /api tx (app.ts:5092, 7482) and is not on a bypass list. `_endSessionLocked` (inapp-adapter.ts:2280), and the FSM-end path at :2095, fire `void this.runSummary(session)`. summarizeSession → gateway.complete has no await before `aiRunRepo.create`, so the INSERT lands inside the request tx. That is fine. The `updateStatus(…'completed')` at gateway.ts:651 is different: it runs after the provider call, seconds later, through PgAiRunRepository.withTenant on the released client. Prod gateway = createLLMGateway with PgAiRunRepository (build-repositories.ts:552, app.ts:1499).
- I ran the auditor's probe against the real middleware and PgBaseRepository. Tenant A's UPDATE ran after tenant B's BEGIN/set_config(B)/SET LOCAL ROLE, inside B's transaction.
- The supervisor race is more realistic than the finding suggests. `refresh` starts with `isEnabledForTenantWithDefault`, which (with no tenant override row) calls `platformRepo.get`, and that goes through `withClient`, a separate `pool.connect()` (pg-feature-flags.ts:57-58). That creates a real gap, so `getActive` and `counters.read` (service.ts:277-287) can be issued after the request has released its client.

What is narrower or different:
1) No cross-tenant read or write disclosure is reachable today. Every late statement I found has an explicit `tenant_id = A` predicate. Under B's RLS these match 0 rows. On an idle connection they run as the privileged principal and return or affect only A's rows.
2) Concrete harm today:
   (a) In-app voice summary ai_runs rows stay non-terminal, with no tokens or cost, whenever the late UPDATE lands under another tenant's context. The cost feeds only the internal admin usage view (admin/pg-tenant-usage.ts), not tenant billing.
   (b) The supervisor snapshot can be cached for 30s with A's policy hidden (platform defaults) and the counters at 0. That fails the budget and auto-approval caps open, and it is a race.
3) The 'late INSERT aborts B → B 500' impact has no reachable path in the default config. The only late INSERT I found is PgShadowComparisonStore, which is opt-in via SHADOW_LLM_ENABLED. The consequence is also misstated: if A's statement errored inside B's tx and B issued no further query, Postgres would turn B's COMMIT into ROLLBACK without an error. B would get a 200 over lost writes, not a 500.
4) The 'RLS-only read (knowledge_chunks) on an idle client' impact names no late caller. It is hypothetical.
5) cache.ts:138 is opt-in (AI_CACHE_ENABLED) and its create is enqueued synchronously, so it is low priority.

This is a real defect in the core tenant-isolation primitive and the highest-leverage fix in this dimension. Given 1-4, its current impact is medium, not high.

**Fix to implement (verifier's corrected fix):**

1) Close the context when the settle STARTS, not only at release. Otherwise statements queued between COMMIT and release run after COMMIT on the bare connection, as the privileged principal with no GUC.
- In tenant-context.ts, pass a mutable `{ client, tenantId, closed: false }` to `tenantContextStore.run`. Set `ctx.closed = true` where `cleanedUp = true` is set in `cleanup()`, before the COMMIT/ROLLBACK is enqueued, and also in the BEGIN-failure path.
- Do the same before COMMIT/ROLLBACK in PgTenantTransactionRunner.run (tenant-transaction.ts:128-139) and in commands/command-runner.ts:52, which also sets the store.
- PgBaseRepository.withTenantTransaction: reuse only when `ctx && !ctx.closed && ctx.tenantId === tenantId`. Otherwise use the existing fresh-connection BEGIN/applyTenantContext path.
- withRequestSavepoint: run `fn()` directly when closed. runAfterCommit: run the effect immediately when closed. commitRequestTransactionAndBegin: return or throw when closed.

2) Detach the known spawns with `tenantContextStore.exit(...)` (the voice-quality.ts:189 idiom): inapp-adapter.ts:2095 and :2280 (runSummary) and supervisor/service.ts:139 (refresh). cache.ts:138 is optional (opt-in path).

3) Unit-test that a store entry closed at settle start forces a fresh connect + BEGIN + set_config(A). Add the Docker-gated pool-max=1 integration test as proposed.

**Auditor's original fix (superseded where the corrected fix differs):**

1) Invalidate the context before release. In tenant-context.ts, store a mutable `{ client, tenantId, released: false }` and set `ctx.released = true` inside releaseOnce, before `client.release()`. Do the same in PgTenantTransactionRunner.run's finally (tenant-transaction.ts). In PgBaseRepository.withTenantTransaction, reuse only when `ctx && !ctx.released && ctx.tenantId === tenantId`; otherwise fall through to the existing fresh-connection BEGIN/applyTenantContext path. Apply the same guard in withRequestSavepoint, commitRequestTransactionAndBegin and runAfterCommit. 2) Detach the known background spawns with `tenantContextStore.exit(...)` / runOutsideRequestTransaction, the same idiom as routes/voice-quality.ts:189: inapp-adapter.ts:2095 and :2280 (runSummary), proposals/supervisor/service.ts:139 (refresh), and ai/gateway/cache.ts:138 (writeAiRunForCacheHit).

**Test specification (from the audit):**

Unit test (test/db/pg-base.test.ts or test/middleware/tenant-context.test.ts): run withTenantTransaction(pool) with a mock pool and client. In next(), schedule `repo.withTenant(A, …)` on a timer, end the response, then run a second middleware invocation for tenant B on the same mock client. Assert the late call made a fresh pool.connect(), issued BEGIN + set_config(A) on its own client, and never queried the released client while B owned it. Handler-level test for InAppVoiceAdapter with a mocked gateway: assert tenantContextStore.getStore() is undefined inside the summary gateway.complete call after endSession. Docker-gated integration test (test/integration/, same pattern as request-transaction-commit-before-response.test.ts, RLS_RUNTIME_ROLE=true, pool max=1): request A spawns a delayed PgAiRunRepository.updateStatus after its 204, request B (tenant B) holds the connection in a transaction. Assert A's ai_runs row ends 'completed' and B commits normally.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names TI-01 in the body and ends with the session trailers.

## Gate for this batch (every command, exact counts in the PR body)

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm run lint
cd packages/api && npx vitest run                      # full unit suite
cd packages/api && EXTERNAL_TEST_DB_URL=<batch DB> RLS_RUNTIME_ROLE=true \
  npx vitest run --config vitest.integration.config.mts test/integration/<touched and covering files>
npm run check:migration-keys --workspace=packages/api   # when a migration was added
cd packages/api && npx vitest run test/db/migration-immutability.test.ts test/db/migration-key-order.test.ts
```
Plus `packages/shared` / `packages/web` tsc and vitest when touched. Known flake:
`test/settings/voice-approval-pin-route.test.ts:127` (~0.1%); re-run once if it is the only failure.

## Independent review checklist (reviewer runs `code-review`, then this)

- Standards axis: integer cents; UTC; `tenant_id` + RLS; audit event on every mutation; every AI call
  through the gateway; Zod proposals never auto-executed; catalog-grounded prices; entity resolver;
  dead code removed; tests in the same commit; plain owner/caller copy (never AI, agent, dashboard,
  verify, provisioning, proposal, Stripe, Twilio; never a promise the code path can't deliver);
  migrations idempotent, additive, next key, snapshot row.
- Spec axis: each finding ID above, traced from trigger to fix on the production path.
- Adversarial: a test that passes with the fix reverted is BLOCKING; a wrapper, cache-hit, failover
  or background-spawn path that bypasses the fix is BLOCKING; a new security hole is BLOCKING.

## Draft PR body skeleton

```
## Findings closed
- TI-02: <one line: mechanism of the fix>
- TI-01: <one line: mechanism of the fix>

## Behaviour owners and callers will notice
- <...>

## Plan corrections found during claim verification
- <file:line — what the plan said — what the code says — what was built instead>

## Tests
- <unit / handler / integration files added or changed; each new test fails on main>

## Gate (verbatim summary lines)
- tsc build: <output>
- lint: <output>
- unit: Test Files N passed, Tests N passed
- integration: <files> — Test Files N passed, Tests N passed (RLS_RUNTIME_ROLE=true)

## Owner actions
- <...>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01LUnuhssW9WEwiZgrAnuvRj
```
