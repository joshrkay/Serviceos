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
  - Each batch that needs a migration takes the next free key at the time it is written; the current
    max on 20637e004 is `313_onboarding_drafts_owner_phone`.
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
    - **That route must work on a cold process with the DB down, so it can't sit behind DB-backed
      signature verification.** The router puts `requireTwilioSignature` on every route
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
      - Optional, for an outage of the whole API rather than only the DB: point `VoiceFallbackUrl`
        at a Twilio-hosted target instead (a Serverless Function provisioned per subaccount). That
        is an owner choice, because it adds a Twilio deployment surface.
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
  - The fallback route returns static TwiML with no DB and no warm credential cache. It answers on a
    cold process with the DB down.
  - A recording callback that fails while the DB is down → after recovery, the reconciliation sweep
    ingests that recording exactly once.
  - The DB is down before `/voicemail-status` runs → after recovery, the sweep creates exactly one
    lead and one voicemail recording, and replaying the sweep creates neither again.
  - The lead receipt is recorded, then `createLead` throws. The lead leg stays retryable, and the next
    delivery or sweep creates exactly one lead.
  - The sweep is down for longer than any rolling window. On restart it resumes from the watermark,
    misses no recording, and creates no duplicates in the overlap.
  - A fallback voicemail whose callback arrives after the DB recovers creates its lead and recording
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
- **Patterns to follow:**
  - `packages/api/src/integrations/twilio/a2p-10dlc/registration.ts:21-24` and
    `packages/api/src/workers/a2p-10dlc-registration.ts` (a provider workflow that checkpoints every
    created resource and resumes after a crash)
  - `packages/api/src/proposals/pg-proposal.ts:644-655` (a guarded claim) and `:657` (stale claims
    retried, then failed after a retry limit)
- **Approach**, recommended defaults pending that decision:
  - The endpoint is `POST /api/customers/:id/erase`:
    - owner-only and audited
    - an explicit human action, never an AI proposal
    - **Two phases, not one transaction.** The tombstone has to be visible to other processes
      before the scrub starts. `executeAudited` opens `BEGIN` and commits only after its whole state
      change and its audit insert, so a tombstone written inside the same transaction would stay
      invisible while in-flight writers pass their checks. The erase therefore runs in two phases:
      1. A short audited transaction commits the tombstone (and an `erase_started` audit event).
      2. A durable erasure job then runs the target snapshot, the scrub, the external cleanup, the
         drain and the final re-scan, each step in its own short audited transaction, and records
         `erase_completed` or `erase_incomplete`.
    - **Phase 2 is a durable, resumable job, not code that runs after the request.** A process can
      exit after phase 1 commits. The tombstone would then keep fencing the subject while nothing
      finished the erase, and the customer would stay partly erased indefinitely. So:
      - **One job row per erase, written by phase 1.** Phase 1 inserts a `customer_erasure_jobs` row
        in the same transaction as the tombstone and `erase_started`, so a tombstone never exists
        without a job. The table has `tenant_id` and RLS like every tenant table. It has a unique
        index on `(tenant_id, customer_id)`, so a second erase request returns the existing job
        instead of starting another.
      - **Every table U7 adds carries `tenant_id` and forced RLS, not only the job row.**
        `rls-force-catalog.test.ts` checks only tables that have a `tenant_id` column. A table
        keyed only by `job_id` would ship without RLS and still pass, and the status-callback and
        email-event handlers, which start with no tenant context, could then write against another
        tenant's job. So:
        - `customer_erasure_steps`, the tables that hold step targets and candidates,
          `customer_erasure_identifiers` (see "The raw identifiers outlive the `customers`
          scrub" below), `erasure_storage_cleanup`, the tombstone, the late-link inbox (see "A
          write that links new data to the erased subject" below), the start-failure counts
          (see "Repeated failures to start alert" below), and the fence's write-ahead claims if
          they get a table of their own, each have `tenant_id NOT NULL`, `ENABLE` and
          `FORCE ROW LEVEL SECURITY`, and the usual tenant policy.
        - Each child row references its job by `(tenant_id, job_id)` →
          `customer_erasure_jobs (tenant_id, id)`, so a row can't point at another tenant's job.
        - **The test derives that set from the catalog, not from a list of U7 tables.** A list
          would have to be kept by hand, and a later U7 table left off it would escape both tests.
          A fence claims table isn't reached through the job either. Claims exist before any
          erase, so a new sink's claims table, keyed by `customer_id` and `source_id`, has no
          foreign key to the job. If it also had no `tenant_id`, `rls-force-catalog.test.ts`
          would skip it, and a status-callback handler could write another tenant's claim. So
          each of these must have `tenant_id NOT NULL` and forced RLS:
          - every table with a foreign key to `customer_erasure_jobs`, and every table the
            manifest classifies as "the erasure record"
          - every claims table that an `externalSinks` entry names
          - every table that has a manifest entry
          The only exceptions are on a short explicit list of global tables, each with a reason,
          such as the capture-on intervals and `webhook_events`. A foreign key to
          `customer_erasure_jobs` must be the composite one above, and the test fails on any
          single-column foreign key to it.
        - **The global list is pinned and constrained, not a free allowlist.** A new sink's
          claims table could be created without `tenant_id`, because its webhook starts with no
          tenant context, and added to the list with the reason "written by a tenantless
          webhook". The test would pass, and the handler could write another tenant's claim. So:
          - The list sits in the same reviewed snapshot as the `exempt` ids (see "`exempt` is not
            a free-text allowlist" below).
          - It can't hold a table that has a foreign key to `customer_erasure_jobs`, that an
            `externalSinks` entry names, or that has a subject-key column (the names listed in
            "The catalog test also finds tables linked by the tombstone's other keys" below).
        - A handler that starts with no tenant context takes the tenant from the signed request.
          The per-send status-callback URL carries the tenant id beside the row id, and so does an
          email's custom metadata. The handler sets that tenant before it writes.
      - **The erase's own records are classified `keep`, and hold no subject data once done.** The
        job row's `customer_id` and the tombstone's customer id are `%customer_id` columns, so the
        coverage test forces a classification. As `scrub` or `anonymize` they would get the
        erasure trigger, and phase 1's own insert would be refused, because its tombstone is
        visible inside its own transaction. So:
        - Every table U7 adds is classified `keep`, with the reason "the erasure record", and has
          no erasure trigger.
        - An S3 key can name the subject. An attachment key ends in the uploaded filename
          (`routes/attachments.ts:136`, `${fileId}-${safeName}`). So each S3 target and cleanup
          row stores the bucket, the `files` id when there is one, and the key encrypted with
          `encrypt`. The key is nulled in the transaction that marks its target done. The S3 step
          also nulls the key on each subject write-ahead claim it took a target from.
        - A stored error keeps only the provider's error code and HTTP status, never its message
          text, which can echo the customer's name.
        - These tables are `keep`, but each of their columns is still classified (see "Coverage
          is per column" below). A later `last_error text` that stored a provider's message would
          fail the schema test.
      - **`audit_events` is classified `anonymize` by metadata key.** It is an `entity_type` /
        `entity_id` table (`schema.ts:61-72`), so the coverage test forces a class. Its `metadata`
        JSONB holds subject PII today: `workers/call-me-back-worker.ts:100` writes
        `{ callerPhone }`, with the session id as `correlation_id`. As `keep`, that phone would
        survive every erase. With the plain erasure trigger, phase 1's own `erase_started` event
        would be refused, and so would the audit insert of every audited write on a retained
        invoice, whose `entity_id` is a tombstone key. That rolls back the payment update the
        fence must let through. A trigger keyed on `entity_id` would also take a stripe for U8's
        spend events under the spend lock. So:
        - **The manifest classifies `(event_type, key)` pairs, not bare keys.** A bare key can mean
          two things. `jobs/job-money-state.ts:139` writes `{ from, to }` holding money states on
          a job, and `routes/onboarding.ts:955` writes `{ from, to }` holding phone numbers. A
          list of bare safe keys would have to hold `from` and `to`, so a later
          `customer.phone_changed { from, to }` would keep both phones through the erase. `error`
          and `name` are ambiguous the same way. So each pair is listed as PII or safe
          (`callerPhone`, `callerName`, `recipient`, `email`, `phone` and so on, per event type).
          `createAuditEvent` checks each pair against the two lists, and under test it throws on a
          pair in neither. A new event type therefore needs its own entries, even for a key that
          is already listed.
        - **The lists are enforced at build time, and the backstop doesn't depend on them.** A
          throw under test catches only a path some test runs. A later route could write
          `customer.contact_merged { mergedPhone }` through `createAuditEventBestEffort`
          (`audit/audit.ts:95`) with no test on that call. In production the pair is in neither
          list, so the trigger, the strip and the value pass would all treat it as safe, and the
          phone would survive every erase.
          - **A check at the `createAuditEvent` call can't see most audit writes.** The inner
            call is generic almost everywhere. `executeAudited` runs `createAuditEvent(input)`
            on whatever the caller's `audit` callback returns
            (`commands/command-runner.ts:92-101`). `createAuditEventBestEffort` passes its own
            parameter through (`audit/audit.ts:95-100`). About 30 local helpers take
            `eventType: string` and `metadata: Record<string, unknown>`, such as
            `sms/tech-status/handler.ts:75-92` (which adds `fromE164`),
            `invoices/invoice-payment-link.ts:300` and `materials/job-materials.ts:55`.
            Onboarding builds `agent.onboarding.${eventType}` into `SideEffect` objects
            (`ai/agents/onboarding/transitions.ts:86`), which
            `ai/orchestration/onboarding-conversation.ts:370` turns into audit events. Two
            paths insert into `audit_events` with raw SQL (`demo/platform-audit.ts:34`,
            `learning/entity-aliases/pg-entity-alias.ts:93`). A check at the call would fail
            on all of these, an implementer would have to exempt the wrappers, and those are
            exactly the paths left unchecked. A `{ fromName }` added through the tech-status
            helper would then keep the subject's name through every erase, since that row's
            `entity_id` is a message SID that no tombstone key selects. So:
          - The classification is a compile-time type. The manifest generates an
            `AuditEventInput` union keyed by literal `eventType`. Each member has an exact
            `metadata` type, with no index signature and nested objects typed down to their
            leaves. The compiler then checks every object that becomes an audit event, wherever
            it is built: an `executeAudited` callback, a best-effort call, a `SideEffect` or a
            helper.
          - Helpers become generic, `<E extends AuditEventType>(eventType: E, metadata:
            AuditMetadata<E>)`, and so does the audit variant of `SideEffect`.
          - A structural test fails on a cast to `AuditEventInput` or `AuditMetadata`, on an
            `any`- or `string`-typed value where an `eventType` goes, and on SQL that inserts
            into `audit_events` outside `audit/pg-audit.ts`. The two raw inserts above move
            onto the repository.
          - Fixture: a helper typed `(eventType: string, metadata: Record<string, unknown>)`
            that feeds `createAuditEvent` fails to compile.
          - The strip, run on rows keyed by a tombstone key, treats any pair in neither list as
            PII.
          - The trigger's PII pair list is generated from the manifest, and the schema test
            compares the trigger's list with the manifest's.
        - An `error` value is stored as a code, never as `err.message`.
        - **A phase-2 step strips PII by link and by value.** Picking rows only by `entity_id` or
          `correlation_id` misses a row keyed by something else. `sms/tech-status/handler.ts:83-91`
          writes `fromE164`, and its `entity_id` falls back to the message SID when the sender
          isn't a technician. A customer whose text is routed there leaves their phone in a
          `tech_status.unverified_mobile` row that no tombstone key selects. So the step:
          - strips the PII pairs from every audit row whose `entity_id` or `correlation_id` is a
            tombstone key
          - also normalizes and keyed-hashes every string leaf of `metadata` in the tenant's
            audit rows, not only PII-classified values, in a batched scan, and compares it with
            the subject's phone and email hashes. A
            match is scrubbed or candidate-listed by the same corroborated-or-candidate rule as
            the historical `ai_runs` scan, since a household can share a phone.
          The row, its ids and its other keys stay. The final re-scan repeats the value pass.
        - The `audit_events` trigger refuses only a write that sets a PII pair on a row whose
          `entity_id` or `correlation_id` is a tombstone key. It takes a stripe only for a row
          that sets one. `erase_*`, financial and spend events set none, so they pass without a
          stripe.
        - A DNC audit row (`routes/dnc.ts:92`) follows the DNC rows' rule, as a suppression
          record.
        - Test: erase a customer who has a call-me-back audit row. Its `callerPhone` is gone,
          `erase_started` commits, and a later payment on the retained invoice commits with its
          audit event. The seed also holds a message-SID-keyed `tech_status.unverified_mobile` row
          with the subject's phone, and a `{ from, to }` phone-change row on the customer. The
          phone-change row is stripped, and the tech-status row is candidate-listed. Once the
          owner confirms it, no `audit_events` row other than a DNC suppression record holds the
          subject's name, phone or email.
      - **Every target the later steps need is recorded before any step destroys the links to
        it.** A step takes its targets from its own row, never by re-walking links. A crash after
        the scrub has nulled a nullable link, such as `leads.converted_customer_id`, or blanked
        `stripe_customer_id`, would otherwise leave the resumed step with nothing to find. The
        work is split so phase 1 stays short:
        - Phase 1 writes one `customer_erasure_steps` row per store, unique on `(tenant_id,
          job_id, step)`. A store the manifest adds later gets its row on first use (see "Every
          late-target path first makes sure its step row exists" below). Phase 1 writes no
          per-row targets. Their number grows with the customer's history, and phase 1 runs
          under a sub-second deadline (see "Phase 1 is sized by its fence keys" below).
        - The job's first step is `erase_record` (see "Backups keep what the erase removes"
          below). The next, `snapshot`, records every target in batched checkpoints: each local
          row of the closure as a target of its store's step, and the external ids, which are
          the Stripe Customer id, the QuickBooks customer id, the Twilio Call, Message and
          Recording SIDs, the S3 keys, the calendar event ids and the Langfuse trace keys.
        - No step that severs a link or blanks a column starts until `snapshot` is `done`, so every
          link `snapshot` reads is still there.
        - Target rows are unique on `(tenant_id, job_id, step, target_id)`. `snapshot` inserts
          with `ON CONFLICT DO NOTHING`, so it is safe to repeat. A late target is different: it
          may meet a target that is already done, and re-arms it (see "A target that comes back
          re-arms its row" below).
        - **The `target_id` carries the provider's scope, not only its id.** Many provider ids
          are unique only inside a scope. QuickBooks Ids are per company and per entity kind, so
          Jane's Customer can be Id "58" while one of her synced invoices is SalesReceipt "58"
          in the same realm. Both are targets of the one QuickBooks step. With a bare id, the
          receipt would hit the customer's row, `DO NOTHING` would drop it, and its line
          descriptions would stay while the store reports done. A late "58" from another realm
          would instead re-arm the first realm's row, and the realm guard would send it to
          `provider_retained`. So:
          - QuickBooks: `<realm>:<entity kind>:<Id>`.
          - Google Calendar: `<Google account>:<calendar id>:<event id>`, since event ids are
            unique per calendar.
          - Langfuse: `<project>:<trace id>`, since trace ids are unique per project and a
            session can span projects across a config move.
          - S3: a keyed hash of the bucket and key, which stays after the key is nulled.
          - Twilio and Stripe ids are globally unique and stay bare. The row still records the
            account (see "Every external target records the account it lives on" below).
          - The idempotency key and the QuickBooks `requestid` derive from the full
            `target_id`. The re-arm upsert never changes a target's account columns.
          - The seed-and-erase test adds a QuickBooks customer and a SalesReceipt with the same
            Id, and requires both to be anonymized.
        - A late target that arrives before `snapshot` runs is added to its step row like any
          other.
      - **A late target re-opens the job under the job row's lock, so a close can't miss it.** A
        target found later is added to its step in the transaction that finds it. Examples: a SID
        linked by the status callback, a key from a late upload, a recording a fenced webhook
        registers, the owner's confirmation of a candidate. Touching the job row only "if it had
        closed" isn't enough. Under `READ COMMITTED` the worker closing the job and the handler
        adding the target each miss the other's uncommitted write. The job can then close
        `completed` while one of its steps is pending again, and a sweep that claims only
        non-terminal jobs never runs that step. So:
        - Every target add, candidate confirmation and re-open also runs one unconditional
          `UPDATE` on the job row in its transaction. It sets `generation = generation + 1`. When
          the job was terminal, it also puts `state` back to `pending` and stamps `opened_at` and
          `opened_generation` (see "A job-age alarm" below). That takes the job row's lock. The
          step re-open below sets that step's own `next_attempt_at` to now (see "`next_attempt_at`
          is per step" below). It never moves a time gate (see "A time gate is its own column"
          below).
        - **The database enforces the re-open, so no source can skip it.** Targets arrive from at
          least seven places, each written separately: the SMS and call status callbacks, the
          email event handler, the Vapi webhook, the S3 object-created worker, the backstop
          listings, the refusal registration of a sink whose provider copy comes first (see "A
          refusal still registers the external copies" below), and the owner's candidate
          confirmation. One that inserts its
          target but skips the job-row `UPDATE` would leave a `completed` job that the sweep never
          claims again, and the job-age alarm watches only open jobs. So triggers on each
          step-target table run that job-row `UPDATE`, and the step re-open below, in the writing
          transaction. These are U7's own `keep` tables, so they don't meet the erasure trigger. A
          candidate confirmation adds its rows as targets, so it fires them too. The daily retry
          and the repeat `POST` add no target, and run the same re-open directly.
        - **The re-open triggers are statement-level, so a batch touches the job row once.** A
          row trigger would run one job-row `UPDATE` and one step-row `UPDATE` per target, and a
          `snapshot` batch of thousands of targets would rewrite the same two rows thousands of
          times in one transaction. So each step-target table has statement-level `AFTER
          INSERT` and `AFTER UPDATE` triggers with transition tables. The function reads the
          inserted rows, or the old and new rows of an update, keeps those that became
          `pending`, and runs one job-row `UPDATE` and one step-row `UPDATE` per (job, step)
          among them: jobs in ascending id order, each job before its steps.
        - **Every late-target path first makes sure its step row exists.** The tombstone is never
          lifted, so a job outlives changes to the manifest, and phase 1 created step rows only
          for the stores that existed then. Say a later release adds an `anonymize` table linked
          by `payment_id`, and months after a job completed, a row for the erased customer's
          retained payment is inserted. Its target insert would fail the foreign key to
          `customer_erasure_steps` with `23503` on every mover pass, every minute. The job stays
          `completed`, the age alarm watches only open jobs, and nothing would alert. So:
          - Every path that adds a target (the inbox mover, the status-callback, email-event and
            Vapi handlers, the S3 object-created worker, the backstop listings, refusal
            registration and owner confirmation) first runs `INSERT INTO customer_erasure_steps
            (…) VALUES (…) ON CONFLICT (tenant_id, job_id, step) DO NOTHING` under the job-row
            lock. The target insert, and the re-open its trigger runs, then find the row.
          - **A step re-open always matches its row, and raises only when the row is missing.**
            It never passes silently. A re-open written as an `UPDATE ... WHERE state <>
            'inputs_expired'` would match no row for an `inputs_expired` step and raise on every
            mover pass (see "The step re-open and `inputs_expired`" below).
          - A confirmation adds its targets to one confirmation step per candidate kind, created
            on first use by the same upsert. A step row per confirmation would fail with `23505`
            on the second confirmation of a kind, so that candidate could never be scrubbed.
          - An inbox row still unmoved past a fixed age marks an operator alert due on its job,
            in a slot of its own. In one transaction, job row first, the sweep sets the inbox
            row's `alert_marked`, guarded on it being false, and bumps the job's
            `inbox_alert_due_generation`. That transaction is its own, never a mover's, so a
            mover that keeps failing can't roll the marking back. It sends and stamps
            `inbox_alert_sent_generation` like the close's alert.
          - Test: a job created under an older manifest receives a late link for a newly added
            table, and processes it. A second confirmation of the same candidate kind is
            processed too.
        - **A target that comes back re-arms its row, and the re-arm re-opens the job too.** A
          Langfuse trace that reappears has the trace id of its `done` target, and a late S3
          object has the key hash of its closed one. An `INSERT ... ON CONFLICT DO NOTHING`
          inserts no row, so the re-open trigger finds nothing to re-open, and a plain `INSERT`
          fails with `23505` on every pass. Either way the job stays `completed` and the object stays.
          So:
          - A late-target add is an upsert: `INSERT ... ON CONFLICT (tenant_id, job_id, step,
            target_id) DO UPDATE SET state = 'pending', attempts = 0, rearm_count =
            rearm_count + 1, <encrypted payload> = EXCLUDED.<encrypted payload>`, with a `WHERE`
            that skips a target already `pending`. It stores the encrypted payload again, such
            as the S3 key, and never changes the target's account columns. A target a worker
            has in progress is re-armed too. The worker's checkpoint that marks a target done is
            guarded on its state still being the in-progress state the worker set, so after a
            re-arm it matches no row, and the worker runs that target again.
          - `ON CONFLICT DO UPDATE` writes a re-armed row as an update, so the `AFTER UPDATE`
            statement trigger above sees it in its transition tables, and the `AFTER INSERT` one
            sees only rows actually inserted. A plain `UPDATE` that re-arms a target fires the
            `AFTER UPDATE` trigger too. Postgres doesn't allow transition tables on an `UPDATE
            OF state` trigger, so the function pairs old and new rows by primary key itself.
          - **A worker's own retry never moves a target back to `pending`.** If it did, the
            trigger would re-open the step on every retry and reset its `attempts`, so the step
            would never reach its retry limit or end `incomplete`. So a `BEFORE UPDATE` row
            trigger on each step-target table raises on a move from any other state to `pending`
            that doesn't also raise `rearm_count`. Only the re-arm path raises it.
          - The catalog test requires the two re-open triggers and the re-arm guard on every
            table with a foreign key to `customer_erasure_steps`, so a step-target table that a
            later sink adds carries them.
          - **Every table whose rows a step processes has that foreign key.** A rule keyed only
            on the steps table misses `erasure_storage_cleanup`, whose rows carried only the job
            id. Its rows are inserted with the `files` delete, and nothing orders that delete
            before the S3 step's `done`. A delete that retries after backoff, once the S3 step
            has checkpointed `done`, would insert cleanup rows that fire no trigger. The job
            would close `completed`, and the backstop listing, which runs only after a row
            closes, would never run for them. So:
            - `erasure_storage_cleanup`, and every later per-job work table, carries `step` and
              a composite foreign key `(tenant_id, job_id, step)` → `customer_erasure_steps`.
            - The catalog test fails on a table with a composite foreign key to
              `customer_erasure_jobs` and none to `customer_erasure_steps`, unless it is on an
              explicit exception list with a reason: the steps table itself, the tombstone, the
              late-link inbox, the candidates table and `customer_erasure_identifiers`.
            - It also asserts that each re-open trigger's `tgfoid` is the re-open function.
            - **It checks the re-open by behavior too.** Trigger metadata can be right while a
              copied definition is wrong. A later work table whose rows start in a state such
              as `waiting` until `not_before`, given triggers that act only on `pending`, would
              never re-open a `completed` job. So for every table with a foreign key to
              `customer_erasure_steps`, the Docker-gated catalog test inserts a target in each
              non-terminal initial state its state `CHECK` allows, and re-arms a done one,
              against a `completed` job. Each must re-open the job and the step. The test also
              compares `tgqual` and `tgattr` with the generated definition.
            - Test: a cleanup row inserted after the S3 step is `done` re-opens the step and
              the job. A failing target's retry leaves the step's `attempts` counting up, and a
              move back to `pending` without a re-arm raises.
          - Tests: a `done` target in a `completed` job is re-armed once by a plain `UPDATE` and
            once by `INSERT ... ON CONFLICT DO UPDATE`. Each time the job and the step both
            re-open, and the target is processed once. A Langfuse trace that reappears after its
            target is done is deleted once more. An S3 key re-uploaded after its target closed is
            deleted, and its key is nulled again.
        - **Each step has its own generation, so a running step can't checkpoint `done` past a
          new target.** The job's generation guards only the close. A worker deleting recording R1
          decides "every target done" from what it read. Under `READ COMMITTED` that read misses
          a handler's uncommitted R2, and a guard over a subquery on targets isn't re-run when the
          `UPDATE` re-checks its row. The step would commit `done`, and the close would then match
          the new job generation, which already includes R2. So:
          - The re-open also bumps the target's step's `generation`, sets the step `pending` and
            sets its `next_attempt_at` to now, whatever its state, `inputs_expired` included,
            under the rule below.
          - **The step re-open and `inputs_expired`.** An erase completes, and the identifiers
            are deleted once the declared readers are done. Weeks later job J2, whose invoices
            were synced as SalesReceipts, is re-linked to the subject, and the mover adds the
            receipts as QuickBooks targets. If those targets needed the identifiers, the step
            would end `inputs_expired` without sending the update, and every later QuickBooks
            target would meet a step that no re-open may touch. So:
            - Each target records whether processing it reads the identifiers. A known-id
              QuickBooks customer or receipt doesn't: its read-back checks that each field holds
              the value the step wrote (see "Read it back before the target is done" below).
              The targets that do are the declared readers' identifier work: a lost-create
              query, a legacy-row match, a reader candidate's confirmation, and the content
              matches (the historical scan, the identifier-linked stores, ElevenLabs, the
              SendGrid suppressions and the final re-scan).
            - The transaction that deletes the identifiers also stamps `identifiers_deleted_at`
              on the job row, so no other path has to read their table. A path that adds a
              target that reads the identifiers, once that stamp is set, inserts it as
              `inputs_expired`. No trigger fires, and the result lists it.
            - Any other target re-opens its step from any state, `inputs_expired` included. The
              step processes the targets that are ready, leaves its expired targets as they are,
              and ends `inputs_expired` again if any remain. The daily retry and the repeat
              `POST` add no target, so they still leave an `inputs_expired` step alone.
            - Test: two late QuickBooks targets arrive after the identifiers are deleted. Both
              receipts are anonymized, and another job's inbox row in the same tenant is still
              moved.
          - The worker reads the step's generation before it reads the step's targets.
          - The step's terminal transitions (`done`, `incomplete`, `provider_retained`) are
            guarded on that generation, a column of the step row itself, never on a subquery over
            targets. One that matches no row re-reads the step's targets and carries on.
        - The close is guarded on `generation = $read_generation`, the value the worker read
          before it checked the steps, and on no step being non-terminal. Either the close sees the
          new target, or the re-open sees the closed job and re-opens it. A close that matches no
          row re-reads the steps and carries on.
        - The close also requires that no late-link inbox row of the job is unmoved, read after
          the job-row lock. The late-link trigger touches no job row, so the generation guard
          can't see a committed inbox row. The mover moves inbox rows under the job-row lock,
          so the two serialize. An inbox row still uncommitted at that moment is moved later,
          and the mover's re-open re-opens the closed job.
        - **One lock order: the job row first.** Two transactions that take the job row and
          another U7 row in opposite orders deadlock. For example, a Twilio messages checkpoint
          renews the lease and then moves a dispatch row from `sending` to `ambiguous`, while that
          message's status callback records the SID on the dispatch row and then re-opens the job.
          Postgres aborts one of them, and if it aborts the callback, Twilio doesn't retry it, so
          the SID link is lost. So every U7 transaction that touches a job row takes it first,
          before any step, target, cleanup or dispatch row:
          - Every worker checkpoint renews the lease as its first statement.
          - A handler that may add a late target finds its jobs with an unlocked read, then
            locks them (below) before it touches any other row. The trigger's own job-row
            `UPDATE` then finds the lock already held.
          - A handler that learns of a job only after it has locked another row rolls back and
            starts again, job rows first.
          - Inside the trigger and the re-open, the job row comes before the step row.
        - **Several job rows lock in ascending id order, all up front.** One key can belong to
          several jobs. Customers A and C share a household email and are both erased, so a
          shared lead's sends that started after phase 1 are targets of both jobs. Status
          callbacks for two of those messages arrive together. Each finds jobs {A, C} with an
          unlocked read that has no order, or relies on the step-target triggers, which lock in
          insert order. One updates A then C, the other C then A, and Postgres aborts one with
          `40P01`. A status callback isn't retried, so that SID link is lost. A SendGrid batch
          with events for rows of different jobs, the recording refusal path ("every job whose
          tombstone holds the matched key") and the per-tenant sweeps meet the same cycle. So:
          - A transaction that touches more than one job row locks all of them first, before
            any other U7 row, with one `SELECT id FROM customer_erasure_jobs WHERE tenant_id =
            $t AND id = ANY($ids) ORDER BY id FOR NO KEY UPDATE`. Postgres locks the rows in the
            sorted order. The transaction then adds its targets in that order.
          - A re-read after the locks that finds a job outside the locked set rolls back and
            starts again with the larger set.
          - A provider batch, such as a SendGrid event batch, is handled one event per
            transaction.
          - The per-tenant sweeps lock their job set the same way: the job claim, the daily
            retry, identifier retention and the alert stamps. The inbox mover runs one
            transaction per job (see "The inbox mover collects what hangs under a late link"
            below).
          - Every handler that may add a late target locks its job rows first and retries its
            transaction once on `40P01`, as `withErasureFence` does: the SMS and call status
            callbacks, the call bridge callback, the email-event, recording, voicemail,
            Wisetack and Vapi webhooks, and the S3 object-created worker.
          - Test: two handlers that each add targets to the same two jobs, discovered and
            inserted in opposite orders, both commit with no `40P01`.
        - **Job rows are locked `FOR NO KEY UPDATE`, never `FOR UPDATE`.** A tombstone, inbox,
          step, target or candidate insert checks its composite foreign key to
          `customer_erasure_jobs` by taking `FOR KEY SHARE` on the job row, and `FOR KEY SHARE`
          conflicts with `FOR UPDATE`. Say the mover holds S's job J with `FOR UPDATE` while it
          collects under J2. A Stripe webhook inserts a payment on one of J2's retained
          invoices. Its `BEFORE` trigger takes the invoice's stripe in shared mode, and its
          `AFTER` late-link trigger inserts a tombstone row and an inbox row for J, whose
          foreign-key checks wait on the mover. The mover then asks for that stripe in exclusive
          mode and waits on the payment. The payment began waiting first, during the
          collection, so its deadlock check fires first, and Postgres aborts the payment with
          `40P01`. The same cycle forms when `withErasureFence`'s claim transaction, still
          holding its shared stripes, inserts a held send's candidate row for J. So:
          - Every explicit job-row lock is `FOR NO KEY UPDATE`. Every job-row writer in this
            unit (lease renewal, generation bump, re-open, close, stamps) is a plain `UPDATE`,
            which takes the same strength, so they still serialize with each other, and none
            conflicts with `FOR KEY SHARE`.
          - No `UPDATE` changes a job's `id`, `tenant_id` or `customer_id`. Changing a column
            under a unique index that a foreign key can use upgrades an `UPDATE` to
            `FOR UPDATE`.
          - A structural check fails on `FOR UPDATE` or `FOR SHARE` against
            `customer_erasure_jobs`.
          - The mover's and the lead step's deadline starts when they are granted the job row,
            and their collection runs under the same `statement_timeout` (see "The budget is a
            wall-clock deadline" below).
          - The late-linking write paths retry their transaction once on `40P01`, like the
            trigger-bearing paths on a live call.
          - Docker-gated test: the mover holds a late-linked job and waits on an invoice's
            stripe while a payment is inserted on that invoice, and both commit with no `40P01`.
            So does a held-send candidate insert made during the mover's collection.
        - **The order is checked at runtime.** Nothing else catches a new handler that writes a
          dispatch row and then re-opens a job. So:
          - The job-lock helper, which every lease renewal goes through too, sets
            `set_config('erasure.jobs_locked', '1', true)`. It raises when the transaction has
            already written a U7 row or a dispatch or claims row, which their triggers flag with
            `erasure.u7_written` the same way.
          - A `BEFORE UPDATE` trigger on `customer_erasure_jobs` raises unless
            `current_setting('erasure.jobs_locked', true) = '1'`, so every job-row update, the
            re-open trigger's included, needs the helper first. Each check reads `= '1'`, as
            U8's flags do.
          - Any integration test on a path that breaks the order then fails. A test-only path
            that writes a dispatch row and then calls the helper raises.
        - The sweep also claims any job that has a non-terminal step, whatever the job's state.
        - The close writes `erase_completed` or `erase_incomplete` once per close generation. A
          re-opened job that closes again records its new outcome.
      - **The raw identifiers outlive the `customers` scrub, encrypted, until every step that
        reads them is finished.** Several steps match by name, phone and email: the historical
        `ai_runs` content scan, the identifier-linked leads and inbound messages, the final
        re-scan, and the QuickBooks lost-create queries and legacy-row match (see "QuickBooks:
        idempotency through `requestid`" below). The tombstone keeps only keyed hashes, and the
        `customers` scrub removes the originals, so a resumed step would have nothing to match.
        So:
        - Phase 1 stores them encrypted with `encrypt` (`integrations/crypto.ts:15`), in a table
          of their own, `customer_erasure_identifiers`, one row per job, keyed by `(tenant_id,
          job_id)`, with forced RLS and the composite foreign key to the job. It is on the
          catalog test's exception list of job-child tables with no step foreign key.
        - **The readers come from the manifest, not from a list in prose.** Each step declares
          whether it reads the identifiers. A hand-kept list left out the QuickBooks step. That
          step ended `incomplete` while QuickBooks was down, the listed readers finished and
          deleted the identifiers, and the next day's retry found them null and ended
          `inputs_expired`, which no retry touches. The QuickBooks customer would keep the name,
          email and phone for good.
        - **One accessor decrypts them, so a test can tell who reads them.** They are decrypted
          with the same generic `decrypt` (`integrations/crypto.ts`) as every other encrypted
          column, so a test over `decrypt` calls can't tell which call reads them. A new step
          that reads back by name, left undeclared, passes its tests, because the identifiers
          are still present while they run. In production the declared readers finish first, the
          identifiers are deleted, and the new step ends `inputs_expired`. So:
          - Steps read them only through `readErasureIdentifiers`, which throws unless the
            manifest declares the step a reader.
          - **No repository can hand them out by accident.** The job claim follows
            `pg-proposal.ts:644-655`, an `UPDATE ... RETURNING *` passed to `mapRow`. On the job
            row, a claim written that way would put the encrypted identifiers on the job object
            every step receives, without naming their column, and a new step could call the
            generic `decrypt` on them. So they live in `customer_erasure_identifiers` (above),
            which no repository maps. A structural test, following U8's one-ceiling-writer
            pattern, fails on any SQL against that table outside the accessor and the
            transaction that deletes them, `SELECT *` and `RETURNING *` included.
          - **The step id is bound by the runner, not passed by the caller.** A shared matcher
            could call `readErasureIdentifiers(job, 'historical_ai_runs')` with a hard-coded
            id, and an accessor that trusts its argument would accept it. So the step runner
            hands each step an identifier reader bound to that step's registered id, and the
            scan fails on any other import of `readErasureIdentifiers`.
          - The per-step test runs each step with the identifiers present only for declared
            readers.
        - **An undecided candidate whose confirmation reads them is an open read.** A QuickBooks
          create's outcome is unknown. The `DisplayName` query finds an inactive customer, but
          the `PrimaryEmailAddr` query finds nothing, because the bookkeeper changed the email.
          The customer goes on the candidate list, and the QuickBooks step ends `done`. The other
          readers finish, and that transaction would delete the identifiers. The owner confirms
          the candidate the next morning, and its confirmation step must re-check the customer
          against the identifiers before the irreversible anonymize, since the bookkeeper may have
          changed the record since the match. It would find them null and end `inputs_expired`,
          and the customer would keep the name, email, phone and addresses for good. Candidates are
          reviewed after the result appears, so this is the normal order. So:
          - The manifest declares, for each candidate kind, whether its confirmation step is a
            reader. A QuickBooks customer candidate's is.
          - The accessor's rule and its structural test cover those confirmation steps like any
            other reader.
          - Test: a QuickBooks candidate confirmed after every other reader is `done` is
            anonymized and reads back clean.
        - They are deleted in the transaction that leaves every declared reader `done` or
          `provider_retained`, no reader candidate undecided, and no late-link inbox row of the
          job unmoved, read after the job-row lock, as for the close. An undecided reader candidate
          keeps them until the owner confirms or dismisses it. An `incomplete` reader keeps them,
          because the daily retry will re-open it. Neither keeps them past their maximum
          retention (below). The result says so.
        - Test: the QuickBooks step ends `incomplete` while every other step is `done`. The daily
          retry runs with QuickBooks back up, and the inactive QuickBooks customer is found and
          anonymized.
      - **Each step is a checkpoint, and so is each target inside it.** A step moves `pending →
        running → done`, or ends `incomplete`, `provider_retained` or `inputs_expired`. Each
        target records its own
        outcome and an idempotency key, `erase:<job id>:<step>:<target id>`, written before the
        provider call. On resume:
        - A delete whose target is already gone counts as done, by each provider's own meaning of
          "gone", and only when the answer comes from the account the target lives on (below).
          The crash test kills the process between a delete and its checkpoint, so the repeat
          delete must read as done:
          - Twilio: a 404 (error 20404).
          - Stripe: a 404 `resource_missing`, or the customer returned with `deleted: true`.
          - Google Calendar: a 404, a 410 Gone, or the event returned with `status: "cancelled"`.
            A repeat delete gets 410, not 404.
          - S3: see "On a versioned bucket a HEAD 404 proves nothing" below.
          A Stripe Customer, Twilio Call or calendar event that an earlier run deleted is
          recognised as done, not reported as a failure.
        - **Every external target records the account it lives on.** Twilio puts the account in
          every resource URL (`/Accounts/{AccountSid}/...`), so a SID asked for under another
          account returns 404, and `Recordings?CallSid=` returns an empty list. Sends with no
          `tenantId` go out on the global account, and tenant sends on the tenant's own or
          subaccount (`notifications/per-tenant-twilio-delivery-provider.ts:61-63`, `:72-119`).
          `message_dispatches` and `voice_sessions` store no account. A tenant that moved from the
          platform number to its own subaccount would have its older SIDs deleted with the wrong
          credentials, each 404 counted done. A Stripe saved-card customer lives on the connected
          account (`payments/stripe-saved-card.ts:93-95`), so after a reconnect a `DELETE` under
          the new `Stripe-Account` returns 404 too. So:
          - Whatever path records a target (`snapshot`, a late target, a write-ahead row or a
            status callback), it records the account. For Twilio that is the `account_sid` from
            the create response, the callback's `AccountSid`, or the account in `recording_url`.
            For Stripe it is the `Stripe-Account` scope.
          - A SID stored before this change, with no account, is looked up on each account the
            tenant is known to have sent from. The step records the account it finds it on before
            it deletes it.
          - The step deletes and lists on that account's credentials. A 404 or `deleted: true`
            counts as done only when it comes from that account.
          - When that account's credentials are gone, or no known account has the SID, the target
            ends `provider_retained` with that reason, never `done`.
          - **QuickBooks: the realm.** `accounting_integrations` has one row per tenant, and its
            upsert overwrites `realm_id` in place on a reconnect
            (`integrations/accounting/repository.ts:290-322`). `accounting_sync_log` rows are
            keyed by `integration_id` and carry no realm (`findExternalIdForEntity`, `:483-499`).
            QuickBooks entity Ids are per-company sequences. So after a reconnect from company A
            to company B, Jane's Customer Id "58" from A names some other customer in B, and an
            anonymize there would blank that person's name, email, phone and addresses, past
            undoing. Its read-back would find none of Jane's identifiers and mark the target done,
            and a lost-create query in the wrong realm finds nothing, which counts as proof of
            absence. So:
            - Every `accounting_sync_log` push, and every QuickBooks claim, records the
              `realm_id` it was sent to. `snapshot` copies it onto the target.
            - The QuickBooks step, its lost-create queries and its read-back included, runs only
              when the integration's current realm equals the target's. Otherwise the target ends
              `provider_retained`: "the record stays in QuickBooks company <realm>, which is no
              longer connected".
            - A legacy row with no realm, synced after the integration's current `connected_at`,
              was sent to the current realm. An older one is anonymized only when the GET's
              `DisplayName`, after stripping a trailing " (deleted)" (see "QuickBooks renames
              an inactive customer" below), or its `PrimaryEmailAddr` matches the job's
              encrypted identifiers. Otherwise it goes onto the candidate list.
            - Test: after a reconnect to a second mock company that holds a different customer
              with the same Id, that customer is untouched and the store reports
              `provider_retained`.
          - **Google Calendar: the Google account and the concrete calendar.** `calendarId`
            defaults to `'primary'` (`integrations/calendar-integration.ts:152`, `:333`), which
            Google resolves to the primary calendar of whichever account issued the token. A
            reconnect upserts the technician's row and overwrites `external_account_email` and
            `calendar_id` (`:314-321`). `user_calendar_integrations` has no `connected_at`
            (`db/schema.ts:2287-2302`). A technician who pushed Jane's appointment as
            work@a.com and later reconnected as personal@b.com would have the step list b.com's
            calendar, find nothing and count it done, while the event with Jane's name and
            address stays in a.com's. The integration is active, so the revocation rule never
            applies. So:
            - Each calendar claim and `appointment_calendar_events` row records the Google
              account (`external_account_email`, or the token's `sub`) and the concrete calendar
              id that `'primary'` resolved to at insert.
            - The calendar step lists and deletes only with credentials for that same account.
              When the technician's integration now belongs to another account, the target ends
              `provider_retained`: "the event stays in <account>, which is no longer connected".
            - A legacy row with no recorded account is listed on the current account, and any
              match is deleted. When that listing finds nothing, the target ends
              `provider_retained` ("the event may stay in a Google account connected earlier"),
              never `done`.
            - Test: push under account A, reconnect as account B, erase. The store reports
              `provider_retained`, not `done`.
          - Test: a message sent on the global account, and a Stripe customer on a previously
            connected account, are both deleted. A 404 from another account is not counted done.
        - A provider write that isn't a delete sends that key wherever the provider accepts one, and
          writes the same value every time. The anonymized QuickBooks `DisplayName` is always the
          same `Erased customer <short id>`. A provider that replays its first answer for a
          repeated key, as QuickBooks does, gets a new key after a definite rejection (see "A
          reused `requestid` replays its first answer" below).
        - A local scrub commits its writes and its checkpoint in one transaction. A batched scan,
          such as the historical `ai_runs` scan, checkpoints its cursor with each batch. Candidate
          rows are unique on `(job_id, store, row id)`, so a re-run never lists one twice.
        - Provider calls run between transactions, never inside one (`workers/tenant-query.ts:11-12`).
      - **One worker per job, by lease.** A worker claims a job with one guarded update. It sets
        `lease_owner`, `lease_expires_at` and a new `lease_epoch`, and matches only a job that has
        no live lease, read with `clock_timestamp()`, and either isn't terminal or has a
        non-terminal step.
        - **Every checkpoint renews the lease on the job row, in the same transaction.** A guard
          that only reads the job's `lease_epoch`, such as an `EXISTS` on the target's update,
          takes no lock on the job row. Under `READ COMMITTED` it can pass beside a re-claim that
          hasn't committed yet, and it never notices a lease that lapsed but hasn't been re-claimed.
          Two workers would then call the provider for the same target. So:
          - Each checkpoint, including the one a target makes before its provider call, runs
            `UPDATE customer_erasure_jobs SET lease_expires_at = clock_timestamp() + <lease> WHERE
            id = $1 AND lease_epoch = $e AND lease_expires_at > clock_timestamp()` with its own
            write, as its first statement (see "One lock order: the job row first" above).
          - That takes the job row's lock, so it serializes with a claim. Either the checkpoint
            commits first and the claim finds a live lease, or the claim commits first and the
            checkpoint matches no row.
          - A checkpoint that matches no row rolls back its own write, and the worker stops before
            its next provider call.
        - A call that a stale worker already had in flight repeats harmlessly, by the rules above.
        - The lease outlasts the longest single provider call. The pre-call checkpoint renews it,
          so every call starts with a full lease ahead of it.
      - **A wait is a checkpoint, not a sleep.** A step that has to wait records when to look again
        (its own step row's `next_attempt_at`), releases its lease and returns. Examples: a call
        still in progress, an upload window not yet over, a drain window, an ambiguous send not yet
        linked. No worker holds a lease, a connection or a lock across a wait.
        - **`next_attempt_at` is per step, so a wait can't push back a re-open.** On the job row, a
          wait checkpoint would overwrite the "now" that a late target's re-open had just set. Both
          take the job row first, so they serialize, and the wait commits second. The re-opened
          step, say a recording that a refused callback registered, would then wait out the other
          step's interval, which behind a Twilio 20009 wait could be hours. So each step row has
          its own `next_attempt_at`, a wait writes only its own step's, and the sweep's due test
          runs over the steps (below).
        - Test: a late target committed while another step is about to wait is processed on the
          next sweep pass, not after the wait.
        - **A time gate is its own column, and a re-open never moves it.** Some waits are not
          retries but conditions of a proof: the Twilio recordings step's `not_before` (the
          call's completion plus the recording-callback window), the Langfuse send-and-ingest
          bound, the `idempotency_keys` lifetime, an upload window, and a writer's drain window
          before a reconciliation read. Held only in `next_attempt_at`, each would be cut short
          by a late target's re-open. A refused recording callback at +30 s would re-open the
          recordings step, which would delete that recording, list `Recordings?CallSid=` before
          a second recording on the call was finalized, find nothing, and checkpoint `done`. So:
          - Each gate is a column of its own, on the step or on the target, set when the wait
            first starts. A re-open moves only `next_attempt_at`.
          - A run that starts before a gate processes only the targets that are ready. Until
            every gate on the step has passed, it runs no listing or reconciliation read that
            counts as proof of absence, and it doesn't checkpoint `done`.
          - Test: a refused recording callback re-opens the step at +30 s. The step isn't `done`
            before its `not_before`, and a recording finalized after that early run is still
            listed and deleted.
      - **Every wait has a deadline, so no job waits forever.** A wait with no bound can keep a job
        running, with no alert, while `customer_erasure_identifiers` still holds the raw
        identifiers. An SMS whose client
        timed out before Twilio accepted it never gets a status callback, so "not yet linked" would
        otherwise repeat every few minutes indefinitely. So:
        - Each wait records a `wait_deadline` when it first starts, taken from the bound of what it
          waits on: an SMS's `ValidityPeriod` plus a carrier margin (see "Rows the callback never
          linked" below), the call `timeLimit` maximum, the end of an upload window (see
          "Presigned uploads" below), Langfuse's deletion processing, Twilio's finalization bound
          for error 20009, or the writer's declared drain window. A re-check never moves it.
        - Past its deadline, a wait takes its fallback or counts as a failure. An ambiguous send
          still not linked falls back to the strict content match below, and zero matches after
          that deadline is recorded as reconciled-absent. A call still in progress past the
          `timeLimit` maximum counts as a failure.
      - **A sweep resumes every started-but-unfinished erase** (the async worker pattern, P0-009):
        - Phase 1 enqueues an `erasure_job` message with `sendOn` inside its own transaction
          (`queues/pg-queue.ts:108`), so the work starts at once. The message only wakes a worker.
          The job row is the record, and the queue's retry limit and dead-letter queue never end an
          erase.
        - A leader-gated sweep (`runAsLeader` with a new `SWEEP_LOCK` key, `app.ts:2588`, `:2674`)
          runs once at boot and then every minute. It claims every job that has no live lease and
          either has a non-terminal step whose `next_attempt_at` has passed, or isn't terminal and
          has no non-terminal step left, so only its close remains.
        - **Every U7 sweep starts with no tenant, so every one uses U4's pattern.**
          `message_dispatches` has `FORCE ROW LEVEL SECURITY` (`schema.ts:1113-1114`), and so does
          every U7 table. A scan on the runtime role with no tenant set sees no rows. A released
          send would never go out, a hold would never expire and keep its stored message, and the
          S3 and Langfuse backstops would find nothing. So each sweep selects its due rows'
          `(tenant_id, id)` across tenants the way U4's purge does, then runs one transaction per
          tenant under that tenant's context, or one per job where a failure must not hold up the
          tenant's other jobs, as in the inbox mover. That covers:
          - the job claim, the daily retry and identifier retention
          - the late-link inbox mover
          - the release sender and hold expiry
          - the S3 prefix listing and the Langfuse re-query
          - every alert outbox: the close's, the age alarm's, the inbox-age alert's and the
            start-failure count's
          Each is tested at its entry point under `RLS_RUNTIME_ROLE=true`, with due rows in two
          tenants, as U8's reaper test is. A superuser test connection bypasses RLS, so a test on
          it proves nothing here.
      - **Retries are bounded, and the end state is explicit.**
        - **A crash counts as an attempt.** A failure counted only after a caught error never counts
          a step that kills the process, such as an out-of-memory on a large `ai_runs` batch or a
          `SIGKILL` during a deploy. The sweep would re-claim it after every lease expiry, forever.
          So the start checkpoint increments the step's `attempts` before the work runs. A run that
          ends in a wait checkpoint gives that attempt back in the same write. A caught error and a
          crash each count, and a wait doesn't.
        - **A success gives the budget back.** A run that ends `done` would otherwise keep its
          attempt. The S3 step of a customer with many uploads, re-opened by object-created
          notifications and the backstop listing, or the Twilio messages step re-opened by late
          SIDs, would climb toward the limit on runs that all succeeded. Its next transient error
          would then end it `incomplete` with no backoff retry. So a run that checkpoints `done`
          resets the step's `attempts` to 0 in the same write. So does every re-open that adds or
          re-arms a target, in the trigger, as the re-arm already does for the target. Test: a
          step re-opened more times than the retry limit, each run succeeding, still gets its
          full retries on a later transient failure.
        - A step that fails retries with capped exponential backoff.
        - After a fixed number of failures, the step ends `incomplete` with its last error.
        - **Some provider answers are waits or end states, not failures.** Counted as failures,
          they would end the step `incomplete`, and the daily re-open would alert again every day:
          - Twilio error 20009 ("Cannot delete this resource before it is complete") is a wait
            checkpoint, with a `wait_deadline` of the finalization bound Twilio documents for it
            (up to 14 days). It isn't a failed attempt.
          - **A rate limit is a wait.** A long-standing customer can have hundreds of SIDs, and the
            historical scan can add a Langfuse target for every pre-linkage run, so deletes come
            in bursts. Each of these is a wait checkpoint, not a failure: Twilio's 429 (error
            20429), a 429 from Stripe, QuickBooks or Langfuse, and Google's 429 or 403
            `rateLimitExceeded` / `userRateLimitExceeded`. Its `next_attempt_at` comes from
            `Retry-After`, or from the backoff when there is none, under a `wait_deadline`, and it
            gives its attempt back. Calls are paced per provider account, and historical Langfuse
            targets are deleted in batches through Langfuse's multi-trace delete.
          - A confirmed credential revocation ends the target `provider_retained`, with the
            reason "the record stays in the tenant's <provider> account, and we no longer have
            access". Confirmed means the integration is disconnected, or a token refresh fails
            with the provider's revoked-grant error, not a single 401. Examples: the tenant
            disconnected Google, Stripe or QuickBooks, or closed a Twilio subaccount. The close
            that records it marks the operator alert due, once for that close generation. The
            daily re-open doesn't touch it while the integration stays disconnected, and
            re-tests it once the integration reads as connected again.
          - **A QuickBooks refresh race is not a revocation.** Intuit rotates refresh tokens, and
            when two refreshes use the same refresh token, the first succeeds and the second gets
            `invalid_grant`. `AccountingSyncService.syncIntegration` reads the token pair once for
            its whole paged sweep (`integrations/accounting/sync-service.ts:81-86`).
            `refreshIfNeeded` refreshes from that copy with no lock and no re-read (`:135-156`),
            and a push error whose message contains "token" sets the integration `expired`
            (`:245-246`). The sweep and the erase's QuickBooks step can each get a 401 and refresh
            with the same token. The loser either reads `invalid_grant` as a revocation, or later
            marks a working integration `expired`, and either way the QuickBooks customer keeps
            the name, email, phone and addresses. So:
            - Refreshes are serialized per integration without a transaction held across the
              call (`workers/tenant-query.ts:11-12`). The refresher re-reads the stored pair. If
              another process has already stored a newer access token, it uses that one and
              doesn't refresh. Otherwise it claims the refresh with one guarded update on the
              `accounting_integrations` row: a short `refresh_claimed_until`, set only when no
              live claim exists and the stored refresh token is still the one it read. It commits,
              refreshes, and writes the rotated pair guarded on that claim. A process that loses
              the claim waits briefly and re-reads.
            - `invalid_grant` counts as revocation only when a re-read after the claim shows the
              stored refresh token is still the one that failed.
            - A refresh race never sets the integration `expired` or disconnected. The match on
              "token" in the message gives way to the typed revoked-grant result.
            - Test: the sweep and the erase step refresh at the same moment, and the QuickBooks
              customer is still anonymized.
        - Once every step is `done`, `provider_retained`, `incomplete` or `inputs_expired`, one
          guarded transition closes the job (guarded on its generation, above). It ends `completed`
          with `erase_completed` when no step is `incomplete` or `inputs_expired`, and
          `erase_incomplete` with that audit event otherwise.
        - The audit event is written in that transition's transaction, so a resumed job never writes
          it twice for the same close generation.
        - The transition to `erase_incomplete` also marks an operator alert due on the job row, by
          writing that close generation to `alert_due_generation`. The sweep sends every alert
          whose `alert_due_generation` is past `alert_sent_generation`, through `alertOperator`.
          Then it sets `alert_sent_generation` to the generation it read, guarded on
          `alert_due_generation` still being that value. So:
          - A crash right after the commit still alerts.
          - A job that re-opens, after a retry or a late target, and closes incomplete again has a
            new close generation, so it alerts again. No stamp needs resetting.
          - A close that lands between the send and the stamp makes the stamp match no row, and the
            next pass sends the new alert.
        - **Generations start at 1, and every due and sent column at 0.** With the usual `DEFAULT
          0` everywhere, a job inserted at `generation = 0` that closes `erase_incomplete` with no
          target ever added writes 0 to `alert_due_generation`, which isn't past
          `alert_sent_generation` 0, so no alert goes out. So phase 1 inserts the job with
          `generation = 1` and `opened_generation = 1`, and every `*_due_generation` and
          `*_sent_generation` column is `BIGINT NOT NULL DEFAULT 0`. Every close and every opening
          is then past its stamp.
        - **A job-age alarm, with its own outbox slot.** If it shared `alert_due_generation`, an
          age alert stamped at generation 7 would leave a later `erase_incomplete` close at 7
          unsent. And an age measured from phase 1 would fire at once on every re-open after the
          limit, such as the daily retry or a late object from the 30-day listing. So:
          - The age runs from when the job last opened. Phase 1 sets `opened_at`, and
            `opened_generation` to 1 (above). A re-open that moves a terminal job back to `pending`
            stamps both again, and one that finds the job already open stamps neither. So a job
            stuck in its first opening compares `age_alert_due_generation` 0 with
            `opened_generation` 1, and its alarm can fire.
          - The sweep marks the age alert due for any job still not terminal a fixed number of
            hours after `opened_at`. It writes `opened_generation` to `age_alert_due_generation`,
            guarded on that being below `opened_generation`. The number of hours is longer than
            the longest wait deadline plus the retry budget, so it fires only on a job that the
            rules above failed to end.
          - It sends and stamps `age_alert_sent_generation` the same way as the close's alert,
            guarded on `age_alert_due_generation` still being the value it read.
          - So the age alarm fires at most once per opening, and never takes the close's alert.
        - The owner sees which stores are incomplete, and why.
        - **An `erase_incomplete` job is retried automatically.** The sweep re-opens its incomplete
          steps on a fixed schedule, for example daily, by the same re-open as a late target.
          Sending `POST /api/customers/:id/erase` again is the owner's immediate retry. Either one
          resets the incomplete steps' failure counts, and steps already `done` stay done. Neither
          touches an `inputs_expired` or `provider_retained` step.
        - **The encrypted identifiers have a maximum retention**, for example 30 days after phase 1.
          When it passes, the sweep's retention pass deletes them, even from an unfinished job, in
          one transaction that takes the job row first. So:
          - It bumps `lease_epoch` and clears the lease in that transaction, so a worker mid-step
            has its next checkpoint refused and stops.
          - It moves each step that still needed them to `inputs_expired`, a terminal state of its
            own. The daily retry and the owner's repeat `POST` don't touch it. A late target
            re-opens it only when that target doesn't read the identifiers (see "The step
            re-open and `inputs_expired`" above). A target that finds the identifiers null ends
            `inputs_expired`, never `done`, and so does its step.
          - The job then closes `erase_incomplete`, which alerts once. The result reports those
            stores as incomplete, because their inputs expired, and an audit event says which they
            were.
        - The owner's confirmation of a candidate adds its row as a target of the job's
          confirmation step for that candidate kind (see "Every late-target path first makes sure
          its step row exists" above). It isn't run inline. The owner can instead dismiss a
          candidate ("this is someone else"), which closes it with no scrub.
        - **Every owner decision on an erase is owner-only and audited.** Confirming a candidate
          authorizes an irreversible scrub of a row that may be someone else's. Releasing a held
          send writes an exemption that weakens the fence (see "A held send has a durable release
          path" below), and dropping one discards a message. So candidate confirmation and
          dismissal, release and drop are owner-only, like the erase endpoint. Each writes an
          audit event (actor, job, row or source id, decision) in the same transaction as its
          change. The sweep that moves late-link inbox rows names the tombstone keys they added in
          that job's next step audit event.
        - Test: a non-owner gets `403` on confirm, dismiss, release and drop, and each decision
          leaves exactly one audit row.
      - **The tombstone fences whatever state the job is in.** Writers check the tombstone, never the
        job, and the tombstone is never lifted. So a slow, stuck or `erase_incomplete` job never
        weakens the fence.
        - Phase 2 holds no erasure lock across steps. Each step's transaction is short, so a long
          erase blocks no writer.
        - The fence refuses only writes that would put subject data back, so retained financial
          records keep updating however long the job takes.
        - **"Never lifted" is enforced in the database, for every principal.** A later
          data-minimization job could purge completed erasure jobs older than a year, deleting
          their tombstone rows first or through an `ON DELETE CASCADE`. The subject's
          owned-entity ids, session ids and recipient hashes would stop fencing, and a stale
          writer could reattach data with no step left to catch it. Grants to the runtime role
          alone don't stop that: `applyTenantContext` switches to `rls_app_runtime` only inside
          a tenant transaction (`db/rls-runtime-role.ts:63-71`), and cross-tenant work runs as
          `rls_cross_tenant` or the connection principal. A sweep written as one cross-tenant
          `DELETE` would run as one of those. So:
          - A `BEFORE UPDATE OR DELETE` trigger on the tombstone, and a `BEFORE DELETE` trigger
            on `customer_erasure_jobs`, raise for every principal.
          - Only `session_replication_role = 'replica'` skips them. The whole-tenant purge uses
            it, in deprovision (`tenants/deprovision.ts:205`) and the demo reset
            (`tenants/purge-walk.ts:113`). A structural test fails on `session_replication_role`
            anywhere else in `packages/api/src`.
          - Neither the runtime role nor `rls_cross_tenant` has `UPDATE` or `DELETE` on the
            tombstone, or `DELETE` on `customer_erasure_jobs`.
          - The tombstone's composite foreign key to the job is `ON DELETE RESTRICT`.
          - The catalog test asserts those grants, that foreign-key action, and that both
            triggers are enabled (`'O'`).
      - **The endpoint returns the job, not the result.** It responds `202` with the job id once
        phase 1 commits. The owner reads progress, each store's outcome and the candidate list from
        `GET /api/customers/:id/erase`. Every "erase result" in this unit means that job state.
  - **U7 starts with a data inventory, before any erase code.** Review keeps turning up one more
    store that holds customer data: service locations, custom-field values, converted leads, callback
    tasks, an external trace sink. That shows the scope has to be discovered systematically, not
    patched one store at a time. The first deliverable is a written inventory, reviewed on its own
    PR, of every place a customer's data can live, reached through any of six kinds of link:
    - **Direct:** a `customer_id` foreign key.
    - **Bare column:** a `%customer_id` column with no foreign key.
    - **Session- or call-linked:** keyed by the customer's `voice_sessions`, `call_sid` or
      conversation ids. For example, `call_me_back_tasks` (`schema.ts:3887-3901`) is linked only
      through `session_id`, yet it holds `caller_phone`, `caller_name`, `callback_message` and
      `intent_summary`. `call_usage_events` (`schema.ts:7058-7070`) holds `caller_phone`, keyed
      only by a `call_id TEXT` with no foreign key.
    - **Polymorphic:** an `entity_type` / `entity_id` pair that names the customer, or one of the
      customer's jobs, estimates or invoices. For example, `customer-mms/customer-mms-intake.ts:150-163`
      uploads each customer MMS image to S3 and creates a `files` row with `entityType: 'customer'`.
      The schema test also lists every `entity_type` / `entity_id` table, so each must be classified.
      The erase deletes those file rows and their S3 objects.
    - **Identifier-linked:** matched only by the customer's phone, email or name.
    - **External sinks:** S3 objects, Twilio recordings, Langfuse traces when
      `LANGFUSE_CAPTURE_CONTENT` is on, and Vapi when `VAPI_API_KEY` is set.
      `trace-exporter.ts` exports gateway inputs and outputs, including transcripts, under
      correlation and session ids.
      - **Vapi takes whole calls by routing, not by a call site.** Provisioning step 4.5 links
        every tenant number to a Vapi assistant (`workers/provision-twilio.ts:602-650`). Vapi
        then runs those calls on its own infrastructure. It keeps the call log, with the
        caller's number and the transcript, and records the call unless the assistant turns
        recording off. Locally, the end-of-call webhook inserts a `voice_sessions` row with
        only the Vapi call id (`integrations/vapi/webhook.ts:125-150`), with no customer link
        and no phone. The call-site scan sees only the assistant-config calls, because subject
        data reaches Vapi through Twilio number routing. So:
        - Vapi is a manifest entry marked as an integration whose data enters by routing.
        - **A Vapi call is a Twilio call too.** `linkPhoneNumber` imports the tenant's Twilio
          number into Vapi with `provider: 'twilio'` (`integrations/vapi/client.ts:96-104`), so
          every Vapi call still arrives at Twilio as a Call resource on that account, with the
          caller's number as `From`. Vapi gives the call its own id and carries the Twilio
          `CallSid` as the call's `phoneCallProviderId`. The webhook stores only the Vapi id,
          only from the end-of-call report (`integrations/vapi/webhook.ts:125-150`), and ignores
          every non-terminal event (`:166-170`). An end-of-call report can be missing, after a
          failed delivery or a call that ends without one. Then the Twilio parent leg, any
          transfer's child leg and the Vapi recording and transcript would never be targets.
          So:
          - The webhook records the Vapi call id, its `phoneCallProviderId` and the Twilio
            account on the `voice_sessions` row from the first call event it receives, not
            only from the end-of-call report. It records the caller's keyed phone hash, and
            links the customer when the number resolves to one.
          - `snapshot` adds each subject Vapi call id as a Vapi target, and its `CallSid` as a
            Twilio Call target, whose child legs and recordings the Twilio steps find as for any
            call (see "Child legs are found through Twilio's own parent link" below).
          - As a backstop, the Vapi step lists Vapi calls on the tenant's `phoneNumberId` over
            the subject's activity window, and the Twilio calls step lists Calls to the tenant's
            numbers from each subject phone over the same window. A match by number alone goes
            onto the candidate list, under the household rule.
          - **A call that ends after phase 1 is still targeted.** Its first event or its report
            can arrive after `snapshot`, and its `voice_sessions` write then drops the subject
            link (see "A write that links new data to the erased subject" below), so `snapshot`
            never sees it. So the webhook first finds and locks the jobs whose tombstone holds
            the caller's customer id or phone hash. When the call resolved to the subject, it
            adds the Vapi call id and the `CallSid` as late targets on each of those jobs. When
            it matched only a recipient hash, it puts the call on that job's candidate list.
          - Test: a Vapi-routed call whose end-of-call report is dropped still has its Twilio
            parent and child legs deleted, or candidate-listed. A report that arrives after
            phase 1, for a call identified as the subject, leaves that Vapi call deleted, or
            `provider_retained`, before `erase_completed`.
        - A Vapi step deletes each call through Vapi's call API and re-checks it. Where that
          can't be confirmed, the target ends `provider_retained`.
        - The alternative is a boot guard that requires the assistant to be created with
          recording and transcript storage off (the PRIV-6 acknowledgement shape). Owner
          decision 1 picks one.
        - U8 covers Vapi's spend (see U8's "Every `externalSinks` entry declares its spend").
      Two business integrations hold directly linked customer records too:
      - **Stripe.** `payments/stripe-saved-card.ts:84-124` creates a Stripe Customer with the
        customer's name, email and internal id, and attaches saved cards to it. The erase deletes
        that Stripe Customer, which also detaches its saved payment methods. Stripe keeps its own
        charge records under its legal obligations, outside our control, and the result says so.
        - **Payment Link products are named after the customer.** Invoice and estimate-deposit
          links send `product_data[name]` as `Invoice <n> — <customer.displayName>`
          (`invoices/public-invoice-service.ts:354`, `:387`;
          `estimates/public-estimate-service.ts:889-891`, `:914`). `price_data` creates a new
          Product inline, on the platform or the tenant's connected account, and the live link
          page shows that name to anyone with the URL. A Product isn't a charge record, and it
          can be renamed. So:
          - The product name carries only the invoice or estimate number, never the display
            name.
          - **Every link ever minted is a target, not only the current one.** A link is retired
            when its invoice is credited, voided or switched to collect-on-site.
            `retireCheckoutLink` deactivates it at Stripe, then `clearPaymentLinkIfMatches`
            nulls the stored id (`invoices/invoice-payment-link.ts:193`, `:363-371`), and the
            next Pay Now mints another. A concurrency loser's link is deactivated and never
            stored (`invoices/public-invoice-service.ts:332-336`), and the code notes that
            nothing persists which account a link was minted under
            (`invoice-payment-link.ts:285`). Deactivating a link deletes neither the link nor the
            Product its `price_data` created, so every Product minted before the name change
            above keeps the customer's name. So:
            - Each payment-link create writes an append-only row per invoice or estimate before
              the call, with the `Stripe-Account` scope, and fills in the link id once it
              returns. Nothing clears these rows.
            - `snapshot` takes every such row of a subject invoice or estimate as a Stripe target.
            - For links minted before those rows existed, `snapshot` also reads the
              `invoice.payment_link_*` audit rows of subject invoices, and lists `GET
              /v1/payment_links` on the platform and on every connected account recorded for the
              tenant. It keeps the links whose `metadata.invoice_id` is a subject invoice, or
              whose `metadata.estimate_id` is a subject estimate for a deposit link
              (`estimates/public-estimate-service.ts:917-919`).
            - A row whose create response was lost is reconciled by that same listing.
            - Test: a link retired by a credit and then re-minted has both Products renamed.
          - The Stripe step reads each link's line items (`GET
            /v1/payment_links/:id/line_items`) for its Product, renames the Product to the
            anonymized value (`POST /v1/products/:id`), and confirms with a GET that no
            identifier remains.
          - Each Checkout Session's line-item snapshot is listed as `provider_retained`, under
            Stripe's charge-record retention.
          - The seed-and-erase test seeds a payment-link Product named after the subject.
      - **QuickBooks.** `integrations/accounting/sync-service.ts:271-315` pushes the customer's
        display name, email and phone. Accounting records fall under the same tax and legal
        retention as local invoices (owner decision 1). The default is to keep the financial
        records and anonymize the QuickBooks customer record:
        - Replace the required `DisplayName` with a stable anonymized value, for example
          `Erased customer <short id>`. `sync-service.ts:282-287` sends `customer.displayName`, and
          `quickbooks-client.ts:93-103` stores it as `DisplayName`, so clearing email and phone
          alone leaves the name.
        - Clear the email and the phone.
        - **Set `PrintOnCheckName` to the same anonymized value.** `createCustomer` sends only
          `DisplayName`, `PrimaryEmailAddr` and `PrimaryPhone` (`quickbooks-client.ts:93-103`).
          Intuit's Customer reference says `PrintOnCheckName` is filled from `DisplayName` when it
          isn't given, and can't be removed with a sparse update. So every customer we pushed
          still prints checks to "Jane Doe" after the `DisplayName` changes.
        - **Overwrite every name and contact field, not only the ones we sent.** The tenant's
          bookkeeper can fill more in QuickBooks. The update sets `GivenName`, `MiddleName`,
          `FamilyName`, `CompanyName`, `PrintOnCheckName`, `PrimaryEmailAddr`, `PrimaryPhone`,
          `Mobile`, `AlternatePhone`, `Fax`, `BillAddr`, `ShipAddr` and `Notes` to the anonymized
          value or an empty one.
        - **Read it back before the target is done.** The step GETs the customer and checks that
          each of those fields holds the value the step wrote, the anonymized value or empty,
          after stripping a trailing " (deleted)" (see "QuickBooks renames an inactive customer"
          below). A field that holds anything else leaves the target pending. This read-back
          needs no identifiers, so a known-id target can still be processed after they are
          deleted (see "The step re-open and `inputs_expired`" above). The step is still a
          declared reader, for its lost-create queries and the legacy-row match.
        - **Sales receipts carry the line descriptions too.** Every synced invoice becomes a
          SalesReceipt whose `Line[].Description` is each local line item's description
          (`sync-service.ts:194-200`, `quickbooks-client.ts:122-145`). The local erase blanks and
          fences those descriptions, and a line such as "Water heater at 12 Oak St, gate code
          4411, ask for Jane" would otherwise stay in QuickBooks while the store reports `done`.
          QuickBooks can also fill a receipt's addresses from the customer record. So:
          - `snapshot` makes each SalesReceipt id in `accounting_sync_log` (entity type
            `invoice`) a QuickBooks target, with its realm.
          - **A receipt from a lost create is found by a query, not the sync log.**
            `createSalesReceipt` sends its key as a `Request-Id` header too
            (`quickbooks-client.ts:64-66`). On a timeout the push is logged as a failure with no
            receipt id, and the next sweep pushes the invoice again (`sync-service.ts:194-238`).
            If QuickBooks created SR 301 before the response was lost, the retry creates SR 302,
            and only 302 is logged. SR 301 keeps "gate code 4411, ask for Jane". So:
            - For each subject QuickBooks customer id in the target's realm, `snapshot` queries
              `select * from SalesReceipt where CustomerRef = '<id>'`, paged, and adds every
              receipt it finds as a target. For a customer a lost-create query finds later, the
              QuickBooks step runs the same query before it checkpoints `done`.
            - It also queries by `DocNumber` for each subject invoice number. A match whose
              `CustomerRef` isn't a subject customer goes onto the candidate list.
            - Receipt creates send `?requestid=` like customer creates, and the receipt create's
              claim declares that query as its reconciliation read.
            - The per-sink test drops a receipt create's response, and asserts that the orphan
              receipt is found and rewritten.
          - The step sends one sparse update that resends the whole `Line` array from its GET,
            with each `Description` replaced by the scrubbed value the local scrub writes, and
            clears `BillAddr`, `ShipAddr` and `BillEmail`. It follows the same `requestid` rules
            as the customer anonymize.
          - A read-back checks that every line and address field holds the value the step wrote.
          - If owner decision 1 keeps receipts verbatim, or QuickBooks refuses the edit in a
            closed period, the target ends `provider_retained` with that reason, never `done`.
          - The seed-and-erase test adds a receipt whose line description names the subject.
      - **Twilio calls.** Deleting recordings and messages still leaves Twilio's Call resource, and
        with it the call log of both parties' phone numbers. Twilio exposes a separate DELETE for a
        completed Call record, and deleting a recording doesn't remove it. So:
        - The erase deletes the subject's Call resources: the primary call, plus any child legs
          such as a dialed transfer or the on-call page.
        - It selects them only by the Call SIDs we keep linked to the subject:
          `voice_sessions.call_sid`, the `phoneCallProviderId` of a Vapi-routed call (see "A Vapi
          call is a Twilio call too" above), and the outbound call results we store. An outbound
          call whose create response was lost is linked by its own callback or fallback (see "An
          outbound call needs its own correlation" below).
        - **Child legs are found through Twilio's own parent link.** Escalations and owner
          patch-throughs use `<Dial>` (`ai/skills/escalate-to-human.ts`,
          `ai/skills/patch-owner-through.ts`), and Twilio logs a `<Dial>` as a separate child
          Call, by default with the caller's number as its caller ID. We keep a child SID only for
          an answered screened transfer, and then only in audit metadata
          (`telephony/transfer-screening.ts:71`). So for every subject Call SID, before it deletes
          that Call, the step lists `GET /Calls.json?ParentCallSid=<sid>` on that call's account.
          Each child becomes a Call target, and its recordings are listed with
          `Recordings?CallSid=` too. A child is deleted before its parent. That link is Twilio's
          parent relation, not a phone-number match.
        - A call still in progress can't be deleted. The erase waits for it to complete, up to the
          call `timeLimit` maximum, and until then the Twilio calls store is `incomplete`.
        - A Call is deleted only after the Twilio recordings step has asked Twilio for that Call's
          recordings (see "A writer the fence refuses can still leave a copy" below).
        - A 404 on the call's own account counts as done, and a re-check after the delete must
          come back clean.
      - **Twilio messages.** `notifications/twilio-delivery-provider.ts:238-268` posts the recipient
        and the body to Twilio's Messages resource, and we keep the returned message SIDs. The
        erase deletes the customer's SMS/MMS Message resources, media included, through the
        Twilio API.
        - **A delete, never a redaction.** Twilio offers both. A redaction, a POST that sets
          `Body` to an empty string, keeps the Message record with both numbers, the timestamps
          and, for MMS, the Media holding the customer's photo. A redacted Message still returns
          200, so a re-check would pass. Only an HTTP `DELETE` of the Message removes the record,
          and its Media with it. So:
          - The step always `DELETE`s the Message, and confirms with a GET that returns 404
            (error 20404) on the target's own account.
          - Redaction is only a fallback for a Message Twilio refuses to delete, other than the
            20009 wait (see "Some provider answers are waits or end states" above). The step then
            deletes each Media subresource explicitly, and ends
            the target `provider_retained`, naming the number Twilio keeps.
        - It selects them only by the message SIDs we keep linked to the subject: outbound sends,
          and inbound captures, which already store `messageSid` with `customerId`
          (`sms/inbound-capture.ts:293-309`).
        - It never selects them by phone number alone. A household can share a number and numbers
          get reassigned, so a number-only match could irreversibly delete someone else's history.
        - Unlinked inbound messages that match only on the number go onto the same owner-confirmed
          candidate list as historical `ai_runs`.
      - Every enabled integration is a manifest entry with its delete, anonymize or legally-retain
        rule.
      - **Copies a provider keeps anyway are reported as provider-retained.** Without this, the
        job can end `erase_completed` while providers still hold copies. Each `exempt` model or
        transcription provider, and each anonymized or deleted integration, has a manifest
        retention entry that the erase result prints, as it already does for Stripe, financing
        and email:
        - OpenAI keeps API inputs and outputs (chat, Whisper, speech and embeddings, all used
          here) in abuse-monitoring logs for up to 30 days, unless zero data retention applies.
        - **A model provider's retention entry is keyed by the endpoint that was configured, not
          by the call site.** The chat and embeddings call sites are one OpenAI-compatible
          adapter whose endpoint comes from `AI_PROVIDER_BASE_URL` and
          `AI_FALLBACK_PROVIDER_BASE_URL` at runtime, and the documented options include
          OpenRouter and "any other OpenAI-compatible endpoint" (`ai/gateway/factory.ts:36-57`).
          A tenant whose failover went through OpenRouter would otherwise get a result that says
          "OpenAI, 30 days". So:
          - Retention entries are keyed by endpoint host. A boot guard maps each configured base
            URL to an entry, and refuses an unlisted host in production or staging (the PRIV-6
            shape). OpenRouter's entry says it forwards to upstream providers whose retention
            varies.
          - Each boot records its configured endpoint hosts as intervals, like the capture-on
            intervals. The result prints the retention of every host configured while the
            subject's runs were made.
        - **ElevenLabs is a deletable store, not a fixed retention entry.** It receives the text
          it speaks (`ai/tts/elevenlabs-stream.ts:201`, and the REST synthesis in
          `ai/tts/tts-provider.ts`), which can read back the caller's name and address. Its stream
          was missing because it is a `ws` WebSocket, which the call-site scan didn't see (see "a
          transport value" below). ElevenLabs logs each request's text and audio to the
          account's history unless the request sends `enable_logging=false`, which needs its
          Zero Retention Mode. Each history item can be deleted. So one of these applies, and
          owner decision 1 names which:
          - Every request sends `enable_logging=false`, and a boot guard checks the account has
            Zero Retention Mode, the PRIV-6 way.
          - Or an ElevenLabs step pages `GET /v1/history` over the window of the subject's calls,
            matches each item's text against the subject's identifiers and ids by the
            corroborated-or-candidate rule of the historical `ai_runs` scan, deletes each match
            with `DELETE /v1/history/{history_item_id}`, and re-checks. A rate limit is a wait.
            The step is a declared reader of the identifiers.
        - **Backups keep what the erase removes.** Twilio documents that message bodies can
          persist in its database backups for up to 30 days after a `DELETE`. Our own Postgres
          and bucket backups hold everything the erase scrubs. A restore from a backup taken
          before phase 1 brings the customer's rows back with no tombstone and no job, so
          writers aren't fenced and no step runs again. So:
          - The result lists database and bucket backups, and Twilio's backup window, as
            `provider_retained` until their retention dates.
          - The job keeps a minimal erase record outside the restorable database: the job id,
            tenant id, customer id and phase-1 time, for example as one object per erase in a
            dedicated bucket that the database restore doesn't touch.
          - **The record is the job's first step, not part of phase 1.** A PUT can't commit
            with Postgres. Inside phase 1 it would be a provider call in the transaction that
            holds the exclusive stripes, under a sub-second deadline. Right after phase 1's
            commit, a crash or a deploy before the PUT would leave a job that completes with no
            record, and a later restore from an older backup would bring the customer back with
            nothing in the runbook to re-erase them. So:
            - Phase 1 creates an `erase_record` step row like every other step, and the worker
              runs it first: an idempotent PUT keyed by the job id, confirmed with a GET, retried
              and alerted like any provider step.
            - A failing record step doesn't hold up the scrub, but the job can't close
              `completed` until it is `done`.
            - Its call site is registered with a kind of its own, `erasure_record` (see "A
              registered entry is one of five kinds" below).
          - U7 adds a restore step to `docs/runbooks/rollback.md`: before the app takes traffic,
            start a new erase for every logged erase newer than the backup.
          - Test: kill the process right after phase 1 commits. After restart the worker writes
            the record first, and it exists before `erase_completed`. A simulated restore from a
            pre-phase-1 snapshot, followed by the runbook step, re-runs the erase.
        - Deepgram: no call site sets `mip_opt_out=true`. Deepgram asks for that flag on each
          request that should stay out of its Model Improvement Partnership Program, so the
          live-call audio and U4's PCI pass fall under it.
        - QuickBooks keeps the old `DisplayName`, email and phone in the company's Audit Log after
          the anonymize.
        - Google Calendar keeps a deleted event in the calendar's bin for about 30 days, where the
          technician can restore it. The result lists the calendar store as provider-retained in
          the bin until its purge date.
        - Owner decision 1 covers these defaults, including whether to set `mip_opt_out=true` on
          every Deepgram request and whether to seek zero data retention from OpenAI.

    The erase code and its tests are then written against that inventory. The list of stores below
    is a starting point, not the definition.
    - **External sinks are erased too, or the erase says it is incomplete.**
      - With content capture on, the erase deletes the subject's Langfuse traces through the
        Langfuse API, keyed by the collected correlation and session ids.
      - **The Langfuse step targets every trace that may exist, not only current ones.**
        - **Capture that has since been turned off.** Capture can be on for months, with the
          PRIV-6 acknowledgement, and then turned off. So each boot records when
          `LANGFUSE_CAPTURE_CONTENT` is on, as capture-on intervals. The step runs whenever any
          interval falls inside Langfuse's retention period, whatever the setting is now.
        - **A trace lives in the project it was exported to.** Langfuse API keys are scoped to one
          project, so a trace fetched or deleted with another project's keys returns 404. If
          capture ran into project A on Langfuse Cloud and the deployment then moved to project B,
          or to a self-hosted Langfuse, every delete and re-check would go to B and count A's
          traces clean. That is the wrong-account 404 ruled out above for Twilio and Stripe. So:
          - Each capture-on interval also records `LANGFUSE_BASE_URL` and the project of the
            public key in use.
          - Each Langfuse target is tied to the projects whose intervals cover its run's time. The
            step deletes and re-checks on those projects' keys, which a separate setting keeps for
            retired projects. A 404 counts as clean only from that project.
          - When a project's keys are no longer available, the target ends `provider_retained`
            with that reason.
          - Test: traces exported under project A are deleted in A after the config moves to B,
            and a 404 from B isn't counted done.
        - **Historical runs.** The trace id is the request's `correlationId`
          (`ai/gateway/trace-exporter.ts:7`), and pre-linkage runs have random correlation ids.
          So the correlation id of every `ai_runs` row that the historical scan scrubs, or that
          the owner confirms, is added as a Langfuse target.
        - **Runs U4 has already purged.** U4's purge scrubs `ai_runs` content past its window but
          never touches Langfuse, whose self-hosted retention is unlimited by default. The content
          scan can't match those rows any more, so their traces can't be found. Owner decision 1
          covers setting the Langfuse project's data retention to at most the `ai_runs` window.
          Until that is set, the result says that traces older than the last purge may remain,
          as `provider_retained` under Langfuse's retention.
      - The Langfuse SDK queues events synchronously and sends them later. A trace queued before
        the tombstone was written can therefore still go out after the external delete and recreate
        the trace (`trace-exporter.ts` exposes `flush()` only for shutdown). So the erase does four
        things:
        - flushes the exporter queue before the external delete, through a new erasure-specific
          drain. The existing `LangfuseTraceExporter.flush()` calls `shutdownAsync()` and swallows
          errors. Using it here would either shut down the process-wide exporter for good or fail
          silently. The new drain leaves the exporter running, waits for pending sends, and
          propagates any failure. A failure marks the store `incomplete` instead of reporting
          success.
        - applies the tombstone at the exporter's send boundary too, so queued events for the
          subject are dropped before transport
        - deletes again after the drain window
        - reports success only once that second delete and its re-check come back clean
      - **A self-hosted Langfuse with a versioned blob bucket keeps the raw events.** Langfuse v3
        stores ingested events and media in S3-compatible blob storage, and its data-retention
        docs say that on versioned buckets, delete markers and non-current versions must be
        removed by hand or by a lifecycle rule. A trace delete and its API re-check would come
        back clean while the event objects with the transcript stay as non-current versions,
        the same trap as "On a versioned bucket a HEAD 404 proves nothing" below. So:
        - In production or staging, the boot config guard refuses a self-hosted Langfuse unless
          an acknowledgement says its event and media buckets are unversioned, or names a
          noncurrent-version expiration of at most a fixed number of days (the PRIV-6 shape).
        - With the expiration acknowledgement, the Langfuse store ends `provider_retained` until
          that horizon after the delete, naming the bucket.
      - **The second delete waits by time, not on the drain.** The drain reaches only the process
        running the erase, and only while it lives. The gateway exports from every process, and a
        resumed job can't drain a queue that belonged to an earlier one. So the second delete is a
        job step with a `not_before`: the phase-1 commit time plus the SDK's longest send time,
        retries included, plus a declared ingestion-lag bound (below). By then every process's
        event for the subject has either been sent and ingested, so the second delete removes it,
        or been dropped at the send boundary.
      - **Langfuse ingests and deletes asynchronously, so each delete is confirmed after a wait.**
        A finished send only means Langfuse accepted the event. Ingestion is processed later, and
        events can take minutes to appear. A trace delete runs in the background, usually within
        about 15 minutes, with no confirmation (Langfuse's data-deletion docs). A re-check before
        an accepted event is ingested finds nothing and counts as clean, and a re-check right
        after a delete still sees the trace and burns a retry. So:
        - Each Langfuse delete is a delete, then a wait checkpoint, then a re-check. The wait's
          `wait_deadline` covers Langfuse's deletion processing, for example 1 hour.
        - **A backstop re-query.** Like the S3 listing, the sweep re-queries the subject's trace
          ids and session ids on a schedule for a fixed period after the step is done, for example
          daily for 7 days. A trace that reappears re-arms its target (see "A target that comes
          back re-arms its row" above), which re-opens the job.
        - Test: against a mocked Langfuse that ingests an event 10 minutes after accepting it and
          deletes 15 minutes after the call, the job completes only after the late event is
          deleted, and no re-check counts as a failed attempt.
      - If any external delete fails, the erase result reports that store as incomplete, the owner
        sees it, and `alertOperator` fires.
      - It never claims success it hasn't confirmed.
    - Build an erase-coverage manifest in code. It names every table that references `customers`.
      Foreign keys alone miss many links, because a lot of customer links in this schema are bare
      columns: `leads.converted_customer_id` (`schema.ts:1411`), `portal_sessions.customer_id`
      (`:1760`), and the bare `customer_id` columns at `:1611`, `:2963`, `:4171` and `:4243`. So the
      manifest covers three kinds of link:
      - every foreign key to `customers`, whether in a table definition or added later by
        `ALTER TABLE`
      - every column whose name ends in `customer_id`, foreign key or not, including external ids
        such as `stripe_customer_id` (classified `keep` or `anonymize` with a reason)
      - stores linked only by the customer's identifiers, such as an unconverted lead that matches
        the customer's phone or email. These are listed explicitly, with how each is matched.
    - Classify each table, with a reason, as exactly one of:
      - `scrub` (delete or blank its PII columns)
      - `anonymize` (keep the row and blank the PII, dropping the link where the column allows it)
      - `keep` (a legal or financial retention reason)
    - **Each `anonymize` table names how it treats its link.** Many link columns are `NOT NULL`:
      `service_locations.customer_id` (`schema.ts:340`), `jobs.customer_id` and `jobs.location_id`
      (`:370-371`), `estimates.job_id` (`:526`) and `invoices.job_id` (`:623`). Invoices and
      payments have no customer column at all; they reach the customer through the job. An
      `UPDATE` that nulls one of those links fails with `23502` on every retry, rolls back the
      blanking in the same statement, and leaves the PII. So:
      - `null-link` nulls the link, where the column is nullable.
      - `keep-link` keeps the link to the blanked `customers` row, and relies on the tombstone's
        owned-entity keys to fence its children. The `customers` row is therefore blanked, never
        deleted.
      - The schema test fails on an `anonymize` table whose link column is `NOT NULL` unless its
        method is `keep-link`.
    - A schema test reads the live catalog (`pg_constraint` for foreign keys, and
      `information_schema.columns` for every `%customer_id` column) in the Docker-gated suite. It
      fails when any match, or any newly added one, is missing from the manifest. A future table or
      bare link column therefore can't silently escape the erase.
    - **Every table is created by the migrations, so the catalog sees it.** `PgQueue` creates
      `_queue_messages` and `_queue_dlq` in `ensureTable` (`queues/pg-queue.ts:38-71`), kept out
      of the `MIGRATIONS` registry on purpose, and `flags/pg-feature-flags.ts:27` creates
      `_feature_flags` the same way. A freshly migrated test database doesn't have them
      (`test/integration/shared.ts:98` checks `to_regclass('_queue_messages')` for that
      reason), so the catalog tests would see them only in some test orders. So:
      - Those three tables move into `MIGRATIONS`.
      - A structural test fails on `CREATE TABLE` in `packages/api/src` outside `db/schema.ts`.
      - The queue tables are then classified like any other (see "The queue tables hold names,
        phones and message bodies" below).
    - **The manifest covers the whole customer-owned graph, not just direct links.** Many tables
      reach the subject only through another subject-owned entity. For example,
      `appointments.notes` and `job_timeline_events.description` / `metadata` link only through
      `job_id → jobs.customer_id`. So:
      - The schema test computes the transitive closure from `customers`, recursively over
        `pg_constraint`, and adds bare link columns named after a subject-owned table (`job_id`,
        `appointment_id`, `estimate_id`, `invoice_id` and so on).
      - Every table in that closure must have a manifest entry, a classification, and the erasure
        trigger if it is `scrub` or `anonymize`.
      - Test: a test-only migration adds a table linked only by `job_id`. The coverage test fails
        until the manifest classifies it.
    - **The catalog test also finds tables linked by the tombstone's other keys, or holding an
      identifier.** The closure from `customers` covers only foreign keys and bare columns named
      after a subject-owned table. `call_usage_events` holds `caller_phone` keyed only by
      `call_id TEXT`, and it can't flag that. So:
      - Any table with a column named `session_id`, `voice_session_id`, `call_sid`, `call_id`,
        `correlation_id`, `conversation_id`, `message_sid` or `recording_sid`, foreign key or not,
        must have a manifest entry.
      - So must any table with a column matching the identifier patterns (`%phone%`, `%email%`,
        `caller_%`, `recipient%`, `%_name`, `%address%`).
      - **So must any table with a `jsonb`, `json` or free `text` column**, outside a short safe
        list of enum-like status, type and kind columns. The safe list accepts a column only when
        it has an enum type, or a `CHECK` constraint that limits it to a literal set, read from
        `pg_type` and `pg_constraint`, never by name, so a `failure_kind text` that stores
        provider message text can't escape. The test parses `pg_get_constraintdef` and accepts
        only `col IN (...)` or `col = ANY (ARRAY[...])` over literals. A length, non-empty or
        pattern check doesn't count: free text under a length check is already common here,
        such as `voice_call_corrections.note` (`schema.ts:8456`) and
        `customer_text_wording.body` (`:8226`). Fixture: a `failure_detail text CHECK
        (char_length(failure_detail) <= 2000)` column is refused from the safe list. The list
        sits in the same reviewed snapshot as the `exempt` ids. A
        payload store holds the subject's data
        under no matching column name. `webhook_events` (`schema.ts:264-276`) has only `source`,
        `event_type`, `idempotency_key`, `payload`, `status` and `error_message`, no `tenant_id`,
        and nothing deletes from it. The Twilio route records the whole body, `From`, `Body` and
        `MediaUrl0` included, as `payload` (`webhooks/routes.ts:3237`, for `/twilio/sms/:tenantId`
        at `:3335`), and the SendGrid route stores whole event batches with recipient emails
        (`:3430`). So:
        - The Twilio and SendGrid receipt writers store only ids from now on, as the voicemail
          and LSA receipts already do (`telephony/voicemail-status-route.ts:387-392`,
          `lsa/lsa-webhook.ts:134-137`).
        - The erase blanks `payload` on the `webhook_events` rows keyed by the subject's message
          and call SIDs.
        - A leader-gated purge blanks `payload` on processed rows past a fixed window, no shorter
          than its readers need (`workers/money-reconciliation.ts` reads Stripe receipts). That
          covers older rows the erase can't link. The erase result lists `webhook_events` as held
          until the next purge date, like the calendar bin.
        - `idempotency_keys.response_body` (`schema.ts:7442`) caches API responses, such as a
          customer create, for 24 hours before the hold-reaper prunes them. A step with a
          `not_before` of phase 1 plus that lifetime plus the prune interval confirms that no row
          created before phase 1 is left.
        - The seed-and-erase test sends an inbound SMS and a SendGrid event through their routes,
          and asserts that neither receipt holds the subject's data once the job completes. A
          seeded legacy receipt with a full payload and no subject SID is listed as held, and the
          purge blanks it.
        - **The queue tables hold names, phones and message bodies.** A delay notice carries
          `customerName`, `destination` and `message`
          (`notifications/delay-notifications.ts:257-267`), an emergency page carries
          `callerPhone` (`telephony/emergency-page-retry.ts:66`), and MMS ingest carries
          `fromPhone` and `body` (`sms/tech-status/mms-ingest.ts:323-332`). `last_error` and
          `_queue_dlq.error` keep handler error text, and nothing deletes from `_queue_dlq`. A
          delay notice to Jane that fails three times while Twilio is down would keep her name,
          phone and message there for good. So:
          - The queue tables have no `tenant_id`, so they go on the pinned global list with a
            defined erase rule. A step deletes, or blanks `payload`, `error` and `last_error`
            on, every row whose `payload->>'tenantId'` is the tenant and whose payload holds a
            tombstone key (a customer, session, message SID or appointment id) or matches the
            subject's phone or email hashes in the value pass. The final re-scan repeats it.
          - A leader-gated purge bounds `_queue_dlq` by age, and errors are stored as codes.
          - A handler whose fenced write is refused acks its message, so the message never
            retries into the DLQ.
          - **A tenantless payload store meets the trigger rule another way.** The fence trigger
            probes by `(tenant_id, key)`, and these tables have no tenant column. So the rule
            that a subject-data table is `scrub` or `anonymize` with a fence trigger has one
            exception: a tenantless payload store on the global list, here the queue tables and
            `webhook_events`. Each has an erase step that finds its rows by the payload's
            tenant and keys, a purge that bounds its age, and writers whose own sinks are fenced
            when the message runs. Its entry on the global list names all three.
          - The seed-and-erase test seeds a dead-lettered delay notice for the subject.
      - `keep` with a reason is allowed.
      - Fixture: a test-only migration adds a table with only `call_id TEXT` and
        `caller_phone TEXT`, and the test fails until the manifest classifies it.
    - **Coverage is per column, not per table.** A migration that adds `customers.alt_phone`, or
      `service_locations.lockbox_code`, to a table that is already classified passes every
      table-level test. The scrub blanks only the designated list, and the trigger compares only
      those columns, so the new column would keep the subject's data and accept it again after
      the erase. So:
      - The manifest classifies every column of every table it lists, `keep` tables included:
        - A `scrub` or `anonymize` table's column is designated (blanked and fenced) or retained,
          with a reason.
        - A `keep` table's column is "no subject data", with a reason, or "subject data, blanked
          by the erase while the row is kept". Without this, a later `last_error text` on
          `customer_erasure_steps` that stored "Duplicate Name Exists ... Jane Doe" would keep the
          name for good, and so would a message-body column added to a consent or DNC row, or to
          U8's spend tables.
      - **Outside the erasure record, a retained table that holds subject data is `anonymize`,
        never `keep`.** A `keep` table has no trigger. `call_usage_events` is the AI answering
        billing ledger (`schema.ts:7057-7070`), naturally `keep` for financial retention, with
        `caller_phone`. While the subject's live call is still running, the job would blank that
        column, and at session end `billing/call-usage-events.ts:73-77` inserts the row with
        `caller_phone`. Nothing would refuse or late-link it, and the phone would stay. And a
        generic scrub that walks only `scrub` and `anonymize` tables would blank no `keep`
        column at all, while the schema test still passed. So:
        - Any non-U7 table with a subject-data column is `scrub` or `anonymize`, and one whose
          rows are retained is `anonymize`, which brings the trigger, the manifest-driven
          blanking and the late-link. The schema test fails on a non-U7 `keep` table with a
          "subject data, blanked" column.
        - A third label, "subject data, retained by law", is allowed only on a pinned list of
          tables: consent, DNC and the DNC audit rows.
        - On U7's own tables, each "subject data, blanked" column names the transition that
          nulls it, such as a target's encrypted key at its terminal transition.
        - The seed-and-erase test generates its seed from the manifest. It puts a sentinel in
          every column classified as subject data, and asserts each is blank once the job
          completes, including after a write that arrives once its blank step has run.
      - The schema test reads `information_schema.columns` for every manifest table, and fails on
        any column the manifest doesn't classify.
      - It also checks each table's trigger against the manifest: the trigger's arguments, or its
        generated function, name exactly the manifest's designated and key columns. A trigger
        configured with the wrong key column fails.
      - The scrub step takes its column list from the manifest, never from a hand-written list.
      - Test: a test-only migration adds a text column to `customers`, and the coverage test fails
        until the column is classified.
    - **The manifest records how each table is scrubbed.** Blanking can break a constraint.
      `tenant_entity_aliases` (`schema.ts:6412-6432`) has `normalized_alias NOT NULL` with
      `CHECK (char_length(normalized_alias) BETWEEN 1 AND 120)`, and a unique index on
      `(tenant_id, entity_kind, normalized_alias) WHERE active = true`. A blank fails the check,
      and a fixed placeholder collides on the index once a second customer in the tenant is
      erased. The alias step would fail every retry, and the name would stay. So:
      - Each `scrub` table names its method: blank the designated columns, or delete the row.
      - `tenant_entity_aliases` rows that name the subject are deleted.
      - The schema test fails on a `blank` table whose designated columns carry a check
        constraint or a unique index.
      - The seed-and-erase test seeds alias rows for two customers erased in the same tenant.
      - **Each designated column declares its scrubbed value.** Many are `NOT NULL`:
        `service_locations.street1` and `postal_code` (`schema.ts:342`, `:346`),
        `message_dispatches.recipient` (`:1101`), `call_me_back_tasks.caller_phone` (`:3892`) and
        `ai_runs.input_snapshot`, a `JSONB NOT NULL` (`:181`). A scrub that writes `NULL` fails
        with `23502` on every retry and rolls back the whole statement, PII included. `''` isn't
        valid `jsonb`. And a trigger whose blank test knew only `NULL` or `''` would see the
        erase's own `'{}'` as a new value and refuse the scrub. So:
        - The manifest declares each designated column's scrubbed value: `NULL` only where the
          column is nullable, `''` for `NOT NULL` text, and `'{}'` or `'[]'` for `NOT NULL`
          `jsonb`.
        - The scrub writes that value, and the trigger treats exactly `NULL` or that value as
          blank.
        - The schema test fails on a `NOT NULL` designated column whose declared value is `NULL`
          or doesn't cast to the column's type.
      - **A delete names every foreign key that points at the row.** A `files` row the erase
        deletes can still be referenced. `job_photos.file_id` (`schema.ts:1731`) and
        `attachments.file_id` (`:4038`) are `NOT NULL REFERENCES files(id)` with no `ON DELETE`
        action. `voice_recordings.file_id` (`:153`, made nullable by
        `088_fix_schema_constraints`, `:2427-2431`) and `messages.file_id` (`:136`) are nullable,
        with no action either. A call recording's `files` row is keyed by the Call SID
        (`voice/voice-service.ts:608-624`), a tombstone key, while its `voice_recordings` row is
        kept with only its transcript blanked. Deleting the `files` row first would fail with
        `23503`, roll back the `erasure_storage_cleanup` insert in the same transaction, and do
        so on every retry. The step would end `incomplete` for good, and an attachment's `files`
        row would keep a `filename` such as `Jane_Doe_passport.jpg`. So:
        - The manifest lists, for every delete-method table, each foreign key that references
          it, read from `pg_constraint`, and how it is handled:
          - When the erase also deletes the referencing row, that row is deleted first, in the
            same transaction, in child-first order taken from `pg_constraint`.
          - When the referencing row is kept and its link is nullable, the link is nulled in
            that transaction, before the delete.
          - When the referencing row is kept and its link is `NOT NULL`, the parent row can't be
            deleted. A `files` row referenced that way is blanked instead: `filename` and
            `s3_key` take their declared scrubbed values, the key is kept, encrypted, only on the
            cleanup row, and the S3 object is still deleted.
        - The schema test fails on a delete-method table referenced by a `NOT NULL` foreign key
          from a table whose method keeps its rows, unless the delete-method table declares that
          blank fallback, as `files` does.
        - The seed-and-erase test seeds a call recording, a job photo and an attachment for the
          subject. Each `files` row is deleted or blanked, each S3 object is gone, and no step
          fails with `23503`.
    - Free-text stores that can hold a customer's details without a foreign key (notes, messages,
      transcripts, `ai_runs`) are listed in the manifest explicitly, with how each is matched. The
      `jsonb`, `json` and free `text` rule above is the test behind that list.
  - **Fence writers that are still in flight, or the erase can be undone.** An erase can overlap an
    asynchronous writer. For example, the gateway creates a pending `ai_runs` row before it
    dispatches, and only writes `outputSnapshot` after completion (`gateway.ts:568-588`, `:679`);
    the trace export, transcript append and session summary work the same way. A completion that
    lands after the scrub would put the data back.
    - The erase first writes a durable, tenant-scoped erasure tombstone. It is keyed by:
      - the customer id, and the collected session, call and correlation ids
      - **every owned-entity id that other rows link by**: the jobs, estimates, invoices,
        payments, appointments and service locations in the manifest's transitive closure,
        collected in phase 1. Phase 2 severs or anonymizes the parent links, so a child row such as
        `invoice_line_items`, which carries only `invoice_id` (`schema.ts:653-664`), could no
        longer be traced to the subject. Its `invoice_id` still matches the tombstone. A leaf
        row's own id is added only where it becomes the row's only key (see "Phase 1 is sized
        by its fence keys" below).
      - the subject's normalized phone numbers and email addresses, stored as keyed hashes
        (HMAC-SHA256 with a server-side key), so the tombstone keeps no raw identifier
      A writer that knows only a recipient, with no customer id, still matches. The erased
      customer row no longer holds the identifiers, so without this such a writer could never
      match the tombstone.
    - **Each tombstone row names its job and its key kind.** Two customers in one tenant can share
      a household phone. A flat key set, unique on `(tenant_id, key)`, would fail the second
      customer's phase 1 with `23505` on every attempt, so that customer could never be erased. A
      flat set also can't say which job a match belongs to, which a late target and a late-link
      inbox row both need, and it can't keep one job's exemption from lifting another job's fence.
      So:
      - A tombstone row is `(tenant_id, job_id, key_kind, key)`, unique on all four. Every add, in
        phase 1, the late-link trigger and the lead step, uses `ON CONFLICT DO NOTHING`.
      - The `(tenant_id, key)` probe index isn't unique.
      - `key_kind` separates fence keys (customer, owned entity, session, call, correlation,
        recipient hash, recorded source) from exemptions (see "A held send has a durable release
        path" below).
      - A write is fenced by every job that holds a matching fence key, under the provenance rule
        below. An exemption lifts only the hold of the job that recorded it, and never overrides
        another job's fence.
      - A match adds its late target, or its late-link inbox row, to every job that holds the
        matched key.
      - Test: two customers in one tenant who share a phone are both erased, and both jobs
        complete. A released send's source then sends. A later erase that records that same
        source refuses it.
    - **One fence for every writer, enforced by a test, not by a list.** The writers named in this
      plan are examples, and a list can always miss one. U7 adds a single primitive,
      `withErasureFence(tenantId, sinkId, subjectKeys, write)`:
      - `sinkId` names the writer's `externalSinks` entry (see the structural test below), which
        holds its worst-case duration and its reconciliation read.
      - **The entry also declares the key kinds its writer must pass**, such as a customer id, or
        a recipient hash plus a source row id. `withErasureFence` throws when the key set is empty
        or lacks a declared kind. A calendar sync whose lookup returned null, or a customerless
        send that passes only its job id, would otherwise lock no stripe the tombstone holds and
        match no key. A missing key is an error, never an unfenced write. A unit test covers
        each entry, and a fixture with an empty key set throws.
      - It takes the subject's erasure lock in shared mode, checks the tombstone, and records a
        write-ahead claim, all in one transaction.
      - **The tombstone probe is its own statement, issued after the one that took the
        stripes.** Under `READ COMMITTED` a statement's snapshot is taken when the statement
        starts, not when a lock inside it is granted. Suppose a claim is written as one round
        trip, `WITH l AS (SELECT pg_advisory_xact_lock_shared(…)) INSERT … WHERE NOT EXISTS
        (<tombstone probe>)`, and it starts while phase 1 holds the stripe in exclusive mode. It
        waits, is granted the stripe once phase 1 commits, and still evaluates its `NOT EXISTS`
        against the snapshot from before the wait. It sees no tombstone and inserts a `claimed`
        row that phase 1's claim fence never saw, so the send goes out to the erased subject.
        So:
        - In `withErasureFence`, the senders' claim transaction, the release re-fence and the
          `BEFORE` trigger, the statement that takes the stripes runs first. The probe, and any
          write that depends on it, run in a later statement.
        - Each fence and late-link trigger function is `plpgsql` and `VOLATILE`, so each
          statement inside it takes a fresh snapshot. A `STABLE` function would reuse its
          caller's.
        - The catalog test asserts `provolatile = 'v'` on every fence and late-link trigger
          function.
        - Docker-gated test: phase 1 holds the stripes while a sender and a trigger-bearing
          insert each queue for the shared stripe. Phase 1 commits, and both see the tombstone:
          the send is refused, and the content is dropped.
      - It runs the write, or the provider call, only after the guarded claim flip
        `claimed → sending` (see below). Every sink uses that same flip, whatever table holds its
        claims, so phase 1's fence of `claimed` claims stops every sink alike.
      - **The lock covers every key the tombstone holds, not only the customer id.** Many writers
        can name the subject only by the key they carry, such as `invoice_line_items.invoice_id` or
        a transcript turn's session id. A lock on the customer id alone doesn't serialize them with
        phase 1. So:
        - The erasure lock is keyed like the tombstone probe, by `(tenant_id, key)`, hashed onto a
          fixed number of lock stripes per tenant, so phase 1 takes a bounded number of locks.
        - **Stripes and the spend lock have key spaces of their own.** The app takes most
          advisory locks as `pg_advisory_xact_lock(hashtext($1))` (`jobs/pg-job.ts:138`,
          `invoices/payment-mode-change.ts:171`), whose keys are `int4`, and `app.ts:2603`
          already records one silent collision (590014). With 10,000 tenants at, say, 64 stripes
          each, plus 10,000 spend keys, about 1.5 collisions between a spend key and a stripe are
          expected. Tenant B's phase 1 would then hold tenant A's spend lock in exclusive mode,
          and a B transaction holding that stripe in shared mode would make every reserve and
          settle in A wait. So:
          - Stripes and the spend lock use the two-key form, `pg_advisory_xact_lock(int4,
            int4)`, with one fixed class id for erasure stripes and another for the spend lock.
            The object id is `hashtext` of the tenant and stripe, or of the tenant. Postgres
            keeps the one-key and two-key spaces apart, so no one-key lock can collide with them.
          - The existing two-key locks (`proposals/execution/idempotency-lock.ts:65`,
            `db/tenant-transaction.ts:112`, `db/migrate.ts:51` and the trigger at
            `db/schema.ts:8683`) take their first key from a hash, so a collision with a fixed
            class needs both halves to match.
          - Ascending stripe order means ascending object id, so two tenants whose stripes
            collide still lock in one order.
          - A unit test pins the two class ids as distinct constants, and a structural test
            fails on either literal outside the stripe helper and the spend module.
        - **Phase 1 queues for its stripes, inside a budget, so writers can't starve it.** A
          try-lock that rolls back whenever any stripe is busy may never find every stripe free at
          once: not in a tenant with steady transcript writes, and not behind one long batch
          transaction. Every erase request would then fail. So:
          - Phase 1 collects the subject's keys and takes their stripes in exclusive mode, in
            ascending stripe order, with a blocking `pg_advisory_xact_lock`. A waiting request
            keeps its place in the lock queue, so shared requests that arrive after it wait behind
            it.
          - **The budget is a wall-clock deadline, not a sum of waits.** A budget that counts only
            lock waits leaves out the re-collection and the round trips between locks. With a
            900 ms budget, a re-collection that runs for 650 ms under the locks still leaves the
            next wait its full 900 ms, and a writer that began waiting on phase 1 early in that
            re-collection reaches its deadlock check first. So:
            - The deadline is fixed when phase 1 is granted its first stripe, since no writer can
              wait on phase 1 before then. The first lock's own wait is bounded by the budget.
            - Before each lock, phase 1 sets `lock_timeout` to the deadline minus
              `clock_timestamp()`, through `set_config('lock_timeout', …, true)`. Every later
              statement, the collections and the claim fence included, runs under a
              `statement_timeout` set the same way, so work that isn't a lock wait counts too.
            - When no time is left, phase 1 rolls back and retries, as on a timeout. It never sets
              either timeout to 0, which would turn it off.
            - The deadline minus the first grant stays below the server's `deadlock_timeout` (1s
              by default), less a margin.
          - **Phase 1 collects to a fixed point, not twice.** One re-collection misses a row
            created under an entity that the re-collection itself found. Between phase 1's first
            collection and its locks, a booking flow commits a new job J for the customer. The
            second collection finds J. Before phase 1 asks for J's stripe, the flow's next
            transaction inserts appointment A under J, holding J's stripe in shared mode, and A is
            still uncommitted when the second collection runs. Phase 1 then waits for J's stripe
            and writes the tombstone without A. Rows keyed only by A, such as
            `technician_location_pings` (`schema.ts:989-993`, GPS at the customer's address) and
            `delay_notice_state` (`schema.ts:5345-5348`), then pass the trigger for good. So:
            - Phase 1 repeats collect-then-lock. Each round takes its new stripes in ascending
              order. It stops when a collection, run while phase 1 holds the stripe of every key
              found so far, finds no key whose stripe it does not hold.
            - That last collection's keys are the ones phase 1 writes into the tombstone.
            - All rounds share the one deadline. The loop always ends, because each round adds at
              least one stripe and a tenant has a fixed number of them.
          - **Why the deadline is below `deadlock_timeout`.** A writer can hold one shared stripe
            while it waits for another that phase 1 holds, because the trigger takes stripes row by
            row, in the order the writes happen. If phase 1 then waits for the writer's stripe, the
            two are deadlocked. Postgres checks a lock wait for deadlock once, `deadlock_timeout`
            after that wait began, and the backend whose check finds the cycle is aborted. That
            could be the writer, such as a live call's transcript append. Any wait on a stripe
            phase 1 holds began after phase 1's first grant, so its check comes after phase 1's
            deadline. So phase 1 gives up first: it rolls back, releases every stripe, and the
            writer goes on.
          - **A writer that was already waiting on another writer can still be the one aborted.**
            Writer W2 holds a session stripe in shared mode and has waited 700 ms on a
            `voice_sessions` row lock held by W1 when phase 1 starts. Phase 1 takes stripe s_a and
            waits on W2's stripe. W1 then asks for s_a, for the customer key it writes next. That
            closes a cycle, W2 → W1 → phase 1 → W2. W2's check fires 300 ms later, inside phase
            1's deadline, and Postgres aborts W2. No timeout on phase 1 can rule that out. So
            `withErasureFence`, and the trigger-bearing write paths on a live call (the transcript
            append, the session summary and status updates), retry their transaction once on
            SQLSTATE `40P01`.
          - When the budget runs out, phase 1 rolls back and retries after a short backoff, a fixed
            number of times. Then the endpoint returns a typed `409`: the erase didn't start, and
            the owner can try again.
          - **Repeated failures to start alert, though no job exists.** With no job row there is
            no sweep, age alarm or `erase_incomplete` alert. So each `409` increments a
            per-customer count in a small U7 table of its own (`tenant_id`, `customer_id`, the
            count and an alert outbox pair), in its own transaction. At a fixed count it marks an
            operator alert due, sent and stamped like the close's alert. The inbox mover does the
            same per inbox row: a fixed number of timeouts on one row marks its alert due, as
            the inbox-age alert does.
        - **Phase 1 stays short, because writers on its stripes wait while it runs.** It writes the
          tombstone, the job row, its encrypted identifiers, the step rows and the queue wake,
          and fences the subject's `claimed` and `released` write-ahead claims in every sink's
          claims table (see
          "phase 1 fences every sink's claims" below). The snapshot of targets is a job step, not
          part of phase 1 (see "Every target the later steps need" above).
        - **Phase 1 is sized by its fence keys, not by the history behind them.** A customer of
          three years can have 150 jobs, 400 appointments, about 16,000
          `technician_location_pings` keyed by appointment, about 4,000 `call_transcript_turns`
          and 1,500 `invoice_line_items`. If every row of the closure went into the tombstone,
          phase 1 would collect about 23,000 rows at least twice and insert them, under
          exclusive stripes and a sub-second deadline. Every attempt would time out, every retry
          would get the `409`, and no job would exist to alert. So:
          - Phase 1 collects and writes only the fence keys: the customer id, the recipient
            hashes, and the ids that other rows link by (jobs, estimates, invoices, payments,
            appointments, service locations, sessions, calls and correlation ids). A leaf row
            such as a location ping or a transcript turn is fenced by its link column, which
            matches one of those keys.
          - A row's own id goes into the tombstone only where it becomes the row's only key: a
            row whose link the erase nulls (`null-link`), or a recorded source. The step that
            nulls the link adds the id in the same transaction, under that id's stripe in
            exclusive mode and phase 1's deadline rules, as the lead step does (see "Recording a
            source in phase 2 is a limit change" below).
          - `snapshot` collects the per-row targets in batched checkpoints (see "Every target the
            later steps need" above), and the re-open triggers touch the job row once per
            statement (see "The re-open triggers are statement-level" above).
          - Docker-gated test: for a subject with thousands of appointments, location pings and
            transcript turns, phase 1 commits inside its deadline, and every one of those rows is
            erased.
        - Every writer and every trigger takes the stripe of each key it checks, in shared mode.
          `withErasureFence` takes all of its stripes at once, in ascending order. An unrelated key
          that shares a stripe only makes its writer wait out a short phase 1.
        - **One lock order with U8: the stripes first, the spend lock last.** No transaction takes
          a stripe while it holds U8's per-tenant spend lock. Phase 1 and the erasure steps never
          take the spend lock. U8 states the same rule. So an erase can make an AI write wait only
          at its stripe, never while that write holds the spend lock, and it never holds up the
          tenant's other reserves and settles, live calls included. U8 checks this order at
          runtime (see U8's "The order is checked at runtime").
      Every writer that can persist or export the subject's data goes through it. That includes:
      - AI content: the `ai_runs` completion, the trace export, the transcript append, the summary
        and the knowledge-chunk ingest
      - outbound messages, email and calls
      - business-integration creates: QuickBooks `ensureCustomerExternalId`
        (`integrations/accounting/sync-service.ts:280-310`) and Stripe saved-card customer
        creation (`payments/stripe-saved-card.ts:84-124`)
      **The structural test enumerates every outbound call, not a list of known clients.** A
      closed list missed two existing writers:
      - `financing/financing.ts:133-145` sends the customer's name, email and phone to Wisetack
        before it saves the local application.
      - `integrations/calendar-sync.ts:132-179` creates a Google Calendar event with the customer's
        name and address before it saves the external event id.
      So:
      - **The test checks each call site, not each file.** A registry of files would let a second
        `fetch` or SDK write, added to a file that is already registered, skip the fence while the
        test still passes.
      - The test parses `packages/api/src` with the TypeScript compiler API and its type checker
        (`typescript` is already a dev dependency, `packages/api/package.json:92`).
      - **A call site is defined by the type of the value being called, not by the symbol it
        names.** Most outbound calls here go through an injected value, wherever it flowed (a
        property, a parameter or a return value):
        - `notifications/twilio-delivery-provider.ts` calls `sms.fetchImpl(...)` and
          `email.fetchImpl(...)` (`:265`, `:361`), a property filled by
          `config.sms.fetchImpl ?? fetch` (`:193`, `:206`). A scan that resolves symbols sees
          only the `?? fetch` default, so a new `sendMms()` calling `sms.fetchImpl(...)` with no
          fence would need no marker.
        - QuickBooks calls `fetchFn` (`integrations/accounting/quickbooks-client.ts:42`), Stripe
          casts `globalThis.fetch as unknown as StripeFetch` (`payments/stripe-saved-card.ts:206`),
          and `shared/timed-fetch.ts:36` calls `(baseFetch ?? globalThis.fetch)`.
        - Langfuse is loaded with `require('langfuse') as LangfuseModule` and called through the
          local `LangfuseClientLike` interface (`ai/gateway/trace-exporter.ts:104-129`), so it
          resolves to no SDK method at all.
        So a call site is any call whose callee or receiver is one of these:
        - a value with the global `fetch`'s type
        - a value whose type a provider SDK package declares, such as `twilio`, `openai`,
          `langfuse` or `posthog-node`
        - a value of a registered provider-surface type, such as `LangfuseClientLike`,
          `StripeFetch`, `TwilioA2pClient` or `TwilioProvisioningClient`
        - a provider write method: `generateUploadUrl` or `putObject` on `StorageProvider`, or a
          wrapper registered as `via` (below)
        - **a transport value**: the global `WebSocket` type, `ws`'s types, and `request`,
          `connect` and `send` on the Node built-ins `http`, `https`, `http2`, `net`, `tls` and
          `dgram`. `ai/tts/elevenlabs-stream.ts:119-121` and
          `voice/transcription-providers.ts:580-582` build their client as `globalThis.WebSocket
          ?? (NodeWebSocket as unknown as typeof globalThis.WebSocket)`, then `send` the TTS text
          or the caller's audio (`elevenlabs-stream.ts:201`, `transcription-providers.ts:745`).
          That value has neither `fetch`'s type nor an SDK type, so without this rule both
          streams pass with no marker.
        A reference that isn't a direct call, such as `fetch` assigned to a variable or passed as a
        value, counts too, so an alias can't hide a call.
      - **The test also fails on whatever can hide that type**, naming file and line:
        - a cast (`as`, or `as unknown as`) of `fetch`, an SDK value or a transport value to a
          type that is neither a transport type nor a registered provider-surface type
        - a `require()` or dynamic `import()` of a provider package whose result isn't typed by a
          registered provider-surface type
        - an `any`-typed callee in a file that references `fetch`, a provider package or a
          provider-surface type
      - **Each call site is covered in one of two ways.** Otherwise the test fails, naming its file
        and line.
        - **Fenced:** it sits inside the `write` callback of a `withErasureFence` call, and it
          resolves to the entry the call's `sinkId` names. Every fence call's `sinkId`, whether or
          not the call wraps a network call, must be a string literal that names a subject-data
          entry in `externalSinks`.
          - **One callback reaches one sink.** A booking flow could wrap a Google Calendar insert
            and the confirmation SMS in one `withErasureFence(t, 'twilio_sms', …)`. The calendar
            insert would then have no claim of its own and no read-back for a lost response, and
            the SMS sink's short `deadline_at` could abort it mid-flight. So each `externalSinks`
            entry declares the call sites it covers: its SDK, surface or transport types, its
            `via` wrappers, or a marker on a bare `fetch`. The test resolves every call site
            inside a fence callback to its entry, and fails unless that entry is the fence's
            `sinkId`. A bare `fetch` inside a callback needs a `// external-sink: <id>` marker
            naming the same sink, and a callback that reaches two sinks fails.
          - **"Fenced" means bounded by the callback, not only written inside it.** A call
            site that drops the callback's `AbortSignal`, such as a call-site
            `withRetry(() => client.create(params), 4)`, keeps retrying past `deadline_at`. A
            `void client.create(...)` lets the callback return before the call lands, and
            passes `no-floating-promises`, whose `ignoreVoid` option is on by default
            (`eslint.config.mjs:66`). Either way the Stripe listing or the QuickBooks queries
            run after `deadline_at`, find nothing and record the target done, and then the
            create lands with the subject's name and email. So:
            - The scan requires every fenced call site to receive the callback's `signal`, or a
              signal derived from it with `AbortSignal.any`, among its arguments or options. A
              `via` wrapper must take a signal parameter and pass it to its marked call.
            - It fails on a fenced call site whose promise isn't awaited or returned on the
              callback's own path: `void`-ed, unawaited, or inside a nested function handed to
              `setTimeout`, `forEach` or a queue.
            - A sink whose SDK can't take a signal declares that. Its entry sets the SDK's own
              timeout and retry options to literal values, which the test checks against the
              entry's declared duration.
            - Fixtures: a fenced call that drops the signal fails, and so does a `void`-ed one.
        - **Registered:** the line above it carries `// external-sink: <id>`, and `<id>` is an
          `externalSinks` entry with a reason. One id covers one call site, so a new call in a
          registered file needs its own entry.
      - A registered entry is one of five kinds: `exempt`, `erasure_cleanup`,
        `erasure_record`, `no_subject_data` and `via`.
        - `exempt`, with a reason, for example a model provider receiving only already-fenced
          content. Its manifest retention entry says what the provider keeps anyway (see "Copies a
          provider keeps anyway" above). The ElevenLabs and Deepgram streams are registered this
          way.
          - **`exempt` is not a free-text allowlist.** Otherwise a new Twilio Lookup or SMS path
            marked `exempt` "read only" would need no fence, no claim and no reservation, and only
            a reviewer reading the registry diff would notice. So `exempt` is allowed only for a
            call site whose resolved provider is on a fixed list of content-only model,
            transcription and speech providers, never a messaging, payment, storage, calendar or
            accounting surface.
          - The set of `exempt` ids, and U8's `spend_exempt` ids, is pinned in a snapshot inside
            the test, so adding one changes a reviewed test file. The repo has no `CODEOWNERS`
            yet, so U7 adds one that names an owner for that file. GitHub enforces `CODEOWNERS`
            only when branch protection requires code-owner review, so this needs an owner
            action: turn on "Require review from Code Owners" for `main`.
        - **`erasure_cleanup`, `erasure_record` and `no_subject_data` are three more kinds, each
          constrained by surface.** `TwilioA2pClient`
          (`integrations/twilio/a2p-10dlc/twilio-a2p-client.ts:77`) and `TwilioProvisioningClient`
          (`notifications/twilio-provisioning.ts:13`) are provider-surface types, so every call
          on them is a call site, yet they carry no
          subject, and `withErasureFence` throws on an empty key set. The erase's own Twilio,
          Stripe and S3 deletes and the QuickBooks anonymize can't be fenced either, because the
          tombstone would refuse them. Left undefined, an implementer would add a third kind as
          one more entry with a reason, and a later WhatsApp send registered "no subject data:
          system notice" would skip the fence, the write-ahead claim and phase 1's claim fence,
          and reach the erased subject with nothing to target it. So:
          - `erasure_cleanup` is allowed only for a call site inside the erasure module whose
            resolved surface method is a delete, a list, a get or the declared anonymize update,
            never a create.
          - `erasure_record` is allowed only for a `putObject` inside the erasure module whose
            bucket is the dedicated erase-record bucket (see "The record is the job's first
            step" above). That PUT is a create, which `erasure_cleanup` forbids, and it can't be
            fenced, since its own customer key is in the tombstone.
          - `no_subject_data` is allowed only for a call site whose resolved surface type is on
            a fixed list, such as A2P registration and number provisioning, never a message,
            call or email create, a customer create, a calendar insert or a storage write.
          - All three id sets sit in the same pinned snapshot as `exempt`.
          - Fixtures: an SMS create marked `no_subject_data` fails, an erasure-module delete
            passes, an erasure-module create fails, and an `erasure_record` `putObject` to any
            other bucket fails.
        - `via`, for a low-level client call that a wrapper reaches, such as the `fetch` inside a
          delivery provider's send method. The entry names that wrapper method as its callers reach
          it, which is the interface method when they hold the interface. The test then treats
          every call of that wrapper as a call site in its own right. The coverage moves to the
          caller, where the subject is known.
        - **A `via` entry is checked, not trusted.** The marker records what its author believed
          about the call graph. Suppose the `fetch` sits in a private `post()` helper marked
          `via: DeliveryProvider.send`, and a developer later adds `sendBulk()`, which calls
          `post()` directly. The calls of `sendBulk` would reach the same `fetch` with nothing
          checking them. So a `via` entry is valid only when every route to the marked call goes
          through the named wrapper. The test walks the references of the marked call's enclosing
          function with the type checker's reference search. Every reference must be
          inside the named wrapper, inside a `withErasureFence` callback, or itself a registered
          `via`. Any other route fails the test, naming file and line.
      - Every subject-data entry has a manifest entry with its delete or retention rule.
      - An entry that no fence call or marker names fails the test too, so stale coverage can't
        linger.
      - The test also fails on a runtime dependency in `packages/api/package.json` that it doesn't
        list as a provider SDK, as a transport (`ws`), or as neither. A new SDK or transport can't
        arrive unseen.
      - Wisetack and Google Calendar join the fence and the external-sink manifest:
        - **Ambiguous creates.** The create sends `external_reference: <tenant>:<applicationId>`
          (`financing/financing-provider.ts:92-111`), which Wisetack echoes on its webhook. That
          echo links a financing create whose response was lost, as `custom_args` does for
          email. The plan names no Wisetack lookup endpoint, so there is no read-back (see
          "Wisetack is linked by its webhook" below).
        - **Calendar events are found by the appointment id we stamp, not by a stored event id.**
          `pushForTechnician` inserts a new event on every push
          (`integrations/calendar-sync.ts:112`). `appointment_calendar_events` keeps only the
          latest id: the upsert overwrites it (`:322`), and a failed push overwrites a good id with
          null (`:195`). Once appointment sync is
          wired (today only test-push calls it, `routes/calendar-integrations.ts:361`), a
          reschedule or a retry after a lost response leaves earlier events with the customer's
          name and address that no stored id names. A deterministic event id doesn't help: Google
          requires event ids to be unique per calendar, and an insert with an existing id, a
          deleted event's included, returns 409, so every re-push would fail. So:
          - Every insert already stamps `extendedProperties.private.serviceos_appointment_id`
            (`:148`), and each calendar claim records the Google account and the concrete
            calendar it inserted into (see "Google Calendar: the Google account and the concrete
            calendar" above).
          - The calendar step lists
            `events.list?privateExtendedProperty=serviceos_appointment_id%3D<id>` for each subject
            appointment, on each calendar that a calendar claim or an `appointment_calendar_events`
            row names for it, with that account's credentials, and deletes every match.
          - That listing is also the read-back for a lost create, and it finds events whose ids
            were overwritten.
          - Test: an appointment pushed twice, whose first event id was overwritten, has both
            events deleted.
        - **On erase.** The erase deletes the subject's calendar events. For financing, which the
          lender holds under its own obligations, it records what the provider keeps and says so in
          the result.
    - **Local writes are fenced in the database, so no repository can skip the fence.** A test over
      provider calls can't see a local write. For example, a transcription already waiting on its
      provider still runs `voiceRepository.updateStatus(..., 'completed', { transcript, metadata })`
      (`workers/transcription.ts:489-508`) after the scrub. That would put the transcript back, and
      the encrypted raw copy in `metadata.raw_transcript_retention` with it. So:
      - Every table that the erase-coverage manifest classifies `scrub` or `anonymize` gets a
        `BEFORE INSERT OR UPDATE` trigger.
      - The trigger takes the shared stripe lock of each subject key it checks, so it serializes
        with phase 1 like every other writer. It probes the tombstone in a later statement than
        the one that took the stripes (see "The tombstone probe is its own statement" above).
      - It checks the row's subject keys against the tombstone. The manifest maps those keys for
        each table: `customer_id`, session id, call SID or correlation id, or, for a transitively
        linked table, the owned-entity link column, such as `invoice_line_items.invoice_id`.
      - **It also probes the row's own primary key.** Every entity other rows link by has its id
        in the tombstone, and so do every row whose link the erase nulls and every recorded
        source (see "Phase 1 is sized by its fence keys" above), but a trigger that probes only
        link columns never looks at them. Lead L was converted into
        customer A. The erase blanks L and nulls `leads.converted_customer_id`. A staff member
        still has L's edit form open and saves it, and `leads/pg-lead.ts:299-303` runs an
        `UPDATE leads` that sets the name, phone, email and notes and never names
        `converted_customer_id`. The only link column is null in `OLD` and `NEW`, so the save
        would pass, no late link would fire, and A's name, phone and email would be back on L
        for good. An unconverted lead or callback task recorded as a source is the same: its
        only tombstone key is its own id. So:
        - The manifest's key mapping lists `id` for every `scrub` or `anonymize` table in the
          closure and for every identifier-linked store. The schema test fails on any such table
          whose mapping leaves `id` out.
        - Test: after the job nulls a converted lead's link and blanks it, a stale lead-form save
          that carries the old name and email is refused. The same holds for an unconverted lead
          recorded as a source.
      - Test: after phase 2 has blanked the subject's `customers` row and the job behind an
        invoice, an in-flight update that writes a description into one of that invoice's
        `invoice_line_items` rows is caught by its `invoice_id`, and the description stays blank.
      - **It stops only writes that would put subject data back, never ordinary updates to retained
        rows.** Retained financial records keep changing after an erase.
        `PgInvoiceRepository.incrementAmountPaidAtomic` and `reconcileBalanceAtomic` still update
        balances and statuses on an erased customer's invoices and payments, and refusing those
        writes would leave legally retained records wrong. So:
        - The manifest lists each table's designated PII/content columns, each with its declared
          scrubbed value (see "Each designated column declares its scrubbed value" above).
        - On a tombstone match, the trigger compares `NEW` with `OLD` only on those columns. A
          write puts data back when it would set a designated column to a value that is neither
          `NULL` nor its scrubbed value, and differs from `OLD`. On an `INSERT`, any designated
          column holding something other than `NULL` or its scrubbed value counts.
        - **In a `scrub` table, such a write raises a dedicated SQLSTATE.**
        - **In an `anonymize` table, the trigger blanks it instead of raising.** It sets `NEW`'s
          designated columns to their scrubbed values and lets the write through. These rows are
          retained records, and a refusal would drop the write's financial part along with its
          content. After an erase, the owner records a check payment against the erased
          customer's retained invoice, with notes "check #4411". `payments.notes` is designated
          and `invoice_id` is a tombstone key, so a refusal would drop the payment, and the
          retained invoice would show a balance that was paid. A stale form that resends an old
          description with a status change is the same. The late-link rule below still applies.
        - Every other write passes: a balance, status or reconciliation update that leaves the
          designated columns as they are, and a write that only blanks them, which is what the erase
          itself does.
        - Test: after an erase, a payment against the customer's retained invoice still updates
          `amount_paid` and the status. A new payment with notes on that invoice commits with
          blank notes and the correct amount. An update that tries to put a description back on
          the same invoice commits with the description still blank.
      - **A write that links new data to the erased subject is caught too.** Between phase 1 and
        the `customers` scrub, the customer's phone is still on its row. A call identified as the
        subject inserts a `voice_sessions` row with `customer_id` set to the subject and no
        content yet, so no designated column is non-blank and the insert passes. Its new session
        id is no tombstone key, so every transcript turn keyed by it passes too, and no step ever
        targets it. The same goes for a new job with an empty description and its appointments.
        So the trigger also checks the row's subject-key columns:
        - An `INSERT` whose subject-key column matches a tombstone key, or an `UPDATE` that changes
          such a column to one, attaches new data to the erased subject.
        - In a `scrub` table, it is refused with the erasure SQLSTATE. A writer that creates a new
          entity, such as the voice path's session insert, then writes it without the subject
          link, so the call goes on as an unknown caller.
        - In a table whose rows the manifest retains (an `anonymize` table, such as a payment on a
          retained invoice), it passes, and the late link below runs.
        - **The late link runs in an `AFTER INSERT OR UPDATE` row trigger, never in the `BEFORE`
          one.** Postgres runs `BEFORE INSERT` row triggers on every proposed row, including one
          that `ON CONFLICT DO NOTHING` then skips, and one that `DO UPDATE` turns into an update
          of an existing row with another id. `payment_refunds` inserts with `ON CONFLICT
          (tenant_id, stripe_refund_id) DO NOTHING` (`invoices/pg-payment.ts:302`), and
          appointments insert with an idempotency key (`appointments/pg-appointment.ts:90`). A
          redelivered refund webhook would add an id that is never inserted to the tombstone, and
          each redelivery would re-open the completed job for a row that doesn't exist. So:
          - The `BEFORE` trigger keeps the stripe locks, the refusal and the blanking of `NEW`.
          - The `AFTER` trigger fires only for the row actually written, which on the `DO UPDATE`
            path is the existing row. In the writing transaction it adds that row's id to the
            tombstone of every job that holds the matched key, and writes a late-link inbox row
            naming it for each of those jobs.
          - Neither trigger updates the job row, so a writer that already holds an invoice row
            can't deadlock with a worker that holds the job row. Their tombstone and inbox
            inserts do take `FOR KEY SHARE` on it through the foreign key, which is why job rows
            are locked `FOR NO KEY UPDATE` (see "Job rows are locked `FOR NO KEY UPDATE`"
            above).
          - A step counts a late target whose row no longer exists as done.
          - Test: a duplicate refund delivery for a retained payment writes no inbox row and no
            tombstone key.
        - **The inbox mover collects what hangs under a late link, under exclusive stripes.**
          After S's phase 1, an office user reassigns job J2 from customer X to S. The trigger
          passes that `jobs` update (`anonymize`, `keep-link`), adds J2 to the tombstone and
          writes an inbox row naming J2. That add is a limit change made without the exclusive
          stripe the design rule requires, so a technician's `job_timeline_events` note keyed by
          J2 can probe the tombstone before the reassignment commits, and pass. And a mover that
          targets only J2 never collects J2's existing appointments, notes and photos, or the
          photos' S3 objects. So the sweep moves inbox rows into their job's steps like this:
          - It runs one transaction per job, never one per tenant, so a failure on one job's
            inbox row can't roll back another job's.
          - It takes the job row first (see "Several job rows lock in ascending id order"
            above), then collects the fence keys under each late-linked id to a fixed point, as
            phase 1 does (see "Phase 1 is sized by its fence keys" above).
          - It takes the stripes of the keys it finds in exclusive mode, under phase 1's deadline
            and `lock_timeout` rules, with the deadline starting when it is granted the job row.
            A timeout rolls back and is a short wait, not a failed attempt, up to the alert
            count in "Repeated failures to start alert" above.
          - It adds every key found to the tombstone, and re-opens `snapshot` with each
            late-linked id as a target. `snapshot` then records the rows under that id as
            targets of their stores' steps in batched checkpoints, so a large late-linked
            closure never has to fit in one transaction. A writer that committed beside the
            trigger is then caught by that collection.
          - It claims any job with an inbox row, whatever its state.
          - Test: a job re-linked to the subject after phase 1, with an existing appointment
            note and photo plus a concurrent timeline note, has all three erased before
            `erase_completed`.
        - Test: an inbound call identified as the subject between phase 1 and the `customers`
          scrub leaves no transcript turns once the job completes. A payment on the retained
          invoice after phase 1 commits, and the job then anonymizes the new payment's link.
      - Writers treat that SQLSTATE as "erased, drop the content". Only a `scrub` table raises
        it. It is never an error that retries. The transcription worker ends that recording's job
        without writing.
      - The manifest schema test reads `pg_trigger` in the Docker-gated suite. It fails when any
        `scrub` or `anonymize` table lacks the trigger, or an `anonymize` table lacks its late-link
        trigger, so a new table or repository is covered by construction.
      - **It checks that each trigger fires, not only that it exists.** Every migration re-runs on
        each boot, so a backfill migration that runs `DISABLE TRIGGER` and never re-enables it
        leaves `tgenabled = 'D'` for good. A trigger created `BEFORE UPDATE` only is listed too.
        So for each fence trigger, each late-link trigger, the `audit_events` trigger and each
        step-target re-open trigger, the test asserts that `tgenabled` is `'O'` or `'A'`, and
        that `tgtype` encodes its level (`ROW` for the fences and the late link, `STATEMENT`
        for the re-open), its timing (`BEFORE` for the fences, `AFTER` for the late link and the
        re-open) and its events (`INSERT` and `UPDATE` for the fences and the late link, one
        each for the two re-open triggers). It also asserts that the runtime role can't set
        `session_replication_role`, which would stop every `'O'` trigger from firing. The
        connection principal can, so the structural test in "'Never lifted' is enforced in the
        database" above fails on any other code that sets it.
      - The tombstone lookup is an index probe on `(tenant_id, key)`, not unique (see "Each
        tombstone row names its job"), so the per-row cost on hot tables such as
        `call_transcript_turns` stays small.
      - Test: a transcription is held at its provider while the erase runs. Its completion write is
        refused by the trigger, the recording's transcript and metadata stay blank, and the job
        doesn't retry.
    - **Presigned uploads are writers too, and they outlive the request.** `/api/files/upload-url`
      creates the `files` row and returns a presigned PUT URL (`routes/files.ts:80-114`), valid for
      `DEFAULT_UPLOAD_EXPIRES_SECONDS` (300s, `files/storage-provider.ts:69`). The client uploads
      the bytes directly to S3 later, so no application writer is in flight to drain. An erase can
      delete the still-empty key and its row, report success, and then the client uploads. That
      leaves a customer object no re-scan can find. So:
      - **Fence every `generateUploadUrl`.** Signing goes through the fence, and after the
        tombstone it is refused for the subject. The call sites are `routes/files.ts`,
        `routes/job-files.ts`, `routes/job-photos.ts`, `routes/attachments.ts`,
        `telephony/recording-webhook.ts` and `telephony/voicemail-status-route.ts`. The structural
        test lists `generateUploadUrl` among the provider write methods, so a new call site has to
        go through the fence too.
      - **Keep issued keys until no upload to them can still be running, durably.** A key held
        only in the running erase is lost if the process restarts before the upload ends, and the
        client could then upload with nothing left to find it. So:
        - In the same transaction that deletes a subject `files` row, or blanks one that a kept
          row still references (see "A delete names every foreign key that points at the row"
          above), the erase inserts an `erasure_storage_cleanup` row with the bucket, the key and
          `not_before`. This happens whether or not the upload went through.
        - **`not_before` is the end of the upload window, not the URL's expiry.** S3 checks a
          presigned URL's expiry when the request starts. A large PUT that starts a second before
          expiry keeps transferring after it, and its object appears only when the PUT finishes. A
          delete and a HEAD at expiry plus clock skew could both run while that PUT is underway.
          So:
          - The signed size bounds the transfer. `generateUploadUrl` requires `sizeBytes` and signs
            it as `Content-Length` (`files/storage-provider.ts:214-231`), so a PUT can't send more
            bytes than the route validated, and never more than `MAX_FILE_SIZE`
            (`files/file-service.ts:113`).
          - Every fenced storage write records the URL's expiry and the signed size on its
            write-ahead claim. That includes `putObject`, which signs its own 60-second URL for the
            body's length (`files/storage-provider.ts:269`).
          - `not_before` is that expiry, plus clock skew, plus a transfer allowance: the signed
            size at a fixed floor throughput, capped at a fixed maximum.
        - The erasure job's S3 step processes those rows after `not_before`: it deletes each key
          again. Each row carries the job id, and the step is `done` only when every row is.
        - Then a HEAD request confirms each key is gone, and only then is the cleanup row marked
          done.
        - **On a versioned bucket a HEAD 404 proves nothing.** Storage is any S3-compatible
          endpoint (`STORAGE_ENDPOINT`, `shared/storage-config.ts`). On a bucket with versioning
          enabled or suspended, a `DeleteObject` without a `VersionId` only adds a delete marker.
          HEAD then returns 404, and `ListObjectsV2` shows nothing, while
          `GetObject?versionId=` still returns the customer's photo. So:
          - A boot-time config guard, like PRIV-6's, reads `GetBucketVersioning`. A delete
            response that carries `x-amz-delete-marker: true` also marks the bucket versioned.
          - **The guard says what an error answer means.** R2, which the `R2_*` variables
            describe (`shared/storage-config.ts:60-68`), has no bucket versioning or replication
            in its S3 API and can answer `GetBucketVersioning` and `GetBucketReplication` (below)
            with `NotImplemented`. A guard that read that as "can't prove unversioned" would stop
            every production boot on R2. One that read every error as "unversioned" would pass an
            endpoint that versions but errors on the call, where a HEAD 404 proves nothing. So:
            - A `NotImplemented` answer from an R2 endpoint (`*.r2.cloudflarestorage.com`, as
              `storage-config.ts:68` builds it) means unversioned and unreplicated.
            - Any other error, or `NotImplemented` from another endpoint, refuses boot in
              production or staging unless an acknowledgement is set (the PRIV-6 shape).
            - Tests cover both against mocks.
          - On a versioned bucket the step lists `ListObjectVersions` with the key as prefix,
            keeps the entries whose key is exactly that key, deletes every version and delete
            marker by `VersionId`, and confirms that the same listing comes back empty. That
            replaces the HEAD.
          - If Object Lock or a bucket lock refuses a delete, the target ends `provider_retained`
            with the lock's retention date.
          - **A replicated bucket's replica is cleaned too.** AWS's "What does Amazon S3
            replicate?" says that a `DELETE` naming a version id deletes that version in the
            source bucket only, and the deletion isn't replicated. Delete markers aren't
            replicated by default either. Replication requires versioning, so the version deletes
            above would leave every version in the replica while the source listing comes back
            empty. So:
            - The boot config guard also reads `GetBucketReplication`.
            - When a rule exists, the S3 step runs the same version deletes and empty-listing
              check in each destination bucket, on that bucket's credentials. A target is done
              only when every bucket is clean.
            - In production or staging the guard refuses a replicated bucket without destination
              credentials, unless an explicit acknowledgement is set (the PRIV-6 shape). With the
              acknowledgement, the target ends `provider_retained`, naming the replica.
            - Test: against a mocked replicated bucket, the replica's versions are deleted, or
              the store reports provider-retained.
          - Test: against a versioned mock bucket, every version of the key is deleted, and a
            `GetObject?versionId=` afterwards finds nothing.
        - Until every cleanup row for the erase is done, the S3 store is `incomplete`. The result
          shows when it expects to finish, which is the latest `not_before` of its rows. A restart
          resumes from the rows.
        - Test: the process restarts between the row delete and the re-delete. The worker still
          removes the late upload.
      - **A late object is caught when it is created, not by the clock.** The transfer allowance is
        an estimate, not a proof. A client can send bytes more slowly than any floor, and the
        storage provider doesn't stop a PUT that started before expiry. So closing a cleanup row
        doesn't end the check:
        - When the key is nulled, the cleanup row keeps the key's listing prefix: the key cut just
          after its file id, such as `<tenant>/<file id>/` (`files/file-service.ts:194`) or
          `…/<file id>-` (`routes/attachments.ts:136`). The prefix names no file, so the erase
          record still holds no subject data. A key with no filename in it, such as a recording key
          (`telephony/recording-webhook.ts:113-119`), is its own prefix. The thumbnail key,
          `${key}.thumb.jpg` (`workers/image-post-process-worker.ts:60-62`), falls under the same
          prefix.
        - **An object-created notification re-opens the job.** The deploy can point at AWS S3 or
          Cloudflare R2 (`shared/storage-config.ts:12-13`). Both can send the bucket's
          object-created events to a queue, which a worker drains (P0-009). For each created key,
          the worker:
          - decodes the key first. S3 sends `s3.object.key` URL-encoded, so the worker
            form-decodes it: `+` to a space, then percent-decoding. `sanitizeFilename` keeps
            spaces (`files/file-service.ts:136-143`), so `Jane Doe passport.jpg` arrives as
            `Jane+Doe+passport.jpg`. A delete of the encoded key returns 204 for an object that
            doesn't exist, and its HEAD returns 404, so the real object would stay. The match, the
            delete and the check all use the decoded key. Another provider's notification is
            decoded by its own documented encoding.
          - takes the tenant from the key's first segment, and sets it before it reads or writes
          - looks for that tenant's cleanup row, open or closed, whose prefix starts the key
          - when one matches and no `files` row holds the key, adds the key to that row's job as a
            late target, encrypted, or re-arms its closed target (see "A target that comes back
            re-arms its row" above)
          That re-opens the job under the job row's lock (see "A late target re-opens the job"
          above). The S3 step deletes the object, confirms with a HEAD and nulls the key again,
          however long after the URL's expiry the PUT finished.
        - **A listing backs up a lost notification.** A notification can be delayed, or lost while
          the queue consumer is down. So the leader-gated sweep also lists each cleanup row's
          prefix (`ListObjectsV2` with that prefix) on a fixed schedule for a fixed period after
          the row closes, for example daily for 30 days, and treats any object it finds the same
          way.
        - Every S3 target the step takes from a write-ahead claim, rather than from a deleted
          `files` row, gets a cleanup row too, with `not_before` from that claim. So this check
          covers it as well.
        - **A public URL is purged at the CDN too.** With `STORAGE_PUBLIC_URL` set,
          `generateDownloadUrl` returns a permanent, unauthenticated URL
          (`files/storage-provider.ts:233-236`), for example an R2 custom domain behind
          Cloudflare's cache. A link sent earlier by SMS or email keeps serving the cached photo
          after the origin delete, until the edge TTL runs out, while the origin check already
          reports the key clean. So when a public base URL is configured:
          - The S3 step purges each deleted key's public URL at the CDN (a Cloudflare purge by
            URL, or a CloudFront invalidation).
          - **The CDN confirms the purge, not one GET.** A CloudFront invalidation runs across
            edge locations asynchronously, and `GetInvalidation` reports `InProgress` until
            every edge is done. A GET from the worker reaches only its nearest edge, which can
            return 404 while an edge near the customer still serves the cached photo. So the step
            waits, through a wait checkpoint with a `wait_deadline`, for the CDN's own completion
            signal: `GetInvalidation` returning `Completed` for CloudFront, or for Cloudflare a
            successful purge response plus its documented propagation allowance. An
            unauthenticated GET that returns 404 is then the final check. The S3 store stays
            `incomplete` until then.
          - The boot config guard refuses `STORAGE_PUBLIC_URL` in production or staging without
            purge credentials for that domain, unless an explicit acknowledgement variable says
            the domain isn't cached (the PRIV-6 shape).
        - **What the tenant sees.** The person uploading may see the PUT succeed, because the
          storage provider can't stop a PUT already underway. The file never appears in the app,
          since its `files` row is gone, and the object is deleted, at the CDN as well when there
          is a public URL. The owner's erase result shows
          the S3 store waiting until its latest `not_before`, then done. A late object re-opens the
          job: the owner sees it running again, then completed again, with the late object listed
          as deleted and a new `erase_completed` for that close.
      - Test: an upload URL is issued, the erase runs, and the client PUTs the bytes afterwards,
        before the URL expires. The re-delete removes the object, and the erase reports success
        only after the HEAD check.
      - Tests, against a mocked storage endpoint that can hold a PUT open:
        - A PUT starts one second before its URL expires and is still transferring at expiry plus
          clock skew. The S3 step doesn't run before `not_before`. Once the PUT completes, the
          step deletes the object and the HEAD comes back clean.
        - A PUT held open past `not_before` completes after its cleanup row has closed. Its
          object-created notification re-opens the job, the object is deleted, and the job closes
          again with one `erase_completed` for the new generation. Afterwards no U7 table holds the
          filename.
        - The same late PUT with its notification dropped is found by the next backstop listing
          and deleted.
        - A notification for another file of the same tenant matches no cleanup row and changes
          nothing.
        - A late object whose filename contains spaces and a literal `+` is matched, deleted and
          checked by its decoded key, and a GET of the real key afterwards finds nothing.
        - With a public base URL and a mocked CDN that caches, the S3 store stays `incomplete`
          until the purge runs and an unauthenticated GET of the public URL returns 404.
    - **A writer the fence refuses can still leave a copy, and so can one in flight at phase 1.**
      Targets come from the `snapshot` step's record of stored SIDs and keys, the status callbacks
      and the upload cleanup rows. Some writers create the external copy before any row records it:
      - The recording and voicemail webhooks fetch the bytes from Twilio and PUT them to S3 before
        they insert `voice_recordings` (`telephony/recording-webhook.ts:391-407`,
        `telephony/voicemail-status-route.ts:533-556`). They delete Twilio's copy only after that
        row commits (`recording-webhook.ts:454`).
      - The image post-process worker writes `thumbnailKeyFor(key)` before it records the
        thumbnail key (`workers/image-post-process-worker.ts:147-156`).
      - Customer MMS intake runs `putObject` before `fileRepo.create`
        (`sms/customer-mms/customer-mms-intake.ts:162-163`).
      For example, a call ends, and the owner erases the customer ten seconds later. `snapshot`
      records the Call SID, but no Recording SID exists locally yet. The recording callback then
      arrives, the fence refuses it, the handler returns `500`, and Twilio gives up after its
      retries. The Twilio calls step deletes the Call, but the Recording with the customer's audio
      stays at Twilio, its SID recorded nowhere, and the job completes. So:
      - **A refusal still registers the external copies.** When the fence refuses a recording or
        voicemail callback, the handler adds the `RecordingSid`, and the deterministic S3 key from
        `buildRecordingStorageKey` or `buildVoicemailStorageKey`, as late targets on every job
        whose tombstone holds the matched key. That re-opens the job (see "A late target re-opens
        the job" above). The handler then returns `200`, since the job now owns the cleanup.
      - **That rule belongs to the sink, not to two handlers.** Every `externalSinks` entry whose
        provider copy can exist before its local row declares so: the recording and voicemail
        webhooks, the Vapi webhook (see "A call that ends after phase 1 is still targeted"
        above), image post-processing and customer MMS. Its handler registers the copy as a late
        target when the fence refuses its local write. The per-registered-sink test sends each
        such sink's callback after phase 1 and asserts that a late target exists.
      - **The Twilio recordings step asks Twilio, not only our rows.** For every subject Call SID it
        lists the Call's recordings at Twilio (`Recordings?CallSid=`) and deletes each one. It runs
        with a `not_before` of the call's completion plus the recording-callback window, and before
        the Twilio calls step deletes the Call.
      - **Every fenced storage write records its key on its write-ahead claim.** That covers
        `putObject` as well as `generateUploadUrl`, and the structural test lists both among the
        provider write methods.
        - The S3 step takes as targets every subject claim's bucket and key, plus
          `thumbnailKeyFor` of every subject key.
        - It waits for `sending` claims to reach a terminal state, up to their deadline (see
          "Every wait has a deadline" above). Then it deletes each key again and confirms with a
          HEAD request, or with the version listing on a versioned bucket. A key from a signed
          URL is also gated by its cleanup row's `not_before` (see "`not_before` is the end of
          the upload window" above).
      - These writers join the drain list below.
      - Tests:
        - A recording callback arrives after phase 1. The handler returns `200`, and the job
          deletes that Recording at Twilio and its S3 key.
        - A webhook is paused between its S3 PUT and its row insert when the erase starts. Its
          insert is refused, and the S3 step still deletes the object.
        - A post-process job is paused before its thumbnail put when the erase starts. Once it
          resumes, the S3 step still deletes the thumbnail, and the HEAD check comes back clean.
    - **A recipient match fences only the subject's own work, by provenance, not by time.** A
      household can share a phone or an email, so a recipient hash alone can't say whose send it
      is, and neither can creation time. So:
      - A send whose source record links to a customer is fenced by that customer's id only. A
        reminder for customer B is never fenced by customer A's recipient hash, even when they
        share a number.
      - When the erase finds an identifier-linked source row that has no customer link (a lead or
        callback task it scrubs, or one it puts on the candidate list), it records that row's id in
        the tombstone.
      - **Recording a source in phase 2 is a limit change, so it is serialized like phase 1.** Only
        the phase-2 lead step finds identifier-linked sources, since it reads the encrypted
        identifiers. Lead L has no customer link, matches customer A only by A's email, and has a
        phone that isn't one of A's. Between phase 1 and the lead step, L's follow-up SMS matches
        no recipient hash and no recorded source, so it goes out, and Twilio stores it. A send
        that is between its claim and its flip when the step records L goes out too, because only
        phase 1 fences claimed rows. Neither message is ever a target. So in one transaction,
        after the job row (see "One lock order: the job row first"), the lead step:
        - takes the stripe of each source id it records, in exclusive mode, under phase 1's
          deadline and `lock_timeout` rules. Senders pass the source row id as a declared key
          kind, so they hold that stripe in shared mode. A timeout rolls back and is a short wait,
          not a failed attempt.
        - records the ids
        - moves every `claimed`, `held` or `released` claim from those sources to `fenced`, in
          every sink's claims table, and deletes a held row's stored message
        - adds each claim from those sources that started after phase 1 (`sending`, `sent` or
          `ambiguous`) as a target of the Twilio messages or email step. That step then deletes
          the SID, or records the send `provider_retained`.
        - Test: a lead matched only by email sends to its own phone between phase 1 and the lead
          step, and a second send is paused between its claim and its flip when L is recorded.
          After the job completes, the first message is deleted at Twilio and the second was
          never sent.
      - A customerless send is refused when its source row is one of those recorded ids.
      - A customerless send that matches the recipient hash but whose source row isn't recorded is
        ambiguous, unless the job whose hash it matched holds an exemption for that source. It is
        held, not refused, and goes onto that job's owner-confirmed candidate list. The
        owner either releases it ("this is someone else") or drops it. Nothing stays held
        indefinitely: a hold nobody decides expires (below).
      - **A claim already committed when phase 1 runs follows the same rule.** Lead L matches
        customer A only by phone. A follow-up SMS to L commits its claim, with no customer and A's
        phone as recipient, just before phase 1, and pauses before its flip. A fence that matches
        `customer_id` never matches its null, so the send would go out after the tombstone, and
        the Twilio messages step, which takes only rows linked to the subject, would never delete
        it. A fence that matches the recipient would instead drop household member B's send.
        Phase 1 can't hold the row either, since it has no rendered message. So:
        - Each write-ahead row also records its source (`source_type`, `source_id`) and the
          recipient's keyed hash.
        - Phase 1, which holds those stripes, applies the rule to `claimed` and `released` rows.
          A row whose `customer_id` is the subject, or that has no customer and a source already
          recorded in the tombstone, moves to `fenced`.
        - A row with no customer, a matching recipient hash and a source that isn't recorded is
          added to its step (Twilio messages, or email) as a target. That step runs after the
          identifier-linked lead step has recorded its rows. It waits for the row to be terminal,
          then deletes its SID when its source has since been recorded, or candidate-lists it.
        - Test: a lead-sourced customerless send paused between its claim and its flip during
          phase 1 is never sent, or is deleted at Twilio before `erase_completed`. A household
          member's customerless send claimed at the same time still goes out.
      - **A held send has a durable release path, and an expiry.** Its write-ahead row holds only a
        body hash. Re-running the source would meet the same fence, since the recipient hash still
        matches and the source row still isn't recorded, so a release that re-ran it would be held
        again. So:
        - The held row keeps the rendered message, encrypted with `encrypt`, and a
          `hold_expires_at`. The source sets it to when its message goes stale, such as the
          appointment start for a reminder, capped at a fixed maximum.
        - **A release is checked against every tombstone, not only the one that held it.**
          Customers A and C share household phone P, and lead L has phone P and no customer link.
          L's send R is held under A's erase. If C's erase has since recorded L, a release that
          read only A's tombstone would send R to P after C's erase fenced L. So releasing is one
          owner-only, audited transaction (see "Every owner decision on an erase" above). It takes
          the row's recipient-hash and source stripes in shared mode, and then:
          - refuses the release when another job's tombstone records the source
          - records an exemption for that source row in the holding job's tombstone, with that
            job's id ("this source is not the subject"), and moves the row `held → released`
        - **A `released` row is fenced like a `claimed` one until its flip.** A leader-gated sweep
          sends each `released` row from its stored message through `withErasureFence` again,
          with the row's recipient hash and source id as keys, taking their stripes in shared
          mode. The exemption counts only for the job that recorded it. So any tombstone that
          records the source refuses the send, and another subject whose recipient hash matches,
          while the source is unrecorded, holds it again on that subject's candidate list. Phase 1
          and the lead step apply the provenance rule to `released` rows as they do to `claimed`
          ones. A row that passes takes the same guarded flip to `sending` as a `claimed` row, and
          goes on to the usual terminal states.
        - A later send from that source passes that job's fence and isn't held again by it. Any
          other job's fence still applies.
        - Dropping it, or `hold_expires_at` passing first, ends it `dropped` or `expired`, and
          deletes the stored message. A release after expiry is refused. The source reads that
          outcome, so a reminder flow knows its message never went out.
        - Test: R is held under A's erase, C is erased and C's lead step records L, then the owner
          releases R, and R is never sent. Run again with C's phase 1 committing between the
          release and the sweep: R is held again under C's erase instead of being sent, and once
          C's lead step records L it is fenced.
      - A send from a source created after the erase is a new contact, and the normal consent and
        do-not-contact rules govern it.
    - **Each writer drains for its own worst case, taken from the `externalSinks` registry.** The
      erase waits out each fenced writer's own worst-case duration, not just the gateway deadline.
      A closed list here left out Stripe, Wisetack and Google Calendar. So each subject-data entry
      in the registry declares its worst-case duration and its reconciliation read, and the
      structural test fails on an entry that is missing either. For example:
      - the gateway: the maximum gateway deadline
      - the QuickBooks client: its retrying 20-second requests, times its retry count
      - messaging and email: the provider client timeout
      - Stripe, Wisetack and Google Calendar: their bounded request timeout, times their retries
      - the recording and voicemail webhooks, the image post-process worker and customer MMS
        intake: their provider fetch plus their S3 write
      Each wait is a job checkpoint with a `next_attempt_at` and a deadline. Then it re-scans,
      within the job's bounded retries, until the result comes back clean.
      - **The declared duration is computed from the client's own constants, and enforced.** A
        number restated in the registry drifts. The QuickBooks bound lives in module-private
        constants (`MAX_RETRIES = 3`, `QBO_REQUEST_TIMEOUT_MS = 20_000`,
        `integrations/accounting/quickbooks-client.ts:28-32`). If someone raises `MAX_RETRIES`,
        the entry still says about 60 seconds. The erase's wait then ends early, the lookup finds
        nothing while the create is still retrying, the step records done, and the create lands
        afterwards with the customer's name, email and phone. So:
        - Each client exports the constants its timeouts and retries use, and its registry entry
          computes its duration from them.
        - `withErasureFence` stores `deadline_at = attempt_started_at + declared worst case` on
          the claim, and passes the write an `AbortSignal` that fires at that deadline. The scan
          checks that every fenced call site uses it (see "'Fenced' means bounded by the
          callback" above). No attempt or retry outlives its declared bound.
        - The reconciliation read runs after `deadline_at` plus the provider's processing
          allowance.
        - Tests: a fixture client whose retry loop would outlast its declaration is aborted at
          `deadline_at`. A unit test pins each entry's duration to at least timeout × attempts
          plus backoff, from the client's exported constants.
      - **The reconciliation read is tested, not only declared.** A new sink could ship with
        `reconcile: async () => ({ found: [] })` and pass the structural test. A create whose
        response was lost would then be recorded reconciled-absent while the provider holds the
        record. So each entry also supplies a mock of its provider. The per-registered-sink test,
        which already covers the claim fence, also drops a create's response and asserts that the
        entry's reconciliation read finds the record, and that the step deletes or anonymizes it.
        For a store whose outcome is `provider_retained`, such as email or Wisetack, it asserts
        that the row is linked and reported retained.
    - **An ambiguous business-integration create is reconciled with a strongly consistent read,
      not assumed absent.** Each write-ahead claim stores the idempotency key or request id it
      sent, and the account it sent it on.
      - **QuickBooks: idempotency through `requestid`, and absence proved by a query that sees
        inactive customers.** The create carries a stable key (`customer-<id>`,
        `sync-service.ts:288`), but sends it as a `Request-Id` header
        (`quickbooks-client.ts:64-66`). Intuit's idempotency key is the `requestid` query
        parameter, so the create isn't idempotent today. A timed-out first create followed by the
        catch-path re-create (`sync-service.ts:301-310`) gets "Duplicate Name Exists", and the
        customer sits in QuickBooks unlinked. QuickBooks has no lookup by request id, its queries
        return only active customers by default, and a customer "deleted" in its UI is only made
        inactive. So:
        - The create and the erase's anonymize update send their key as `?requestid=`, at most 50
          characters. The erase uses a hash of its idempotency key.
        - **A reused `requestid` replays its first answer, so a definite rejection gets a new
          one.** Intuit's `requestid` docs say a repeat request with the same id isn't run again:
          the service sends back the response it gave the first time. Suppose the first sparse
          update gets Stale Object Error 5010, because the bookkeeper edited the customer between
          our GET and our POST. The step reads the new `SyncToken`, retries with the same
          `requestid`, and gets 5010 again, on every retry, every daily re-open and every repeat
          `POST`. A create rejected with 6240 "Duplicate Name Exists" is replayed the same way
          after the tenant renames the customer, so it never syncs. So:
          - The `requestid` of each call is stored on the target row, or on the sync's claim,
            before the call.
          - A retry whose outcome is unknown (a timeout, a reset, a 5xx with no `Fault` body)
            reuses it, so a lost success is replayed, not repeated.
          - After a definite QuickBooks `Fault` (5010, 6240 or any validation fault), the next
            attempt derives a new `requestid` from the idempotency key plus an attempt counter,
            re-reads the `SyncToken`, and retries.
          - Test, against a mocked QuickBooks that stores and replays the response for each
            `requestid`: a first anonymize that gets 5010 succeeds on the retry, and a create that
            got 6240 succeeds after the rename.
        - When a create's outcome is unknown, the erase runs two QuickBooks queries, one on
          `DisplayName` and one on `PrimaryEmailAddr`, from the encrypted identifiers, each with
          `Active IN (true, false)`. (The query language has no `OR`.)
        - **QuickBooks renames an inactive customer.** A customer made inactive in the UI is shown,
          and returned, as "Jane Doe (deleted)". Say a first create for Jane, who has no email or
          whose email the bookkeeper cleared, is accepted but its response is lost, and the
          bookkeeper later deletes the unknown duplicate in the UI. An exact `DisplayName = 'Jane
          Doe'` query never finds "Jane Doe (deleted)", the email query finds nothing, and zero
          results would count as proof of absence while QuickBooks keeps her phone and
          addresses. So:
          - The name query is `DisplayName LIKE '<name>%'`, with quotes in the name escaped.
          - A row counts as a name match only when its `DisplayName`, after stripping a trailing
            " (deleted)", equals the subject's name. The legacy-row match and the read-back strip
            it the same way.
          - The QuickBooks mock renames a customer on inactivation the way QuickBooks does.
          - Test: a lost create with no email, which the bookkeeper inactivated, is still found
            and anonymized, or candidate-listed, and never recorded absent.
        - A customer that matches both is anonymized. One that matches only one goes onto the
          owner's candidate list, since a name or an email alone can belong to someone else.
        - Zero results from both queries is the only proof of absence.
      - **Stripe Search can't prove a customer absent.** Stripe documents Search as not for
        read-after-write: its index usually lags by under a minute, and longer during incidents. A
        lookup seconds after a lost `customers.create` (`payments/stripe-saved-card.ts:96-105`)
        could find nothing while the customer exists, with a card attached by
        `setup_intent.succeeded`. So:
        - The Stripe step lists customers instead (`GET /v1/customers`, which is consistent), on the
          claim's account. It lists those created between the claim's `attempt_started_at` and its
          `deadline_at`, widened by clock skew, and keeps those whose
          `metadata.customer_id` and `metadata.tenant_id` match. It deletes every one it keeps.
        - The list needs no raw identifier, so the erase never sends the erased name or email to
          Stripe again.
        - Search runs only as an extra pass, after a `not_before` past its indexing delay. It
          queries `metadata['customer_id']`, never the email, so it doesn't read the identifiers.
          Its empty result never counts as proof that the customer is absent.
      - Google Calendar reads back by the `serviceos_appointment_id` listing (see "Calendar
        events are found by the appointment id we stamp" above). Until that read succeeds, the
        store is `incomplete`.
      - **Wisetack is linked by its webhook, not read back.** No Wisetack lookup by our
        reference is named here, so a read-back could never succeed, and an "incomplete until
        read" rule would re-open and alert every day. The lender holds the data under its own
        obligations either way. So an ambiguous financing claim is linked when the webhook
        echoes its `external_reference`, and once Wisetack's webhook window has passed the row
        ends `provider_retained`, linked or not, like an ambiguous email. A read-back is added
        only if a documented lookup endpoint is named in this plan.
      - Test: against a mocked Stripe whose Search lags by 60 seconds, a create whose response was
        lost is still found by the list read and deleted.
    - Tests:
      - A gateway call is in flight when the erase starts. It completes afterwards, and its output
        is never persisted or exported.
      - **First sync versus erase.** The accounting sweep has loaded the customer and is paused
        inside its first QuickBooks create when the erase starts. Either the erase sees the claim,
        waits, then finds and anonymizes the QuickBooks customer, or the create is refused. It is
        never left holding the old name, email and phone.
      - A customerless send that begins after phase 1 has fully committed, sourced from a lead the
        erase scrubbed, is refused.
      - A reminder for customer B, who shares customer A's household phone, still goes out after A
        is erased.
      - A customerless send whose source row the erase didn't record, matching the shared phone, is
        held and candidate-listed. Releasing it sends it once, from the stored message, and a later
        send from the same source isn't held.
      - A hold nobody decides ends `expired` at its `hold_expires_at`, its stored message is gone,
        and a release after that is refused.
      - A sweep killed after a release commits still sends the released message once on restart.
      - A send sourced from a lead created after the erase goes through.
      - The structural test, run on fixtures planted with `plantTree`
        (`test/support/structural-scan.ts:238`):
        - fails on a fixture provider call site that isn't wrapped
        - fails on a second `fetch` added to a file that already has a registered one, when the new
          call has no fence and no id of its own
        - fails on `fetch` called through an alias, and on a `via` wrapper called outside any fence
        - fails on a class that stores `opts.fetch ?? fetch` in a property and calls it from a
          second, unmarked method
        - fails on `require('langfuse')` cast to an unregistered local interface
        - fails on a second public method that calls a `via` helper directly, bypassing the named
          wrapper
        - fails on a registry entry that no call site names
        - fails on a calendar `via` call inside an SMS fence, and on a callback that reaches two
          sinks
        - fails on an unmarked `new WebSocket(...).send(...)`, and on a `ws` client cast to the
          global `WebSocket` type with no entry
        - fails on a new `exempt` or `spend_exempt` id that the snapshot doesn't list, and on an
          `exempt` entry for a messaging surface
        - passes a call inside a `withErasureFence` callback whose `sinkId` is registered and
          is the call's own entry
  - **Fence outbound provider writes too, including ambiguous ones.** An outbound SMS can pass its
    tombstone check and then complete at Twilio after the provider cleanup has run.
    `notifications/send-service.ts:750-816` calls Twilio first and writes the `message_dispatches`
    row, with the returned SID, only afterwards. If Twilio accepts the message but our client times
    out, the catch path records a `failed` row with no SID. Nothing links the message to the
    subject, so a SID-only cleanup can't find it, and the erase would report success while Twilio
    still holds the recipient and the body. So:
    - **The check and the claim are one atomic step, serialized against the tombstone.** A
      separate check and insert would let a sender pause between them: the erase would commit its
      tombstone, find no in-flight row and report success, and the sender would then insert its
      row and send. So:
      - Every customer-facing outbound send writes a durable write-ahead dispatch row with status
        `claimed`. The row holds the recipient and its keyed hash, the account and the sending
        number, Messaging Service or address, the `customer_id`, the source (`source_type`,
        `source_id`) and a hash of the body.
      - It writes that row in one transaction that first takes the subject's erasure lock in
        shared mode. The lock is a `pg_advisory_xact_lock_shared` on the stripe of the customer
        id. A send with no customer id locks the stripe of its normalized recipient's keyed hash
        instead.
      - In the same transaction, in a statement after the one that took the stripe, it checks
        the tombstone, and it refuses the send when the tombstone matches (see "The tombstone
        probe is its own statement" above).
      - The erase's phase 1 takes the stripe of every key it writes into the tombstone in
        exclusive mode, as described above, the customer id and every normalized phone and email of
        the subject among them. It writes the tombstone under them.
      - **In the same transaction, phase 1 fences every sink's claims, not only the message
        rows.** Every sink's write-ahead claim takes the same guarded flip. Suppose the owner saves
        a card for the customer, and the Stripe saved-card claim commits just before phase 1. Its
        flip runs after phase 1, after an event-loop stall or an `await` between the claim and the
        flip. If phase 1 fenced only message rows, the flip would succeed and `customers.create`
        would send the name and email, after the Stripe step had found nothing to reconcile. The
        same holds for QuickBooks `ensureCustomerExternalId`, the Google Calendar insert, Wisetack,
        `putObject` and the trace export. So phase 1 moves to `fenced`, in every sink's claims
        table:
        - every `claimed` claim with a subject key that meets a tombstone key (the customer,
          session, call, correlation or owned-entity id)
        - every customerless `claimed` or `released` claim that the provenance rule fences (see
          "A claim already committed when phase 1 runs" and "A `released` row is fenced like a
          `claimed` one" above)
        - Test, per registered sink: a claim committed before phase 1, with its flip held until
          after phase 1 commits, fails the flip and makes no provider call.
      - Either a sender's row commits before the tombstone, and the erase sees it, or the sender
        sees the tombstone. No order lets both miss.
    - **The provider call starts only after a conditional flip.** Immediately before the call, at
      `markProviderStarting`, the sender runs one statement: `claimed → sending`, setting
      `attempt_started_at`, guarded on the status still being `claimed`. A `fenced` row fails that
      flip, and no provider call is made.
    - This covers SMS/MMS, email and outbound calls, on every path, including the direct Send
      Estimate/Invoice routes that no send claim wraps today.
    - **Each claim write commits on its own, whatever transaction the caller holds.** `POST
      /api/estimates/:id/send` (`routes/estimates.ts:944`) isn't in `LLM_LONG_CALL_ROUTES`
      (`middleware/tenant-context.ts:212`), so it runs inside the request transaction. That
      transaction commits only at `res.end`, and rolls back on a `>= 400` response, on a client
      disconnect before the response, or when its COMMIT fails (#1133). The dispatch repository
      is a `PgBaseRepository`, so it would join that transaction through `tenantContextStore`.
      The stripe, the `claimed` row, the flip and the SID write would all be uncommitted while
      Twilio is called. If Twilio accepts SM1 and the owner then closes the tab, the rollback
      removes the row and its SID, the status callback names a row that doesn't exist, and a
      later erase never targets SM1. The request would also hold its shared stripe across both
      provider calls of a `both`-channel send, past phase 1's budget, so phase 1 would time out
      whenever such a send is in flight. Today's `send_claims` avoids this by writing through
      `pool.query` (`notifications/send-claim-ledger.ts:68`). So:
      - For every sink whose write is a provider call, `withErasureFence` runs the claim
        transaction (stripes, tombstone check, claim insert), the guarded flip, and each terminal
        write (`sent` with its SID, `failed`, `ambiguous`) on its own connection, outside any
        ambient transaction (`runOutsideRequestTransaction`, `middleware/tenant-context.ts:676`).
        Each commits before the next starts. The claim is durable before the call, and the
        stripe is held only for the short claim transaction.
      - **Those connections come from a small dedicated pool, not the main one.** That
        function's comment warns that a fresh checkout can wait on the request's own client, and
        `middleware/tenant-context.ts:222-226` records the incident: in-app voice turns that
        each held two connections "deadlocked on checkout and 500'd every tenant's /api". A
        caller that holds a main-pool client and awaits a second checkout from the same pool can
        repeat it. So the claim, flip and terminal writes run on the same dedicated pool as U8's
        spend module (see U8's "They run on a small dedicated pool"). Every transaction on it
        sets a `lock_timeout`, so a wait on a lock that a main-pool transaction holds ends in an
        error, never a hang.
      - The direct send routes (`routes/estimates.ts:944`, `routes/invoices.ts:649`) also move
        onto a route list that runs with no request transaction, like `LLM_LONG_CALL_ROUTES`,
        and hold one connection while they wait on the provider.
      - A local-write fence may still join the caller's transaction.
      - A structural check fails on a provider-sink claims repository that takes its client from
        `tenantContextStore`.
      - Docker-gated test: a `POST /api/estimates/:id/send` whose client disconnects after mocked
        Twilio accepts keeps its claim and SID, and a later erase deletes the message.
    - **Terminal states:**
      - A success fills in the SID and marks the row `sent`.
      - A definite provider rejection (a 4xx with an error body) marks it `failed`; nothing exists
        at the provider.
      - A timeout, connection reset or 5xx without a SID marks it `ambiguous`, not `failed`.
    - **A provider-side unique correlation links ambiguous sends.** Matching on From, To and the
      body hash is not unique: identical appointment reminders to two customers who share a
      household phone have the same tuple, and a match would delete the other customer's history.
      So each SMS send passes a per-send `StatusCallback` URL that carries the write-ahead row's
      id. The status-callback handler is built on the webhook base (P0-014) and signature-checked.
      It records the SID on that row even when our create call timed out. A row linked this way is
      deleted like any linked SID.
    - **An outbound call needs its own correlation, and its own fallback.** `initiateOutboundCall`
      POSTs `Calls.json` with the agent as `To` and the bridge as `Url`
      (`telephony/outbound-call-service.ts:250-266`), and sets no `StatusCallback`. When the agent
      answers, the bridge `<Dial>`s the customer as a child leg. If the create times out after
      Twilio accepted it, the row is `ambiguous` with no SID. The Calls step selects only stored
      SIDs, and the only fallback below lists Messages. So the parent Call, the child leg with the
      customer's number and its recordings would stay at Twilio, and the job would end
      `erase_incomplete` every day. So:
      - Every `Calls.json` create passes a per-call `StatusCallback` with
        `StatusCallbackEvent=initiated`. Its URL carries the tenant id and the write-ahead row id.
        The handler is built on the webhook base (P0-014), signature-checked, and records the SID
        on the row like the SMS callback, job row first.
      - The bridge callback, which Twilio sends with the parent's `CallSid`, records the SID too,
        job row first, and retries once on `40P01` (see "One lock order: the job row first"
        above).
      - A call row still unlinked once its deadline has passed (the ring timeout plus `TimeLimit`
        plus a margin) falls back to listing its account's Calls by the row's `To` and `From`,
        kept to its `date_created` window. One match is linked, and its children are then found
        through `ParentCallSid` as above. Several go on the candidate list. Zero is recorded
        reconciled-absent.
      - Test: a call create whose response is lost is linked by its callback, and the parent and
        child legs are deleted. With the callback lost too, the fallback finds and deletes them.
    - **Email needs its own correlation, and its own erase outcome.** The SMS callback above
      doesn't cover email. When SendGrid or Twilio Email accepts a request but our client times out,
      the provider id (SendGrid's `x-message-id`, Twilio Email's `operationId`) arrives only in the
      lost response (`twilio-delivery-provider.ts:361-380`, `twilio-email-delivery-provider.ts:215-231`).
      So:
      - Each email send carries the write-ahead row's id in the provider's per-message custom
        metadata. For SendGrid that is `custom_args`, which its Event Webhook echoes back.
      - A signature-checked event handler, built on the webhook base (P0-014), records the
        provider message id on that row from the first event.
      - If a provider can't echo per-message metadata, its ambiguous rows can't be linked. They are
        never matched by recipient alone.
      - **Erase outcome.** Neither email provider offers a per-message delete. The manifest
        classifies their activity logs as provider-retained, under the provider's own retention.
        So an ambiguous email row ends `provider_retained` once the provider's event window has
        passed, linked or not. It can't block the erase forever.
      - The erase result lists those rows as retained by the provider, with that retention period,
        and never as deleted.
      - **SendGrid's suppression lists are a store of their own.** An email to the subject that
        bounced, was blocked or was reported as spam puts the address on SendGrid's bounces,
        blocks, invalid-email or spam-report list. Those entries don't expire, and each can be
        deleted through the Suppressions API (`DELETE /v3/suppression/bounces/{email}` and its
        siblings). A result that printed the Email Activity retention would tell the owner the
        address leaves SendGrid on a date when it stays for good. So:
        - The email store's manifest entry includes the suppression lists.
        - The email step deletes the subject's addresses from bounces, blocks and
          `invalid_emails`, which are deliverability records, and reads each list back.
        - Spam reports and unsubscribes are suppression records, like consent and DNC rows. They
          stay, and the result lists them `provider_retained` with no expiry.
        - Those deletes and read-backs need the raw addresses, so the email step is a declared
          reader of the identifiers.
      - Test: an email send whose response is lost is linked by its event, and resolves
        `provider_retained`. An unlinked one resolves `provider_retained` after the window. The
        erase completes, listing both as provider-retained.
    - **Rows the callback never linked fall back to a strict content match, which proves absence
      only once the message can no longer be sent.** A tenant registered for A2P sends through a
      Messaging Service, with `MessagingServiceSid` and no `From`
      (`notifications/per-tenant-twilio-delivery-provider.ts:94-99`), and Twilio picks the number
      from the pool. A message still waiting in the service's queue has no `date_sent`, and can
      wait up to its `ValidityPeriod`, 36,000 seconds by default. Link shortening and smart
      encoding can change the body Twilio stores. A filter on the row's sender, over a `DateSent`
      window, matched by body hash, would find nothing in each of those cases and record a message
      Twilio still holds, and may still deliver, as reconciled-absent. So:
      - Each write-ahead row records the account SID, and either the `MessagingServiceSid` or the
        bare `From`.
      - **The fallback reads its target, never the dispatch row.** `message_dispatches` has
        `customer_id` and `recipient TEXT NOT NULL` (`schema.ts:8186`, `:1101`), so the catalog
        and per-column rules make `recipient` a designated column. The local scrub blanks it
        within minutes of `snapshot`, and nothing orders that scrub after the Twilio messages
        step, whose fallback runs hours later. A fallback that read the row would list Messages
        with an empty `To`, find none, and record a message Twilio still holds as
        reconciled-absent. So:
        - When a dispatch row becomes a Twilio messages or email target, at phase 1 or at
          `snapshot`, the target copies the account SID, the Messaging Service SID or `From`, the
          `To` encrypted with `encrypt`, the body hash and the send window.
        - The fallback below reads only the target. The uniqueness check compares other rows by
          their keyed recipient hash, which the scrub keeps, as the tombstone does.
        - The target's encrypted `To` is nulled in the transaction that makes the target
          terminal.
        - A sink whose claims live in a table of their own, classified `keep`, marks the raw
          recipient "subject data, blanked", and nulls it at the claim's terminal transition.
        - Test: an ambiguous send whose dispatch row is scrubbed before the fallback deadline is
          still found by the fallback and deleted, and afterwards no table holds the phone.
      - Every customer-facing SMS is sent with an explicit `ValidityPeriod`, `SmartEncoded=false`
        and no `ShortenUrls`, so the body Twilio stores is the one we hashed. The not-yet-linked
        wait's deadline is that period plus a carrier margin.
      - The fallback lists the target's account's Messages by the target's `To`, adding `From`
        only for a bare-number send, with no `DateSent` filter. It keeps the messages whose
        `messaging_service_sid` or `from` matches the target and whose `date_created` falls in
        the send window (the row's `attempt_started_at` to the client timeout after it, widened
        by clock skew), and compares their body hash.
      - It accepts a match automatically only when both hold:
        - exactly one Twilio message matches
        - no other write-ahead row, for any customer in the tenant, has the same sender,
          recipient hash and body hash in an overlapping window
      - Anything else goes onto the owner-confirmed candidate list. That includes a message from
        the target's sender to its `To`, in its window, whose body doesn't match.
      - The fallback runs once the wait's deadline has passed. Zero messages from the target's
        sender to its `To` in the window then counts as Twilio never having accepted the message,
        and the row is recorded reconciled-absent.
      - Test: a Messaging Service send whose response and status callback are both lost, and that
        stays queued for hours, is found by the fallback and deleted once Twilio has finished with
        it. It is never recorded reconciled-absent.
    - **The erase never reports success while a linked row is open.** It waits until every row
      linked to the subject is terminal:
      - `sent`, with its SID deleted
      - `failed`
      - `ambiguous` and reconciled
      - **A send that crashed mid-call gets a resume path too.** A sender that dies after the
        `claimed → sending` flip leaves a row nobody will finish. The job's Twilio messages step
        moves any subject row still `sending` past its provider timeout to `ambiguous`, with a
        guarded transition, and reconciles it like any other ambiguous row. A late result from the
        original sender still lands: `ambiguous → sent` with the SID is allowed.
      - A row that still can't be reconciled after the step's retries leaves the Twilio messages
        store `incomplete`, which ends the job `erase_incomplete` with its one alert. The erase stays
        incomplete until every row clears or the owner closes it from the candidate list.
  - **Scrub:**
    - the `customers` row and `customer_contacts`
    - `customer_custom_field_values`: the arbitrary `value` column (`schema.ts:4733-4741`) can hold
      gate codes, dates of birth or account references
    - the customer's `service_locations`: street, city, postal code, latitude/longitude and access
      notes, all linked by `customer_id` (`schema.ts:338-352`). Anonymize these rather than delete
      them, because jobs and appointments still reference the rows. Their `customer_id` is
      `NOT NULL`, so their method is `keep-link`.
    - SMS conversations and message bodies
    - customer-linked notes
    - `call_transcript_turns`, `call_summaries`, `knowledge_chunks` by source
    - `voice_sessions.transcript`, `voice_recordings.transcript`
    - stored audio (S3 and Twilio)
    - entity aliases and correction lessons that reference the customer
    - `ai_runs` content, found two ways:
      - **Linked rows.** Rows whose `correlation_id` is one of the subject's conversation, session or
        call ids. U2 (OBS-2) makes every drafting call carry that id; before U7 ships, check that the
        classifier, summary and other voice-path gateway calls carry it too, and close any gap.
      - **Historical rows.** Rows written before that linkage have random correlation ids, so match
        them by content instead. Use a tenant-scoped, batched scan of `input_snapshot` /
        `output_snapshot` text for the subject's normalized phone numbers, email and full name. U4's
        purge has already scrubbed anything older than the window it last applied, so the scan
        starts from the tenant's oldest remaining `ai_runs` row, not from the current retention
        setting. A window shortened since the last purge would otherwise hide rows the purge hasn't
        reached yet.
      - **The scan also matches the subject's ids.** A drafting prompt can carry only the resolved
        customer id and non-identifying job details. For example, `estimate-task.ts` serializes
        `context.existingEntities`, including the verified `customerId`, into the user message, and
        `gateway.ts` stores that message verbatim under a random correlation id. A phone, email and
        name scan finds nothing in such a row. So:
        - The historical scan also matches the customer UUID, and the UUIDs of the subject's jobs,
          estimates, invoices and appointments.
        - A UUID is unique to the subject, so a UUID match counts as corroborated on its own, and
          that row is scrubbed automatically.
      - **A content match is a candidate, not proof.** Names, phones and emails are not unique per
        customer (`packages/api/src/db/schema.ts:325-328`): two customers can share a name, and a
        household can share a phone. The scrub is irreversible, so it runs automatically only for a
        corroborated row, which meets both of these:
        - its text carries at least two of the subject's identifiers
        - no other customer or contact in the tenant shares any identifier that matched
      - Every other match goes onto a candidate list, returned with the erase result and shown to the
        owner. Those rows are scrubbed only after the owner explicitly confirms them.
      - The erase result reports how many rows each strategy scrubbed, and how many candidates are
        still waiting.
  - **Anonymize** jobs, invoices, payments and estimates, and keep the amounts for tax and legal
    retention. Their PII is blanked. Their links are `NOT NULL` (`jobs.customer_id`,
    `estimates.job_id`, `invoices.job_id`, `payments.invoice_id`), so each keeps its link to the
    blanked row (`keep-link`, see "Each `anonymize` table names how it treats its link").
  - **Keep** `consent_events` and DNC rows as suppression records, hashing the phone if counsel
    requires it.
- **Test scenarios:** one Docker-gated integration test that seeds a customer across every store,
  erases them, and asserts:
  - each store is scrubbed, including a pre-linkage `ai_runs` row found only by content and a linked
    row found by `correlation_id`
  - the customer's `service_locations` rows keep their ids but lose street, city, postal code,
    coordinates and access notes
  - a seeded `customer_custom_field_values` value is gone
  - a customer MMS photo (a `files` row with `entityType: 'customer'`) is deleted along with its S3
    object
  - a call recording, a job photo and an attachment of the subject: each `files` row is deleted,
    or blanked where a kept row still references it, each S3 object is gone, and no step fails
    with `23503`
  - a QuickBooks sales receipt whose line description names the subject, and a Stripe
    payment-link Product named after the subject, hold none of the subject's identifiers
  - **schema coverage:** the manifest test fails when a test-only migration adds a new table with a
    `customer_id` foreign key that the manifest doesn't list, and also when it adds a bare
    `…_customer_id` column with no foreign key
  - a lead converted into the customer (linked only by `converted_customer_id`, with no foreign key)
    has its name, phone, email, notes and service address scrubbed
  - a `call_me_back_tasks` row linked only through the customer's voice session has its caller phone,
    name, message and intent summary scrubbed
  - with content capture on, the subject's Langfuse traces are deleted through the API (a mocked
    Langfuse endpoint). When the delete fails, the erase result marks that store incomplete and
    alerts.
  - a trace queued before the erase whose transport is delayed until after it is never recreated: it
    is dropped at the send boundary, or deleted again on the second pass
  - with capture turned off since an earlier capture-on interval, the erase still deletes that
    interval's subject traces. A pre-linkage run that the historical scan scrubs has its trace,
    keyed by its random correlation id, deleted too.
  - against mocked Stripe, QuickBooks, Twilio Messages and Twilio Calls APIs:
    - the subject's completed Call resources, child legs included, are deleted. A child leg we
      never stored is found through `ParentCallSid` and deleted before its parent. A call still in
      progress keeps the store `incomplete` until it completes, and then it is deleted.
    - the Stripe Customer is deleted
    - the QuickBooks customer's `DisplayName` is replaced and its email and phone are cleared. An
      inactive QuickBooks customer from a lost create is still found, against a mock that renames
      it "<name> (deleted)" on inactivation, and the create and the update each send
      `?requestid=`. A receipt from a lost receipt create is found by its `CustomerRef` and
      rewritten. Against a mock that fills `PrintOnCheckName` from
      `DisplayName` on create, the anonymize overwrites it, and the read-back finds none of the
      subject's identifiers in any name or contact field.
    - a Message delete that returns 20009 waits and retries without using up the step's retries,
      and a disconnected integration ends its store `provider_retained`, with one alert
    - a burst of deletes that Twilio answers with 429 and a `Retry-After` waits out each one,
      uses none of the step's retries, and ends `done` with no alert
    - each of the customer's linked Twilio Messages returns 404 after the erase, and its Media
      list is empty
    - a message from a shared household number that isn't linked to the subject is left alone and
      listed as a candidate
    - a failure at any provider marks that store `incomplete` and alerts
  - erase versus in-flight outbound SMS, against real Postgres and a mocked Twilio Messages API:
    - **Paused between check and claim.** A sender is paused after it takes the shared lock, and
      the erase starts. The erase waits for the lock. Once the sender's row commits, the erase sees
      it and fences or drains it. A sender that reaches the lock after the tombstone sees it and
      makes no provider call.
    - **Fenced before the flip.** A sender is paused after its row commits but before the
      `claimed → sending` flip. The erase moves the row to `fenced`, the flip fails, and no provider
      call is made.
    - **Held at the provider.** A send is held at the provider when the erase starts, and Twilio
      accepts it afterwards. The erase waits for the row to be terminal and deletes its SID.
    - **Timed out, then linked by the callback.** Twilio accepts a send but the client times out,
      so the row is `ambiguous`. The status callback links the SID through the row id, and the
      erase deletes that message.
    - **Not unique.** An ambiguous row whose From, To and body hash match two Twilio messages is
      not auto-matched. The same goes for a row that conflicts with another customer's row
      (household reminders). Neither message is deleted, the row is candidate-listed, and the
      erase is `incomplete`.
    - **Sender died mid-call.** A sender dies after the `claimed → sending` flip. After the
      provider timeout the job moves the row to `ambiguous` and reconciles it. A row that still
      can't be reconciled ends the job `erase_incomplete`, with one alert.
  - after an erase, the exporter still sends unrelated traces, so the drain did not shut it down
  - a drain failure marks Langfuse `incomplete`
  - with phase 1 committed, an in-flight writer in another connection sees the tombstone and drops
    its content while phase 2 is still running
  - with two customers sharing a full name, the other customer's row is untouched
  - a row that matches only a household-shared phone lands on the candidate list and is scrubbed only
    after confirmation
  - financial amounts remain
  - suppression remains
  - an audit event is written
  - a non-owner gets 403 on the erase, and on each candidate confirmation, dismissal, release and
    drop
  - another tenant's data is untouched
  - **the erasure job survives a crash**, against real Postgres and the mocked providers:
    - **Restart right after phase 1.** The process is killed once phase 1 commits, before any
      phase-2 step runs. On boot the sweep claims the job and finishes it. The erase record is
      written first, every store is erased, `erase_completed` is written once, and writers stay
      fenced throughout.
    - **Crash after each later checkpoint.** For each step in turn, the process is killed once just
      after the step's checkpoint commits, and once between a provider delete and its checkpoint.
      On resume, no checkpointed target is sent a second delete. A repeated delete that returns 404,
      for the Stripe Customer or a Twilio Call, or 410 for a calendar event, is recorded `done`,
      not as a failure. The job completes.
    - **Resume after the links are gone.** The process is killed after the scrub has nulled the
      nullable links and blanked the `customers` row and the jobs behind the invoices. The
      resumed Stripe, QuickBooks,
      `invoice_line_items` and historical `ai_runs` steps still find every target, from the step
      rows and the job's encrypted identifiers. Once those steps are done, no
      `customer_erasure_identifiers` row remains for the job.
    - **Snapshot before severing.** The process is killed partway through `snapshot`. On resume
      it records each external id once, and no scrub step started before it was done.
    - **Two workers race.** The queue handler and the boot sweep claim the same job at once.
      Exactly one claim succeeds, and each provider delete is sent once. A worker whose lease
      lapsed mid-step has its next checkpoint refused, and makes no further provider call.
    - **A checkpoint races a re-claim.** A worker's lease has lapsed, and its pre-call checkpoint
      is held before commit while another worker claims the job. Exactly one of them calls the
      provider for that target.
    - **Bounded retries.** A provider that fails every time ends its step `incomplete` after the
      retry limit. The job ends `erase_incomplete`, naming that store, with one alert. A repeat
      `POST` retries only that step. If that step ends `incomplete` again, a second alert fires.
      The tombstone fences writers the whole time.
    - **A step that crashes every run.** A step calls `process.exit()` on every run. After the
      retry limit it ends `incomplete`, and the job ends `erase_incomplete` with one alert.
    - **A callback that never arrives.** An SMS whose client timed out before Twilio accepted it
      stays `ambiguous`, and no status callback ever comes. Past its deadline (the send's
      `ValidityPeriod` plus the margin) the step falls back to the content match, finds nothing and
      records reconciled-absent. The job ends terminal.
    - **A late target races the close.** A status-callback handler is held between its step update
      and its commit while the worker closes the job. Once both commit, the job isn't terminal. The
      sweep runs the re-opened step, the SID is deleted at Twilio, and the job closes again with one
      audit event for that generation.
    - **A late target races a running step.** A status callback adds a SID to the Twilio messages
      step while it runs, and commits between the step's target read and its `done` checkpoint.
      The step doesn't end `done` until that SID is deleted, and the job then closes once.
    - **A source that skips the re-open.** A raw `INSERT` of a target into a `done` step of a
      `completed` job, made after the job-lock helper, leaves the job `pending`, and the sweep
      then processes the target. The same insert without the helper raises.
    - **The job row first.** A callback is held between its job-row update and its dispatch-row
      update while a checkpoint moves the same dispatch row. Both commit, with no `40P01`.
    - **Age alarm.** A job still not terminal past the age limit raises one job-age alert. An age
      alert followed by an `erase_incomplete` close at the same generation sends both alerts. A
      job re-opened by the daily retry after the age limit raises no age alert unless it stays open
      past the limit again. A job stuck in its first opening raises the age alarm, and a job with
      no targets that closes `erase_incomplete` alerts once.
    - **Identifier retention.** An `erase_incomplete` job whose historical scan keeps failing
      reaches the identifiers' maximum retention while a worker is mid-scan. The identifiers are
      deleted, the worker's next checkpoint is refused, and that step ends `inputs_expired`. The
      job ends `erase_incomplete` with one alert, and the daily retry and a repeat `POST` leave
      that step alone.
  - **the lock covers every tombstone key:** a writer that carries only a session id, or only an
    `invoice_id`, holds its shared stripe lock, paused before commit, when the erase starts. Phase 1
    waits for it, and phase 2 then scrubs what it wrote.
  - **phase 1 can't be starved, and gives way to a writer:**
    - With writers taking the subject's shared stripes back to back, phase 1 still commits within
      its retries.
    - A writer holds one shared stripe and waits for one that phase 1 holds, while phase 1 waits
      for the writer's. Phase 1 times out inside its budget, rolls back and retries. The writer
      commits, with no deadlock error.
    - A writer that holds a stripe past every retry gets the owner a typed `409`, and no tombstone
      or job row exists.
    - Phase 1's deadline, measured from its first grant, is below the value `SHOW deadlock_timeout`
      returns, less the margin.
    - **A slow collection.** The re-collection is slowed to most of the budget while a two-stripe
      writer waits on phase 1. Phase 1 rolls back, and the writer commits without a `40P01`.
    - **A writer already waiting on another writer.** A writer has waited 700 ms on another
      writer's row lock when phase 1 starts, and the three form a cycle. That writer commits after
      its one retry, and no writer fails with a deadlock error it doesn't retry.
  - **every U7 table is a tenant table:** the set comes from the catalog. A test-only migration that
    adds a child table keyed by `job_id` alone fails the test, and so does a fixture sink whose
    claims table has no `tenant_id`. A late target written under one tenant's context against
    another tenant's job id is refused.
  - **the erase record keeps no subject data:** a customer with an attachment named
    `Jane_Doe_passport.jpg` is erased. Phase 1's inserts aren't refused by the erasure trigger.
    Every mocked provider fails once with an error body that echoes the subject's name and email.
    Once the job completes, no U7 table holds that filename, in a key or an error, and no U7
    table, spend table or audit row holds the name or the email.
  - **the second Langfuse delete waits by time:** another process queues a subject trace before
    phase 1 and sends it after the first delete. The job's second delete, at `not_before`, removes
    it, even when the process that ran the first delete restarted in between.
  - **the historical scan ignores a newly shortened window:** the owner shortens the retention
    window, and the erase runs before the next purge. A pre-linkage `ai_runs` row older than the new
    window is still found and scrubbed.

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
- **Approach:**
  - A nullable `tenant_settings` monthly ceiling in whole cents, as `BIGINT` (new idempotent
    migration). Null means no cap is enforced. `billing/overage-cap.ts`'s column is `INTEGER`
    (`schema.ts:7122`); this one isn't, for the reason in "Keep the ledger in micro-cents" below.
  - **One module writes the ceiling, so no write can skip the spend lock.** `tenant_settings` has a
    generic key-to-column updater. `PgSettingsRepository.update` maps each key through `fieldMap`
    (`settings/pg-settings.ts:421`) into one `UPDATE tenant_settings` (`:696`), with no spend lock
    and none of the checks below. Many callers reach it besides `PUT /api/settings`: onboarding and
    proposal handlers, among others. Leaving a key out of `updateSettingsSchema`
    (`shared/contracts.ts:537`) guards only the route. `siteAboutText` is absent from that schema
    yet still in `fieldMap` (`pg-settings.ts:485`). A ceiling written that way would reopen the
    race below. So:
    - The ceiling has its own store module, the way `ai_overage_cap_cents` has
      `billing/overage-cap.ts`. Its write takes the spend lock and runs the checks below. Its read
      is the one the reserve runs under the lock.
    - The ceiling is kept out of `fieldMap` and off `TenantSettings`, so the generic updater can't
      name it. The settings page sends a cap change to that module.
    - A structural test in `packages/api/test/invariants/` (the
      `i9-one-totals-engine.structural.test.ts` pattern) scans `packages/api/src`. It fails on any
      SQL that names the ceiling column outside that module and its migration.
  - **The cap is the owner's, and every change is audited.** Most settings routes require only
    `requirePermission('settings:update')` (`routes/settings.ts:419`), while some also require
    `requireRole('owner')` (`:789`). A cap route on the common pattern would let a non-owner clear
    or raise the cap, with no record. So:
    - The cap route is owner-only, with `requireRole('owner')`.
    - The module writes an audit event (actor, old value, new value) in the same transaction as
      the change, under the spend lock.
    - No proposal handler can reach it. The structural test also fails on an import of the
      module's write function outside the cap route.
    - Tests: a non-owner gets `403`, and each change leaves exactly one audit row.
  - **The ledger runs for every tenant, capped or not, so a cap set mid-month is a real monthly
    cap.** If the ledger started when a cap was set, a tenant that had already spent $90 could
    enable a $100 ceiling and spend another $100.
    - Every attempt is reserved and settled in the ledger whether or not a ceiling is set. With a
      null ceiling, the reserve step skips only the comparison. It still takes the spend lock and
      reads the ceiling under it (see "A ceiling change and a reservation take the same lock"
      below).
    - **Caps start in the first full calendar month after the ledger ships, so no pre-ledger
      spend has to be estimated.** Every attempt to reconcile old-version spend inside a month
      left a race. A seed missed late writes. A reconcile on an interval went stale. Even a
      recompute inside the reserve transaction can't serialize with an old-version write it never
      sees under `READ COMMITTED`, because old code takes no lock. Old-version processes can't be
      proven gone either, because they predate any heartbeat. So:
      - Every ledger-era `ai_runs` row carries a ledger tag from the moment it is inserted, from
        the day the ledger ships. The `ai_runs` repository's insert writes `ledger_era = true`, in
        a column whose default is `false` and that old code never names.
        - The tag can't be the reservation's `attempt_id`. The gateway inserts the pending
          `ai_runs` row before dispatch (`gateway.ts:568-588`), the reservations wrap each attempt
          inside the retry loop after that, and no `ai_runs` write runs under the spend lock. So a
          run's own pending row would still be untagged when its first reserve checks the
          tripwire below, and every capped request would refuse itself. The attempt link stays on
          `ai_spend_reservations.ai_run_id`.
        - A cache hit still writes an `ai_runs` audit row (`ai/gateway/cache.ts:191-224`), through
          the same insert, so it carries the tag too. It costs nothing and has no reservation.
      - A cap can be enabled from the first full calendar month after the ledger ships. Every run
        in that month, and in every month after it, was written by ledger-era code, so `spent` is
        the month's real spend. During the ship month, the settings write that enables a cap is
        refused, with a plain "available from <date>".
      - **A tripwire stays in place.** A capped tenant's reserve transaction checks a partial index
        for the current month:
        `ai_runs (tenant_id, created_at) WHERE NOT ledger_era`.
        - An untagged row means an old-version writer is still alive, weeks after the ship. The
          capped reservation is then refused, and `alertOperator` fires.
        - A ledger-era run is tagged before its first reserve, so neither its own pending row, nor
          a cache hit, nor a run whose process died before dispatch ever trips it.
        - Tests: a capped tenant's cache hit writes a tagged row, and the next capped request is
          admitted. A capped tenant's request and a concurrent second request are both admitted.
      - The conditional reserve therefore compares `spent + reserved + $cost` with the cap. There is
        no `pre_ledger_spent`.
    - **Unpriced usage fails closed; it is not shown as a floor.** `SUM(cost_micro_cents)` skips
      null-cost runs. A tenant with substantial unpriced usage could therefore enable a $100 cap
      and still get close to another $100. So:
      - Once a verified price exists for a run's model, the run is repriced from its stored
        `model` and `token_usage`, and the computed cost is written back. A leader-gated sweep does
        this at boot and on an interval. Each row's state is its checkpoint, so a sweep killed
        partway through a batch resumes with the rows it hadn't reached.
      - **Repricing reconciles the ledger in the same transaction, exactly once per physical
        attempt.** The run's `settled_unpriced` reservation row takes one guarded transition out
        of that state: to `settled` when it has usage, or to `charged_unreconciled` at its worst
        case when it has none (below). The guard is `state = 'settled_unpriced' AND
        reserved_micro_cents IS NULL` (see "Repricing is what gives it its amounts" below). The
        ledger's `spent` grows by exactly the repriced amount. A repricing that runs twice matches
        no row the second time. Retried attempts each have their own row, so each one is counted.
        - The `ai_runs` cost is written back after that transaction commits, in a transaction of
          its own, never under the spend lock (see "One lock order with U7" below). It is guarded
          on a charge stamp (see "A later change to a charge is written back too" below). A crash
          between the two leaves the cost unwritten, and the sweep's next pass writes it.
        - **The write-back waits for no open reservation, not for every one to be priced.** A
          `released` reservation has no snapshot and is never repriced, so "every reservation of
          the run is priced" would never hold for an unpriced attempt that failed before
          dispatch, and the sweep would re-select that run forever. So a ledger-era run's cost is
          written once none of its reservations is `reserved` or `settled_unpriced`, and no new
          attempt can start: the `ai_runs` row is no longer pending, or is older than the maximum
          gateway deadline, which bounds the whole retry loop. The cost is
          `COALESCE(SUM(charged_micro_cents), 0)` over the run's reservations, so a `released` one
          counts as zero, and a run whose only reservation was released gets cost 0. The second
          condition keeps a retry loop that is between a released attempt and its next reserve
          from being written early. An
          `ai_runs` row therefore never shows a cost that the ledger didn't hold, and a later
          change reaches it on the next write-back. The cap's checks read the ledger and the
          reservations, not the `ai_runs` cost, so a cost that lags by one pass changes none of
          them.
        - **A later change to a charge is written back too.** A priced attempt's lease expires
          while its call is still running, and the reaper charges its worst case as
          `charged_unreconciled`. The write-back writes that worst case. When the call then
          settles with real usage, `charged_unreconciled → settled` lowers the charge, and a
          write-back guarded on the cost being null would never run again, so `ai_runs` would
          keep the worst case for good. So:
          - Every change to a reservation's `charged_micro_cents`, made under the spend lock,
            stamps the reservation with the next value of one sequence. The spend lock orders a
            tenant's changes, so a later change has a higher stamp.
          - The write-back reads the run's charge sum and its highest stamp in one statement,
            through the spend module, and writes the cost guarded on the run's stored stamp being
            lower: `COALESCE(cost_stamp, 0) < $stamp`. A write-back that read before a later
            change then matches no row once the newer one has landed.
          - The `charged_unreconciled → settled` transition marks the run for another
            write-back, which runs in its own transaction outside the spend lock.
          - Test: a reaped attempt that later settles from usage ends with its `ai_runs` cost
            equal to the settled charge.
      - Each row is repriced from its own stored inputs, never from the logical `ai_runs` row:
        - An attempt with recorded usage is settled at the new price.
        - An attempt with no usage (it timed out after dispatch, or its lease expired) is charged at
          the worst case from its stored bound, and moves to `charged_unreconciled`. Its output
          bound is the price entry's `maxBilledOutputTokens`, never less than the stored
          `maxTokens` (see "An unpriced attempt is priced at its entry's billed bound" below).
        So every `settled_unpriced` row can be cleared once its model has a price. Only the
        current month's rows gate a cap (below), so an old month's row whose model never gets a
        price, such as a model the deployment has since stopped using, doesn't block enabling one.
      - **A reservation with no price snapshot never charges zero.** An unpriced reservation has no
        amount. A lease reaper or an ambiguous failure that moved it to `charged_unreconciled` would
        charge it 0. Repricing, which matches only `settled_unpriced`, would then skip it, and so
        would the cap-enable count, while its spend stayed outside the ledger. So:
        - The reaper and the ambiguous-failure path move a row with no snapshot to
          `settled_unpriced`, with no usage, never to `charged_unreconciled`. Repricing then charges
          it at the worst case, as above.
        - A definitive no-dispatch failure still releases it.
        - The check constraint ties each state to its snapshot and its amounts (see "two amounts"
          below). `settled` and `charged_unreconciled` need a price snapshot and a
          `charged_micro_cents`. Only `reserved`, `settled_unpriced` and `released` may lack a
          snapshot, since a released row charges nothing, plus Vapi's two states when owner
          decision 2 charges Vapi (see "The charge doesn't come from the end-of-call report"
          below). `reserved_micro_cents` is null exactly when the row has no snapshot, and
          `charged_micro_cents` is set exactly in `settled`, `charged_unreconciled` and
          `vapi_settled`.
      - The cap-enable check counts every reservation without a price snapshot that can still
        change this month's spend, not just null `ai_runs` costs:
        - the `settled_unpriced` rows of the month `spend_month` returns, reaped and ambiguous ones
          included
        - the `reserved` rows of unpriced attempts still in flight, in any month (see below)
        An earlier month's `settled_unpriced` row stays in the repricing queue. Repricing, and the
        ceiling write's pricing of an attempt, only ever charge the reservation's own month, so
        that row can't change this month's headroom, and it doesn't gate the cap. Once the counted
        rows are priced, the ledger already holds that spend.
        - It counts rows (`reserved_micro_cents IS NULL` in those two states). It never sums their
          amounts, because `SUM` skips nulls, the same trap as the null `ai_runs` costs above.
      - While any of those is still unpriced after that repricing, the settings write that enables a
        cap is refused. The message says plainly that this month's usage can't be fully counted
        yet.
      - A tenant that already has a cap and later gets an unpriced run has its capped reservations
        refused. That matches the existing fail-closed rule for unpriced models.
    - **A ceiling change and a reservation take the same lock, so a cap can't slip in beside an
      uncapped attempt.** Without it, an attempt can read the null ceiling and reserve or dispatch
      with no comparison, while the settings write reads the ledger before that attempt commits and
      enables a lower cap. An unpriced attempt is the worst case: it is still `reserved`, not yet
      `settled_unpriced`, so the enable check misses it, and it can later settle above the new
      ceiling. So:
      - **One per-tenant spend lock.** Every transaction that inserts a reservation, transitions
        one, changes the ledger or writes the ceiling first takes `pg_advisory_xact_lock` on the
        tenant's spend key, in the two-key form with the spend class id (see U7's "Stripes and
        the spend lock have key spaces of their own"). That covers reserve, settle, release,
        expiry, reconciliation and repricing. The lock is per tenant, not per tenant-month, so a
        cap written in the last second of a month still serializes with a reservation that lands
        in the next one.
      - **The spend module's transactions never join an ambient one.** Repositories here are
        `PgBaseRepository`s, which join any open tenant transaction: the request transaction,
        `executeAudited`, or `PgTenantTransactionRunner.run` (`db/tenant-transaction.ts:96`).
        Suppose a gateway call runs inside one, on an `/api` route missing from the hand-kept
        `LLM_LONG_CALL_ROUTES` or in a proposal handler. The pending `ai_runs` insert
        (`gateway.ts:568-588`) would join it and its erasure trigger would set the stripe flag,
        so the spend module would raise on entry and every AI call on that path would fail
        closed. Or, with no stripe taken first, the reservation and the spend lock would last
        until the outer COMMIT, across the dispatch, and every reserve and settle in the tenant,
        live calls included, would wait for the whole LLM call. A disconnect or crash would then
        roll the reservation back after the provider had billed. So:
        - Reserve, settle, release, expiry, reconciliation, repricing and the ceiling write each
          run in their own transaction, outside any ambient one (`runOutsideRequestTransaction`,
          `middleware/tenant-context.ts:676`), and commit before the module returns.
        - **They run on a small dedicated pool, not the main one.** A caller inside a request
          transaction holds one main-pool client, and each reserve and settle would await a
          second from the same pool. `runOutsideRequestTransaction`'s own comment says a request
          must never await it on its routine path, and `middleware/tenant-context.ts:222-226`
          records the incident: in-app voice turns that each held two connections "deadlocked on
          checkout and 500'd every tenant's /api". `POST /api/tenant-site/about/draft`
          (`routes/tenant-site.ts:279`) calls the gateway inside the request transaction and
          isn't on `LLM_LONG_CALL_ROUTES` (`middleware/tenant-context.ts:212`). At the default
          `DB_MAX_CONNECTIONS` of 20 (`db/pool.ts:110`), 20 such drafts at once would each hold
          a client and wait for a second, every reserve would fail closed after the 5-second
          `connectionTimeoutMillis`, and the rest of `/api` would wait on the pool. So:
          - The spend module, and U7's claim, flip and terminal writes, use a dedicated pool
            with its own size, as the session-lock holders use the direct pool
            (`db/pool.ts:155-175`).
          - Its transactions wait only on the spend lock, a stripe, or a row that only they
            write, and each sets a `lock_timeout`. A caller holding a main-pool client never
            waits on the main pool through them.
        - **Every gateway-calling path leaves the request transaction.** Inside one, the pending
          `ai_runs` insert, a local-write fence that may join the caller's transaction, holds its
          shared stripes until the request commits, across the whole LLM call, and an erase's
          phase 1 times out behind it while a draft is in flight. So `POST
          /tenant-site/about/draft`, and every other route and proposal handler that calls the
          gateway, moves onto `LLM_LONG_CALL_ROUTES`, or makes its gateway call before it opens
          its transaction.
        - Entering the spend module while `currentTenantContext()` (`:619`) is present throws
          under test and logs its caller in production. A structural test fails on a gateway or
          provider-sink call reachable from `executeAudited`, `PgTenantTransactionRunner.run`,
          or an `/api` route not on the no-transaction list.
        - Tests, with the under-test throw switched off to prove the production path: a reserve
          called inside a `PgTenantTransactionRunner.run` that then rolls back leaves its
          reservation committed, and the spend lock is free once the reserve returns.
          Docker-gated, at `DB_MAX_CONNECTIONS=2`, three concurrent in-transaction gateway calls
          all reserve, dispatch and settle.
      - **One lock order with U7: the erasure stripes first, the spend lock last.** `ai_runs` is a
        U7 `scrub` table, so a write to it takes shared erasure stripes, and those wait while an
        erase's phase 1 holds them. A transaction that held the spend lock while it waited there
        would hold up every reserve and settle in the tenant, live calls included. So:
        - A transaction never takes a stripe while it holds the spend lock. U7 states the same
          order, and the erase never takes the spend lock.
        - Under the spend lock, a transaction writes only `ai_spend_reservations`,
          `ai_spend_ledger`, `ai_spend_bound_breaches` (see "A settle above its reservation is
          caught" below), the ceiling and their audit events. The U7 manifest classifies the
          three spend tables `keep`, since they hold a model, token counts and amounts but no
          subject content, so they carry no erasure trigger. Their audit events set no PII metadata key,
          so the `audit_events` trigger takes no stripe for them (see U7's "`audit_events` is
          classified `anonymize` by metadata key").
        - **The order is checked at runtime, not only by the repricing test.** A later change
          could write the `ai_runs` cost inside the settle transaction, which is the obvious place
          for it, or put a PII key into a spend audit event. Either would take a stripe under the
          spend lock, and while an erase's phase 1 held that stripe, every reserve and settle in
          the tenant would wait behind it, with no test failing. So:
          - Taking the spend lock and taking a stripe each set a transaction-local flag to a
            fixed sentinel, `set_config(<name>, '1', true)`, which reverts at commit or rollback.
          - **A check reads `= '1'`, never `IS NOT NULL`.** A custom setting that a
            transaction-local `set_config` created doesn't go back to unset at commit. For the
            rest of the session, `current_setting(<name>, true)` returns `''`, not `NULL`, and
            node-pg reuses connections. An `IS NOT NULL` check would then raise on every later
            spend-module entry on a connection that once took a stripe, refusing AI calls for
            uncapped tenants too, and on every fenced write on a connection that once took the
            spend lock. So each check is `current_setting(<name>, true) = '1'`, which reads
            `NULL` and `''` alike as unset.
          - The stripe helper that the erasure trigger and `withErasureFence` use raises when the
            spend-lock flag is set. The spend module raises on entry when the stripe flag is set,
            since a spend transaction writes no fenced table at all.
          - Integration test: on one pooled client, a stripe-taking transaction commits and then
            a spend transaction runs, and the reverse. Both pass.
          - Each check is one `current_setting` read, cheap enough for the per-row trigger. Any
            integration test that exercises a violating path then fails loudly.
        - Any write to a fenced table that goes with a spend change runs in its own transaction,
          outside the spend lock. That covers the `ai_runs` cost write-back (see "Repricing
          reconciles the ledger" above). The gateway's completion write (`gateway.ts:679`) is
          already its own call.
      - **The reserve reads the ceiling under the lock.** It reads `tenant_settings` in a statement
        that runs after the lock is granted, never a value read earlier or passed in, and compares
        against that. Under `READ COMMITTED` each statement sees every transaction committed before
        it starts, so a cap that committed while the reserve waited is the cap it compares against.
      - **The month and the unpriced decision are read under the lock too.** The lock orders the
        transactions, but not the values they act on. Postgres `now()` and `CURRENT_DATE` return
        the transaction's start time. A settings write that begins at 23:59:59.990 on Oct 31 and
        gets the lock just after midnight would check October. It would miss a November unpriced
        attempt that committed while it waited, and enable the cap. Once that attempt is repriced,
        November ends above the cap by its worst case. So:
        - One SQL function, `spend_month(clock_timestamp())`, defines the month. The month is the
          UTC calendar month. A tenant's timezone setting can change, and a month that moved would
          leave open reservations in the wrong month. The settings page renders the reset time in
          the tenant's timezone, like every other time.
        - The reserve, the settings check, the tripwire and the ship-month rule each evaluate it in
          a statement that runs after the lock is granted. A reservation records the month that
          `spend_month` returned in its reserve.
        - **An unpriced attempt is admitted only when the ceiling read under the lock is null.** The
          reserve inserts a row with no price snapshot only in a statement guarded on that read.
          Otherwise it returns the typed refusal. So no pre-check outside the lock decides the
          path. Neither does a replica whose pricing table lacks the model, during a rolling deploy
          or after an `AI_MODEL_PRICING_JSON` change.
      - **Every ceiling write takes the lock too**, whether it enables, lowers, raises or clears the
        cap. One that enables or lowers it then checks, in that transaction and before it writes the
        new value:
        - the `spent` and `reserved` of the month `spend_month` returns after the lock
        - every reservation without a price snapshot that can still change this month's spend: a
          `reserved` row with none, in any month, which is an unpriced attempt in flight, and every
          `settled_unpriced` row of the month `spend_month` returns
        - the tripwire, the ship-month rule, and the rule that every configured model and every
          reserved surface has a price (see "That check covers every reserved surface" below)
      - **Only two orders exist.** Either an attempt's reservation commits first, and the settings
        write counts it, or the settings write commits first, and the reservation compares against
        the new ceiling.
      - **An attempt already dispatched when a cap is enabled counts at its worst case until it
        settles.**
        - A priced attempt is already in `reserved` at its worst case.
        - An unpriced attempt in flight is priced inside the settings transaction, when its model
          now has a verified price. The transaction writes that price into the attempt's snapshot,
          sets its `reserved_micro_cents` to the worst case from the attempt's own stored input
          bound and the entry's billed output bound (below), and adds that to `reserved`. The
          attempt then settles at its actual cost. Settle reads the snapshot from the row in its
          guarded transition, so it can't settle as unpriced.
        - **An unpriced attempt is priced at its entry's billed bound, not at the `maxTokens` it
          sent.** An attempt reserved while unpriced stored only its input bound and its
          `maxTokens`, since it had no entry to declare `maxBilledOutputTokens` (see "`max_tokens`
          bounds billed output only where the provider says so" below). Say an uncapped tenant's
          tier points at a reasoning model with no verified price, and an attempt with
          `maxTokens` 1,000 is in flight. The owner adds a price whose entry declares 33,000
          billed output tokens, and enables a $50 cap at $49.95 spent. Priced at 1,000 output
          tokens, the attempt is admitted, bills 30,000, and takes the month over the cap. So:
          - The ceiling write, and repricing's worst-case charge, take the output bound from the
            entry's `maxBilledOutputTokens`, never less than the stored `maxTokens`.
          - An in-flight attempt whose frozen request lacks a bound the entry requires, such as
            an OpenRouter request reserved with no `provider.max_price`, is unpriceable, and the
            cap write is refused until it settles.
          - A `settled_unpriced` row with that gap is repriced only from the endpoint's reported
            per-request charge. With none, it stays unpriced, and while it is counted the cap
            can't be enabled.
          - Tests: enabling a cap while an unpriced reasoning-model attempt is in flight reserves
            its worst case at `maxBilledOutputTokens`. With an unpriced OpenRouter attempt in
            flight, the enable is refused.
        - A counted `settled_unpriced` row is repriced in the same transaction, by the transition
          the repricing sweep uses. Its `ai_runs` cost is written back after the settings transaction
          commits, as in the sweep.
        - If any of them can't be priced, the cap write is refused, as above.
      - Enabling a cap takes effect at once against the month's real spend. The settings response
        states `spent + reserved` against the new ceiling in plain words. When that is already over
        the ceiling, it says so, and new AI work is refused.
  - **Keep the ledger in micro-cents.** `computeCostMicroCents` returns micro-cents (1 cent =
    1,000,000; `packages/api/src/ai/gateway/model-pricing.ts`), so the arithmetic must stay in that
    unit.
    - The ledger's `spent` and `reserved` are `BIGINT` micro-cents.
    - The owner-set ceiling stays in whole cents. Convert it once (× 1,000,000) before the atomic
      comparison.
    - **The conversion can't overflow, and no `BIGINT` is read as a string.** As `int4 × int4`,
      `ceiling_cents * 1000000` raises "integer out of range" from a cap of 2,148 cents, and the
      80% threshold (× 800,000) from 2,685 cents. Every capped reserve would then error. And
      node-pg returns `BIGINT` values as strings, since `packages/api/src` registers no
      `setTypeParser`, so a `spent + reserved` in JS would concatenate. So:
      - The ceiling column is `BIGINT`, and SQL that converts it casts with `::bigint` before it
        multiplies. A conversion in JS checks `Number.isSafeInteger` first.
      - Every `BIGINT` the spend module reads (`spent`, `reserved`, each `*_micro_cents`) goes
        through an explicit safe-integer parse, like `toSafeInteger`
        (`admin/tenant-usage.ts:70`, used by `admin/pg-tenant-usage.ts`).
      - **Every reserve error fails closed.** A reserve that throws returns the typed refusal,
        and the call is never dispatched.
      - **A reserve the caller gave up on is released, even when it commits later.** A reserve's
        COMMIT can succeed while its caller never sees the result: a connection error after the
        COMMIT, the caller's own deadline, or a Deepgram renewal that commits just after the
        meter closed the socket at the chunk's reserved end. Nothing takes that reservation,
        and the lease reaper later charges its worst case as `charged_unreconciled` for a call
        that was never made. So:
        - The caller generates the `attempt_id` before the reserve.
        - On any reserve error, or when the meter abandons a renewal, it releases that
          `attempt_id` as a definitive no-dispatch, since `take()` was never called.
        - A release that finds no row for the `attempt_id` inserts one, already `released`, with
          no amount. A reserve whose `attempt_id` already has a row inserts nothing and changes
          no ledger amount. Both run under the spend lock, so whichever commits first decides.
        - Test: a renewal that commits after the meter closed the socket ends `released`, and
          `spent` is unchanged.
    - Never round an individual call to cents: sub-cent calls would count as zero and the
      aggregate could pass the cap.
    - A unit test pins the conversion: a cap of 100 cents admits exactly 100,000,000 micro-cents of
      reservations. Integration tests at a cap of 1,000,000 cents admit a reservation under it,
      and cross 80% at that cap exactly once.
  - **Reserve before dispatch, atomically, then reconcile.** A plain check before dispatch followed by
    a charge on completion lets concurrent requests near the ceiling all pass and overshoot it.
    - Before dispatch, reserve the call's worst-case cost at that model's prices: an upper bound on
      input tokens, plus `maxTokens`. Do not use the fairness quota's `estimateTokens`
      (`ceil(chars / 4)`, `tenant-quota.ts`), which undercounts multilingual and punctuation-heavy
      text and leaves out chat framing.
      - Bound the input by its UTF-8 byte length. For a byte-level BPE tokenizer, the token count
        can never exceed the byte count.
      - Add a per-message framing allowance, and each image's maximum token charge.
      - An exact tokenizer for the model family may replace the byte bound only if a test proves it
        never undercounts.
    - **Bound the final wire payload, not the gateway's view of it.** For a `responseFormat: 'json'`
      request whose messages don't mention JSON, the provider adapter injects
      `JSON_MODE_SYSTEM_INSTRUCTION` downstream of the gateway (`openai-compatible.ts:63-69`,
      `:369-372`). A bound computed from the original messages misses that text and its framing.
      - Each provider adapter therefore exposes the payload it will actually send, with every
        injected instruction, transformation and framing included, for example through a
        `buildWireRequest()` it also uses itself.
      - The reservation is computed from that payload.
      - A test covers JSON-mode injection on byte-dense input.
    - **The reservation carries the payload it bounded, so nothing else can be sent.** A bound tied
      to the sent payload only by convention breaks the first time an adapter adds tool
      definitions or a preamble inside `complete()` after `buildWireRequest()` has run, or a new
      adapter builds its own payload. Every call would under-reserve, and N concurrent calls near
      the ceiling would all be admitted and settle above their reservations. So:
      - The reserve takes the wire request, computes the bound from it, and returns it frozen
        inside the `ActiveReservation`. The dispatch method sends only `reservation.wireRequest`.
      - `maxTokens` is required on the reserve input. It is optional today in `LLMRequest`,
        `RoutingDecision` and `TaskRouteConfig` (`ai/gateway/gateway.ts:75`,
        `ai/gateway/router.ts:55`, `ai/gateway/routing-config.ts:16`), and only the default tier
        table fills it in. When a request leaves it out, the reserve resolves it from the model's
        maximum output and puts that value in the wire request.
      - Test: an adapter that changes the payload after building it fails.
    - **`max_tokens` bounds billed output only where the provider says so.** The adapter serves any
      OpenAI-compatible endpoint, and sends `max_tokens` (`openai-compatible.ts:402`). DeepSeek's
      reasoning-model docs say `max_tokens` caps only the final answer, and that the chain of
      thought before it, billed as output, can run to 32K more tokens. A capped tenant whose tier
      points at such a model would pass the reserve with a worst case built from `maxTokens`, and
      settle up to 32K output tokens above it. So each pricing entry declares the most output a
      request can bill. That equals `max_tokens` only where the provider documents it as a hard
      bound on all billed output. Otherwise the entry declares `maxBilledOutputTokens`, and a model
      without one counts as unpriced for a capped tenant.
    - **A settle above its reservation is caught.** Settle compares the actual input and output
      tokens with the reserved bound. When the actual cost exceeds `reserved_micro_cents`, settle
      still charges the actual cost, since the provider billed it. It records a breach, which
      alerts and refuses later capped reserves on that model. Under test, an overshoot throws.
      - **The breach is a durable row, not a process-memory mark.** Settle runs under the spend
        lock, which limits what its transaction may write, so a mark in memory or a write after
        the commit is the obvious build. A replica that marks the model in memory and alerts
        inline, then exits on a deploy, loses both. Other replicas, and that one after its
        restart, keep admitting capped reserves at the too-low bound, each settling above its
        reservation. So:
        - An `ai_spend_bound_breaches` row, keyed by model and pricing-source version, records
          the bound that was exceeded. It holds no tenant data and has no `tenant_id`, so the
          table sits on U7's pinned global list, with that reason (see U7's "The global list is
          pinned and constrained").
        - Settle writes it, with an audit event, in its own transaction under the spend lock.
        - The capped reserve reads it in a statement that runs after the spend lock is granted,
          as it reads the ceiling. A breach refuses the reserve while the current pricing
          entry's declared bound is no higher than the bound it recorded. Only a pricing version
          that raises the bound clears it.
        - The alert goes through an outbox on the breach row, with `alert_due_seq` and
          `alert_sent_seq`, sent and stamped like the 80% alert below.
      - Unit test: a mocked reasoning endpoint that returns usage above `max_tokens` triggers the
        alert, and the next capped reservation on that model is refused.
      - Integration test, with two gateway instances on real Postgres: the process is killed
        right after an overshooting settle commits. After the restart the alert is sent once,
        and a capped reserve on that model from the other instance is refused.
    - **Give each physical attempt its own durable reservation, in Postgres.** An aggregate
      `reserved` counter can't say which of two concurrent attempts expired, whether that attempt
      was already reconciled, or whether a retried completion has already been counted. So:
      - An `ai_spend_reservations` row is keyed by a unique `attempt_id`. It holds:
        - `tenant_id`, the month, `state` and `lease_expires_at`
        - **two amounts, because settle needs both.** A settle takes the worst case off the
          month's `reserved` and adds the actual cost to `spent`. One amount column can't hold both
          values, and an `UPDATE`'s `RETURNING` gives only the new ones. A settle that overwrote
          the amount would take only the actual cost off `reserved`, stranding the rest there on
          every call, so a capped tenant would be refused well under its cap. So:
          - `reserved_micro_cents` is the worst case. It is set once, when the row gets its
            snapshot (at the reserve, when the ceiling write prices an in-flight attempt, or when
            repricing prices a `settled_unpriced` row), and never changed after that.
          - `charged_micro_cents` is what `spent` holds for the row. Settle, expiry, an ambiguous
            failure and repricing set it.
          - So each month's `spent` is the sum of its rows' `charged_micro_cents`, and its
            `reserved` is the sum of `reserved_micro_cents` over its rows still `reserved`.
        - the `ai_run_id`, once known
        - **this physical attempt's own pricing inputs:** the `model`, the worst-case input-token
          bound and `maxTokens` it reserved against, and its actual `token_usage` when the provider
          returned one
        - **a snapshot of the rates it reserved at:** the concrete input, output and per-image rates
          in micro-cents, and the pricing source's version. `AI_MODEL_PRICING_JSON` or a built-in
          price can change between reserve and settle, and settling at newer rates could charge
          more than was reserved and push a capped tenant over its ceiling. So settle, the
          worst-case charge and any later reconciliation or repricing of an attempt all use that
          snapshot. Only an attempt reserved while unpriced takes the first verified price, when
          repricing prices its `settled_unpriced` row or a ceiling write prices it in flight, and
          that price is then written into its snapshot.
          - **A routed endpoint's rate is bounded in the request, or it is unpriced.** OpenRouter
            is the documented fallback, or the primary in Profile B
            (`ai/gateway/factory.ts:36-57`). Its provider routing load-balances one model id
            across upstream providers at different per-token prices. A failover hop to
            `meta-llama/llama-3.1-8b-instruct` routed to a pricier provider is billed above the
            snapshot rate while its tokens stay inside the bound, so the ledger records less than
            OpenRouter charged, and N such calls near the ceiling pass the cap with no alert. So:
            - Pricing entries are keyed by endpoint as well as model.
            - For an OpenRouter endpoint, the wire request the reserve freezes carries
              `provider.max_price` set to the snapshot rates, so OpenRouter refuses any route
              that would bill above the reservation. That refusal is a definitive no-dispatch
              failure, and the reservation is released.
            - Where the endpoint reports what it charged per request, settle charges the larger
              of that figure and the snapshot-rate cost, and alerts when they differ.
            - A pricing entry for a routed endpoint that can't bound its rate counts as unpriced
              for a capped tenant.
            - Test: a mocked OpenRouter that bills a higher upstream rate is either refused by
              `max_price`, or settled at its reported cost.
        The logical `ai_runs` row keeps only the final attempt's usage. A timed-out first attempt
        followed by a successful retry would otherwise leave nothing to price the first attempt
        from.
        The states, and the only transitions allowed out of `reserved`:
        - `settled`: the actual cost from the usage object is charged. A success with no usage
          object doesn't settle at zero (see "A success with no usage block" below).
        - `released`: a definitive no-dispatch failure, so nothing is charged.
        - `charged_unreconciled`: a priced attempt's ambiguous failure or expired lease, charged at
          the worst-case amount. If the provider's usage later becomes known, one guarded transition
          `charged_unreconciled → settled` sets `charged_micro_cents` to the actual cost, and
          adjusts `spent` by the actual cost minus the charge it read under the lock.
        - `settled_unpriced`: an uncapped tenant's call to a model with no verified price, including
          one whose outcome is ambiguous or whose lease expired. There is no amount to charge yet;
          see "Unpriced usage" above.
        A check constraint holds exactly these states, plus Vapi's two when owner decision 2
        charges Vapi (see "The charge doesn't come from the end-of-call report"). Only
        `reserved`, `settled_unpriced` and `released`, and those Vapi states, may lack a price
        snapshot (see "A reservation with no price snapshot never charges zero").
      - Its RLS matches every tenant table.
      - A per-tenant monthly `ai_spend_ledger` row holds `spent` and `reserved`. Its key is
        `(tenant_id, month)`. Both columns are `BIGINT NOT NULL DEFAULT 0`, with a check that
        neither goes negative, so a null amount, or an adjustment that would go below zero, fails
        loudly instead of corrupting the row.
      - **The month's ledger row exists before anything reads or updates it.** A tenant's first
        attempt, and its first attempt after a UTC month rollover, find no row for that month. A
        plain `UPDATE` would match nothing, and the reserve couldn't tell "over the cap" from "no
        row yet". It would either refuse work that has headroom or dispatch with no reservation.
        So every reserve, on either path below, and every transaction that changes a ledger row
        runs this under the spend lock, before its first statement on a ledger row:
        `INSERT INTO ai_spend_ledger (tenant_id, month, spent, reserved) VALUES ($t, $m, 0, 0)
        ON CONFLICT (tenant_id, month) DO NOTHING`
        - `$m` is the month this transaction read from `spend_month` after the lock, or the month
          stored on the reservation it transitions. It is never recomputed.
        - Every insert of a ledger row holds the spend lock, so this one never waits on another
          transaction's insert. Under `READ COMMITTED` the next statement takes a new snapshot,
          so it sees the row whether this transaction created it or an earlier one did.
        - That covers the reserve, settle, release, expiry, reconciliation, repricing, the Vapi
          settle and every ceiling write, including its checks, its pricing of in-flight attempts
          and its 80% stamps.
        - After it, a ledger update that matches no row is a bug: it raises, and the transaction
          rolls back. The one exception is the priced reserve's conditional update, where no row
          means the cap refused the attempt. A refused reserve may leave the zeroed row behind,
          which changes no total.
      - **Reserve** is one transaction. It takes the spend lock, then reads the ceiling and
        `spend_month` under it (see "A ceiling change and a reservation take the same lock" above).
        A missing `tenant_settings` row counts as a null ceiling. It creates the month's ledger row
        as above. When a row for the attempt's `attempt_id` already exists, such as one a release
        inserted after the caller gave up (see "A reserve the caller gave up on is released"
        above), the reserve stops there: it changes no ledger amount, inserts nothing and returns
        the typed refusal. Otherwise it takes exactly one of two paths:
        - **A priced attempt** runs the conditional update on that month's row, against that
          ceiling:
          `UPDATE ai_spend_ledger SET reserved = reserved + $cost WHERE tenant_id = $t AND month =
          $m AND ($cap::bigint IS NULL OR spent + reserved + $cost <= $cap) RETURNING …`
          - `$cost` is the attempt's worst case, and is never null on this path. `$cap` is the
            ceiling in micro-cents, or null for no comparison. The cast lets Postgres type a null
            parameter.
          - When it returns a row, the reservation row is inserted with that month, its snapshot
            and its `reserved_micro_cents`. When it returns none, the cap refused the attempt,
            nothing is inserted, and the caller gets the typed refusal.
        - **An unpriced attempt never touches the ledger's numbers.** It has no amount to add, and
          `reserved + NULL` would make `reserved` null, or fail the `NOT NULL`. So it inserts only
          its reservation row, in `reserved`, with no snapshot and no amount, in one statement
          guarded on the ceiling being null:
          `INSERT INTO ai_spend_reservations (…) SELECT … WHERE NOT EXISTS (SELECT 1 FROM
          tenant_settings WHERE tenant_id = $t AND <ceiling> IS NOT NULL)`
          - The guard admits the attempt when the settings row is missing or its ceiling is null,
            and refuses it otherwise. No row inserted means the typed refusal.
          - The ledger's `spent` and `reserved` stay as they were until repricing, or the ceiling
            write that prices an in-flight attempt, supplies an amount.
        Caps start only in a month with no untagged runs (see above), so `spent` is the month's
        full spend.
      - **Every later step is a guarded transition on that one row**, in the same transaction as
        the ledger adjustment, after the spend lock.
        - Under the lock, the step reads the row (its state, snapshot, `reserved_micro_cents` and
          month) and computes `$charge` from the row's own snapshot. Every write to a reservation
          holds the tenant's spend lock, so the row can't change between that read and the update.
        - Then it runs `UPDATE ai_spend_reservations SET state = $next, charged_micro_cents =
          $charge WHERE tenant_id = $t AND attempt_id = $1 AND state = 'reserved' AND
          reserved_micro_cents IS NOT NULL RETURNING reserved_micro_cents, charged_micro_cents,
          month`.
        - The ledger row for the returned month then moves by exactly the returned amounts:
          `reserved` down by `reserved_micro_cents`, and `spent` up by `charged_micro_cents`, or
          not at all when it is null.
        - That covers settle (`$charge` is the actual cost from `computeCostMicroCents` at the
          snapshot rates, even when it exceeds the reservation; see "A settle above its
          reservation is caught"), release (`$charge` is null) and expiry or an ambiguous failure
          (`$charge` is the row's `reserved_micro_cents`, the worst case).
        - An attempt reserved at 23:59:50 on Oct 31 that settles just after midnight adjusts
          October's row. November's `reserved` never goes negative, and its headroom isn't inflated.
        - **A row with no amount takes its own transitions, and they never touch the ledger.**
          Under the spend lock, the step reads the row and runs the transition for its kind. The
          unpriced transition is guarded on `reserved_micro_cents IS NULL`. A settle, an expiry or
          an ambiguous failure moves it to `settled_unpriced`, keeping any usage the provider
          returned. A definitive no-dispatch failure moves it to `released`. Nothing was added to
          the ledger for it, so nothing is taken off.
        - **Repricing is what gives it its amounts.** One guarded update sets its snapshot, its
          `reserved_micro_cents` (the worst case from its stored bound), its `charged_micro_cents`
          and its next state, `WHERE tenant_id = $t AND attempt_id = $1 AND state =
          'settled_unpriced' AND reserved_micro_cents IS NULL`. The same transaction adds the
          returned `charged_micro_cents` to `spent` on the ledger row for the reservation's month.
          The ceiling write prices an in-flight attempt the same way, guarded on `state =
          'reserved'` instead, and sets only the snapshot and `reserved_micro_cents`. The row stays
          `reserved`, and its worst case is added to the month's `reserved`.
      - A transition that matches no row is a no-op. A retried completion, a reaper that races a
        late completion, and a double release therefore each count once.
      - The lease reaper expires each attempt by its own id and amount, and moves an attempt with no
        price snapshot to `settled_unpriced`. It never strands capacity, double-charges, charges
        zero, or releases a reservation that may have been billed. It is a leader-gated sweep that
        runs at boot and every minute, so a crashed process's reservations are charged after a
        restart too.
      - **U8's sweeps start with no tenant, so those that read tenant tables use U4's pattern.**
        The lease reaper, the repricing sweep, the 80% alert sweep and, when owner decision 2
        charges Vapi, the Vapi settle sweep each read forced-RLS tenant tables. The breach alert
        reads only the global `ai_spend_bound_breaches`. A scan on
        the runtime role with no tenant context sees no rows, so expired reservations would stay
        `reserved` for good, with no alert: a priced one holding its worst case in the month's
        `reserved`, an unpriced one keeping the cap-enable check refusing. So:
        - Each sweep selects the due rows' `(tenant_id, attempt_id)` across tenants, the way U4's
          purge selects tenants (PRIV-1).
        - It then runs one transaction per tenant that sets that tenant's context, takes its spend
          lock and runs the guarded transitions.
        - `tenant_id` is in every transition's `WHERE` and `RETURNING`, and in every ledger
          `WHERE`.
        - Test the sweep entry point, not the per-tenant function, under `RLS_RUNTIME_ROLE=true`,
          with expired reservations in two tenants. Both are reaped, and each ledger row moves
          only by its own amounts.
      - Postgres, not Redis, holds this, because a money ledger must be durable and auditable.
        Each transition writes an audit event in the same transaction as the transition, so a
        transition that matches no row writes none.
    - **Only a failure that definitively never reached the provider releases the reservation.**
      Examples: preflight rejection, quota rejection, a connection refused before send, a 4xx
      validation error. An ambiguous failure — a timeout or connection reset after send, a 5xx after
      streaming started — has no usage object, so charge the full worst-case reservation and move it
      to `charged_unreconciled`. Otherwise outage retries would be free in the ledger and could exceed the cap.
      An attempt with no price snapshot has no worst case yet, so it moves to `settled_unpriced`
      instead, and repricing charges it.
      This is the same definitive-no-call rule as the onboarding plan's demo-call budget (D11).
    - **A success with no usage block is charged like an ambiguous outcome, never at zero.**
      `ai/providers/openai-compatible.ts:430-440` turns a missing `usage` into zero tokens. That
      adapter targets any OpenAI-compatible endpoint, and some omit `usage`. A settle at
      `computeCostMicroCents(…, 0)` would release the worst case while the provider billed the
      tokens, and a capped tenant's real spend could pass the cap while the ledger showed headroom.
      So:
      - The adapter returns usage as `undefined` when the provider omits it, not zeros.
      - Settle treats such a success like an ambiguous outcome: `charged_unreconciled` at the
        worst case, or `settled_unpriced` for a row with no snapshot. Usage that arrives later
        settles it through the guarded `charged_unreconciled → settled`.
      - Unit test: a success with no usage object leaves the worst-case charge in `spent`.
    - **Reserve every physical dispatch, not every logical call.** `ProviderRetryDeadlineWrapper`
      can send another attempt to the same provider after a timeout
      (`compose-resilience.ts:167-182`). The first attempt may already have been billed, and if the
      retry succeeds, only the retry's usage comes back.
      - The reservation, and the ambiguous-failure charge, wrap each attempt inside the retry loop.
      - A failover hop reserves again at the fallback model's price.
    - **The compiler ties every model dispatch to a reservation.** Unit tests of today's retry and
      failover paths, and a tripwire that sees only untagged `ai_runs` rows, can't catch spend
      that writes no `ai_runs` row or rides a run that already has a reservation. Two paths do
      that today:
      - `createEmbedding` (`ai/providers/openai-compatible.ts:352`) is called directly by
        `workers/transcript-ingestion-worker.ts:356` and `workers/proposal-correction-worker.ts:191`,
        with no reservation.
      - `ShadowComparisonGateway.complete` (`ai/evaluation/shadow-comparison.ts:117-133`) sends a
        second request per sampled call inside the provider that the retry loop wraps
        (`ai/gateway/factory.ts:184`). One reservation, priced at the primary model, covers two
        dispatches.
      So:
      - Every provider dispatch method (`complete`, `createEmbedding` and any new one) takes an
        `ActiveReservation`, which only the spend module's reserve returns, and settles through
        it. The shadow wrapper reserves its own dispatch at the shadow model's price, and skips the
        shadow call when the cap refuses it, never failing the primary call.
      - **`ActiveReservation` can't be forged.** TypeScript types are structural, so a worker could
        pass `{ attemptId: randomUUID(), settle: async () => {} } as ActiveReservation`, or reuse a
        test fake. It would compile, sit inside a method that takes the type, and dispatch with no
        ledger row. So `ActiveReservation` is a class with an ECMAScript `#private` field,
        constructed only inside the spend module. The structural test fails on any
        `as ActiveReservation`, any object literal typed as one, and any `new` of it outside that
        module, test helpers included. Tests get a real reservation from an in-test spend module.
      - **`ActiveReservation` is single-use and checked at runtime, and no SDK retries under
        it.** A real reservation can't be forged but could be reused, and one call can bill
        twice:
        - `workers/transcript-ingestion-worker.ts` could reserve once and pass the same
          reservation to `createEmbedding` for each of 40 chunks. Every call type-checks. The
          first settle moves the row to `settled`, the other 39 match no row, and 39 billed
          dispatches never reach `spent`.
        - A new adapter that calls `new OpenAI({ apiKey, baseURL })` without `maxRetries: 0`
          gets the SDK's default of 2 (the repo's own warning, `openai-compatible.ts:121-123`).
          The voice-quality harness builds one with `maxRetries: config.maxRetries`, defaulting to
          `LAYER_TWO_MAX_RETRIES = 2` (`ai/gateway/real-layer-two-factory.ts:192`, `:471-476`). A
          timeout after send is then retried inside one `complete()`: billed twice, reserved
          once, and settled from the last usage only.
        - An `any`-typed value passed where an `ActiveReservation` parameter is expected needs no
          `as`, and the `#private` brand is never checked at runtime.
        So:
        - A dispatch reaches the provider only through `reservation.take()`. `take()` checks the
          brand (`#field in r`), flips an internal consumed flag, and throws on a second call.
          Settle refuses a reservation that was never taken.
        - **`take()` returns a one-shot sender, not a payload.** A payload can be sent many times.
          An adapter could write `const req = reservation.take(); return runWithRetry(() =>
          this.client.embeddings.create(req, { signal }))`, reusing the gateway's helper
          (`ai/gateway/retry.ts:314`), or wrap a `fetch` to Whisper in a loop that retries on a
          5xx. `take()` runs once, the SDK has `maxRetries: 0` and the signal is passed, so every
          check passes, while each retry the provider accepted is billed and only the last one
          settles. So `take()` returns `send(transport)`, which makes the single network call
          with the frozen request and throws on a second invocation.
        - The scan also fails on a reserved call site, or a `send(...)` call, that sits lexically
          inside a loop, inside a recursive function, or inside a function passed to any callee
          other than `send` itself, `runWithRetry` included.
        - The structural test fails on any model-provider SDK client built without a literal
          `maxRetries: 0`, or the equivalent option on another SDK, unless its entry is
          `spend_exempt`. It also fails on an `any`-typed argument at an `ActiveReservation`
          parameter.
        - Tests: one reservation reused for a second dispatch throws. A fixture adapter with SDK
          retries left on fails the scan. A fixture adapter that wraps its call in
          `runWithRetry` after `take()` fails the scan, and a second `send` throws.
      - U7's call-site scan gains one rule: every model-provider call site sits inside such a
        method, or is registered `spend_exempt` with a reason.
      - **Every `externalSinks` entry declares its spend, so "model-provider call site" is
        mechanical.** A `fetch`-typed call site carries no type that marks it as a model provider.
        `voice/voice-service.ts:329` and `ai/tts/tts-provider.ts:144` are plain `fetch` calls to
        OpenAI's transcription and speech endpoints on the platform key. Whisper
        (`voice/transcription-providers.ts:254`), Deepgram live STT (the `ws` stream at `:580-582`)
        and ElevenLabs TTS (`ai/tts/elevenlabs-stream.ts:119-121`) never pass through `complete` or
        `createEmbedding`. A capped tenant at its ceiling would have its LLM calls refused while it
        kept transcribing voicemails and synthesizing speech, none of it in `spent`. So:
        - `spend` is a required field on every `externalSinks` entry: `reserved` (the call site sits
          inside a dispatch method that takes an `ActiveReservation`) or `spend_exempt` with a
          reason.
        - Each entry names its provider, and a checked-in table says which providers bill per use.
          The test requires `reserved`, or a `spend_exempt` with a reason, on every entry whose
          provider does.
        - U7's transport rule (see U7's "a transport value") makes the Deepgram and ElevenLabs
          WebSockets call sites, so they need entries too.
        - **Vapi spends with no call site to reserve.** When `VAPI_API_KEY` is set, tenant calls
          route to Vapi by number (see U7's "Vapi takes whole calls by routing"), and each Vapi
          minute, with its LLM, speech-to-text and text-to-speech, is billed on the platform key
          with no reservation. A capped tenant at its ceiling would keep spending. So the Vapi
          entry either charges each call's cost to the ledger after the fact, under the spend
          lock, keyed by the Vapi call id so the call counts once, or is `spend_exempt` with
          that reason. Owner decision 2 picks one. Either way the settings page says that a Vapi
          call isn't stopped at the cap.
          - **The charge doesn't come from the end-of-call report.** A report can fail to arrive,
            and its call object can be a stale snapshot whose `cost` reads 0. Settled from the
            webhook, a dropped report would record nothing, and a report with cost 0 would use
            up the call id's one count before a correct figure arrived. So, when owner decision
            2 picks charging:
            - The webhook records each Vapi call id from its first event as an open spend row,
              in a state of its own, `vapi_pending`, under the spend lock. It has no snapshot
              and no amount, the reserve path never admits against it, and the cap-enable check
              doesn't count it, since the settings page already says a Vapi call isn't stopped
              at the cap.
            - A leader-gated sweep, per tenant like U8's other sweeps, fetches `GET /call/{id}`
              once the call has ended, and moves the row with one guarded transition
              `vapi_pending → vapi_settled`, setting `charged_micro_cents` to the reported cost
              and adding it to `spent`. It never settles at 0 unless Vapi reports that the call
              never connected.
            - A row is retried until its cost is final, under a deadline after which it alerts.
            - Calls whose ids were never recorded are found by listing Vapi calls per tenant
              `phoneNumberId`.
            - The check constraint gains both states: `vapi_pending` with no amount, and
              `vapi_settled` with a `charged_micro_cents` and no rate snapshot.
            - Test: a dropped report and a report with cost 0 each still end with the call's
              real cost in `spent`, once.
        - **The cap's own fallback spends too.** A refused renewal degrades the call to Gather.
          Twilio bills `<Gather input="speech">` speech recognition per use, and premium `<Say>`
          voices too, through TwiML returned in a webhook response, so no outbound call site
          carries that spend. `telephony/twilio-adapter.ts:739` and `routes/telephony.ts:1423`
          emit `<Gather input="speech">`, and the voice path speaks with Polly voices. A capped
          tenant at its ceiling would have every live call degrade to Gather and keep billing
          speech recognition and speech, with no reservation, no `spend_exempt` decision and
          nothing in `spent`. So:
          - A manifest and `externalSinks` entry covers Twilio speech recognition and premium
            `<Say>` voices, marked as spend that enters by TwiML, like Vapi's routing entry, with
            `spend` declared.
          - Either the TwiML builder reserves before it emits each `<Gather input="speech">`,
            bounded by its maximum speech duration, and each premium `<Say>`, by character
            count, and on refusal emits a non-speech fallback (a DTMF Gather or the hold line),
            or the entry is `spend_exempt` and the settings page says Gather speech is outside
            the cap. Owner decision 2 picks one.
          - A scan rule fails on any TwiML string that emits `<Gather input="speech…">`, or a
            `<Say voice="Polly.…">` or `<Say voice="Google.…">`, outside a builder that carries
            that entry.
      - **Each price declares its billing unit.** The worst case above is defined in tokens, but
        OpenAI prices Whisper per minute of audio (the repo's own constant,
        `ai/voice-quality/audio/whisper-real-provider.ts:44`), Deepgram prices streamed audio by
        the minute, and ElevenLabs and OpenAI speech bill per character. A reserve that can't
        compute their worst case would treat them as unpriced and refuse every capped tenant's
        live-call STT. So each pricing entry declares its unit (tokens, audio seconds or
        characters), and the reserve computes the worst case in that unit from the wire request:
        - Whisper from the audio's duration, capped by the provider's file limit
        - ElevenLabs and OpenAI speech from the text's character count
        - a Deepgram stream as renewable chunks of audio time. A refused renewal ends the stream,
          and the call degrades to Gather.
      - **A rate that depends on request flags is keyed on them.** Owner decision 1 may set
        `mip_opt_out=true` on every Deepgram request, and Deepgram charges more to customers who
        opt out of its Model Improvement Partnership Program. A single per-minute entry per model
        would keep reserving and settling at the old rate after the flag is added. So the
        Deepgram pricing entry is keyed on the request parameters that change its rate,
        `mip_opt_out` and any add-on Deepgram bills separately, read from the frozen wire
        request. A unit test fails when a request sets a rate-changing flag that its pricing entry
        doesn't declare.
      - **A streamed chunk is metered at the transport, and stops at its reserved end.**
        `startStream` returns a session whose `send(chunk)` calls `ws.send(chunk)` for the whole
        call (`voice/transcription-providers.ts:745`). Giving `startStream` an `ActiveReservation`
        parameter would pass the scan while nothing tied the frames to a live chunk, so every
        capped call near the ceiling could stream to its `TimeLimit` on its first chunk's
        reservation. And a renewal requested at the chunk boundary waits on the tenant's spend
        lock while audio keeps flowing. Seconds past the reserved end are then billed with no
        reservation, and even a granted renewal leaves the chunk settling above its
        `reserved_micro_cents`. That trips "A settle above its reservation is caught" and
        refuses every capped tenant's live speech-to-text, though the model's bound was right.
        So:
        - For a `spend: reserved` streaming entry, the reserve returns a metered reservation
          whose `send(bytes)` is the only route to the transport. It counts audio time against
          the current chunk.
        - It requests each renewal early, once a fixed fraction of the chunk is used. The renewal
          is a new attempt row under the spend lock, off the per-frame path. Its reserve sets
          `lock_timeout` to the time left before the reserved end, so a long wait for the lock
          ends the stream rather than overrunning the chunk.
        - It never forwards audio past the reserved end. If the renewal hasn't committed by then,
          or is refused, it closes the socket and the call degrades to Gather.
        - Each chunk settles at the seconds actually streamed inside it.
        - The same rules apply to a character-reserved TTS stream.
        - The scan fails on a raw transport `send` under a reserved streaming entry that doesn't
          go through the meter.
        - Tests: a three-chunk fixture stream reserves three times. A refused renewal closes the
          socket, and the call degrades to Gather. With the spend lock held across a chunk
          boundary, no audio past the reserved end is sent, and no overshoot alert fires.
      - The recommended default, pending owner decision 2, is that this spend is capped like
        model tokens. If the owner keeps any of it outside the cap, each such entry is
        `spend_exempt` with that reason, and the settings page says the cap covers model tokens
        only.
      - The one-ceiling-writer structural test also fails on SQL that names
        `ai_spend_reservations`, `ai_spend_ledger` or `ai_spend_bound_breaches` outside the spend
        module.
      - Test: with the shadow wrapper on, a capped tenant's sampled call reserves twice, and an
        embedding call reserves once. A capped tenant's voicemail transcription reserves by
        duration. A fixture `new WebSocket('wss://api.deepgram.com/...')` with no reservation and no
        `spend_exempt` fails the scan.
    - A reservation carries a lease expiry. A crashed process can't say whether its call went out, so
      an expired lease is charged at worst case and marked `charged_unreconciled`; it is not released.
      An unpriced one goes to `settled_unpriced`, as above.
    - **Fail closed on unpriced models.** A worst-case reservation can't be computed without a price.
      U3 deliberately leaves unverified models unpriced (null, with a boot warning), and the default
      `gpt-4o-mini` is not in the built-in table.
      - For a tenant with a cap set, a request whose selected or fallback model has no verified price
        is rejected with a typed error. The ceiling read under the spend lock decides that, never a
        check made before the lock (see "The month and the unpriced decision are read under the
        lock too").
      - The settings write that enables a cap is refused until every configured tier and fallback
        model has a price, from the defaults or `AI_MODEL_PRICING_JSON`. The fail-closed path then
        only fires on later misconfiguration.
      - **That check covers every reserved surface, not only the tier and fallback models.**
        Embeddings, the shadow model, Whisper, OpenAI speech, ElevenLabs and Deepgram are each
        priced from an entry in its own billing unit, and none is a tier or fallback model. An
        owner who enabled a cap while Deepgram's per-second price was missing would have every
        call degrade to Gather, and its voicemail transcriptions and embedding ingests refused.
        So the enable check, and the boot warning, cover every surface whose `externalSinks`
        entry is `spend: reserved` and whose provider is configured, priced in its declared unit,
        plus the shadow model while sampling is on. The refusal names each unpriced surface.
        Test: enabling a cap with Deepgram unpriced is refused, and the refusal names Deepgram.
  - Reject with a typed error that the voice path turns into its existing hold-line / Gather behaviour.
    That fallback's own spend is covered in "The cap's own fallback spends too" above.
  - **Alert at 80% through `alertOperator`, from an outbox.** A reservation can't send the alert
    inside its transaction, and a call after the commit is lost if the process exits first. The
    outbox uses integer generations, as U7's does, not a timestamp. A due timestamp from the
    database clock has microseconds, while node-pg parses it into a JS `Date` with milliseconds
    (`packages/api/src` registers no `setTypeParser`). A guard that passes that value back would
    match almost no row, so every pass would send the alert again, for past months too. So:
    - The ledger row carries `alert_80_crossed` (`BOOLEAN NOT NULL DEFAULT false`), and
      `alert_80_due_seq` and `alert_80_sent_seq` (both `BIGINT NOT NULL DEFAULT 0`). So the
      zeroed row that every reserve inserts (see "The month's ledger row exists before anything
      reads or updates it" above) needs no other value.
    - The transaction that first takes the month to 80% of the ceiling sets `alert_80_crossed` and
      bumps `alert_80_due_seq`, under the spend lock, guarded on `alert_80_crossed` being false.
    - A ceiling write applies the same rule in its transaction, under the same lock. A lower cap
      that puts the month past 80% marks the alert due. A higher cap that puts it back under 80%
      clears `alert_80_crossed`, so the alert can fire again.
    - A leader-gated sweep sends every alert whose `alert_80_due_seq` is past `alert_80_sent_seq`,
      then sets `alert_80_sent_seq` to the value it read, guarded on `alert_80_due_seq` still being
      that value. A guard on the sent stamp alone isn't enough. A ceiling raise between the send
      and the stamp clears `alert_80_crossed`, a reservation then crosses 80% of the new cap and
      bumps `alert_80_due_seq`, and the stamp would mark that new alert sent without sending it.
      With the guard, the stamp matches no row, and the next pass sends the new alert.
    - A crash between the send and the stamp sends it twice, which is harmless for an operator
      alert. A crash before the send loses nothing.
- **Test scenarios:**
  - **Unit:** a call is admitted under the cap and rejected over it.
  - **Unit:** failover is charged once.
  - **Unit:** a timeout followed by a successful retry leaves the ledger with attempt 1's worst-case
    charge plus attempt 2's actual cost.
  - **Unit:** an input that tokenizes far above `chars / 4` (dense punctuation or CJK) still reserves at
    least its true cost.
  - **Concurrency (real Postgres, Docker-gated):** N requests start together just below the
    ceiling, through the spend module, on N connections released together by a barrier, under
    `RLS_RUNTIME_ROLE=true`. Admitted reservations never exceed the cap, and every rejection is
    typed. It runs once with a cap and once with a null cap, where every request is admitted and
    `reserved` is their sum. An in-memory ledger fake would pass even with a missing
    `$cap::bigint` cast or a ceiling read before the lock.
  - **Unit:** an expired lease is charged at worst case and marked `charged_unreconciled`. A usage
    object that arrives later settles it once, with the difference.
  - **Integration (unpriced, uncapped):** an uncapped tenant makes two unpriced attempts. The first
    times out after dispatch with no usage, and the retry succeeds. After a price is added,
    repricing does two things:
    - It charges the first attempt at the worst case from its own stored bound, as
      `charged_unreconciled`.
    - It settles the retry from its own usage.
    Both amounts are added to `spent` once. A second repricing changes nothing, and enabling a cap
    then counts that spend.
  - **Unit:** a definitive no-dispatch failure releases its reservation, and an ambiguous timeout keeps
    the worst-case charge.
  - **Unit:** a capped tenant's request to an unpriced model is rejected with a typed error.
  - **Unit:** enabling a cap is refused while any configured model, or any configured surface
    whose entry is `spend: reserved`, is unpriced.
  - **Integration:** the monthly window resets. The ledger's `spent` equals the sum of the month's
    `charged_micro_cents`, not the `ai_runs` costs, and its `reserved` equals the sum of
    `reserved_micro_cents` over the month's rows still `reserved`. A timed-out attempt followed by
    a successful retry is charged twice by design, while `ai_runs` keeps only the retry. Each
    `settled` row's `charged_micro_cents` equals `computeCostMicroCents` of that attempt's own
    stored usage at its snapshot rates, and its `reserved_micro_cents` still holds its worst case.
  - **Integration (settle frees the whole worst case):** a capped tenant runs many calls that each
    settle well below their worst case. Afterwards `reserved` is 0, and a request that fits under
    the cap against `spent` alone is admitted.
  - **Integration (price change):** a price changes between an attempt's reserve and its settle.
    The settle charges at the snapshot rates, and a capped tenant can't be pushed over by the
    change.
  - **Integration (per-attempt reservations, real Postgres):**
    - Two concurrent attempts reserve different amounts, and one process dies. The reaper charges
      exactly that attempt's amount, and the other attempt settles normally.
    - A completion delivered twice settles once.
    - A reaper racing a late completion produces exactly one transition.
  - **Integration (first request of a month, real Postgres):**
    - A tenant whose only ledger row is October's makes its first request on Nov 1. The reserve
      creates November's row, with `spent` 0 and `reserved` equal to the worst case. October's
      row is unchanged.
    - A first-ever tenant with no ceiling has its first request reserved, and its ledger row
      appears.
    - A first-ever tenant with a cap, in a month after the ship month, has a request under the cap
      admitted. A request whose worst case alone exceeds the cap is refused with the typed error,
      and no reservation row exists for it.
    - Two first requests of a new month start together. Afterwards one ledger row exists for that
      month, and its `reserved` is the sum of both.
    - A first-ever tenant enables a cap. The settings write reads zero spend for the month and
      succeeds.
  - **Integration (unpriced reserve, then repricing, real Postgres):** a first-ever, uncapped
    tenant makes an attempt on an unpriced model.
    - Its reservation has no snapshot and no amount. The month's ledger row exists, with `spent`
      and `reserved` both 0, not null.
    - The attempt completes with usage and moves to `settled_unpriced`. The ledger is unchanged.
    - A priced attempt in the same month then reserves and settles normally.
    - A price is added. Repricing sets the snapshot and both amounts, moves the row to `settled`,
      and adds exactly `computeCostMicroCents` of its usage to `spent`, once. A second repricing
      changes nothing.
    - An unpriced attempt that fails before dispatch ends `released`, with no amount, and the
      ledger is unchanged.
  - **Integration (mid-month cap):** in a month after the ship month, a tenant has $90 of tagged
    `ai_runs` cost. It enables a $100 cap, and a $15 worst-case call is refused.
  - **Integration (ship month):**
    - Enabling a cap during the ship month is refused, with the date it becomes available.
    - An untagged run in a later month trips the wire: the capped reservation is refused, and an
      alert fires.
  - **Integration (unpriced):**
    - A current-month `settled_unpriced` reservation blocks enabling a cap. A null `ai_runs` cost
      alone doesn't, since the check reads only reservations.
    - An unpriced attempt that fails before dispatch is `released`. Once the run is no longer
      pending, the write-back gives it cost 0, and the sweep doesn't select it again.
    - After a verified price is added, the run is repriced from its `model` and `token_usage`, and
      the cap can then be enabled against the full total.
    - A `settled_unpriced` row from an earlier month, on a model that never gets a price, doesn't
      block enabling a cap. It stays in the repricing queue.
  - **Integration (cap change versus a reservation, real Postgres, the racy order forced):** two
    connections, each held at a set point.
    - **Reservation first.** An uncapped tenant's attempt, reserved while its model was unpriced,
      takes the spend lock, reads the null ceiling, inserts its `reserved` row and is held before
      commit. A settings write that enables a cap starts. While the reservation is held, the
      settings write doesn't return. Once the reservation commits, the settings write counts it.
      With a verified price now present, it prices the attempt at its worst case from its stored
      bound. Without one, it refuses the cap. The attempt then settles within the counted amount.
    - **Settings first.** The settings write is held after its checks, before commit. A reservation
      that starts then waits, reads the new ceiling once the write commits, and is compared against
      it. One that would exceed the cap is refused with the typed error.
    - **Month boundary.** A cap written in the last second of a month and a reservation in the
      first second of the next serialize, in both orders.
    - **Midnight while waiting.** The settings write is held between `BEGIN` and the lock while the
      clock `spend_month` is given crosses midnight. An unpriced attempt reserves in the new month
      and commits. The settings write then counts that attempt: it prices it at its worst case, or
      it refuses the cap.
    - **A settle that straddles midnight.** An attempt reserved before midnight settles after it.
      The adjustment lands on its reserve month's ledger row, and the new month's `reserved` is
      unchanged.
    - **A replica with the model unpriced.** After a cap is enabled, an attempt from a replica whose
      pricing table lacks the model is refused with the typed error, and no row without a price
      snapshot is inserted.
  - **Integration (unpriced attempt reaped, real Postgres):** an uncapped tenant's call to an
    unpriced model is in flight when its process dies. The reaper moves its reservation to
    `settled_unpriced`, never to `charged_unreconciled` at zero. Enabling a cap is refused while it
    stays unpriced. After a price is added, repricing charges its worst case once, then writes the
    `ai_runs` cost in its own transaction, and enabling a cap then counts that spend. An ambiguous
    timeout on the same kind of attempt ends the same way.
  - **Integration (in-flight priced attempt):** a priced attempt is dispatched while the tenant is
    uncapped, and a cap is then enabled. Until the attempt settles, the cap's headroom excludes its
    worst case. It settles at its actual cost, and the difference is freed.
  - **Integration (repricing sweep):** the sweep is killed partway through a batch. The next run
    reprices the rest, and each row is counted once. A run whose ledger transition committed
    before the kill gets its `ai_runs` cost on the next run.
  - **Integration (80% alert):** the process exits right after the reservation that crosses 80%
    commits. After the restart the sweep sends the alert once. Lowering a cap so the month is
    already past 80% marks the alert due without any new reservation.
    - A ceiling raise lands between the sweep's send and its stamp, and a reservation then
      crosses 80% of the new cap. The new alert is still sent, once.
    - A crossing alerts exactly once across several sweep passes, including a crossing in a month
      that has since ended.
  - **Integration (lock order with U7, real Postgres):** an erase's phase 1 holds the stripes of a
    run's correlation id and customer. A repricing of that run commits its ledger transition
    without waiting, and reserves and settles for other attempts in the tenant don't wait either.
    The run's `ai_runs` cost is written once phase 1 commits. A test-only path that takes a stripe
    under the spend lock raises, and so does one that enters the spend module holding a stripe.
  - **Structural (one ceiling writer):** SQL that names the ceiling column outside its module fails
    the build, and so does SQL that names `ai_spend_reservations`, `ai_spend_ledger` or
    `ai_spend_bound_breaches` outside the spend module. A `PUT /api/settings` body that carries a
    ceiling key leaves the ceiling unchanged.

## Owner decisions and actions (not code)

1. **PRIV-5 erasure scope.** Confirm the U7 defaults, especially anonymizing financial records rather
   than deleting them, and keeping consent and DNC rows.
2. **A money cap on AI spend** (U8). Decide whether you want it, and whether to set a platform
   default.
3. **An auto-approve threshold floor** (OVAS-04, part b). The UI offers a permissive preset and an
   Advanced input down to 0.50. If you want a floor, change the UI and the schema together.
4. **AI-disclosure wording and placement** (PRIV-4). Counsel to confirm.
5. **Run the VoiceFallbackUrl backfill** for existing numbers (U5 ships the script with a dry-run
   default).
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
