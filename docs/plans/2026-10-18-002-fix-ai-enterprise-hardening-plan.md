# fix: AI enterprise hardening — close the 34 verified readiness findings

**Created:** 2026-10-18
**Depth:** Deep
**Status:** plan (handoff-ready: a fresh thread can execute this without the originating session)

## Summary

Close the 34 verified findings in
`docs/quality/ai-enterprise-readiness-audit-2026-10-18.md`. The work runs as six independent fix
batches (U1–U6), each on its own branch and PR, followed by two follow-on features (U7 data-subject
erasure, U8 a money cap on AI spend). The bar is a security, reliability and privacy review by a large
enterprise customer.

## Start here (handoff)

- **What exists.** The audit report and the full machine-readable findings ship in this PR:
  - `docs/quality/ai-enterprise-readiness-audit-2026-10-18.md`
  - `docs/quality/ai-enterprise-readiness-audit-2026-10-18.findings.json`
  - Each JSON entry carries `trigger`, `impact`, `evidence`, `fix` and `test`, plus a `verification`
    block (`verdict`, `severity`, `reasoning`, `corrected_fix`) and the `batch` letter.
- **Precedence.** For every finding:
  - This plan's ruling wins.
  - Otherwise the verifier's `corrected_fix` wins.
  - Otherwise the auditor's `fix` applies.
  - Re-check every claim against current code before changing it, because `main` will have moved
    since 20637e004.
- **Is a batch already done?** Before starting one, check whether its branch already exists on origin:
  `git ls-remote origin 'fix/ai-hardening-*'`. The originating session may have pushed finished
  batches as draft PRs. If a branch exists with an open PR, continue that PR rather than starting
  over.
- **Parallelism.** The batches are independent, so run them in separate worktrees at the same time.
  Overlap hot spots are listed under Risks.

## Problem Frame

The AI feature (the voice agent, chat assistant, drafting tasks, gateway and learning loop) has been
built and graded for product capability. It has not been graded for what an enterprise reviewer
blocks on:

- tenant isolation at the connection layer
- AI actions bypassing role-based approval
- retention, PCI and disclosure obligations
- calls that drop or go silent when one dependency fails
- spend control
- traceability of AI decisions
- regression gates on prompt changes

The audit found 12 high, 16 medium and 6 low issues across those areas, all independently verified.

## Requirements

- R1. Every high finding is fixed with a test that fails without the fix.
- R2. Every medium and low finding is fixed, or recorded with the reason it is not.
- R3. No regression:
  - `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` is clean.
  - `npm run lint --workspace=packages/api` is clean.
  - The full API unit suite is green.
  - Every touched integration file is green under `RLS_RUNTIME_ROLE=true`.
  - PR CI (`test`, `playwright`, `onboarding`, voice gates) is green.
- R4. Repository invariants hold (CLAUDE.md):
  - integer cents
  - UTC
  - `tenant_id` + RLS
  - audit events on mutations
  - LLM gateway
  - Zod-validated proposals that are never auto-executed
  - catalog-grounded prices
  - entity resolver
  - dead-code removal
  - tests in the same commit
- R5. Caller- and owner-facing copy is plain. It never promises an action that the code path cannot
  deliver.
- R6. Anything only the owner can do is listed under Owner decisions and actions and never guessed in
  code.

## Key Technical Decisions

- **Six batches, split by code area so the file sets barely overlap.** This lets them run in parallel
  and review as focused PRs. (Alternative considered: one mega-PR. Rejected because it can't be
  reviewed, and one red check blocks every fix.)
- **The verifier's corrected fixes, not the auditor's.** The verifier re-read the code and narrowed
  eight findings. Two auditor fixes would have broken shipped behaviour:
  - OVAS-04 would have clamped the permissive threshold preset.
  - PRIV-2 would have nulled `recording_url`, which is an idempotency key.
- **No speculative product changes.** These are deferred to the owner rather than invented:
  - an auto-approve threshold floor
  - a money cap (U8)
  - a plan → AI tier mapping
  - the erasure scope (U7)
- **Migrations are a merge-time concern.**
  - `getMigrationSQL()` concatenates every migration in insertion order on every boot, and the
    migration-immutability test requires each new key to be greater than every existing key.
  - Each batch that needs a migration takes the next free key at the time it is written; the max
    on 20637e004 was `313_onboarding_drafts_owner_phone`. On `main` at `58383e730` (2026-10-25) it
    is `353_shadow_comparisons_created_index`, so the next free key is 354. U7 and U8 both take
    keys from there, at merge time.
  - The batch merged second renumbers before merge. Its migration is pre-deploy, so this is allowed.
    Update the immutability snapshot in that same commit.
  - Every migration must be idempotent (`IF NOT EXISTS`).
- **Two design rules for every unit.** Review has found gaps of these two kinds four times in U7 and
  U8, most recently the phase-2 erase and the cap enable. Check every step against both before
  writing it:
  - **Every multi-step operation that crosses a commit boundary or an external call is a durable,
    resumable job with checkpoints and idempotent steps.** A process can exit between any two steps.
    So:
    - The operation's state lives in a row, with a checkpoint per step.
    - A sweep that runs at boot and on an interval resumes every started-but-unfinished job.
    - A lease lets only one worker run a job at a time.
    - Every step is safe to repeat, and recognises work an earlier run already did.
    - Retries are bounded, and the job ends in an explicit terminal state that someone sees.
    - Every wait has a deadline, and a run that crashes counts as an attempt. No job stays
      unfinished without an alert.
    - Re-opening a closed job takes the same row lock as the close, so neither can miss the other.
    - Code that runs "after the commit" in the same process is never the only way a job finishes.
  - **Every change to a limit is serialized with the consumers of that limit under the same lock.**
    A limit is anything a consumer checks before it acts: a ceiling, a fence, a tombstone. So:
    - The write that changes the limit takes the lock the consumers take.
    - Inside that transaction it counts the consumers' committed and in-flight work.
    - Each consumer reads the limit only after it holds the lock, never from a value read earlier.
      That includes the clock: a time or a month it acts on is read after the lock, never taken
      from the transaction's start.
    - Either the consumer commits first and the change counts it, or the change commits first and
      the consumer sees it. No third order exists.

## Scope Boundaries

**In scope:** U1–U6 (the 33 findings assigned to batches); U7 and U8 once their owner decisions land.

**Non-goals:**

- Externalizing voice session state for multi-replica voice. LCR-05 ships the mitigations and a config
  guard; real scale-out is its own project.
- A per-tenant DPA/subprocessor opt-in for Langfuse content export. PRIV-6 ships a config guard only.
- Hard-coding unverified model prices (GATEWAY-04).

### Deferred to follow-up work

- Change the hardcoded `'owner'` approver role in the SMS reply handler, if non-owner backup
  supervisors can approve by SMS. The PI-2 verifier noted it.
- A per-task volume-spike alert (OBS-4, optional).
- An `ai_runs(tenant_id, correlation_id)` index, if traceability lookups need it (OBS-2).

## Repository invariants touched

- **RLS / tenant_id**
  - U1 (TI-01, TI-02): connection reuse after release; pool starvation.
  - U4 (PRIV-1): a cross-tenant tenant selection, then per-tenant updates under the tenant
    transaction.
- **Human-approval gate**
  - U2 (OVAS-01, OVAS-02, OVAS-04): born-`draft` and role-fail-closed downgrades.
  - U2 (PI-2, PI-3): `settings:update` on config-writing approvals.
- **Zod proposals / entity resolver**
  - U2 (OVAS-03): the job id comes only from resolved entities, and approval and execution
    reference-check it.
- **Audit events**
  - U2: the real approver role is recorded.
  - U4: purge and delete audit metadata; disclosure ledger.
  - U5: the deploy-restart log.
- **LLM gateway**
  - U3 throughout.
  - U4: a single PAN-scrub hunk in `gateway.ts`.
- **Integer cents**
  - U3: cost accounting (`model-pricing.ts`).
  - U8: the spend cap in integer cents.

## High-Level Technical Design

```mermaid
flowchart LR
  subgraph Batches[parallel, one worktree + one test DB each]
    A[U1 tenant DB] --- B[U2 action safety] --- C[U3 gateway]
    D[U4 privacy] --- E[U5 live-call] --- F[U6 injection + ops]
  end
  A --> M[merge: A, B, C, D, E, F; renumber migrations as needed]
  B --> M
  C --> M
  D --> M
  E --> M
  F --> M
  D --> U7[U7 erasure: needs owner scope decision]
  C --> U8[U8 spend cap: needs owner decision]
```

## How to execute a batch

1. **Worktree on the batch branch, off fresh `origin/main`.**
   ```
   git worktree add -b fix/ai-hardening-<name> ../hard-<K> origin/main
   ```
   Then symlink or install `node_modules`, and run `npm run build --workspace=packages/shared` once.
2. **Postgres.** Use one local database per batch, so concurrent batches don't collide:
   ```
   service postgresql start
   createdb serviceos_test_<k>
   ```
   Integration tests use the external-DB path in `packages/api/test/integration/global-setup.ts`:
   ```
   cd packages/api && EXTERNAL_TEST_DB_URL=postgres://postgres:postgres@localhost:5432/serviceos_test_<k> \
     RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.mts test/integration/<file>
   ```
3. **Test-first.**
   - Write the failing test.
   - Watch it fail for the right reason.
   - Implement.
   - Watch it pass.
   - Grep `docs/solutions/` for the area first.
4. **Commits.**
   - One per finding or tight group: `fix(<area>): <the defect, in plain words>`.
   - Stage only the files you changed.
   - End each message with the repo's Co-Authored-By / Claude-Session trailers.
5. **Gate** (all must pass, reported with exact counts):
   - `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
   - `npm run lint --workspace=packages/api`
   - `cd packages/api && npx vitest run`, the full suite. To prove a failure is unrelated, run that
     test on a clean `origin/main`.
   - Every integration file you added or touched, plus the existing ones covering the changed code.
   - If `packages/web` or `packages/shared` changed, their `tsc` and `vitest` too.
6. **Independent review.**
   - A second reviewer reads `git diff origin/main...HEAD` adversarially.
   - Blocking: a fix that doesn't hold on the real production path, a caller regression, a broken
     invariant, a test that passes without the fix, a new security hole, jargon or over-promising
     copy, or a non-idempotent migration.
   - Fix the blocking items test-first, then re-run the gate.
7. **Push and open a draft PR.**
   - Body: the findings fixed, with IDs; tests; gate results; any owner actions.
   - Watch CI and bot reviews to green.
   - Reply to every review thread, and resolve the ones you addressed.

## Implementation Units

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
  - `packages/api/src/routes/tenant-site.ts` (`POST /about/draft`)
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
    - `POST /tenant-site/about/draft$`. This is mandatory U1 scope, not part of optional U8: the
      route awaits the gateway inside the request transaction, and U8's design confirms that 20
      concurrent drafts can exhaust the default pool and stall all `/api` traffic. It lands in
      #1811.
  - Make that route's post-LLM writes (reject stale proposals, create the proposal, audit) commit
    together in one short tenant transaction of their own, after the gateway call returns, the way
    the resolve-entity route does.
  - Add a guard that makes any gateway call made while a request transaction is held fail tests,
    so the next such route can't slip through.
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
  - **Integration** (Docker-gated, under `packages/api/test/integration/`): concurrent
    `POST /tenant-site/about/draft` calls against a small pool do not stall other `/api` requests,
    and a draft's post-LLM writes commit or roll back together.
  - **Unit:** a gateway call made while a request transaction is held fails the guard.
- **Verification:** the integration test fails on `main` and passes on the branch.

### U2. Approval and action safety — batch B, `fix/ai-hardening-action-safety`

- **Goal:** no AI-drafted action executes past the human approval the role model requires, and every
  proposal traces to the model run that drafted it.
- **Requirements:** R1, R2, R4, R5
- **Dependencies:** none
- **Findings:** OVAS-01 (high), OVAS-02 (high, partial), OVAS-03, OVAS-04 (partial), PI-2, PI-3, OBS-2
  (all medium).
- **Files:**
  - `packages/api/src/ai/tasks/estimate-edit-task.ts`
  - `packages/api/src/ai/tasks/estimate-task.ts`
  - the other drafting task handlers
  - `packages/api/src/proposals/{proposal,auto-approve,actions,approval-reference-checks}.ts`
  - `packages/api/src/proposals/execution/{update-estimate-handler,handlers,standing-instruction-handler}.ts`
  - `packages/api/src/routes/assistant.ts`
  - `packages/api/src/workers/voice-action-router.ts`
  - the daily digest worker
  - `packages/api/src/learning/corrections/*`
  - `packages/api/src/ai/proposal-linkage.ts` (wire or delete)
  - `voice-audit.ts` `createIntentRun` (wire or delete)
  - wiring in `packages/api/src/app.ts`
  - Tests: next to each changed module, plus new `packages/api/test/integration/` files.
- **Approach:**
  - **OVAS-01**
    - An accepted target is born `draft`: omit `sourceTrustTier` when accepted, the same idiom as
      `create-appointment-task`'s `reviewGatedFallback`.
    - The executor passes `allowAccepted` / `invalidateAcceptance` only when the `_acceptance` marker
      is present.
    - The SMS shows the marker's reason.
    - Exclude `_acceptance` proposals from digest batch approval and one-tap.
  - **OVAS-02**
    - Write one fail-closed helper in `proposals/` (e.g. `holdIfCallerCannotApprove`) that maps each
      auto-approvable type to its direct permission:

      | Proposal type | Direct permission |
      |---|---|
      | `draft_estimate` | `estimates:create` |
      | `update_estimate` | `estimates:update` |
      | `draft_invoice` | `invoices:create` |
      | `update_invoice` | `invoices:update` |
      | `create_appointment`, `create_booking` | `appointments:create` |
      | `update_job` | `jobs:update` |

    - Call it at both chat sites and in `voice-action-router`. There, resolve the memo creator's role
      from `voice_recordings.created_by` via the membership loader, and fail closed when it can't be
      resolved.
    - Do NOT apply it to the D-015 autonomous lane (`docs/decisions.md` D-015).
    - Delete the old two-entry `DIRECT_EXECUTION_PERMISSION` allowlist and its incorrect comment.
  - **OVAS-03**
    - The job id is authored only from `asUuid(context.existingEntities?.jobId)`, and the prompt says
      "Never output a jobId".
    - `DraftEstimateExecutionHandler` loads the job and checks that it belongs to the same customer.
    - Add a `jobReferenceCheck` ApprovalReferenceCheck for `draft_estimate`, `draft_invoice` and
      `create_appointment`, wired in `app.ts`.
  - **OVAS-04** — only items 1–2:
    - Thread `supervisorMode` on the memo path from the creator's `users.current_mode`.
    - Backstop: when the mode is undefined, `resolveAutoApproveThreshold` uses the max of the legacy
      threshold and the defined overrides.
    - The estimate clarification and flagged branches are blocked whatever the tenant threshold is
      (stamp `low` or add a `missingFields` gate).
    - No threshold floor and no schema tightening. That is an owner decision.
  - **PI-2**
    - Add `create_standing_instruction` to `CONFIG_WRITING_PROPOSAL_TYPES`.
    - The handler records the real `executedByRole`.
  - **PI-3**
    - Stamp the approver for the line-item types.
    - Cascade a lesson into the catalog or settings only when the approver holds `settings:update`;
      otherwise record it without the cascade.
    - Pass the real approver id and role to `recordCorrectionLessons`.
  - **OBS-2**
    - No migration.
    - One helper that builds correlation metadata (`conversationId ?? sessionId ?? callSid`), used on
      every drafting handler's `gateway.complete`.
    - Set `aiRunId` on `CreateProposalInput` only when it is defined, since it is an FK.
    - Keep the classifier run as `sourceContext.classifierAiRunId`.
- **Test scenarios:**
  - **Unit**, handler-level with a mocked gateway, per finding:
    - an accepted target is born `draft`
    - the executor refuses an unmarked accepted target
    - a technician's `draft_invoice` lands in `ready_for_review` on chat and on a memo
    - a model-supplied `jobId` is ignored and the entities `jobId` is used
    - a memo with tenant override 1.0 is not auto-approved
    - a dispatcher approving `create_standing_instruction` gets `ForbiddenError` and an owner succeeds
    - a drafting proposal carries the drafting run's `aiRunId`
  - **Integration (OVAS-01):** `accepted_signature_data` survives an AI edit until a human approves.
  - **Integration (OVAS-03):** a dangling or foreign-tenant `jobId` produces no `estimates` row.
  - **Integration (PI-3):** a dispatcher approval leaves the catalog price and labor rate unchanged.
    An owner approval applies them with the correct `actor_role`.
- **Verification:** every scenario fails on `main` and passes on the branch, and approval UX is
  unchanged for owners.

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

### U4. Privacy and data handling — batch D, `fix/ai-hardening-privacy`

- **Goal:** caller data honours the retention promise. Card numbers are never stored or sent to a
  provider. Callers are told they are talking to an AI.
- **Requirements:** R1, R2, R4, R5
- **Dependencies:** none (U7 depends on it)
- **Findings:** PRIV-1, PRIV-2, PRIV-3 (high); PRIV-4 (medium); PRIV-6 (low).
- **Files:**
  - `packages/api/src/workers/recording-retention-worker.ts`
  - `packages/api/src/telephony/{recording-webhook,voicemail-status-route,recording-control}.ts`
  - a new `packages/api/src/ai/privacy/pan-redact.ts`
  - `packages/api/src/ai/voice-turn/transcript-append.ts`
  - one hunk in `packages/api/src/ai/gateway/gateway.ts`
  - `redactTextForExport` and `scrubPii`
  - one parameter in `packages/api/src/voice/transcription-providers.ts` `buildWsUrl`
  - `bootstrapCallEstablishment` / `buildTelephonyGreeting` in
    `packages/api/src/telephony/twilio-adapter.ts`
  - `packages/api/src/ai/skills/disclose-ai-identity.ts`
  - `packages/api/src/shared/config.ts`
  - delete `dataset-hooks.ts` if it is unimported
  - Tests: next to each module, plus new integration files.
- **Approach:**
  - **PRIV-1**
    - Add an `ai_runs` content-purge phase to `RecordingRetentionWorker`, shaped like the #1208
      `voice_sessions` phase.
    - Select tenants cross-tenant, then run each per-tenant `UPDATE` under the tenant transaction.
    - Bound batches with the `(tenant_id, created_at)` index.
    - Keep the row, so the FKs from `proposals` and `supervisor_reviews` survive.
    - Scrub every task type, and write one audit event per tenant batch.
  - **PRIV-2**
    - Delete the Twilio copy only after the whole hand-off is durable. The S3 PUT and the DB insert are
      not enough: in `voicemail-status-route.ts` an `onVoicemailPersisted` failure (the transcription
      enqueue) deliberately returns 500 so the leg can be retried. If Twilio's copy were already gone,
      the retry's fetch of `RecordingUrl` would 404 and the enqueue could never complete. So:
      - The deletion boundary is the success receipt, recorded last.
      - A retried delivery that finds the `voice_recordings` row and its stored S3 object reuses
        them and goes straight to the hand-off; it never re-fetches from Twilio.
      - `recording-webhook.ts` follows the same rule.
    - Build the URL from `recording_url`, which covers subaccounts. Treat 404 as done.
    - The sweep retries legacy and failed rows, and the purge audit records `twilioDeleted`.
    - Do NOT null `recording_url`; it is the idempotency key.
    - Put the deleter behind an injectable seam, and never log the auth token.
  - **PRIV-3**
    - One Luhn-validated scrubber: 13–19 digits, optional space or dash groups, replaced with
      `[card number]`.
    - **The scrubber also catches card numbers spoken as words.** Whisper can return a card number
      read aloud as words ("four one one one …"), not digits. `workers/transcription.ts` sends that
      text to the optional correction model and then stores it. The Deepgram audio pass can flag and
      purge the recording, but it doesn't redact a transcript already stored or exported. So:
      - Before the Luhn check, the scrubber normalizes runs of spoken digit words into digits, in
        English and Spanish: zero/oh to nine, cero to nueve, and "double" / "doble" repeats. Filler
        and separators between them ("and", "dash", "y") are allowed.
      - It Luhn-checks the normalized 13–19-digit sequences, and replaces the original word span
        with `[card number]`.
      - It runs before the correction model and before persistence, at the same boundary as the
        digit form.
      - Tests:
        - a Whisper-shaped word-form PAN, in English and in Spanish, is redacted before the correction
          call and before the write
        - a word-form run that fails Luhn, such as a read-back phone number, is left alone
      - Batch D started before this was added, so it lands as a batch D follow-up commit.
    - Apply it at:
      - `callerTranscriptText`
      - user-role text in `LLMGateway.complete`, before dispatch and before the snapshot
      - `redactTextForExport`
      - `scrubPii`, whose residual detector also flags grouped digits
    - **Scrub at the persistence boundary, not only at the known producers.** Review keeps finding
      one more producer that writes caller speech without passing a listed chokepoint. The latest is
      the Whisper path in `workers/transcription.ts:455-510`: it writes `voice_recordings.transcript`
      and `transcriptMetadata.raw_transcript_retention` for voicemail and in-app recordings without
      going through `callerTranscriptText` or Deepgram. So:
      - Every repository write to a designated caller-text column runs the scrubber and the PCI
        detection. The designated columns are `voice_recordings.transcript` and its
        `raw_transcript_retention`, `call_transcript_turns`, `voice_sessions.transcript`,
        `knowledge_chunks.content` and `content_scrubbed`, and the `ai_runs` snapshots. A new
        speech source therefore can't bypass it.
      - A test pins the list. It checks every repository method that writes one of those columns,
        and a column added to the list without a scrubbing write path fails.
      - **Detect across adjacent caller turns, not one write at a time.** A caller who pauses while
        reading a card number can produce several `call_transcript_turns` rows, each shorter than
        13 digits, that together rebuild the full number. So:
        - On every caller-turn write, the detector also runs over the concatenation of the
          session's preceding caller turns, in order, within a bounded window.
        - When a Luhn-valid sequence spans turns, it rewrites every contributing span in all of
          those rows to `[card number]`, in the same transaction.
        - It does the same to the session's in-memory history, so the next model call doesn't
          carry it.
        - Test: a card number split across three caller turns is redacted in all three rows and in
          the next model prompt.
        - Batch D started before this was added, so it lands as a batch D follow-up, with the
          word-form scrubber.
      - The transcription worker additionally scrubs and detects as soon as the provider returns,
        before the optional correction call, before persistence and before hand-off.
    - Add `redact=pci` to Deepgram.
    - Treat Deepgram's own redaction as a positive detection. With `redact=pci`, Deepgram masks the
      digits before our scrubber sees them, so the Luhn check alone would never flag a media-streams
      call, and its audio would keep the card number for the full retention period.
      - Detect Deepgram's redaction placeholder or entity signal in the transcript.
      - Pin the exact format in a test, built from a recorded Deepgram response rather than a guess.
      - Either signal, or a Luhn hit (the only detector on the Gather path, which has no upstream
        redaction), counts as a detection.
    - **Persist the detection by call, not on the recording.** Detection happens mid-call, but the
      `voice_recordings` row is created only by Twilio's post-hangup recording callback
      (`voice/call-transcript-turn.ts`). An in-memory flag would be lost on exactly the restart and
      outage paths this plan hardens.
      - Write the detection at once to a tenant-scoped, RLS-protected record keyed by `call_sid`,
        for example a small `pci_detections` table added in an idempotent migration.
      - When the recording row is created, it inherits `pci_detected` from that record.
      - The retention worker and the LCR-04 reconciliation sweep both consult it, so a recording
        whose callback never arrives is still purged from Twilio.
    - **Fail closed when the detection can't be persisted.** If the DB is down when Deepgram reports
      a redaction, the write fails. `redact=pci` has already hidden the digits, so the Luhn check
      can't catch it later. Three layers close that gap:
      - Retry the detection write in-process, with backoff, for the rest of the call.
      - If the write still hasn't landed, pause the live recording through the existing
        `RecordingControl.pauseRecording` seam. That is a Twilio API call and needs no DB.
      - **The main control is at ingestion.** Every recording row is created with a
        `pci_scan = 'pending'` state, and the retention worker treats `pending` like
        `pci_detected`, keeping it only for the short PCI period. An ingestion-time scan then clears
        each recording to `clean` or marks it `pci_detected`. It looks in the call's persisted
        transcript turns for three positive signals:
        - Deepgram's redaction markers
        - remaining Luhn hits
        - our own `[card number]` marker. `callerTranscriptText` scrubs before persisting, so on
          the Gather path the digits are already gone. If the scan ignored our own marker, a call
          whose detection write failed would be cleared as `clean` with the card still in the
          audio.

        The scan also always runs one Deepgram pre-recorded pass over the audio with `redact=pci`,
        whatever the transcript shows. It can't be gated on a call having no turns: an outage can
        drop just the turn that held the card number while later turns persist, and the transcript
        can't prove it is complete. A recording is kept under the normal policy only after both
        checks have cleared it. The audio pass costs one pre-recorded transcription per call
        recording; that is the price of a fail-closed PCI control.
    - A `pci_detected` mark makes the retention worker purge that recording's audio promptly from S3
      and Twilio.
    - **Backfill what is already stored.** Everything above guards writes from now on. Card numbers
      captured before this ships would stay in every store still holding them. That includes rows
      older than the retention window: recordings on legal hold, and the transcripts, chunks and
      embeddings derived from them, are exempt from purging (`recording-retention-worker.ts:20-21`,
      `:191-194`). The backfill therefore isn't bounded by the retention window. A scrub removes
      only the card number and keeps the record, so it doesn't conflict with a hold.
      - Add a bounded, resumable, one-time job that runs per tenant, in batches, under the tenant
        transaction.
      - It runs the same scrubber over every remaining row of the designated text stores, whatever
        its age: `call_transcript_turns`,
        `voice_sessions.transcript`, `voice_recordings.transcript` with its
        `raw_transcript_retention`, `knowledge_chunks.content` and `content_scrubbed`, and the
        `ai_runs` input/output snapshots. Every designated column is covered; the context builder
        sends `content_scrubbed` back to the model (`context-builder.ts:189`).
      - **It applies the same cross-turn detection as live writes.** A caller who split a card
        number across turns before the deploy left rows that each fall under 13 digits.
        - For each session, the backfill walks the stored caller turns of `call_transcript_turns`
          in order, over the same bounded window the live path uses.
        - It rewrites every contributing span in one transaction.
        - It does the same for any session-level transcript stitched from those turns.
        - Test: a pre-deploy session with a card number split over three turn rows is redacted in all
          three by the backfill.
      - It deletes or regenerates the embedding of every knowledge chunk it changes, so a vector
        built from the card number can't keep matching.
      - It sets every remaining recording, legal-hold ones included, to `pci_scan = 'pending'`, so
        the audio pass covers recordings made before the deploy too. A held recording that is found
        to contain a card number is kept, because of the hold, but flagged and audited for the
        owner. Whether held audio can be redacted is a legal call for the owner.
      - It writes one audit event per tenant, with the redaction counts.
      - It is idempotent: a re-run changes nothing further.
  - **PRIV-4**
    - Every telephony greeting branch, including custom tenant greetings, includes a plain disclosure
      such as "I'm a virtual assistant".
    - Keep the per-tenant wording override.
    - Ledger it the same way `discloseRecording` does.
    - Do not gate it on the caller's state, which is an unreliable area-code proxy.
  - **PRIV-6:** the config refuses `LANGFUSE_CAPTURE_CONTENT=true` in production or staging, unless
    the base URL is self-hosted or an explicit acknowledgement variable is set.
- **Test scenarios:**
  - **Unit, scrubber:**
    - Luhn-valid PANs are scrubbed, grouped or not.
    - Non-Luhn digit runs and phone numbers are untouched.
    - An unspaced PAN no longer leaks its first five digits through the exporter.
  - **Unit:** the deleter treats 404 as done and keeps the token out of logs.
  - **Unit:** a Whisper voicemail transcript containing a PAN is persisted scrubbed, in both
    `transcript` and `raw_transcript_retention`, and its recording is flagged. The correction call
    never receives the digits.
  - **Unit:** a column added to the designated list without a scrubbing write path fails the
    coverage test.
  - **Unit:** each greeting branch contains the disclosure.
  - **Unit:** the config guard rejects and accepts the right combinations.
  - **Integration (PRIV-1),** RLS on:
    - only rows older than retention are scrubbed
    - FKs stay intact
    - newer rows are untouched
  - **Integration:** the recording flow inserts the row, then deletes the Twilio copy; a failed delete
    is retried by the sweep.
  - **Integration (PCI before callback):** a PAN is detected mid-call, then the process restarts before
    the recording callback. The `pci_detections` record survives, the recording row created later
    inherits `pci_detected`, and its audio is purged from S3 and Twilio.
  - **Integration (persist fails):**
    - The detection write fails because the DB is down.
    - The live recording is paused.
    - After recovery, the callback creates the row as `pci_scan = 'pending'`.
    - The ingestion scan marks it `pci_detected`, and the audio is purged on the PCI schedule.
    - A clean call clears to `clean` and keeps the normal policy.
    - Partial loss: only the turn holding the card number fails to persist, while later turns do. The
      audio pass still finds the card and marks the recording `pci_detected`.
    - Split failure: on the Gather path the detection write fails, but the transcript turn (already
      scrubbed to `[card number]`) is persisted. The scan marks the recording `pci_detected`; it
      never clears it.
  - **Integration (backfill):**
    - A transcript turn, an `ai_runs` row, a recording's `raw_transcript_retention`, and both columns
      of a knowledge chunk that held a PAN before the migration are scrubbed by the backfill. The
      chunk's embedding is regenerated or removed.
    - A recording made before the deploy is set to `pending` and goes through the audio pass.
    - A second run changes nothing.
    - A legal-hold recording older than the retention window has its transcript, chunks and embedding
      scrubbed. The recording is flagged and audited, not deleted.
- **Verification:** a PAN read aloud never reaches `ai_runs`, `call_transcript_turns` or the provider
  payload in tests.

### U5. Live-call reliability — batch E, `fix/ai-hardening-voice-reliability`

- **Goal:** no dependency failure leaves a caller in silence or hangs up on a promise. Deploys don't
  drop live calls.
- **Requirements:** R1, R2, R5
- **Dependencies:** none
- **Findings:** LCR-01, LCR-02, LCR-03, LCR-04, LCR-05 (high); LCR-06 (medium).
- **Files:**
  - `packages/api/src/ai/tts/tts-provider.ts`
  - `packages/api/src/telephony/media-streams/mediastream-adapter.ts`
  - `packages/api/src/ai/voice-turn/shared/low-stt-ladder.ts`
  - `packages/api/src/telephony/twilio-adapter.ts` — not `bootstrapCallEstablishment` or
    `buildTelephonyGreeting`, which belong to U4
  - `packages/api/src/voice/transcription-providers.ts` (Deepgram aggregation, `utterance_end_ms`)
  - `packages/api/src/routes/telephony.ts`
  - `packages/api/src/integrations/twilio/provisioning.ts`
  - the Twilio webhook credential resolver
  - `packages/api/src/app.ts` `runShutdown`
  - `packages/api/src/shared/config.ts` `validateFeatureRequiredConfig`
  - `docs/runbooks/voice-capacity.md`
  - a new backfill script under `scripts/`
- **Approach:**
  - **LCR-01**
    - Add an opt-in `outputFormat: 'pcm_16000'` on `ElevenLabsTtsProvider.synthesize`, which the
      media-streams `synthesizeBounded` always passes.
    - `failDisclosureClosed` degrades to Gather before closing.
    - After a turn whose stream and PCM recovery both failed, degrade to Gather (`tts_unavailable`).
  - **LCR-02**, split by cause:
    - When the pipeline fails or confidence stays low, dispatch the FSM's `system_failure` through the
      host processor. Its `notify_oncall` then parks a `<Dial>`, or the no-one-available voicemail.
    - When the line is silent, offer voicemail or `<Record>` or a callback. Never page on-call.
    - The terminal copy never promises a transfer that the path can't deliver.
    - Update the pins at `mediastream-adapter.test.ts:2880` and `:3444`.
  - **LCR-03**
    - Buffer `is_final` segments and emit one `final` (joined text, minimum confidence) on
      `speech_final` or `UtteranceEnd`, and add `utterance_end_ms=1000`.
    - Forward the buffered segments as partials, so barge-in and the emergency interim scan still see
      them.
    - Never dispatch a final after teardown.
  - **LCR-04**
    - Provision `VoiceFallbackUrl` (POST) at purchase. Point it at a static, DB-free voicemail TwiML
      route.
    - **That route must work with the DB down, so it can't sit behind DB-backed signature
      verification.** The router puts `requireTwilioSignature` on every route
      (`routes/telephony.ts:425-430`), and the credential resolver fails closed when its DB lookup
      throws (`telephony/twilio-webhook-credential.ts:196-208`). A cache of credentials that was
      never filled can't help a cold process.
      - Mount the fallback route outside that middleware, as a documented exemption.
      - Make it side-effect-free. It serves fixed, tenant-neutral voicemail TwiML: no DB read, no
        write, no tenant data, and so no business name. A forged request learns nothing and changes
        nothing.
      - The recording status callback it names stays on the verified router. A recording whose
        callback fails is recovered by the reconciliation sweep.
      - The callback URL must carry the call's `From` and `To`. Twilio's `recordingStatusCallback`
        POST includes neither, and on a cold process there is no in-memory session to supply them.
        Without them `voicemail-status-route.ts:227-299` can't resolve the tenant and returns 200
        with no lead and no recording. So the fallback route copies the incoming request's `From`
        and `To` into the callback query, the way `buildVoicemailTwiml` already does with
        `callerPhone` / `dialedNumber`. The route still reads no DB.

        This is safe even though the route is unsigned. Only Twilio's own fallback request leads
        to a callback, and that callback is signature-verified, including its query.
      - A test pins the route against all of these: no DB access, no mutation, no signature
        dependency.
      - **The app-hosted route doesn't cover a cold start with the DB down.** It covers failures
        inside a running process: the DB lost after boot, a handler that throws, a provider
        outage. With `RLS_RUNTIME_ROLE=true`, startup calls `verifyRlsRuntimeRole(pool)` and exits
        the process when its DB connection is refused (`app.ts:997-1001`), so no instance is up to
        serve it. Serving tenant traffic with that check skipped is not acceptable. A restricted
        fallback-only serving mode was considered and rejected: it is a second boot path that runs
        with RLS enforcement unverified, and a Twilio-hosted target does the job without it.
      - **A Twilio-hosted fallback is mandatory in production.** Each number's `VoiceFallbackUrl`
        is a static, tenant-neutral TwiML target that Twilio itself serves (for example a
        Serverless Function or a TwiML Bin in the subaccount): a short apology and a `<Record>`
        to Twilio-side storage. The recording is then picked up by the reconciliation sweep
        below, which lists each subaccount's recordings. The app-hosted route stays the
        `VoiceFallbackUrl` in non-production, where no Twilio-hosted target is set.
        - Purchase provisioning sets it for new numbers. The backfill (owner decision 5) sets it
          for existing ones.
        - `validateFeatureRequiredConfig` refuses a production boot with voice enabled and no
          Twilio-hosted fallback target configured. The backfill's dry run lists every number
          whose fallback isn't the Twilio-hosted one, and the go-live check in
          `docs/runbooks/voice-capacity.md` flags the same.
    - Keep an in-memory TTL cache of verified webhook credentials, used only when the DB lookup
      throws. It helps a warm process ride out a short brownout on `/voice` and `/gather`. It is not
      the outage path; the exempt fallback route is.
    - The 503 and "try again later" `<Hangup/>` catch-alls on `/voice` and `/gather` become 200 plus
      `buildVoicemailTwiml`.
    - Write an idempotent backfill script for existing numbers that defaults to a dry run. Running it
      is an owner action.
    - **Never rely on Twilio retrying a 5xx; by default it does not.** This overrides the verifier's
      "let its handler 5xx and be retried later". During an outage the fallback `<Record>` still
      captures the audio, and Twilio holds it until it is ingested; PRIV-2 deletes Twilio's copy only
      after ingestion succeeds. Add a reconciliation sweep that does three things:
      - lists each subaccount's recordings through the Twilio Recordings API from a durable
        watermark, not an unspecified "recent" window. A window would let recordings age out
        unseen whenever the sweep is stopped, rate-limited or failing to authenticate for longer
        than the window. So:
        - Keep a per-subaccount watermark in the DB, and re-read a fixed overlap behind it, so
          late-arriving recordings are still picked up.
        - Page through every result.
        - Advance the watermark only after every page has been processed successfully.
        - Alert when the watermark lags beyond a threshold.
      - for any recording whose URL has no `voice_recordings` row (`recording_url` is the idempotency
        key), fetches the parent call's From/To through the Calls API and replays every leg the
        missed callback would have run, through the same handler code rather than a second
        implementation:
        - Twilio's recording `source` tells a voicemail `<Record>` (`RecordVerb`) from a call
          recording.
        - For a voicemail, that means the receipt-guarded lead leg (provider
          `twilio_voicemail_lead`, keyed on RecordingSid) as well as the recording and hand-off legs.
          A sweep that only inserts the recording would lose the lead.
      - **Ingestion is serialized per recording, because the sweep can overlap a late callback.**
        `recordInboundCall` (`voice/voice-service.ts:556-583`) dedupes with
        `SELECT … FOR UPDATE` and then an `INSERT`. Postgres locks no row that doesn't exist yet, and
        nothing is unique on `(tenant_id, call_sid, recording_url)`. A sweep replay racing a delayed
        Twilio callback, or two overlapping callback retries, can therefore both insert, which
        creates duplicate file and recording rows and two transcription hand-offs. So:
        - Inside the same transaction, before the SELECT, it takes
          `pg_advisory_xact_lock(hashtext(tenant_id || call_sid || recording_url))`. Concurrent
          ingests of one recording then run one at a time, and the second finds the first's row.
        - It needs no migration, so it can't fail at boot on duplicates that already exist.
        - A partial unique index is the follow-up, once a one-time job has deduped existing rows.
        - Test: a callback and a sweep replay of the same recording run concurrently on real
          Postgres. Exactly one `voice_recordings` row, one `files` row and one hand-off result.
        - This applies to the callback path already on `main`, not only to the sweep.
      - also resumes recordings that do have a `voice_recordings` row but no success receipt. The
        upload and insert succeeded, then the transcription hand-off failed, and Twilio does not
        retry the resulting 5xx. The sweep picks up from the stored S3 object and re-runs only the
        legs still missing, so the voicemail still reaches transcription. It never re-fetches from
        Twilio.
      - alerts through `alertOperator` on any recording it cannot ingest
    - **Fix a live lead-loss bug the sweep depends on.** Today `voicemail-status-route.ts:315-388`
      records the `twilio_voicemail_lead` receipt and only then calls `createLead`. A `createLead`
      failure is only logged as a warning and processing carries on, so every later delivery or
      sweep replay sees the receipt and skips the lead. One transient failure therefore loses that
      voicemail's lead permanently. Fix it in either of two ways:
      - make the receipt a resumable claim (`pending` → `completed`) that is completed only after the
        lead and its audit event commit, and have the sweep resume `pending` claims
      - or write the lead, its audit event and the receipt in one transaction, keyed idempotently on
        RecordingSid

      Either way, a lead failure must leave the leg retryable, not silently done.
    - Twilio connection-override retry parameters on the callback URL are optional. Use them only
      after confirming against Twilio's documentation that they apply to recording status callbacks.
  - **LCR-05**
    - `runShutdown` first redirects live media-streams calls to `/voice/gather-fallback`.
    - An unknown-session `/gather` starts a fresh inbound session, logged as a deploy-induced restart.
    - The config refuses `NUM_REPLICAS>1` on processes that serve telephony.
    - Fix `docs/runbooks/voice-capacity.md:113-115`.
  - **LCR-06**
    - `shouldUseRealtimeStream` returns Gather at the per-tenant cap. This adds the registry to the
      router deps and exports the cap.
    - In `handleStart`, set the call ids before the cap check, then degrade to Gather.
- **Test scenarios:** handler-level, with mocked providers.
  - TTS stream failure → PCM REST recovery plays.
  - Greeting failure → degrades to Gather.
  - Ladder cap after a pipeline failure → Dial or voicemail TwiML.
  - Silence cap → voicemail or callback, with no page.
  - Three `is_final` fragments → one turn.
  - The 51st caller → Gather.
  - Shutdown → live calls redirected.
  - Unknown session → a fresh disclosed session.
  - The config guard.
  - The app-hosted fallback route returns static TwiML with no DB read and no warm credential cache,
    including when the DB is lost after boot.
  - Provisioning a number in production sets `VoiceFallbackUrl` to the Twilio-hosted target, and the
    backfill's dry run and the go-live check report a number whose fallback is anything else.
  - **Manual drill** (recorded in `docs/runbooks/voice-capacity.md`): stop the DB, cold-start the app,
    place a call. The Twilio-hosted fallback answers, and its recording is ingested by the sweep once
    the DB is back.
  - A recording callback that fails while the DB is down → after recovery, the reconciliation sweep
    ingests that recording exactly once.
  - The DB is down before `/voicemail-status` runs → after recovery, the sweep creates exactly one
    lead and one voicemail recording, and replaying the sweep creates neither again.
  - The lead receipt is recorded, then `createLead` throws. The lead leg stays retryable, and the next
    delivery or sweep creates exactly one lead.
  - The sweep is down for longer than any rolling window. On restart it resumes from the watermark,
    misses no recording, and creates no duplicates in the overlap.
  - An app-hosted fallback voicemail whose callback arrives after the DB recovers creates its lead and recording
    straight from the callback, using the `From`/`To` in its query, without waiting for the sweep.
  - The upload and insert succeed, then the hand-off fails before the success receipt. The sweep resumes
    from the stored S3 object and hands the voicemail to transcription exactly once, with no Twilio
    re-fetch.
- **Verification:** no test path ends a call right after a "connect you" line.

### U6. Injection fences, alerting and eval gates — batch F, `fix/ai-hardening-injection-ops`

- **Goal:**
  - Internet-supplied text is fenced on every prompt path.
  - A single tenant's AI outage or runaway spend pages someone.
  - Prompt changes meet a real-model eval before merge.
- **Requirements:** R1, R2, R3
- **Dependencies:** none
- **Findings:** PI-1, OBS-3, OBS-4 (medium); PI-4 (low).
- **Files:**
  - `packages/api/src/voice/tenant-glossary-provider.ts`
  - `packages/api/src/workers/transcription.ts`
  - `packages/api/src/reputation/{classifier,draft-public-response,draft-private-followup}.ts`
  - `caller-text-fence-sites.test.ts`
  - `packages/api/src/monitoring/pg-failure-monitor.ts`
  - `packages/api/src/workers/failure-rate-monitor.ts`
  - config thresholds
  - `.github/workflows/agent-path-smoke.yml`, plus a skip-pass shim job
- **Approach:**
  - **PI-1**
    - Glossary terms must be name-shaped: at most about 40 characters and 4 words, matching
      `^[\p{L}\p{N}][\p{L}\p{N}'’.&\- ]*$`. This applies to every source.
    - The glossary renders inside its own `buildUntrustedContentSection`, and the system prompt covers
      both fenced blocks.
  - **PI-4**
    - Review text goes inside `buildUntrustedContentSection` in all three calls, and every system
      prompt gets the never-instructions rule.
    - Optionally, flag drafts that contain URLs.
  - **OBS-4**
    - A per-tenant failure-rate rule (`GROUP BY tenant_id, task_type`), with its own floor and the
      cooldown key `ai_task_failure_rate:<task>:<tenant>`.
    - A platform spend rule on `SUM(cost_micro_cents)` against configured thresholds.
    - **Unpriced runs must not hide spend.** The production default `gpt-4o-mini` is deliberately
      unpriced, so its `cost_micro_cents` is null and `SUM` skips it; on its own the spend rule could
      never page on a runaway loop using the default model. So add:
      - a token-volume rule (summed prompt + completion tokens per window, for the platform and per
        tenant), which pages whether or not prices are known
      - an "unpriced model in production" alert, raised when completed runs with null cost exceed a
        small floor, pointing at `AI_MODEL_PRICING_JSON`
    - **Count every physical attempt, not only the logical call.** Take a provider that bills an
      attempt, then times out, and then succeeds on the retry inside `ProviderRetryDeadlineWrapper`.
      The `ai_runs` row records only the retry's usage, and the failure-rate rule sees a completion.
      Volume rules built on `ai_runs` alone would therefore miss a spend loop driven by retries.
      This must not depend on U8, which is optional.
      - The retry wrapper reports, per logical call: physical attempts, ambiguous attempts (timeout
        or reset after send), and each ambiguous attempt's worst-case token bound.
      - The gateway persists these on the `ai_runs` row, in nullable integer columns added by an
        idempotent migration.
      - The token-volume rule adds ambiguous attempts at their bound.
      - A retry-rate alert fires when attempts per call exceed a threshold.
      - U3 also edits the retry wrapper. Keep this a minimal hook, and merge after U3 or resolve
        against it.
    - All of these go through `alertOperator`.
  - **OBS-3**
    - **Gate each prompt family with an eval that exercises it.** Widening a path filter only starts a
      job; a broken public-response, estimate-drafting or summary prompt passes an intent-only job.
      - Build a map from prompt family to eval: grep for system prompts and `gateway.complete` call
        sites.
      - Intent classification and slot extraction use the cost-capped
        `run-intent-eval.ts --live --gate` and the slot eval against the recorded live baselines.
      - Add small, cost-capped, real-model golden checks for `draft_estimate`, the review-response
        drafters and the session summary. Each check asserts that the output parses against its
        schema and that every price is catalog-resolved, never invented. It also asserts that fenced
        input is treated as data.
      - Each family's paths trigger only the evals that exercise that family.
      - Any family still without an eval is listed in the workflow file and the PR as ungated. The
        gate claims nothing about it.
    - Add a skip-pass shim, so the check can be made required without hanging unrelated PRs.
- **Test scenarios:**
  - **Unit:** an injection-shaped customer name is dropped from the glossary or fenced.
  - **Unit:** an injection-shaped review is fenced, and the fence-sites test covers the three new
    sites.
  - **Unit:** the per-tenant, spend, token-volume and unpriced-model evaluators. A null-cost runaway
    loop still pages through the token-volume rule.
  - **Unit:** a timeout followed by a successful retry is counted as two physical attempts, one of them
    ambiguous. The token-volume rule includes the ambiguous attempt at its bound, and the retry-rate
    alert fires past its threshold.
  - **Integration:** an aggregate test that seeds two tenants, one failing and one healthy, and expects
    only the failing tenant to alert.
  - **Workflow YAML:** it parses (actionlint if available), and the secret references match the
    existing jobs.
- **Verification:** the per-tenant rule alerts on a tenant that the platform-wide rule would dilute.

### U7. Data-subject erasure (PRIV-5) — after U4, needs an owner decision

- **Goal:** an owner can erase one customer's personal data and AI artifacts, short of purging the
  whole tenant.
- **Dependencies:** U4 (the Twilio deleter seam and the `ai_runs` purge), plus owner decision 1 below.
- **Design rules:** both rules under Key Technical Decisions apply. In this unit:
  - **Durable, resumable jobs:** the erasure job that runs phase 2, the out-of-database erase
    record, the S3 re-delete, the Langfuse second delete, each outbound send's write-ahead row,
    the owner's candidate confirmations, and the `erase_incomplete` alert.
  - **Limits serialized with their consumers:**
    - The tombstone and every fenced writer, under the erasure lock, which covers every key the
      tombstone holds. That includes a key phase 2 adds, such as a lead the lead step records or
      a key the inbox mover collects under a late link, each of which takes its stripe in
      exclusive mode like phase 1, and a released send, which passes the fence again before its
      flip.
    - The job's close and every late target that re-opens it, a re-armed target included, under
      the job row's lock. Every U7 transaction that touches a job row takes it first, and takes
      several job rows in ascending id order.
    - Each step's terminal transition, under that step's own generation.
    - The historical `ai_runs` scan reads no retention setting at all, so a window changed
      mid-erase can't narrow it.
- **Design:** the full draft design for this unit (every mechanism, its tests and its code
  references) is in [`docs/plans/2026-10-18-002a-u7-data-subject-erasure-design.md`](2026-10-18-002a-u7-data-subject-erasure-design.md). It is a draft to review when
  owner decision 1 is made, not an implementation-ready spec: review it on its own PR
  before any code, the way every other unit here was reproduced first and fixed test-first.

### U8. Money cap on AI spend per tenant (the GATEWAY-05 follow-up) — after U3, needs an owner decision

- **Goal:** a tenant's AI spend can be capped in money, which the token buckets cannot do.
- **Dependencies:** U3, plus owner decision 2 below.
- **Design rules:** both rules under Key Technical Decisions apply. In this unit:
  - **Durable, resumable jobs:** each attempt's reservation (reserve, dispatch, settle, with the
    lease reaper as its resume), repricing, the 80% alert, the bound-breach alert, and the Vapi
    settle when owner decision 2 charges Vapi.
  - **Limits serialized with their consumers:** the ceiling and every reservation and ledger
    transition, under one per-tenant spend lock. The ceiling, the month and the decision to admit
    an unpriced attempt are each read after that lock is granted.
- **Design:** the full draft design for this unit (every mechanism, its tests and its code
  references) is in [`docs/plans/2026-10-18-002b-u8-ai-spend-cap-design.md`](2026-10-18-002b-u8-ai-spend-cap-design.md). It is a draft to review when
  owner decision 2 is made, not an implementation-ready spec: review it on its own PR
  before any code, the way every other unit here was reproduced first and fixed test-first.

## Owner decisions and actions (not code)

1. **PRIV-5 erasure scope.** Confirm the U7 defaults, especially anonymizing financial records rather
   than deleting them, and keeping consent and DNC rows.
2. **A money cap on AI spend** (U8). Decide whether you want it, and whether to set a platform
   default.
3. **An auto-approve threshold floor** (OVAS-04, part b). The UI offers a permissive preset and an
   Advanced input down to 0.50. If you want a floor, change the UI and the schema together.
4. **AI-disclosure wording and placement** (PRIV-4). Counsel to confirm.
5. **Run the VoiceFallbackUrl backfill** for existing numbers (U5 ships the script with a dry-run
   default). It points them at the Twilio-hosted fallback, which production requires.
6. **Make the live AI eval a required check** (U6):
   - Mark it required in branch protection.
   - Disable Railway's GitHub auto-deploy, so the `deploy.yml` gates apply.
7. **Voice scale-out.** Externalize voice session state, or add call affinity, before running voice on
   more than one replica (U5 adds a config refusal until then).
8. **Map pricing plans to tenant AI tiers** (GATEWAY-01). Batch C makes the tier table configurable.
9. **Raise the Cursor Bugbot usage limit.** It currently refuses to run on PRs.

## Other outstanding work (not part of this audit)

- **"Pick, don't build" onboarding** (`docs/plans/2026-10-18-001-feat-pick-dont-build-onboarding-plan.md`).
  S1, S1b (#1694) and S2 (#1693) are merged. Still to do:
  - S3: voice.
  - S4: the U5 override, whole-draft undo/reset with `updateStatusIf`, the owner-cell prompt and
    approval gate, the shared `updateLocked`. S4 also closes #1693's two still-open review threads:
    there is no undo while the save is pending, and the cell is not persisted before cell-dependent
    policies apply.
  - S5: forwarding, the `payment_collection_mode` consumers, and reopening and re-running the price
    card.
  - S6: the pre-signup demo call, which is gated on a decision.
- **D11, not yet in the onboarding plan.** The demo-call phone allowance must be tied to the
  `demo_calls` row, and released under the same definitive-no-call guard as the budget reservation.
  Ambiguous outcomes keep the allowance.
  - First test: a preflight failure or a definitive 4xx leaves the same-day retry free; a timeout or
    5xx keeps the allowance; a replayed release returns it once.
  - Fold it into that plan's "Deferred review findings" as D11 (the intro count goes from ten to
    eleven), with the next commit that touches that plan.
- **A known flaky test:** `packages/api/test/settings/voice-approval-pin-route.test.ts:127` fails about
  0.1% of runs. It is a one-line hardening candidate.

## Risks & Dependencies

- **Files more than one batch edits.** Keep each batch's hunks localized. The batch merged second
  resolves conflicts by merging `main` in (never a rebase on a shared branch).

  | File | Batches |
  |---|---|
  | `packages/api/src/ai/gateway/gateway.ts` | U3, plus U4's PAN hunk |
  | `packages/api/src/telephony/twilio-adapter.ts` | U5, plus U4's greeting functions |
  | `packages/api/src/voice/transcription-providers.ts` | U5's aggregation, plus U4's `redact=pci` |
  | `packages/api/src/shared/config.ts` | U4, U5 |
  | `packages/api/src/app.ts` | all six (wiring only) |
- **Migration key collisions.** See Key Technical Decisions. The second merge renumbers and updates
  the immutability snapshot.
- **Behaviour changes owners and callers will notice:**
  - Technicians and dispatchers see more drafts held for review (U2).
  - Every call now includes an AI-disclosure sentence (U4).
  - A dead line gets voicemail or a callback offer instead of a false "connecting you" (U5).
  - Call these out in each PR description.
- **Required check (U6).** If the live eval is made required before the shim is in place, unrelated
  PRs hang. Land the shim first.

## Open Questions

- Does a tenant plan field exist that can drive `tenantTier` (U3)? If not, the default concurrency is
  raised and the mapping waits on owner decision 8.
- Is `dataset-hooks.ts` (U4) still unimported on current `main`? The same question applies to
  `proposal-linkage.ts` and `createIntentRun` (U2). Re-grep before deleting.
