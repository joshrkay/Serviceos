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
  - **Durable, resumable jobs:** the erasure job that runs phase 2, the S3 re-delete, the Langfuse
    second delete, each outbound send's write-ahead row, the owner's candidate confirmations, and
    the `erase_incomplete` alert.
  - **Limits serialized with their consumers:** the tombstone and every fenced writer, under the
    erasure lock, which covers every key the tombstone holds. The job's close and every late
    target that re-opens it, under the job row's lock. The historical `ai_runs` scan reads no
    retention setting at all, so a window changed mid-erase can't narrow it.
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
      2. A durable erasure job then runs the scrub, the external cleanup, the drain and the final
         re-scan, each step in its own short audited transaction, and records `erase_completed` or
         `erase_incomplete`.
    - **Phase 2 is a durable, resumable job, not code that runs after the request.** A process can
      exit after phase 1 commits. The tombstone would then keep fencing the subject while nothing
      finished the erase, and the customer would stay partly erased indefinitely. So:
      - **One job row per erase, written by phase 1.** Phase 1 inserts a `customer_erasure_jobs` row
        in the same transaction as the tombstone and `erase_started`, so a tombstone never exists
        without a job. The table has `tenant_id` and RLS like every tenant table. It has a unique
        index on `(tenant_id, customer_id)`, so a second erase request returns the existing job
        instead of starting another.
      - **Phase 1 also records every target the later steps need, because phase 2 destroys the
        links to them.** In the same transaction it writes one `customer_erasure_steps` row per
        store, keyed `(job_id, step)`, each with its targets:
        - the owned-entity, session, call and correlation ids it also writes into the tombstone
        - the external ids: the Stripe Customer id, the QuickBooks customer id, the Twilio Call,
          Message and Recording SIDs, the S3 keys, the calendar event ids and the Langfuse trace
          keys
        A step takes its targets from its own row, never by re-walking links. A crash after the
        scrub has severed an invoice's customer link, or blanked `stripe_customer_id`, would
        otherwise leave the resumed step with nothing to find.
      - **A late target re-opens the job under the job row's lock, so a close can't miss it.** A
        target found later is added to its step in the transaction that finds it. Examples: a SID
        linked by the status callback, a key from a late upload, a recording a fenced webhook
        registers, the owner's confirmation of a candidate. Touching the job row only "if it had
        closed" isn't enough. Under `READ COMMITTED` the worker closing the job and the handler
        adding the target each miss the other's uncommitted write. The job can then close
        `completed` while one of its steps is pending again, and a sweep that claims only
        non-terminal jobs never runs that step. So:
        - Every target add, candidate confirmation and re-open also runs one unconditional
          `UPDATE` on the job row in its transaction. It sets `generation = generation + 1` and
          `next_attempt_at` to now, and puts `state` back to `pending` when it was terminal. That
          takes the job row's lock.
        - The close is guarded on `generation = $read_generation`, the value the worker read
          before it checked the steps, and on no step being non-terminal. Either the close sees the
          new target, or the re-open sees the closed job and re-opens it. A close that matches no
          row re-reads the steps and carries on.
        - The sweep also claims any job that has a non-terminal step, whatever the job's state.
        - The close writes `erase_completed` or `erase_incomplete` once per close generation. A
          re-opened job that closes again records its new outcome.
      - **The raw identifiers outlive the `customers` scrub, encrypted, until the last step that
        needs them.** The historical `ai_runs` content scan, the identifier-linked leads and inbound
        messages, and the final re-scan all match by name, phone and email. The tombstone keeps only
        keyed hashes, and the `customers` scrub removes the originals, so a resumed scan would have
        nothing to match. So:
        - Phase 1 stores them on the job row, encrypted with `encrypt` (`integrations/crypto.ts:15`).
        - Only those steps read them.
        - The transaction that marks the last of those steps `done` deletes them. An
          `erase_incomplete` job keeps them only while one of those steps still has to run, and
          never past their maximum retention (below). The result says so.
      - **Each step is a checkpoint, and so is each target inside it.** A step moves `pending →
        running → done`, or ends `incomplete` or `provider_retained`. Each target records its own
        outcome and an idempotency key, `erase:<job id>:<step>:<target id>`, written before the
        provider call. On resume:
        - A delete whose target is already gone counts as done: a 404, or Stripe returning the
          customer as `deleted`. A Stripe Customer or Twilio Call that an earlier run deleted is
          recognised as done, not reported as a failure.
        - A provider write that isn't a delete sends that key wherever the provider accepts one, and
          writes the same value every time. The anonymized QuickBooks `DisplayName` is always the
          same `Erased customer <short id>`.
        - A local scrub commits its writes and its checkpoint in one transaction. A batched scan,
          such as the historical `ai_runs` scan, checkpoints its cursor with each batch. Candidate
          rows are unique on `(job_id, store, row id)`, so a re-run never lists one twice.
        - Provider calls run between transactions, never inside one (`workers/tenant-query.ts:11-12`).
      - **One worker per job, by lease.** A worker claims a job with one guarded update. It sets
        `lease_owner`, `lease_expires_at` and a new `lease_epoch`, and matches only a job that has
        no live lease and either isn't terminal or has a non-terminal step.
        - Every checkpoint write is guarded on that `lease_epoch`, including the one each target
          makes before its provider call. A worker whose lease lapsed, for example after a long
          pause, matches no row on its next write and stops before its next provider call.
        - A call that a stale worker already had in flight repeats harmlessly, by the rules above.
        - The lease outlasts the longest single provider call, and the worker renews it between
          targets.
      - **A wait is a checkpoint, not a sleep.** A step that has to wait records when to look again
        (`next_attempt_at`), releases its lease and returns. Examples: a call still in progress, an
        upload URL not yet expired, a drain window, an ambiguous send not yet linked. No worker holds
        a lease, a connection or a lock across a wait.
      - **Every wait has a deadline, so no job waits forever.** A wait with no bound can keep a job
        running, with no alert, while the job row holds the raw identifiers. An SMS whose client
        timed out before Twilio accepted it never gets a status callback, so "not yet linked" would
        otherwise repeat every few minutes indefinitely. So:
        - Each wait records a `wait_deadline` when it first starts, taken from the bound of what it
          waits on: the Twilio status-callback window, the call `timeLimit` maximum, the upload
          URL's expiry plus clock skew, or the writer's declared drain window. A re-check never
          moves it.
        - Past its deadline, a wait takes its fallback or counts as a failure. An ambiguous send
          still not linked falls back to the strict content match below, and zero matches after the
          callback window is recorded as reconciled-absent. A call still in progress past the
          `timeLimit` maximum counts as a failure.
      - **A sweep resumes every started-but-unfinished erase** (the async worker pattern, P0-009):
        - Phase 1 enqueues an `erasure_job` message with `sendOn` inside its own transaction
          (`queues/pg-queue.ts:108`), so the work starts at once. The message only wakes a worker.
          The job row is the record, and the queue's retry limit and dead-letter queue never end an
          erase.
        - A leader-gated sweep (`runAsLeader` with a new `SWEEP_LOCK` key, `app.ts:2588`, `:2674`)
          runs once at boot and then every minute. It claims every job that has no live lease, whose
          `next_attempt_at` has passed, and that either isn't terminal or has a non-terminal step.
        - Like U4's purge, it selects due jobs across tenants, then runs each step under that
          tenant's context.
      - **Retries are bounded, and the end state is explicit.**
        - **A crash counts as an attempt.** A failure counted only after a caught error never counts
          a step that kills the process, such as an out-of-memory on a large `ai_runs` batch or a
          `SIGKILL` during a deploy. The sweep would re-claim it after every lease expiry, forever.
          So the start checkpoint increments the step's `attempts` before the work runs. A run that
          ends in a wait checkpoint gives that attempt back in the same write. A caught error and a
          crash each count, and a wait doesn't.
        - A step that fails retries with capped exponential backoff.
        - After a fixed number of failures, the step ends `incomplete` with its last error.
        - Once every step is `done`, `provider_retained` or `incomplete`, one guarded transition
          closes the job (guarded on its generation, above). It ends `completed` with
          `erase_completed` when no step is `incomplete`, and `erase_incomplete` with that audit
          event otherwise.
        - The audit event is written in that transition's transaction, so a resumed job never writes
          it twice for the same close generation.
        - The transition to `erase_incomplete` also marks an operator alert due on the job row, for
          that close generation. The sweep sends it through `alertOperator` and then stamps it sent,
          so a crash right after the commit still alerts, and a job that re-opens and closes
          incomplete again alerts again.
        - **A job-age alarm.** The sweep marks the same kind of alert due, through the same outbox,
          for any job still not terminal a fixed number of hours after phase 1. That number is
          longer than the longest wait deadline plus the retry budget, so it fires only on a job
          that the rules above failed to end.
        - The owner sees which stores are incomplete, and why.
        - **An `erase_incomplete` job is retried automatically.** The sweep re-opens its incomplete
          steps on a fixed schedule, for example daily, by the same re-open as a late target.
          Sending `POST /api/customers/:id/erase` again is the owner's immediate retry. Either one
          resets the incomplete steps' failure counts, and steps already `done` stay done.
        - **The encrypted identifiers have a maximum retention**, for example 30 days after phase 1.
          When it passes, the sweep deletes them, even from an unfinished job. The steps that still
          needed them end `incomplete` for good, since no retry can run them without their inputs.
          The job state and an audit event tell the owner which stores those were.
        - The owner's confirmation of a candidate adds a step to the same job. It isn't run inline.
      - **The tombstone fences whatever state the job is in.** Writers check the tombstone, never the
        job, and the tombstone is never lifted. So a slow, stuck or `erase_incomplete` job never
        weakens the fence.
        - Phase 2 holds no erasure lock across steps. Each step's transaction is short, so a long
          erase blocks no writer.
        - The fence refuses only writes that would put subject data back, so retained financial
          records keep updating however long the job takes.
      - **The endpoint returns the job, not the result.** It responds `202` with the job id once
        phase 1 commits. The owner reads progress, each store's outcome and the candidate list from
        `GET /api/customers/:id/erase`. Every "erase result" in this unit means that job state.
  - **U7 starts with a data inventory, before any erase code.** Review keeps turning up one more
    store that holds customer data: service locations, custom-field values, converted leads, callback
    tasks, an external trace sink. That shows the scope has to be discovered systematically, not
    patched one store at a time. The first deliverable is a written inventory, reviewed on its own
    PR, of every place a customer's data can live, reached through any of five kinds of link:
    - **Direct:** a `customer_id` foreign key.
    - **Bare column:** a `%customer_id` column with no foreign key.
    - **Session- or call-linked:** keyed by the customer's `voice_sessions`, `call_sid` or
      conversation ids. For example, `call_me_back_tasks` (`schema.ts:3887-3901`) is linked only
      through `session_id`, yet it holds `caller_phone`, `caller_name`, `callback_message` and
      `intent_summary`.
    - **Polymorphic:** an `entity_type` / `entity_id` pair that names the customer, or one of the
      customer's jobs, estimates or invoices. For example, `customer-mms/customer-mms-intake.ts:150-163`
      uploads each customer MMS image to S3 and creates a `files` row with `entityType: 'customer'`.
      The schema test also lists every `entity_type` / `entity_id` table, so each must be classified.
      The erase deletes those file rows and their S3 objects.
    - **Identifier-linked:** matched only by the customer's phone, email or name.
    - **External sinks:** S3 objects, Twilio recordings, and Langfuse traces when
      `LANGFUSE_CAPTURE_CONTENT` is on. `trace-exporter.ts` exports gateway inputs and outputs,
      including transcripts, under correlation and session ids. Two business integrations hold
      directly linked customer records too:
      - **Stripe.** `payments/stripe-saved-card.ts:84-124` creates a Stripe Customer with the
        customer's name, email and internal id, and attaches saved cards to it. The erase deletes
        that Stripe Customer, which also detaches its saved payment methods. Stripe keeps its own
        charge records under its legal obligations, outside our control, and the result says so.
      - **QuickBooks.** `integrations/accounting/sync-service.ts:271-315` pushes the customer's
        display name, email and phone. Accounting records fall under the same tax and legal
        retention as local invoices (owner decision 1). The default is to keep the financial
        records and anonymize the QuickBooks customer record:
        - Replace the required `DisplayName` with a stable anonymized value, for example
          `Erased customer <short id>`. `sync-service.ts:282-287` sends `customer.displayName`, and
          `quickbooks-client.ts:93-103` stores it as `DisplayName`, so clearing email and phone
          alone leaves the name.
        - Clear the email and the phone.
      - **Twilio calls.** Deleting recordings and messages still leaves Twilio's Call resource, and
        with it the call log of both parties' phone numbers. Twilio exposes a separate DELETE for a
        completed Call record, and deleting a recording doesn't remove it. So:
        - The erase deletes the subject's Call resources: the primary call, plus any child legs
          such as a dialed transfer or the on-call page.
        - It selects them only by the Call SIDs we keep linked to the subject:
          `voice_sessions.call_sid`, and the outbound call results we store.
        - A call still in progress can't be deleted. The erase waits for it to complete, up to the
          call `timeLimit` maximum, and until then the Twilio calls store is `incomplete`.
        - A Call is deleted only after the Twilio recordings step has asked Twilio for that Call's
          recordings (see "A writer the fence refuses can still leave a copy" below).
        - A 404 counts as done, and a re-check after the delete must come back clean.
      - **Twilio messages.** `notifications/twilio-delivery-provider.ts:238-268` posts the recipient
        and the body to Twilio's Messages resource, and we keep the returned message SIDs. The
        erase redacts or deletes the customer's SMS/MMS Message resources, media included, through
        the Twilio API.
        - It selects them only by the message SIDs we keep linked to the subject: outbound sends,
          and inbound captures, which already store `messageSid` with `customerId`
          (`sms/inbound-capture.ts:293-309`).
        - It never selects them by phone number alone. A household can share a number and numbers
          get reassigned, so a number-only match could irreversibly delete someone else's history.
        - Unlinked inbound messages that match only on the number go onto the same owner-confirmed
          candidate list as historical `ai_runs`.
      - Every enabled integration is a manifest entry with its delete, anonymize or legally-retain
        rule.

    The erase code and its tests are then written against that inventory. The list of stores below
    is a starting point, not the definition.
    - **External sinks are erased too, or the erase says it is incomplete.**
      - With content capture on, the erase deletes the subject's Langfuse traces through the
        Langfuse API, keyed by the collected correlation and session ids.
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
      - **The second delete waits by time, not on the drain.** The drain reaches only the process
        running the erase, and only while it lives. The gateway exports from every process, and a
        resumed job can't drain a queue that belonged to an earlier one. So the second delete is a
        job step with a `not_before`: the phase-1 commit time plus the SDK's longest send time,
        retries included. By then every process's event for the subject has either been sent, so
        the second delete removes it, or been dropped at the send boundary.
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
      - `anonymize` (keep the row, drop the link and the PII)
      - `keep` (a legal or financial retention reason)
    - A schema test reads the live catalog (`pg_constraint` for foreign keys, and
      `information_schema.columns` for every `%customer_id` column) in the Docker-gated suite. It
      fails when any match, or any newly added one, is missing from the manifest. A future table or
      bare link column therefore can't silently escape the erase.
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
    - Free-text stores that can hold a customer's details without a foreign key (notes, messages,
      transcripts, `ai_runs`) are listed in the manifest explicitly, with how each is matched.
  - **Fence writers that are still in flight, or the erase can be undone.** An erase can overlap an
    asynchronous writer. For example, the gateway creates a pending `ai_runs` row before it
    dispatches, and only writes `outputSnapshot` after completion (`gateway.ts:632-662`); the trace
    export, transcript append and session summary work the same way. A completion that lands after
    the scrub would put the data back.
    - The erase first writes a durable, tenant-scoped erasure tombstone. It is keyed by:
      - the customer id, and the collected session, call and correlation ids
      - **every owned-entity id in the subject's graph**: the jobs, estimates, invoices,
        appointments, service locations and the rest of the manifest's transitive closure,
        collected in phase 1. Phase 2 severs or anonymizes the parent links, so a child row such as
        `invoice_line_items`, which carries only `invoice_id` (`schema.ts:653-664`), could no
        longer be traced to the subject. Its `invoice_id` still matches the tombstone.
      - the subject's normalized phone numbers and email addresses, stored as keyed hashes
        (HMAC-SHA256 with a server-side key), so the tombstone keeps no raw identifier
      A writer that knows only a recipient, with no customer id, still matches. The erased
      customer row no longer holds the identifiers, so without this such a writer could never
      match the tombstone.
    - **One fence for every writer, enforced by a test, not by a list.** The writers named in this
      plan are examples, and a list can always miss one. U7 adds a single primitive,
      `withErasureFence(tenantId, subjectKeys, write)`:
      - It takes the subject's erasure lock in shared mode, checks the tombstone, and records a
        write-ahead claim, all in one transaction.
      - It runs the write, or the provider call, only after a guarded claim flip (see below).
      - **The lock covers every key the tombstone holds, not only the customer id.** Many writers
        can name the subject only by the key they carry, such as `invoice_line_items.invoice_id` or
        a transcript turn's session id. A lock on the customer id alone doesn't serialize them with
        phase 1. So:
        - The erasure lock is keyed like the tombstone probe, by `(tenant_id, key)`, hashed onto a
          fixed number of lock stripes per tenant, so phase 1 takes a bounded number of locks.
        - Phase 1 collects the subject's keys and takes the stripe of each in exclusive mode, with
          `pg_try_advisory_xact_lock`. Then it collects again under the locks, and locks any key
          that appeared in between. If any stripe is busy, it rolls back and retries after a short
          backoff. Phase 1 therefore never waits while it holds a stripe, so it can't deadlock with
          a writer waiting on it.
        - Every writer and every trigger takes the stripe of each key it checks, in shared mode.
          An unrelated key that shares a stripe only makes its writer wait out a short phase 1.
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
      - Every module that makes an outbound network call (`fetch`, a provider SDK or a presigned
        URL) registers in one `externalSinks` registry.
      - Each entry is classified either as a subject-data writer, which goes through the fence and
        has a manifest entry with its delete or retention rule, or as exempt, with a reason (for
        example a model provider receiving only already-fenced content).
      - The test greps `packages/api/src` for outbound call sites and fails on any file that isn't
        registered, so a new integration can't skip the erase.
      - Wisetack and Google Calendar join the fence and the external-sink manifest:
        - **Ambiguous creates.** The financing application id we send, and a deterministic event id
          we set on the calendar insert, let the erase find a create whose response was lost.
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
        with phase 1 like every other writer.
      - It checks the row's subject keys against the tombstone. The manifest maps those keys for
        each table: `customer_id`, session id, call SID or correlation id, or, for a transitively
        linked table, the owned-entity link column, such as `invoice_line_items.invoice_id`.
      - Test: after phase 2 has severed an invoice's customer link, an in-flight update that writes a
        description into one of that invoice's `invoice_line_items` rows is refused.
      - **It refuses only writes that would put subject data back, never ordinary updates to retained
        rows.** Retained financial records keep changing after an erase.
        `PgInvoiceRepository.incrementAmountPaidAtomic` and `reconcileBalanceAtomic` still update
        balances and statuses on an erased customer's invoices and payments, and refusing those
        writes would leave legally retained records wrong. So:
        - The manifest lists each table's designated PII/content columns.
        - The trigger compares `NEW` with `OLD` only on those columns. A match raises a dedicated
          SQLSTATE only when the write would set a designated column to a non-blank value that
          differs from the scrubbed one. On an `INSERT`, any non-blank designated column counts.
        - Every other write passes: a balance, status or reconciliation update that leaves the
          designated columns as they are, and a write that only blanks them, which is what the erase
          itself does.
        - Test: after an erase, a payment against the customer's retained invoice still updates
          `amount_paid` and the status. An update that tries to put a description back on the same
          invoice is refused.
      - Writers treat that SQLSTATE as "erased, drop the content". It is never an error that
        retries. The transcription worker ends that recording's job without writing.
      - The manifest schema test reads `pg_trigger` in the Docker-gated suite. It fails when any
        `scrub` or `anonymize` table lacks the trigger, so a new table or repository is covered by
        construction.
      - The tombstone lookup is an index probe on `(tenant_id, key)`, so the per-row cost on hot
        tables such as `call_transcript_turns` stays small.
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
      - **Keep issued keys until their URLs expire, durably.** A key held only in the running
        erase is lost if the process restarts before the URL expires, and the client could then
        upload with nothing left to find it. So:
        - In the same transaction that deletes a subject `files` row, the erase inserts an
          `erasure_storage_cleanup` row with the bucket, the key and `not_before`. `not_before` is
          the issued URL's expiry plus clock skew. This happens whether or not the upload went
          through.
        - The erasure job's S3 step processes those rows after `not_before`: it deletes each key
          again. Each row carries the job id, and the step is `done` only when every row is.
        - Then a HEAD request confirms each key is gone, and only then is the cleanup row marked
          done.
        - Until every cleanup row for the erase is done, the S3 store is `incomplete`. The result
          says it finishes once outstanding upload links expire, within about five minutes, and a
          restart resumes from the rows.
        - Test: the process restarts between the row delete and the re-delete. The worker still
          removes the late upload.
      - Test: an upload URL is issued, the erase runs, and the client PUTs the bytes afterwards,
        before the URL expires. The re-delete removes the object, and the erase reports success
        only after the HEAD check.
    - **A writer the fence refuses can still leave a copy, and so can one in flight at phase 1.**
      Targets come from the phase-1 snapshot of stored SIDs and keys, the status callbacks and the
      upload cleanup rows. Some writers create the external copy before any row records it:
      - The recording and voicemail webhooks fetch the bytes from Twilio and PUT them to S3 before
        they insert `voice_recordings` (`telephony/recording-webhook.ts:391-407`,
        `telephony/voicemail-status-route.ts:533-556`). They delete Twilio's copy only after that
        row commits (`recording-webhook.ts:454`).
      - The image post-process worker writes `thumbnailKeyFor(key)` before it records the
        thumbnail key (`workers/image-post-process-worker.ts:147-156`).
      - Customer MMS intake runs `putObject` before `fileRepo.create`
        (`sms/customer-mms/customer-mms-intake.ts:162-163`).
      For example, a call ends, and the owner erases the customer ten seconds later. Phase 1
      records the Call SID, but no Recording SID exists locally yet. The recording callback then
      arrives, the fence refuses it, the handler returns `500`, and Twilio gives up after its
      retries. The Twilio calls step deletes the Call, but the Recording with the customer's audio
      stays at Twilio, its SID recorded nowhere, and the job completes. So:
      - **A refusal still registers the external copies.** When the fence refuses a recording or
        voicemail callback, the handler adds the `RecordingSid`, and the deterministic S3 key from
        `buildRecordingStorageKey` or `buildVoicemailStorageKey`, as late targets on the job whose
        tombstone matched. That re-opens the job (see "A late target re-opens the job" above). The
        handler then returns `200`, since the job now owns the cleanup.
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
          HEAD request.
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
      - A customerless send is refused when its source row is one of those recorded ids.
      - A customerless send that matches the recipient hash but whose source row isn't recorded is
        ambiguous. It is held, not refused, and goes onto the owner-confirmed candidate list. The
        owner either releases it ("this is someone else") or drops it. Nothing is suppressed
        indefinitely without a decision.
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
    - **An ambiguous business-integration create is reconciled with a strongly consistent read,
      not assumed absent.** Each write-ahead claim stores the idempotency key or request id it
      sent, and the account it sent it on.
      - The QuickBooks create already carries a stable request id (`customer-<id>`,
        `sync-service.ts:288`). When a create's outcome is unknown, the erase looks that customer up
        in QuickBooks and anonymizes it if it exists.
      - **Stripe Search can't prove a customer absent.** Stripe documents Search as not for
        read-after-write: its index usually lags by under a minute, and longer during incidents. A
        lookup seconds after a lost `customers.create` (`payments/stripe-saved-card.ts:96-105`)
        could find nothing while the customer exists, with a card attached by
        `setup_intent.succeeded`. So:
        - The Stripe step lists customers instead (`GET /v1/customers`, which is consistent), on the
          claim's account. It lists those created between the claim's `attempt_started_at` and the
          end of Stripe's declared worst case, widened by clock skew, and keeps those whose
          `metadata.customer_id` and `metadata.tenant_id` match. It deletes every one it keeps.
        - The list needs no raw identifier, so the erase never sends the erased name or email to
          Stripe again.
        - Search runs only as an extra pass, after a `not_before` past its indexing delay. Its
          empty result never counts as proof that the customer is absent.
      - Wisetack and Google Calendar read back by the id we sent: the financing application id,
        and the deterministic calendar event id.
      - Until that read succeeds, the store is `incomplete`.
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
        held and candidate-listed. Releasing it sends it.
      - A send sourced from a lead created after the erase goes through.
      - The structural test fails on a fixture provider call site that isn't wrapped.
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
        `claimed`. The row holds the recipient, the sending number or address, the `customer_id`
        and a hash of the body.
      - It writes that row in one transaction that first takes the subject's erasure lock in
        shared mode. The lock is a `pg_advisory_xact_lock_shared` on the stripe of the customer
        id. A send with no customer id locks the stripe of its normalized recipient's keyed hash
        instead.
      - In the same transaction it checks the tombstone, and it refuses the send when the
        tombstone matches.
      - The erase's phase 1 takes the stripe of every key it writes into the tombstone in
        exclusive mode, as described above, the customer id and every normalized phone and email of
        the subject among them. It writes the tombstone under them.
      - In the same transaction, phase 1 moves every `claimed` row for the subject to `fenced`.
      - Either a sender's row commits before the tombstone, and the erase sees it, or the sender
        sees the tombstone. No order lets both miss.
    - **The provider call starts only after a conditional flip.** Immediately before the call, at
      `markProviderStarting`, the sender runs one statement: `claimed → sending`, setting
      `attempt_started_at`, guarded on the status still being `claimed`. A `fenced` row fails that
      flip, and no provider call is made.
    - This covers SMS/MMS, email and outbound calls, on every path, including the direct Send
      Estimate/Invoice routes that no send claim wraps today.
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
      - Test: an email send whose response is lost is linked by its event, and resolves
        `provider_retained`. An unlinked one resolves `provider_retained` after the window. The
        erase completes, listing both as provider-retained.
    - **Rows the callback never linked fall back to a strict content match.** The erase reconciles
      them against Twilio Messages, filtered by the row's From and To over a `DateSent` window and
      matched by the body hash. It accepts the match automatically only when both hold:
      - exactly one Twilio message matches
      - no other write-ahead row, for any customer in the tenant, has the same From, To and body
        hash in an overlapping window
      Anything else goes onto the owner-confirmed candidate list. The fallback runs once the
      status-callback window's deadline has passed. Zero matches then counts as Twilio never having
      accepted the message, and the row is recorded reconciled-absent.
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
      them, because jobs and appointments still reference the rows.
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
  - **Anonymize** the customer link on invoices, payments and estimates, and keep the amounts for
    tax and legal retention.
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
  - against mocked Stripe, QuickBooks, Twilio Messages and Twilio Calls APIs:
    - the subject's completed Call resources, child legs included, are deleted. A call still in
      progress keeps the store `incomplete` until it completes, and then it is deleted.
    - the Stripe Customer is deleted
    - the QuickBooks customer's `DisplayName` is replaced and its email and phone are cleared
    - the customer's linked Twilio Message resources and their media are redacted or deleted
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
  - a non-owner gets 403
  - another tenant's data is untouched
  - **the erasure job survives a crash**, against real Postgres and the mocked providers:
    - **Restart right after phase 1.** The process is killed once phase 1 commits, before any
      phase-2 step runs. On boot the sweep claims the job and finishes it. Every store is erased,
      `erase_completed` is written once, and writers stay fenced throughout.
    - **Crash after each later checkpoint.** For each step in turn, the process is killed once just
      after the step's checkpoint commits, and once between a provider delete and its checkpoint.
      On resume, no checkpointed target is sent a second delete. A repeated delete that returns 404,
      for the Stripe Customer or a Twilio Call, is recorded `done`, not as a failure. The job
      completes.
    - **Resume after the links are gone.** The process is killed after the scrub has severed the
      invoice links and blanked the `customers` row. The resumed Stripe, QuickBooks,
      `invoice_line_items` and historical `ai_runs` steps still find every target, from the step
      rows and the job's encrypted identifiers. Once those steps are done, the job row holds no
      identifiers.
    - **Two workers race.** The queue handler and the boot sweep claim the same job at once.
      Exactly one claim succeeds, and each provider delete is sent once. A worker whose lease
      lapsed mid-step has its next checkpoint refused, and makes no further provider call.
    - **Bounded retries.** A provider that fails every time ends its step `incomplete` after the
      retry limit. The job ends `erase_incomplete`, naming that store, with one alert. A repeat
      `POST` retries only that step. The tombstone fences writers the whole time.
    - **A step that crashes every run.** A step calls `process.exit()` on every run. After the
      retry limit it ends `incomplete`, and the job ends `erase_incomplete` with one alert.
    - **A callback that never arrives.** An SMS whose client timed out before Twilio accepted it
      stays `ambiguous`, and no status callback ever comes. By the callback window's deadline the
      step falls back to the content match, finds nothing and records reconciled-absent. The job
      ends terminal.
    - **A late target races the close.** A status-callback handler is held between its step update
      and its commit while the worker closes the job. Once both commit, the job isn't terminal. The
      sweep runs the re-opened step, the SID is deleted at Twilio, and the job closes again with one
      audit event for that generation.
    - **Age alarm and identifier retention.** A job still not terminal past the age limit raises one
      job-age alert. An `erase_incomplete` job whose historical scan keeps failing reaches the
      identifiers' maximum retention: the identifiers are deleted, that step ends `incomplete` for
      good, and the job state tells the owner.
  - **the lock covers every tombstone key:** a writer that carries only a session id, or only an
    `invoice_id`, holds its shared stripe lock, paused before commit, when the erase starts. Phase 1
    waits for it, and phase 2 then scrubs what it wrote.
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
    lease reaper as its resume), repricing, and the 80% alert.
  - **Limits serialized with their consumers:** the ceiling and every reservation and ledger
    transition, under one per-tenant spend lock. The ceiling, the month and the decision to admit
    an unpriced attempt are each read after that lock is granted.
- **Approach:**
  - A nullable `tenant_settings` monthly ceiling in integer cents (new idempotent migration). Null
    means no cap is enforced.
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
      - Every ledger-era `ai_runs` row carries a ledger tag from the day the ledger ships:
        - a dispatched run records the `attempt_id` of its reservation
        - a run that makes no provider attempt records an explicit exemption instead, such as
          `spend_exempt = 'cache_hit'`. A cache hit still writes an `ai_runs` audit row
          (`ai/gateway/cache.ts:191-224`), but it costs nothing and has no reservation.
      - A cap can be enabled from the first full calendar month after the ledger ships. Every run
        in that month, and in every month after it, was written by ledger-era code, so `spent` is
        the month's real spend. During the ship month, the settings write that enables a cap is
        refused, with a plain "available from <date>".
      - **A tripwire stays in place.** A capped tenant's reserve transaction checks a partial index
        for the current month:
        `ai_runs (tenant_id, created_at) WHERE attempt_id IS NULL AND spend_exempt IS NULL`.
        - A row with neither tag means an old-version writer is still alive, weeks after the ship.
          The capped reservation is then refused, and `alertOperator` fires.
        - Cache hits and other zero-cost runs carry their exemption, so they never trip it.
        - Test: a capped tenant's cache hit writes a `cache_hit` row, and the next capped request is
          admitted.
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
        attempt.** The run's `settled_unpriced` reservation row takes one guarded transition to
        `settled`, `WHERE attempt_id = $1 AND state = 'settled_unpriced'`. The ledger's `spent` grows
        by exactly the repriced amount. A repricing that runs twice matches no row the second time.
        Retried attempts each have their own row, so each one is counted.
        - The `ai_runs` cost is written back in that same transaction, and only when the transition
          matched a row. An `ai_runs` row therefore never shows a cost that the ledger doesn't hold.
      - Each row is repriced from its own stored inputs, never from the logical `ai_runs` row:
        - An attempt with recorded usage is settled at the new price.
        - An attempt with no usage (it timed out after dispatch, or its lease expired) is charged at
          the worst case from its stored bound, and moves to `charged_unreconciled`.
        So every `settled_unpriced` row can be cleared, and none blocks enabling a cap forever.
      - **A reservation with no price snapshot never charges zero.** An unpriced reservation has no
        amount. A lease reaper or an ambiguous failure that moved it to `charged_unreconciled` would
        charge it 0. Repricing, which matches only `settled_unpriced`, would then skip it, and so
        would the cap-enable count, while its spend stayed outside the ledger. So:
        - The reaper and the ambiguous-failure path move a row with no snapshot to
          `settled_unpriced`, with no usage, never to `charged_unreconciled`. Repricing then charges
          it at the worst case, as above.
        - A definitive no-dispatch failure still releases it.
        - The check constraint ties each state to its snapshot: `settled` and
          `charged_unreconciled` need a price snapshot and an amount. Only `reserved` and
          `settled_unpriced` may lack one.
      - The cap-enable check counts every reservation without a price snapshot, not just null
        `ai_runs` costs: the `settled_unpriced` rows, reaped and ambiguous ones included, and the
        `reserved` rows of unpriced attempts still in flight (see below). It counts them in every
        month that still has an open reservation, not only the current one. Once all of them are
        priced, the ledger already holds that spend.
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
        tenant's spend key. That covers reserve, settle, release, expiry, reconciliation and
        repricing. The lock is per tenant, not per tenant-month, so a cap written in the last
        second of a month still serializes with a reservation that lands in the next one.
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
        - every reservation without a price snapshot, in each month that still has an open
          reservation: a `reserved` row with none, which is an unpriced attempt in flight, and
          every `settled_unpriced` row
        - the tripwire, the ship-month rule, and the rule that every configured model has a price
      - **Only two orders exist.** Either an attempt's reservation commits first, and the settings
        write counts it, or the settings write commits first, and the reservation compares against
        the new ceiling.
      - **An attempt already dispatched when a cap is enabled counts at its worst case until it
        settles.**
        - A priced attempt is already in `reserved` at its worst case.
        - An unpriced attempt in flight is priced inside the settings transaction, when its model
          now has a verified price. The transaction writes that price into the attempt's snapshot,
          sets its amount to the worst case from the attempt's own stored bound, and adds that to
          `reserved`. The attempt then settles at its actual cost. Settle reads the snapshot from
          the row in its guarded transition, so it can't settle as unpriced.
        - A `settled_unpriced` row is repriced in the same transaction, by the transition the
          repricing sweep uses.
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
    - Never round an individual call to cents: sub-cent calls would count as zero and the
      aggregate could pass the cap.
    - A unit test pins the conversion: a cap of 100 cents admits exactly 100,000,000 micro-cents of
      reservations.
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
    - **Give each physical attempt its own durable reservation, in Postgres.** An aggregate
      `reserved` counter can't say which of two concurrent attempts expired, whether that attempt
      was already reconciled, or whether a retried completion has already been counted. So:
      - An `ai_spend_reservations` row is keyed by a unique `attempt_id`. It holds:
        - `tenant_id`, the month, `amount_micro_cents`, `state` and `lease_expires_at`
        - the `ai_run_id`, once known
        - **this physical attempt's own pricing inputs:** the `model`, the worst-case input-token
          bound and `maxTokens` it reserved against, and its actual `token_usage` when the provider
          returned one
        - **a snapshot of the rates it reserved at:** the concrete input, output and per-image rates
          in micro-cents, and the pricing source's version. `AI_MODEL_PRICING_JSON` or a built-in
          price can change between reserve and settle, and settling at newer rates could charge
          more than was reserved and push a capped tenant over its ceiling. So settle, the
          worst-case charge and any later reconciliation or repricing of an attempt all use that
          snapshot. Only an attempt reserved while unpriced (`settled_unpriced`) takes the first
          verified price, and that price is then written into its snapshot.
        The logical `ai_runs` row keeps only the final attempt's usage. A timed-out first attempt
        followed by a successful retry would otherwise leave nothing to price the first attempt
        from.
        The states, and the only transitions allowed out of `reserved`:
        - `settled`: the actual cost from the usage object is charged.
        - `released`: a definitive no-dispatch failure, so nothing is charged.
        - `charged_unreconciled`: a priced attempt's ambiguous failure or expired lease, charged at
          the worst-case amount. If the provider's usage later becomes known, one guarded transition
          `charged_unreconciled → settled` adjusts `spent` by the actual cost minus the worst case.
        - `settled_unpriced`: an uncapped tenant's call to a model with no verified price, including
          one whose outcome is ambiguous or whose lease expired. There is no amount to charge yet;
          see "Unpriced usage" above.
        A check constraint holds exactly these states, and only `reserved` and `settled_unpriced`
        may lack a price snapshot (see "A reservation with no price snapshot never charges zero").
      - Its RLS matches every tenant table.
      - A per-tenant monthly `ai_spend_ledger` row holds `spent` and `reserved`.
      - **Reserve** is one transaction. It takes the spend lock, then reads the ceiling and
        `spend_month` under it (see "A ceiling change and a reservation take the same lock" above).
        Then a conditional `UPDATE ai_spend_ledger SET reserved = reserved + $cost WHERE spent +
        reserved + $cost <= cap RETURNING …` runs on that month's row, against that ceiling, with no
        comparison when it is null. When it returns a row, the reservation row is inserted with that month. Caps start
        only in a month with no untagged runs (see above), so `spent` is the month's full spend.
      - **Every later step is a guarded transition on that one row**, in the same transaction as
        the ledger adjustment, after the spend lock:
        `UPDATE ai_spend_reservations SET state = $next WHERE attempt_id = $1 AND state = 'reserved'
        RETURNING amount_micro_cents, month`, and then the matching ledger update by exactly the
        returned amount, on the ledger row for the returned month. That covers settle (charge the
        actual cost from `computeCostMicroCents`), release and expire.
        - An attempt reserved at 23:59:50 on Oct 31 that settles just after midnight adjusts
          October's row. November's `reserved` never goes negative, and its headroom isn't inflated.
      - A transition that matches no row is a no-op. A retried completion, a reaper that races a
        late completion, and a double release therefore each count once.
      - The lease reaper expires each attempt by its own id and amount, and moves an attempt with no
        price snapshot to `settled_unpriced`. It never strands capacity, double-charges, charges
        zero, or releases a reservation that may have been billed. It is a leader-gated sweep that
        runs at boot and every minute, so a crashed process's reservations are charged after a
        restart too.
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
    - **Reserve every physical dispatch, not every logical call.** `ProviderRetryDeadlineWrapper`
      can send another attempt to the same provider after a timeout
      (`compose-resilience.ts:118-125`). The first attempt may already have been billed, and if the
      retry succeeds, only the retry's usage comes back.
      - The reservation, and the ambiguous-failure charge, wrap each attempt inside the retry loop.
      - A failover hop reserves again at the fallback model's price.
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
  - Reject with a typed error that the voice path turns into its existing hold-line / Gather behaviour.
  - **Alert at 80% through `alertOperator`, from an outbox.** A reservation can't send the alert
    inside its transaction, and a call after the commit is lost if the process exits first. So:
    - The transaction that first takes the month to 80% of the ceiling sets `alert_80_due_at` on
      the ledger row, under the spend lock, guarded on it being null.
    - A ceiling write applies the same rule in its transaction, under the same lock. A lower cap
      that puts the month past 80% marks the alert due. A higher cap that puts it back under 80%
      clears both stamps, so the alert can fire again.
    - A leader-gated sweep sends every due alert and then stamps `alert_80_sent_at`, guarded on it
      being null. A crash between the send and the stamp sends it twice, which is harmless for an
      operator alert. A crash before the send loses nothing.
- **Test scenarios:**
  - **Unit:** a call is admitted under the cap and rejected over it.
  - **Unit:** failover is charged once.
  - **Unit:** a timeout followed by a successful retry leaves the ledger with attempt 1's worst-case
    charge plus attempt 2's actual cost.
  - **Unit:** an input that tokenizes far above `chars / 4` (dense punctuation or CJK) still reserves at
    least its true cost.
  - **Concurrency:** N requests start together just below the ceiling. Admitted reservations never
    exceed the cap, and every rejection is typed.
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
  - **Unit:** enabling a cap is refused while any configured model is unpriced.
  - **Integration:** the monthly window resets. The ledger's `spent` equals the sum of the month's
    reservation transitions (the amounts charged by `settled` and `charged_unreconciled`), not the
    `ai_runs` costs. A timed-out attempt followed by a successful retry is charged twice by
    design, while `ai_runs` keeps only the retry. Each `settled` amount equals
    `computeCostMicroCents` of that attempt's own stored usage at its snapshot rates.
  - **Integration (price change):** a price changes between an attempt's reserve and its settle.
    The settle charges at the snapshot rates, and a capped tenant can't be pushed over by the
    change.
  - **Integration (per-attempt reservations, real Postgres):**
    - Two concurrent attempts reserve different amounts, and one process dies. The reaper charges
      exactly that attempt's amount, and the other attempt settles normally.
    - A completion delivered twice settles once.
    - A reaper racing a late completion produces exactly one transition.
  - **Integration (mid-month cap):** in a month after the ship month, a tenant has $90 of tagged
    `ai_runs` cost. It enables a $100 cap, and a $15 worst-case call is refused.
  - **Integration (ship month):**
    - Enabling a cap during the ship month is refused, with the date it becomes available.
    - An untagged run in a later month trips the wire: the capped reservation is refused, and an
      alert fires.
  - **Integration (unpriced):**
    - A current-month run with a null cost blocks enabling a cap.
    - After a verified price is added, the run is repriced from its `model` and `token_usage`, and
      the cap can then be enabled against the full total.
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
    stays unpriced. After a price is added, repricing charges its worst case once, writes the
    `ai_runs` cost in the same transaction, and enabling a cap then counts that spend. An ambiguous
    timeout on the same kind of attempt ends the same way.
  - **Integration (in-flight priced attempt):** a priced attempt is dispatched while the tenant is
    uncapped, and a cap is then enabled. Until the attempt settles, the cap's headroom excludes its
    worst case. It settles at its actual cost, and the difference is freed.
  - **Integration (repricing sweep):** the sweep is killed partway through a batch. The next run
    reprices the rest, and each row is counted once.
  - **Integration (80% alert):** the process exits right after the reservation that crosses 80%
    commits. After the restart the sweep sends the alert once. Lowering a cap so the month is
    already past 80% marks the alert due without any new reservation.

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
