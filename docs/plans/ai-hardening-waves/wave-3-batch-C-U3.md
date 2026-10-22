# Wave 3 — Batch C — U3 LLM gateway resilience and accounting

**Branch:** `fix/ai-hardening-gateway`  
**Execution plan:** `docs/plans/2026-10-18-003-chore-ai-hardening-execution-plan.md` (E3 protocol)  
**Technical plan:** `docs/plans/2026-10-18-002-fix-ai-enterprise-hardening-plan.md` unit U3 (PR #1695)  
**Audit baseline:** `origin/main` `20637e004`. Every file:line below is against that commit; re-verify before editing.

## Findings in this batch

| ID | Severity (verified) | Verdict | Title |
|---|---|---|---|
| GATEWAY-01 | high | confirmed | Per-tenant classify_intent concurrency is hard-capped at 2 for every tenant, rejections are reported as 502 provider failures, and leaked Redis leases block a tenant for 5 minutes |
| GATEWAY-02 | medium | confirmed | Transient network failures are never retried: SDK connection errors are classified 'permanent' now that SDK retries are disabled |
| GATEWAY-03 | medium | confirmed | Failover gives each provider a fresh full deadline, and the breaker never opens on a hanging provider, so every call can take twice its budget |
| GATEWAY-05 | medium | confirmed | The per-tenant token quota does not bound spend: output and image tokens are never reserved, overage is forgiven at zero, and no money-denominated cap exists |
| GATEWAY-06 | low | partial | Failover sends complex and vision tasks to a text-only 8B model by default: the documented vision fallback is dead code and the fallback hop is never capability-checked |
| GATEWAY-04 | low | partial | Cost accounting prices OpenAI's dated model ids by the first matching prefix, not the longest, so gpt-4o-mini is billed at gpt-4o rates; with the default table every production OpenAI call costs null |
| GATEWAY-07 | low | confirmed | Public unauthenticated /api/health/ai returns raw upstream provider error text |
| OBS-1 | medium | confirmed | Every brand-voice generation, including the AI-written SMS the dropped-call sweep sends to callers, loses its ai_runs row because a non-UUID prompt id is written to a UUID column |
| OBS-5 | low | confirmed | Each supervisor review writes two ai_runs rows, and supervisor_reviews links the one with no tokens, no cost and no served model |

## Build order and sequencing

Build order inside the batch:

1. **GATEWAY-01**: typed 429s that keep `code` and `retryAfterMs` leave the gateway unchanged (so
   `inapp-adapter`'s `CLASSIFIER_QUOTA_CODES` matches again); `AI_QUOTA_TIERS_JSON` Zod-validated
   like `AI_MODEL_PRICING_JSON`, bad JSON fails boot; `tenantTier` only if a reliable plan→tier
   signal exists (open question; otherwise raise `classifier_standard.maxConcurrency` with the
   reasoning in a comment); lease TTL just above the longest possible hold.
2. **GATEWAY-02**: `APIConnectionError`, `APIConnectionTimeoutError` and cause codes classify as
   transient. Tests use real SDK error classes.
3. **GATEWAY-03**: `ProviderFailoverWrapper` adopts one deadline and passes each provider a slice
   that leaves the fallback a reserve; stops advancing below `MIN_RETRY_BUDGET_MS`.
4. **GATEWAY-05**: reserve input tokens plus `request.maxTokens`, refund on release, debt down to
   `-bucketCapacity` in both the in-memory registry and `RELEASE_LUA`. (Money cap is U8.)
5. **GATEWAY-06**: each fallback tier defaults to its own model; non-vision fallback refuses image
   messages with a typed non-failover error; boot warning when the complex fallback is not vision.
6. **GATEWAY-04**: longest-prefix pricing match plus boot warning for null-priced configured models.
   No invented prices.
7. **GATEWAY-07**: `/api/health/ai` shows a stable error code; raw text only behind `METRICS_TOKEN`.
8. **OBS-1**: non-UUID `promptVersionId` never binds to `ai_runs.prompt_version_id`; goes to
   `inputSnapshot.promptRef` in `gateway.ts`, `cache.ts` and the repository. Integration test with a
   real `LLMGateway`, `PgAiRunRepository`, stub provider: exactly one completed `brand_voice_v1` row
   with cost set.
9. **OBS-5** last: remove the reviewer's manual `ai_runs` row, link `response.aiRunId`, pass
   `metadata.proposalId` and `metadata.correlationId`.

## File ownership and hot spots

- `packages/api/src/ai/gateway/gateway.ts`: batch D merged one PAN-scrub hunk and batch A one
  detach hunk in `cache.ts` before you; merge `origin/main` in and keep both.
- No migration expected; if one appears, take the then-current next key.
- Spend cap in money is U8, not here.

## The unit as ruled in the technical plan (verbatim; this ruling wins)

### U3. LLM gateway resilience and accounting — batch C, `fix/ai-hardening-gateway`

- **Goal:** gateway failures are classified, retried and failed over within one deadline. Quota
  rejections are typed. Every call is accounted for.
- **Requirements:** R1, R2, R3, R4
- **Dependencies:** none
- **Findings:** GATEWAY-01 (high); GATEWAY-02, GATEWAY-03, GATEWAY-05, OBS-1 (medium); GATEWAY-04,
  GATEWAY-06, GATEWAY-07, OBS-5 (low).
- **Files:**
  - `packages/api/src/ai/gateway/{gateway,compose-resilience,retry,tenant-quota,redis-tenant-quota,model-pricing,fallback-model-map,factory,cache}.ts`
  - `packages/api/src/ai/providers/openai-compatible.ts`
  - `packages/api/src/routes/ai-health.ts`
  - `packages/api/src/ai/pg-ai-run.ts` and the in-memory repo
  - `packages/api/src/ai/supervisor/reviewer.ts`
  - Tests: next to each module, plus a new `packages/api/test/integration/` file for OBS-1.
- **Approach:**
  - **GATEWAY-01**
    - Quota errors leave the gateway as typed 429s that keep `code` and `retryAfterMs`, so
      `inapp-adapter`'s `CLASSIFIER_QUOTA_CODES` matches again.
    - Make the tier table overridable with `AI_QUOTA_TIERS_JSON`, Zod-validated like
      `AI_MODEL_PRICING_JSON`. Bad JSON fails boot loudly.
    - Set `tenantTier` only if a reliable plan → tier signal already exists. Otherwise raise
      `classifier_standard.maxConcurrency` to a defensible value, with the reasoning in a code
      comment.
    - Set the lease TTL to just above the longest possible hold, derived from the max gateway
      deadline.
  - **GATEWAY-02:** `APIConnectionError`, `APIConnectionTimeoutError` and cause codes (`ECONNRESET`,
    `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`, `socket hang up`) classify as transient.
  - **GATEWAY-03**
    - `ProviderFailoverWrapper` adopts one deadline and passes each provider a slice that leaves the
      fallback a reserve.
    - It stops advancing below `MIN_RETRY_BUDGET_MS`.
    - Optionally, a per-provider count of consecutive local aborts, kept separate from the shared
      breaker.
  - **GATEWAY-04:** longest-prefix pricing match, plus a boot warning for null-priced configured
    models. No invented prices.
  - **GATEWAY-05**
    - Reserve input tokens (content, text parts and a per-image allowance) plus `request.maxTokens`.
    - Refund on release.
    - Carry debt down to `-bucketCapacity` in both the in-memory registry and `RELEASE_LUA`.
    - The money cap is U8.
  - **GATEWAY-06**
    - Each fallback tier defaults to its own model.
    - A non-vision fallback refuses image messages with a typed non-failover error.
    - Boot warning when the complex fallback model is not vision-capable.
  - **GATEWAY-07:** the public `/api/health/ai` shows a stable error code. Raw text appears only behind
    `METRICS_TOKEN`.
  - **OBS-1:** a non-UUID `promptVersionId` never binds to `ai_runs.prompt_version_id`. It goes into
    `inputSnapshot.promptRef` (in `gateway.ts`, `cache.ts` and the repository).
  - **OBS-5**
    - Remove the reviewer's manual `ai_runs` row and link `response.aiRunId`.
    - Pass `metadata.proposalId` and `metadata.correlationId`.
- **Test scenarios:**
  - **Unit:** use real SDK error classes (`new OpenAI.APIConnectionError({ cause })`), not
    `new Error('socket hang up')`.
  - **Unit:** with two hanging providers, the total time stays within one budget.
  - **Unit:** four concurrent classify calls get typed 429s with `retryAfterMs`, not a 502.
  - **Unit:** pricing gives the same answer whatever the key order.
  - **Unit:** the tier JSON loads valid input and rejects invalid input.
  - **Lua release test** (existing harness): debt carries over.
  - **Unit:** the health route redacts the error.
  - **Unit:** one `ai_runs` row per supervisor review, carrying usage.
  - **Integration (OBS-1):** a real `LLMGateway`, `PgAiRunRepository` and a stub provider write
    exactly one completed `brand_voice_v1` row, with cost set.
- **Verification:** no unit test relies on a bare `Error` where a real SDK class exists, and the gate
  is green.

## Per-finding work packages

Precedence for each finding: the plan ruling above, then the verifier's corrected fix, then the auditor's fix. Trigger, impact, evidence and reasoning are quoted in full from the audit so the implementer and the reviewer trace the same production path.

### GATEWAY-01 — Per-tenant classify_intent concurrency is hard-capped at 2 for every tenant, rejections are reported as 502 provider failures, and leaked Redis leases block a tenant for 5 minutes

- **Severity:** high (auditor said high). **Verdict:** confirmed. **Dimension:** gateway.
- **Locations (audit baseline):**
  - `packages/api/src/ai/gateway/tenant-quota.ts:53-58`
  - `packages/api/src/ai/gateway/compose-resilience.ts:335-356`
  - `packages/api/src/ai/gateway/gateway.ts:782-791`
  - `packages/api/src/ai/gateway/redis-tenant-quota.ts:129`
  - `packages/api/src/ai/gateway/redis-tenant-quota.ts:200-216`
  - `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts:467-470,502-504`
  - `packages/api/src/ai/voice-turn/classify-infra-failure.ts:38-60`
  - `packages/api/src/telephony/twilio-adapter.ts:2622-2643`

**Trigger (the real production path):**

One enterprise tenant has 3 or more callers on the line at once (the media-streams WS cap allows 50 per tenant, ws/connection-registry.ts:27). Each caller turn runs intent-classifier.ts:3228 `gateway.complete({ taskType: 'classify_intent', tenantId })`, which reaches ProviderTenantQuotaWrapper (compose-resilience.ts:341-344) and is keyed to `${tenantId}:classify_intent` / `classifier_${tenantTier}`. No production caller ever sets `tenantTier` (grep finds it nowhere outside ai/gateway and ws/), so every tenant gets `classifier_standard`. A Redis blip during release, or a replica crash mid-call, also leaves leases in place for the 5-minute TTL.

**Impact:**

The third concurrent classify call for a tenant is rejected immediately, with no queueing. The gateway re-wraps the plain TenantConcurrencyExceededError as `AppError('LLM_PROVIDER_ERROR', ..., 502)`, which drops its code and retryAfterMs. The voice path then sees `provider_transient`, plays the 'we're a bit busy' line once, and after a second consecutive failure dispatches `system_failure` (twilio-adapter.ts:2628-2643), so the AI stops handling the call. The in-app audit never records `classifier_quota_failure`, because `CLASSIFIER_QUOTA_CODES` can never match and quota exhaustion is filed as 'the AI is broken'. The premium tiers (`classifier_premium` maxConcurrency 4, `premium` 32) cannot be reached, so an enterprise tenant cannot be given more capacity without a code change. Two leaked leases block that tenant's classifier for up to 5 minutes after a Redis failover or a crash.

**Evidence:**

tenant-quota.ts:53-58 `classifier_standard: { maxConcurrency: 2, ...}`; compose-resilience.ts:336 `const tenantTier: TenantTier = request.tenantTier ?? 'standard';`; gateway.ts:782-791 `if (err instanceof AppError) { throw err; } throw new AppError('LLM_PROVIDER_ERROR', `Provider ${providerName} failed: ...`, 502, ...)`; redis-tenant-quota.ts:129 `const DEFAULT_QUOTA_LEASE_TTL_MS = 5 * 60 * 1000;` and :214-216 `} catch { // best-effort — the lease TTL reclaims the slot`. I ran a probe with the real LLMGateway, composeResilienceStack and TenantQuotaRegistry, firing 4 concurrent classify_intent calls for one tenant. Result: 2 ok and 2 `ERR code=LLM_PROVIDER_ERROR status=502 infraKind=provider_transient msg=Provider api.openai.com failed: Per-tenant concurrency cap exceeded for tenant tenant-A:classify_intent`.

**Verifier's reasoning (what is real, what was narrowed):**

I read the code and reproduced the behaviour. tenant-quota.ts:53-58 sets classifier_standard to maxConcurrency 2. compose-resilience.ts:336-344 keys classify calls to `${tenantId}:classify_intent` with tier `classifier_${request.tenantTier ?? 'standard'}`. Nothing in production sets LLMRequest.tenantTier: the only tenantTier outside ai/gateway is ws/client-gateway.ts, which feeds the WS connection registry and never reaches the gateway. So classifier_premium and premium can never be reached. TenantConcurrencyExceededError extends Error, not AppError, so gateway.ts:782-791 re-wraps it as AppError('LLM_PROVIDER_ERROR', 502) and drops its code and retryAfterMs. I ran the real LLMGateway over composeResilienceStack and TenantQuotaRegistry with 4 concurrent classify calls: 2 fulfilled and 2 were rejected with `LLM_PROVIDER_ERROR 502 Provider api.openai.com failed: Per-tenant concurrency cap exceeded for tenant tenant-A:classify_intent`, which classifyInfraFailure maps to provider_transient. Because the code is lost, inapp-adapter's CLASSIFIER_QUOTA_CODES can never match in production, and quota rejections are audited as 'provider'. RedisTenantQuotaStore's release swallows Redis errors (lines 214-216), and the lease TTL is 5 minutes (line 129). A failed release or a replica crash therefore holds one of the two cluster-wide slots for up to 5 minutes. One nuance: the voice outcome would be the same even with a correctly typed error, because quota_concurrency and provider_transient are both transient (hold line once, then system_failure; the count resets on the next successful turn). The re-wrap is an observability and audit defect. The real availability problem is the untunable cap of 2 with no queueing, which covers both voice and in-app classify for the whole tenant across all replicas. The in-memory store (no REDIS_URL) has no lease-leak problem. High is reasonable for a multi-line enterprise tenant.

**Fix to implement (verifier's corrected fix):**

(1) In the gateway.ts catch, rethrow errors whose code is TENANT_CONCURRENCY_EXCEEDED or TENANT_TOKEN_BUDGET_EXCEEDED unchanged, or make both classes extend AppError with status 429, keeping code and retryAfterMs. (2) Resolve tenantTier from the tenant's plan, using a cached resolver injected into LLMGateway and set on resolvedRequest, and make the tier table env-overridable. As an immediate mitigation, raise classifier_standard.maxConcurrency, since 2 is the real bottleneck. (3) Lower DEFAULT_QUOTA_LEASE_TTL_MS to a bit more than the longest possible lease hold (about 60s). (4) Optionally, for classify_intent, wait a bounded time within the remaining deadline for a free slot.

**Auditor's original fix (superseded where the corrected fix differs):**

(1) Make TenantConcurrencyExceededError and TenantTokenBudgetExceededError leave the gateway as typed 429s. Either have them extend AppError with statusCode 429 and their own code and retryAfterMs, or rethrow them unchanged in the gateway.ts catch, the same way AppError is rethrown. (2) Fill in `tenantTier` on every gateway request from the tenant's plan, for example with a cached `tenantTierResolver(tenantId)` injected into LLMGateway and applied before `provider.complete`. Make DEFAULT_TIER_CONFIG overridable by env (an `AI_QUOTA_TIERS_JSON`, following the AI_MODEL_PRICING_JSON pattern) so an enterprise tier can be sized without a deploy. (3) Cut DEFAULT_QUOTA_LEASE_TTL_MS to roughly the longest end-to-end budget plus margin (about 60s), not 5 minutes. (4) Optionally, for classify_intent, wait a bounded time for a free slot within the remaining deadline instead of rejecting immediately.

**Test specification (from the audit):**

Unit test: build LLMGateway over composeResilienceStack with a 300ms scripted provider and a TenantQuotaRegistry, then fire 3 concurrent classify_intent calls for one tenant. Assert the rejected one has `code === 'TENANT_CONCURRENCY_EXCEEDED'`, statusCode 429 and a retryAfterMs, that `classifyInfraFailure(err) === 'quota_concurrency'`, and that the in-app `classifierFailureFromError(err).failureClass === 'quota'`. Unit test: a request carrying a resolved premium tier gets `classifier_premium` limits. Docker-gated integration test (packages/api/test/integration/) against real Redis: acquire a lease, make release fail, and assert the slot comes back within the new TTL.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names GATEWAY-01 in the body and ends with the session trailers.

### GATEWAY-02 — Transient network failures are never retried: SDK connection errors are classified 'permanent' now that SDK retries are disabled

- **Severity:** medium (auditor said high). **Verdict:** confirmed. **Dimension:** gateway.
- **Locations (audit baseline):**
  - `packages/api/src/ai/providers/openai-compatible.ts:146`
  - `packages/api/src/ai/providers/openai-compatible.ts:246-250`
  - `packages/api/src/ai/providers/openai-compatible.ts:381-387`
  - `packages/api/src/ai/gateway/retry.ts:154-190`
  - `packages/api/src/ai/gateway/compose-resilience.ts:113-130`

**Trigger (the real production path):**

Any production completion whose socket fails before a response arrives: an ECONNRESET on a reused keep-alive socket, socket hang up, ECONNREFUSED, or a DNS EAI_AGAIN against api.openai.com. The call path is intent-classifier.ts:3228 → gateway.ts:570 → ProviderRetryDeadlineWrapper.runWithRetry (compose-resilience.ts:118) → OpenAICompatibleProvider.complete (openai-compatible.ts:362). With `maxRetries: 0`, openai@4.104 core.js throws `new APIConnectionError({ cause })`, whose message is 'Connection error.' and which has no status. normalizeProviderError passes it through unchanged because it only handles 429.

**Impact:**

classifyError sniffs only `err.message` for 'econnreset' / 'socket hang up' / 'econnrefused' / 'eai_again', never `err.cause`, so the SDK's wrapped error falls through to 'permanent'. runWithRetry makes zero retries even with 12s of budget left. On the default single-provider deployment, one dropped socket becomes `LLM_PROVIDER_UNAVAILABLE` (503) for the turn. On the voice path that means the 'busy' hold line, and a second consecutive failure ends AI handling with system_failure (twilio-adapter.ts:2628-2643). Before PROVIDER_SDK_MAX_RETRIES=0, the SDK retried these errors twice itself, so this is a regression introduced by the 17.4s fix. Existing tests only use `new Error('socket hang up')` (test/ai/resilience.test.ts:50-51), so they miss it.

**Evidence:**

retry.ts:176-189 `if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up') || msg.includes('econnrefused') || msg.includes('eai_again') || msg.includes('aborted') || msg.includes('timeout')) { return 'transient'; } } return 'permanent';`. openai-compatible.ts:249 `if (status !== 429) return err;`. Probe against a closed localhost port through the real provider and composeResilienceStack: `raw error: APIConnectionError name= Error status= undefined msg= "Connection error." cause= ECONNREFUSED => classifyError: permanent` and `stack error: LLM_PROVIDER_UNAVAILABLE ... | provider attempts within a 12s budget: 1`.

**Verifier's reasoning (what is real, what was narrowed):**

PROVIDER_SDK_MAX_RETRIES = 0 is passed to the OpenAI client (openai-compatible.ts:146, :297). With openai@4.104.0, a socket failure throws APIConnectionError with message 'Connection error.', no status, and the network error in `cause` (core.js:332). normalizeProviderError returns the error unchanged unless status is 429. classifyError only inspects err.message and status, so the error is classified 'permanent'. I confirmed this directly: a synthetic APIConnectionError with cause ECONNRESET classifies as 'permanent', and a real request to 127.0.0.1:1 produced APIConnectionError, 'Connection error.', status undefined, cause.code ECONNREFUSED, and 'permanent'. APIConnectionTimeoutError ('Request timed out.') is also 'permanent', because 'timed out' does not contain 'timeout'. runWithRetry therefore never retries these errors, which is a regression from when the SDK retried them itself. Two mitigations: isFailoverEligible (status undefined → true) still advances to a configured fallback, and the breaker counts the error. On the default single-provider deploy, one dropped keep-alive socket fails the call with LLM_PROVIDER_UNAVAILABLE 503. On voice that is a hold line, and a system_failure only if the next turn also fails, so I rate it medium rather than high.

**Fix to implement (verifier's corrected fix):**

In classifyError, after the existing isDeadlineExceeded check (which already routes APIUserAbortError to 'timeout'), return 'transient' when err is an OpenAI APIConnectionError or APIConnectionTimeoutError (name or instanceof), or when `err.cause?.code` / `err.cause?.message` matches ECONNRESET, ETIMEDOUT, ECONNREFUSED, EAI_AGAIN or 'socket hang up'. Alternatively, normalize these errors in normalizeProviderError into a typed ProviderNetworkError with code PROVIDER_NETWORK that classifyError treats as transient. Add a unit test that uses a real `new OpenAI.APIConnectionError({ cause })`, not a bare `new Error('socket hang up')`.

**Auditor's original fix (superseded where the corrected fix differs):**

Normalize connection failures where 429 is already normalized. In `normalizeProviderError`, map `OpenAI.APIConnectionError` (excluding `APIUserAbortError`) to a typed `ProviderNetworkError` with code 'PROVIDER_NETWORK' that keeps the cause's code. Map `APIConnectionTimeoutError` to a timeout class. Then have `classifyError` return 'transient' for that code, next to the existing PROVIDER_EMPTY_RESPONSE branch. As a defensive measure, also let classifyError check `err.cause?.code` / `err.cause?.message` against the same network-signal list.

**Test specification (from the audit):**

Unit test (test/ai/gateway/rate-limit-handling.test.ts or a new provider test): `classifyError(normalizeProviderError(new OpenAI.APIConnectionError({ cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }), 'api.openai.com')) === 'transient'`. Handler-level unit test: composeResilienceStack over a scripted provider that throws that APIConnectionError once and then succeeds. Assert it succeeds after 2 attempts within the deadline and that `gatewayRetryAttemptsTotal` increments.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names GATEWAY-02 in the body and ends with the session trailers.

### GATEWAY-03 — Failover gives each provider a fresh full deadline, and the breaker never opens on a hanging provider, so every call can take twice its budget

- **Severity:** medium (auditor said high). **Verdict:** confirmed. **Dimension:** gateway.
- **Locations (audit baseline):**
  - `packages/api/src/ai/gateway/compose-resilience.ts:113-115`
  - `packages/api/src/ai/gateway/compose-resilience.ts:228-232`
  - `packages/api/src/ai/gateway/compose-resilience.ts:352-364`
  - `packages/api/src/ai/gateway/gateway.ts:488-500`
  - `packages/api/src/ai/orchestration/intent-classifier.ts:3228-3233`
  - `packages/api/src/ai/gateway/breaker.ts:466-470`
  - `packages/api/src/ai/gateway/deadline.ts:143-157`

**Trigger (the real production path):**

The documented production config, Profile A plus the OpenRouter fallback (`AI_FALLBACK_PROVIDER_*`, docs/runbooks/live-ai-restore.md:135-152) with `AI_CLASSIFY_INTENT_DEADLINE_MS=12000`, during an OpenAI latency brownout where requests hang instead of erroring. The classifier passes only `deadlineMs` and no signal (intent-classifier.ts:3233). The gateway forwards it, and ProviderFailoverWrapper hands the same `request` to every provider (compose-resilience.ts:232). Each ProviderRetryDeadlineWrapper then calls `adoptDeadline(request.deadlineMs, request.signal)` with `signal` undefined, which starts a brand-new 12s timer per provider.

**Impact:**

Worst case per voice turn is 2 × 12s = 24s of silence before the fallback answers or fails. Local deadline aborts are deliberately excluded from breaker health (FM-01), so a hanging primary never opens its breaker. Every request keeps paying the full primary deadline before failing over, for as long as the brownout lasts, instead of short-circuiting to the fallback. The outermost tenant-quota lease is held for the whole doubled window, which makes the GATEWAY-01 concurrency rejections worse. The caller-visible deadline the gateway sets (VOX-34) no longer bounds the call.

**Evidence:**

compose-resilience.ts:114-115 `const totalMs = request.deadlineMs ?? this.defaultDeadlineMs; const deadline = adoptDeadline(totalMs, request.signal);`; :231-232 `for (const provider of this.providers) { ... const response = await provider.complete(request);`; breaker.ts:466-469 `if (isLocalDeadlineOrAbort(err)) return false;`. Probe with two providers that hang until aborted, deadlineMs=1500: `elapsed ms 3004 deadlineMs=1500 err LLM_PROVIDER_UNAVAILABLE`. After 16 hung requests: `breaker states ... [["api.openai.com","closed"],["openrouter.ai","closed"]]`.

**Verifier's reasoning (what is real, what was narrowed):**

ProviderFailoverWrapper (compose-resilience.ts:228-232) passes the same `request` to each provider. Each ProviderRetryDeadlineWrapper then calls adoptDeadline(request.deadlineMs, request.signal). The classifier sets only deadlineMs, and the gateway's resolvedRequest adds no signal, so every provider gets a fresh full deadline. I reproduced this: two providers that hang until aborted, with deadlineMs=1500, failed after 3004ms with LLM_PROVIDER_UNAVAILABLE, and each provider saw deadlineMs 1500. The voice path has no outer timeout or Promise.race around classify. isBreakerHealthFailure excludes local aborts (breaker.ts), so a hanging primary never opens its breaker and every call pays the full primary deadline before failing over. The tenant-quota lease is held for the whole doubled window. Two things narrow it. It only applies when the AI_FALLBACK_PROVIDER_* pair is configured; with a single provider there is no doubling. And excluding aborts from breaker health is a deliberate, documented FM-01 trade-off, not an accident. Within those limits the doubling is real, so I rate it medium rather than high.

**Fix to implement (verifier's corrected fix):**

Create one adoptDeadline(request.deadlineMs ?? STAGE_BUDGETS.defaultTotal, request.signal) in ProviderFailoverWrapper.complete. Pass each provider `{ ...request, signal: deadline.signal, deadlineMs: slice }`, where the primary's slice leaves a reserve for the fallback (for example remaining minus min(remaining/2, fallbackReserveMs)). Stop advancing once remainingMs() < MIN_RETRY_BUDGET_MS. Optionally, keep a per-provider count of consecutive local aborts that is separate from the shared breaker, and when it passes a threshold try the fallback first.

**Auditor's original fix (superseded where the corrected fix differs):**

In ProviderFailoverWrapper.complete, create one `adoptDeadline(request.deadlineMs ?? STAGE_BUDGETS.defaultTotal, request.signal)` up front. Pass each provider `{ ...request, signal: deadline.signal, deadlineMs: <slice> }`, and stop advancing when `deadline.remainingMs() < MIN_RETRY_BUDGET_MS`. When fallbacks exist, cap the primary slice (for example `remaining - min(remaining/2, fallbackReserveMs)`) so the fallback still has budget. To keep FM-01 (aborts do not open the shared breaker) while not paying for a hang on every call, track consecutive local-deadline aborts per provider and try the fallback first while that count is over a threshold.

**Test specification (from the audit):**

Unit test in test/ai/gateway (next to factory-fallback.test.ts): composeResilienceStack with two providers that hang until `req.signal` aborts, deadlineMs=1500. Assert total elapsed is at most about 1600ms and that the fallback was called with a `deadlineMs` no larger than what remained. Second test: the primary hangs N times in a row, and on call N+1 the fallback is tried first or the primary gets the reduced slice.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names GATEWAY-03 in the body and ends with the session trailers.

### GATEWAY-05 — The per-tenant token quota does not bound spend: output and image tokens are never reserved, overage is forgiven at zero, and no money-denominated cap exists

- **Severity:** medium (auditor said medium). **Verdict:** confirmed. **Dimension:** gateway.
- **Locations (audit baseline):**
  - `packages/api/src/ai/gateway/compose-resilience.ts:346-359`
  - `packages/api/src/ai/gateway/tenant-quota.ts:207-213`
  - `packages/api/src/ai/gateway/tenant-quota.ts:237-249`
  - `packages/api/src/ai/gateway/redis-tenant-quota.ts:117-119`
  - `packages/api/src/ai/tasks/mms-estimate-task.ts:339-344`

**Trigger (the real production path):**

Any tenant-reachable task with a short prompt and a long output (standard tier maxTokens 4096 and complex 8192, config/ai-routing.ts:261-263, for example `assistant.*` chat or drafting), or with image parts (mms_estimate from inbound customer MMS, sms/customer-mms/customer-mms-intake.ts). ProviderTenantQuotaWrapper estimates only `m.content` chars/4 and ignores `parts` (images and text parts) and the request's maxTokens. Admission checks only that estimate. On release, actual usage above the estimate is subtracted but floored at 0, in both the in-memory and the Redis Lua implementations.

**Impact:**

Once the bucket is drained, every request with a small prompt is admitted as soon as a few tokens refill, and its full output (or image) cost is forgiven. Probe on the standard tier (refill 500 tok/s): 312,780 tokens were consumed in 2s against a 1,000-token refill, about 300× over. Nothing in the gateway checks spend before the call. The only money cap is the per-voice-session tracker, so a tenant's non-voice AI spend is bounded only by concurrency and latency, which is an enterprise cost-control and DPA-budget gap.

**Evidence:**

compose-resilience.ts:347-350 `const estimatedTokens = request.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);`; tenant-quota.ts:208 `if (estimatedTokens > state.bucketTokens) {`; :239-242 `if (delta > 0) { // Underestimated — drain the additional usage from the bucket. state.bucketTokens = Math.max(0, state.bucketTokens - delta);`; redis-tenant-quota.ts:118 `if delta > 0 then tokens = math.max(0, tokens - delta)`. Probe output: `2s window, bucket refill=500 tok/s (=1000 tokens allowed): admitted=78 rejected=1 actual tokens consumed=312780`.

**Verifier's reasoning (what is real, what was narrowed):**

compose-resilience.ts:347-350 estimates only `m.content` length/4. It ignores `parts` (images and text parts, which mms-estimate-task.ts:339-344 really sends) and request.maxTokens (set by routing: 1024, 4096 or 8192). Admission (tenant-quota.ts:208) checks only that estimate. On release, actual usage above the estimate is subtracted but floored at 0, both in memory (tenant-quota.ts:242) and in RELEASE_LUA (redis-tenant-quota.ts:118), so overage is forgiven. hardUpperBoundTokens counts only estimates. No tenant-level money cap exists outside the per-voice-session cost tracker. The binding limits on non-voice spend are concurrency (8 standard) and latency, as claimed. The bucket is described as a fairness cap rather than a spend cap, which explains the design, but the gap for enterprise cost control is real. mms_estimate is reachable from inbound customer MMS. Medium is appropriate.

**Fix to implement (verifier's corrected fix):**

Reserve input tokens (from content plus text parts, plus a fixed per-image allowance) plus request.maxTokens at acquire, and refund the difference on release. Let the bucket carry debt, floored at -bucketCapacity rather than 0, in both TenantQuotaRegistry.release and RELEASE_LUA. A per-tenant spend ceiling in micro-cents is a separate, larger product change; track it as its own story.

**Auditor's original fix (superseded where the corrected fix differs):**

Reserve output up front: estimatedTokens = text tokens from `content` plus every text part, plus a per-image allowance for image parts, plus `request.maxTokens` (already set by routing on the resolvedRequest the wrapper receives), and refund the difference on release. Carry debt instead of forgiving it: allow the bucket to go negative down to -bucketCapacity in both TenantQuotaRegistry.release and RELEASE_LUA. Add a per-tenant spend ceiling in micro-cents, checked before dispatch and charged from `computeCostMicroCents` on completion, so spend is capped before the call, failover included.

**Test specification (from the audit):**

Unit test on TenantQuotaRegistry: drain the bucket, then loop acquire(est=10) / release(10, 4000) for 2s and assert admitted actual tokens stay at or below capacity plus the refill window. Unit test on ProviderTenantQuotaWrapper: a request with image parts and maxTokens 4096 reserves more than its content length/4. Docker-gated Redis integration test proving RELEASE_LUA carries the same negative balance as the in-memory registry.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names GATEWAY-05 in the body and ends with the session trailers.

### GATEWAY-06 — Failover sends complex and vision tasks to a text-only 8B model by default: the documented vision fallback is dead code and the fallback hop is never capability-checked

- **Severity:** low (auditor said medium). **Verdict:** partial. **Dimension:** gateway.
- **Locations (audit baseline):**
  - `packages/api/src/ai/gateway/fallback-model-map.ts:16-31`
  - `packages/api/src/ai/gateway/fallback-model-map.ts:54-58`
  - `packages/api/src/ai/gateway/gateway.ts:505-510`
  - `packages/api/src/config/ai-routing.ts:247-256`

**Trigger (the real production path):**

The runbook config sets only `AI_FALLBACK_LIGHTWEIGHT_MODEL` and marks `AI_FALLBACK_COMPLEX_MODEL` as optional (live-ai-restore.md:149-151). When the primary returns 5xx, times out or is rate-limited for an `mms_estimate` (customer photo to quote, which carries image parts) or a `draft_estimate`/`draft_invoice` (complex tier), ProviderFailoverWrapper advances to FallbackModelMapProvider, which rewrites the model to `tiers.complex`.

**Impact:**

`resolveFallbackTierModelsFromEnv` defaults complex to the lightweight model (`meta-llama/llama-3.1-8b-instruct`), not to `DEFAULT_FALLBACK_TIER_MODELS.complex` (qwen2.5-vl), so that constant is never used. The gateway's vision fail-fast checks only the primary's resolvedModel. Photo-to-quote failover therefore sends image parts to a text-only model and always fails (the owner gets the parse-fallback notice), and the financial drafting tasks are silently downgraded to an 8B model during exactly the outage the fallback exists for.

**Evidence:**

fallback-model-map.ts:25-31 `const lightweight = env.AI_FALLBACK_LIGHTWEIGHT_MODEL?.trim() || DEFAULT_FALLBACK_TIER_MODELS.lightweight; return { lightweight, standard: env.AI_FALLBACK_STANDARD_MODEL?.trim() || lightweight, complex: env.AI_FALLBACK_COMPLEX_MODEL?.trim() || lightweight };`; :55-57 `const tier = tierForTask(request.taskType); const model = this.tiers[tier]; return this.inner.complete({ ...request, model });` (no vision check). ai-routing.ts:253 `mms_estimate: 'complex'`.

**Verifier's reasoning (what is real, what was narrowed):**

In the code: resolveFallbackTierModelsFromEnv (fallback-model-map.ts:25-31) defaults standard and complex to the lightweight model, so DEFAULT_FALLBACK_TIER_MODELS.standard and .complex are never used. FallbackModelMapProvider.complete has no vision check, and the gateway's fail-fast (gateway.ts:505) checks only the primary's resolvedModel. Narrower in practice: the documented setup path, scripts/apply-railway-ai-fallback.sh, always sets all three variables, defaulting complex to qwen/qwen2.5-vl-72b-instruct, which is vision-capable. The 8B cascade only happens when an operator sets the variables by hand per the runbook table and skips the 'optional' ones. Impact is also smaller than stated. The fallback only runs after the primary has already failed, so mms_estimate sent to a text-only fallback becomes 'the fallback did not help' (OpenRouter returns a 4xx), not a new failure. draft_estimate and draft_invoice output on an 8B model is still catalog-resolved for prices and requires human approval. Low.

**Fix to implement (verifier's corrected fix):**

Default each fallback tier to its own DEFAULT_FALLBACK_TIER_MODELS entry instead of cascading to lightweight. In FallbackModelMapProvider.complete, when messagesContainImage(request.messages) && !isVisionCapableModel(model), throw a typed non-failover error without calling the inner provider. Log a boot warning in buildFallbackProvidersFromEnv when the complex fallback model is not vision-capable.

**Auditor's original fix (superseded where the corrected fix differs):**

Default each fallback tier to its own `DEFAULT_FALLBACK_TIER_MODELS` entry instead of cascading to lightweight. In FallbackModelMapProvider.complete, when `messagesContainImage(request.messages) && !isVisionCapableModel(model)`, throw a typed non-failover 4xx-class error (or skip the hop) instead of dispatching. Log a boot warning in buildFallbackProvidersFromEnv when the complex fallback model is not vision-capable.

**Test specification (from the audit):**

Unit test: `resolveFallbackTierModelsFromEnv({ AI_FALLBACK_LIGHTWEIGHT_MODEL: 'meta-llama/llama-3.1-8b-instruct' }).complex` is vision-capable (`isVisionCapableModel` is true). Unit test: FallbackModelMapProvider over a scripted inner provider with an image-bearing mms_estimate request either forwards a vision-capable model or throws the typed error without calling the inner provider.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names GATEWAY-06 in the body and ends with the session trailers.

### GATEWAY-04 — Cost accounting prices OpenAI's dated model ids by the first matching prefix, not the longest, so gpt-4o-mini is billed at gpt-4o rates; with the default table every production OpenAI call costs null

- **Severity:** low (auditor said high). **Verdict:** partial. **Dimension:** gateway.
- **Locations (audit baseline):**
  - `packages/api/src/ai/gateway/model-pricing.ts:60-69`
  - `packages/api/src/ai/gateway/model-pricing.ts:192-203`
  - `packages/api/src/ai/gateway/gateway.ts:583-585`
  - `packages/api/src/ai/gateway/gateway.ts:651-662`
  - `packages/api/src/ai/providers/openai-compatible.ts:406`
  - `packages/api/src/ai/agents/customer-calling/sentiment-classifier.ts:57-61`
  - `packages/api/src/admin/pg-tenant-usage.ts:123`

**Trigger (the real production path):**

Production Profile A (api.openai.com, gpt-4o-mini and gpt-4o per the runbook). OpenAI echoes the dated snapshot id (e.g. `gpt-4o-mini-2024-07-18`) in `completion.model`; the provider returns that (openai-compatible.ts:406), and the gateway prices `response.model` (gateway.ts:583). With no override, OpenAI models are deliberately unpriced, so every call gets `costMicroCents: null`. Once ops follow the module's advice and set `AI_MODEL_PRICING_JSON={"gpt-4o":{...},"gpt-4o-mini":{...}}`, the exact lookup misses the dated id and the prefix loop takes the first family in insertion order that the id starts with, which is `gpt-4o`.

**Impact:**

Wrong money in the cost ledger. Every gpt-4o-mini call is written to `ai_runs.cost_micro_cents` and the `gatewayRequestCostMicroCentsTotal` metric at gpt-4o rates, 16.7× too high. The admin per-tenant usage report (pg-tenant-usage.ts:123 `SUM(cost_micro_cents)`) and the per-call LLM spend recorded for sentiment and vulnerability classifiers (sentiment-classifier.ts:58-61) inherit it, and that feeds the voice usage ledger through `session.costTracker.costMicroCents` (twilio-adapter.ts:3538). Under the owner's 'actual provider cost + 30%' pricing (blocked-on-josh O-1), that is the figure an operator would bill from. The result also depends on key order, so the same rates written in a different order give a different bill. Without an override, production spend attribution is blind: all OpenAI rows are null.

**Evidence:**

model-pricing.ts:196-201 `if (MODEL_PRICING[normalized]) return MODEL_PRICING[normalized]; for (const [family, rates] of Object.entries(MODEL_PRICING)) { if (normalized === family || normalized.startsWith(`${family}-`)) { return rates; } }`. Probe: default table `gpt-4o-mini-2024-07-18 -> null`, `cost null`. With `AI_MODEL_PRICING_JSON={"gpt-4o":{250/1000},"gpt-4o-mini":{15/60}}`: `served id gpt-4o-mini-2024-07-18 -> { inputCentsPerMillionTokens: 250, outputCentsPerMillionTokens: 1000 }`, while the bare `gpt-4o-mini -> {15, 60}`.

**Verifier's reasoning (what is real, what was narrowed):**

The prefix-order bug in resolveModelPricing (model-pricing.ts:196-201) is real: the first family in insertion order that the id starts with wins, not the longest. But it is latent. The default table deliberately leaves OpenAI models unpriced (a documented 'never a guess' policy, lines 60-68), and no family in the default table is a dash-prefix of another, so defaults never mis-price. Mis-billing gpt-4o-mini at gpt-4o rates only happens if an operator sets AI_MODEL_PRICING_JSON with gpt-4o listed before gpt-4o-mini. Nothing in the repo (railway.toml, runbooks, scripts) sets that variable. What happens in production today is that OpenAI calls record costMicroCents = null in ai_runs and the Prometheus counter. That is a by-design gap in spend observability, not wrong money. The voice session cost tracker is unaffected because recordCompletionUsage falls back to estimateCostMicroCents when pricing is null. The admin usage report is not a billing system. The fix is trivial and worth doing, but 'high' and 'wrong money in the cost ledger' overstate what happens today.

**Fix to implement (verifier's corrected fix):**

In resolveModelPricing, pick the longest matching family (track the best match by key length), so the result no longer depends on key order. Do not hard-code unverified OpenAI prices into the defaults, because that contradicts the module's stated policy. Instead, log a boot-time warning (next to the provider-model mismatch check in factory.ts) when a configured tier model resolves to null pricing.

**Auditor's original fix (superseded where the corrected fix differs):**

In resolveModelPricing, choose the longest matching family, either by iterating keys sorted by length descending or by keeping the best match, so the result no longer depends on insertion order. Add verified default rates for the production default models (gpt-4o-mini, gpt-4o), or emit a boot-time error, like the provider-model-compat mismatch check in factory.ts:147-158, when any configured tier model resolves to null pricing. Silent null spend is not acceptable on the default deploy.

**Test specification (from the audit):**

Unit test in test/ai/gateway/model-pricing.test.ts using `vi.resetModules()` with AI_MODEL_PRICING_JSON set in both key orders. Assert `resolveModelPricing('gpt-4o-mini-2024-07-18')` returns the mini rates and `resolveModelPricing('gpt-4o-2024-08-06')` returns the 4o rates in both cases. Gateway handler test with a mocked provider returning `model: 'gpt-4o-mini-2024-07-18'`: assert `costMicroCents` uses the mini rates and the aiRunRepo.updateStatus payload carries the same value.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names GATEWAY-04 in the body and ends with the session trailers.

### GATEWAY-07 — Public unauthenticated /api/health/ai returns raw upstream provider error text

- **Severity:** low (auditor said low). **Verdict:** confirmed. **Dimension:** gateway.
- **Locations (audit baseline):**
  - `packages/api/src/app.ts:916-940`
  - `packages/api/src/routes/ai-health.ts:72-100`
  - `packages/api/src/ai/gateway/breaker.ts:188-195`
  - `packages/api/src/ai/providers/openai-compatible.ts:258-269`

**Trigger (the real production path):**

Any anonymous GET /api/health/ai (only rate-limited, app.ts:788, and documented as 'Public listing (/ai) needs no auth', app.ts:916) after a breaker-counted provider failure. A 429 is a health failure, so ProviderRateLimitError keeps the provider's verbatim message, and BreakerCell.onResult stores `err.message`.

**Impact:**

Anyone on the internet can read the upstream account's error strings, for example OpenAI 429 text that names the organization id and live quota use ('Limit …, Used …, Requested …'), network error text and model ids. That discloses the vendor account identity and real-time quota headroom, which helps time an exhaustion attack. Enterprise security review typically requires that unauthenticated endpoints not echo upstream errors.

**Evidence:**

breaker.ts:190-195 `this.lastErrorMessage = err instanceof Error ? err.message : ...`; ai-health.ts:94-96 `if (state.lastError !== undefined) { entry.lastError = state.lastError; }`; openai-compatible.ts:258-263 `const providerMessage = typeof e.message === 'string' && e.message.length > 0 ? e.message : ...` (verbatim message, by design).

**Verifier's reasoning (what is real, what was narrowed):**

app.ts mounts /api/health before any auth middleware, behind only the per-IP rate limiter, and the comment says the /ai listing needs no auth. routes/ai-health.ts:94-96 copies state.lastError into the public response. BreakerCell.onResult stores err.message for any breaker-health failure, and ProviderRateLimitError (a 429, counted as a health failure) carries OpenAI's verbatim message, which names the organization id and the limit, used and requested counts. 5xx and network error text is exposed the same way. It discloses the vendor account identity and quota headroom to anonymous callers, but not credentials. Low is correct.

**Fix to implement (verifier's corrected fix):**

On the public /ai listing, replace lastError with a stable code (for example classifyError output: rate_limited, timeout, transient or permanent, or 'breaker_open'). Return the raw message only on the METRICS_TOKEN-gated route.

**Auditor's original fix (superseded where the corrected fix differs):**

Drop `lastError` from the public `/ai` listing, or replace it with the stable machine code readiness.ts already derives (`classifyError` → 'rate_limit' | 'timeout' | 'auth' | ...). Keep the raw message only behind the METRICS_TOKEN gate already used by `/ai/completion`.

**Test specification (from the audit):**

Route unit test (supertest on createAiHealthRouter): after recording a breaker failure with an Error whose message contains 'organization org-abc', the unauthenticated GET /ai response body does not contain that string and carries only a stable code; the gated route still returns it with a valid METRICS_TOKEN.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names GATEWAY-07 in the body and ends with the session trailers.

### OBS-1 — Every brand-voice generation, including the AI-written SMS the dropped-call sweep sends to callers, loses its ai_runs row because a non-UUID prompt id is written to a UUID column

- **Severity:** medium (auditor said high). **Verdict:** confirmed. **Dimension:** observe.
- **Locations (audit baseline):**
  - `packages/api/src/ai/prompt-registry.ts:136`
  - `packages/api/src/ai/brand-voice/composer.ts:321-338`
  - `packages/api/src/ai/gateway/gateway.ts:535`
  - `packages/api/src/ai/gateway/gateway.ts:543-566`
  - `packages/api/src/ai/pg-ai-run.ts:50-71`
  - `packages/api/src/db/schema.ts:180`
  - `packages/api/src/scheduling/reschedule/from-tech-out.ts:207-211`
  - `packages/api/src/app.ts:6528-6534`
  - `packages/api/src/sms/recovery/recovery-composer.ts:66`
  - `packages/api/src/app.ts:6663-6664`
  - `packages/api/src/scheduling/reschedule/customer-message-draft.ts:54`
  - `packages/api/src/sms/tech-status/handler.ts:20`
  - `packages/api/src/monitoring/pg-failure-monitor.ts:46-60`
  - `packages/api/src/admin/pg-tenant-usage.ts:123-125`

**Trigger (the real production path):**

Three production callers reach this. (1) A caller drops off an inbound call. The dropped-call sweep runs `compose: createRecoveryComposer({ composerDeps: { gateway: llmGateway, ... } })` (app.ts:6528), which reaches composeBrandVoiceMessage (recovery-composer.ts:66). (2) A tech texts an out-of-office status: sms/tech-status/handler.ts -> createRescheduleProposalsFromTechOut -> draftCustomerRescheduleMessage (customer-message-draft.ts:54). (3) The daily digest calls composeNarrative (app.ts:6664). Each one calls gateway.complete with `metadata: { ..., promptVersionId: BRAND_VOICE_PROMPT_VERSION_ID }`, which is the string 'brand_voice_v1' (prompt-registry.ts:136).

**Impact:**

The gateway builds the run with `promptVersionId = request.metadata?.promptVersionId` (gateway.ts:535). PgAiRunRepository.create binds it to `prompt_version_id`, a `UUID` column (schema.ts:180). Postgres rejects the insert with 'invalid input syntax for type uuid', and the gateway swallows the error: `this.logger?.error('AI-run logging failed (best-effort, LLM call continues)')` (gateway.ts:561-566). The result is 100% of brand-voice completions leave no record of input, output, model, tokens or cost. That includes AI-authored customer SMS sent with no human approval. The per-tenant usage report, which sums ai_runs.cost_micro_cents (pg-tenant-usage.ts:123), under-counts that spend. The failure-rate monitor reads only ai_runs (pg-failure-monitor.ts:46-60), so a brand-voice outage can never page. An enterprise asking 'what did your AI text my customer, and from what input?' gets no answer.

**Evidence:**

I ran a probe with the real LLMGateway plus composeBrandVoiceMessage and a capturing AiRunRepository (<scratch>). It printed `ai_runs.create promptVersionId = "brand_voice_v1" taskType = brand_voice_v1`. pg-ai-run.ts:71 binds `run.promptVersionId ?? null` into `prompt_version_id`, and schema.ts:180 declares `prompt_version_id UUID,`. The repo already hit and documented this exact failure for proposals in from-tech-out.ts:207-211: "that column is `prompt_version_id UUID`, but the brand-voice composer returns a string id ('brand_voice_v1'), so the insert failed with \"invalid input syntax for type uuid\"". The gateway's ai_runs path never got that fix. No integration test runs the composer against PgAiRunRepository: brand-voice.integration.test.ts never touches the gateway or ai_runs.

**Verifier's reasoning (what is real, what was narrowed):**

I checked every link against the code. prompt-registry.ts:136 has `BRAND_VOICE_PROMPT_VERSION_ID = 'brand_voice_v1'`. composer.ts:337 sends it as `metadata.promptVersionId`. gateway.ts:535 copies it into createAiRun with no check (validateAiRunInput doesn't check it either). pg-ai-run.ts:71 binds `run.promptVersionId ?? null` into `prompt_version_id`, which schema.ts:180 declares as `UUID`. No later migration changes that column; the only later ALTER adds cost_micro_cents. Postgres rejects 'brand_voice_v1' as a UUID. The gateway catches that error (gateway.ts:561-566), logs it and leaves aiRun undefined, so no updateStatus runs and no row is ever written. The cache wrapper (cache.ts:182) has the same code, but brand_voice_v1 is not in DEFAULT_DETERMINISTIC_TASK_TYPES, so it never reaches that path. All three production callers exist: the dropped-call sweep (app.ts:6528), tech-status → from-tech-out → customer-message-draft, and the daily digest (app.ts:6664). The codebase already hit this exact failure on proposals (from-tech-out.ts:207-211) but never fixed the ai_runs path. No test catches it. pg-tenant-usage (SUM cost_micro_cents) and the failure monitor (ai_runs GROUP BY task_type) do miss this task type entirely. I lowered the severity to medium for four reasons. (1) The model OUTPUT is kept downstream: the recovery SMS goes through messageDelivery with auditRepo, the tech-out draft is in proposals.source_context.draftSms, and the digest stores its narrative. What is lost is the input prompt, model, tokens and cost. (2) Each failure logs an error, so it is visible in logs. (3) The only no-approval customer SMS path, dropped-call recovery, is off by default behind the per-tenant DROPPED_CALL_RECOVERY_FLAG. (4) Tech-out SMS go out only after a human approves the proposal. It is still a deterministic total loss of the record for a whole task type, so this sits at the top of medium.

**Fix to implement (verifier's corrected fix):**

The auditor's gateway-seam fix is right; put the guard at the persistence seam too. In PgAiRunRepository.create (and the in-memory repo, so tests match), bind prompt_version_id only when the value matches the UUID regex. In gateway.ts:535 and cache.ts:182, write a non-UUID value into inputSnapshot.promptRef instead of promptVersionId. Optionally rename the composer's metadata key to `promptRef`. A TEXT column migration is optional; ai_runs.prompt_version_id has no FK, so the guard is enough. Tests: a unit test that a non-UUID metadata.promptVersionId never reaches aiRunRepo.create, plus a Docker-gated integration test (real LLMGateway + PgAiRunRepository + stub provider + composeBrandVoiceMessage) that asserts exactly one completed brand_voice_v1 row with cost_micro_cents set.

**Auditor's original fix (superseded where the corrected fix differs):**

Fix it at the gateway seam so no caller can repeat this. In gateway.ts (and the mirror in cache.ts:182), pass `promptVersionId` to createAiRun only when it matches a UUID. Put any other value into the snapshot instead: `inputSnapshot: { messages, temperature, maxTokens, ...(rawPromptRef && !isUuid(rawPromptRef) ? { promptRef: rawPromptRef } : {}) }`. Optionally, migrate ai_runs to add a TEXT `prompt_ref` column and stop overloading the UUID FK slot. Keep composer.ts unchanged, or rename its metadata key to `promptRef`.

**Test specification (from the audit):**

Add a Docker-gated integration test in packages/api/test/integration/. Build a real LLMGateway with PgAiRunRepository and a stub provider, call composeBrandVoiceMessage for a test tenant, and assert exactly one ai_runs row: task_type='brand_voice_v1', status='completed', cost_micro_cents present, and promptRef='brand_voice_v1' in input_snapshot. This test fails on main today. Also add a unit test in test/ai/gateway that a non-UUID metadata.promptVersionId never reaches aiRunRepo.create's promptVersionId.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names OBS-1 in the body and ends with the session trailers.

### OBS-5 — Each supervisor review writes two ai_runs rows, and supervisor_reviews links the one with no tokens, no cost and no served model

- **Severity:** low (auditor said low). **Verdict:** confirmed. **Dimension:** observe.
- **Locations (audit baseline):**
  - `packages/api/src/ai/supervisor/reviewer.ts:116-133`
  - `packages/api/src/ai/supervisor/reviewer.ts:139-159`
  - `packages/api/src/ai/supervisor/reviewer.ts:319-324`
  - `packages/api/src/ai/gateway/gateway.ts:543-560`
  - `packages/api/src/app.ts:7615-7622`
  - `packages/api/src/workers/voice-action-router.ts:2238`
  - `packages/api/src/workers/voice-action-router.ts:2642`

**Trigger (the real production path):**

The voice action router reaches the supervisor review gate for a chain head or a ready_for_review action (voice-action-router.ts:2238 and :2642, gate wired at app.ts:7615 with `gateway: llmGateway, aiRunRepo`). runLlmCheck first writes its own ai_runs row (`createAiRun({... model: deps.supervisorModel, createdBy: 'system'})`, reviewer.ts:116-133). It then calls deps.gateway.complete (reviewer.ts:139), and that gateway has the same aiRunRepo, so it writes a second row (gateway.ts:543-560).

**Impact:**

One LLM call produces two rows. supervisor_reviews.ai_run_id points at the reviewer's own row (reviewer.ts:159, persisted at :323). That row is completed with only `outputSnapshot` (reviewer.ts:154-157): no token_usage, no cost_micro_cents, and the configured model rather than the model actually served after failover. So 'why did the supervisor hold or annotate this proposal' leads to a row with no usage or cost, and the real gateway row is orphaned with a random correlation_id. Run counts for supervisor_review double in the admin usage report and in the failure monitor's volume floor.

**Evidence:**

reviewer.ts:154: `await deps.aiRunRepo.updateStatus(proposal.tenantId, run.id, 'completed', { outputSnapshot: (signals ?? { unparseable: true }) as Record<string, unknown> });`, followed by `return { signals, aiRunId: run.id };`. The gateway response's own `response.aiRunId` is ignored.

**Verifier's reasoning (what is real, what was narrowed):**

Verified in reviewer.ts. runLlmCheck calls createAiRun and startAiRun and persists its own row: taskType supervisor_review, model = deps.supervisorModel, createdBy 'system', a structured input snapshot (lines 116-133). It then calls deps.gateway.complete with `metadata: { proposalId }` (line 139). The gate is wired with `gateway: llmGateway, aiRunRepo` (app.ts:7615-7618), and that gateway was built with the same aiRunRepo, so the gateway writes a second row. Its correlation_id is random, because only correlationId and promptVersionId are read from metadata, so proposalId is dropped. On success the reviewer marks its own row completed with only outputSnapshot (no tokenUsage, no costMicroCents, no served model) and returns `aiRunId: run.id`. supervisor_reviews.ai_run_id (reviews-repo.ts) therefore points at the row without usage data, and response.aiRunId is ignored. The path runs in production: DEFAULT_SUPERVISOR_REVIEW_MODE is 'shadow', which still runs the LLM check, and it is reached from voice-action-router.ts:2238 and :2642. Run counts per review are doubled. Both rows succeed or fail together, so the failure rate is unchanged, but the volume floor and the usage report run counts are inflated. Low severity is right.

**Fix to implement (verifier's corrected fix):**

Remove the manual createAiRun/create/updateStatus. Pass `metadata: { proposalId: proposal.id, correlationId: proposal.id }` and link `aiRunId: response.aiRunId ?? null`. One caveat: when gateway.complete throws, the gateway's failed row id is not returned to the caller, so the review row would lose its link on the failure path. Either accept a null ai_run_id there, or, if failed reviews need linking, have the gateway attach aiRunId to the thrown error. Test with a real LLMGateway, a stub provider and InMemoryAiRunRepository: exactly one ai_runs row per review, and supervisor_reviews.aiRunId equals that row's id with tokenUsage set.

**Auditor's original fix (superseded where the corrected fix differs):**

Delete the reviewer's manual createAiRun, create and updateStatus, and use the gateway's row: `aiRunId: response.aiRunId ?? null`. Pass `metadata: { proposalId: proposal.id, correlationId: proposal.id }` so the row is findable. This also removes the 'ai_run create failed → deterministic-only' branch, because the gateway already does best-effort logging. Keep the FK guarantee by only linking when response.aiRunId is defined.

**Test specification (from the audit):**

Unit test in test/ai/supervisor with a real LLMGateway, a stub provider and InMemoryAiRunRepository: exactly one ai_runs row exists after a review, and supervisor_reviews.aiRunId equals that row's id with tokenUsage set. Extend the existing supervisor_reviews integration coverage to assert that the FK resolves to a row with non-null token_usage.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names OBS-5 in the body and ends with the session trailers.

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
- GATEWAY-01: <one line: mechanism of the fix>
- GATEWAY-02: <one line: mechanism of the fix>
- GATEWAY-03: <one line: mechanism of the fix>
- GATEWAY-05: <one line: mechanism of the fix>
- GATEWAY-06: <one line: mechanism of the fix>
- GATEWAY-04: <one line: mechanism of the fix>
- GATEWAY-07: <one line: mechanism of the fix>
- OBS-1: <one line: mechanism of the fix>
- OBS-5: <one line: mechanism of the fix>

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
