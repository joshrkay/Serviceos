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
    - Delete the Twilio copy only after the S3 PUT and the DB insert succeed.
    - Build the URL from `recording_url`, which covers subaccounts. Treat 404 as done.
    - The sweep retries legacy and failed rows, and the purge audit records `twilioDeleted`.
    - Do NOT null `recording_url`; it is the idempotency key.
    - Put the deleter behind an injectable seam, and never log the auth token.
  - **PRIV-3**
    - One Luhn-validated scrubber: 13–19 digits, optional space or dash groups, replaced with
      `[card number]`.
    - Apply it at:
      - `callerTranscriptText`
      - user-role text in `LLMGateway.complete`, before dispatch and before the snapshot
      - `redactTextForExport`
      - `scrubPii`, whose residual detector also flags grouped digits
    - Add `redact=pci` to Deepgram.
    - Mark the recording `pci_detected` so the retention worker purges its audio promptly from S3 and
      Twilio.
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
  - **Unit:** each greeting branch contains the disclosure.
  - **Unit:** the config guard rejects and accepts the right combinations.
  - **Integration (PRIV-1),** RLS on:
    - only rows older than retention are scrubbed
    - FKs stay intact
    - newer rows are untouched
  - **Integration:** the recording flow inserts the row, then deletes the Twilio copy; a failed delete
    is retried by the sweep.
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
    - Keep an in-memory TTL cache of verified webhook credentials, used only when the DB lookup
      throws.
    - The 503 and "try again later" `<Hangup/>` catch-alls on `/voice` and `/gather` become 200 plus
      `buildVoicemailTwiml`.
    - Write an idempotent backfill script for existing numbers that defaults to a dry run. Running it
      is an owner action.
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
  - The fallback route returns static TwiML with no DB.
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
    - Both go through `alertOperator`.
  - **OBS-3**
    - Widen `agent-path-smoke.yml` paths to every file that defines a prompt or routes a model; grep
      for system prompts and `gateway.complete` call sites to build the list.
    - Add the cost-capped `run-intent-eval.ts --live --gate` and the slot eval against the recorded
      live baselines.
    - Add a skip-pass shim, so the check can be made required without hanging unrelated PRs.
- **Test scenarios:**
  - **Unit:** an injection-shaped customer name is dropped from the glossary or fenced.
  - **Unit:** an injection-shaped review is fenced, and the fence-sites test covers the three new
    sites.
  - **Unit:** the per-tenant and spend evaluators.
  - **Integration:** an aggregate test that seeds two tenants, one failing and one healthy, and expects
    only the failing tenant to alert.
  - **Workflow YAML:** it parses (actionlint if available), and the secret references match the
    existing jobs.
- **Verification:** the per-tenant rule alerts on a tenant that the platform-wide rule would dilute.

### U7. Data-subject erasure (PRIV-5) — after U4, needs an owner decision

- **Goal:** an owner can erase one customer's personal data and AI artifacts, short of purging the
  whole tenant.
- **Dependencies:** U4 (the Twilio deleter seam and the `ai_runs` purge), plus owner decision 1 below.
- **Approach**, recommended defaults pending that decision:
  - The endpoint is `POST /api/customers/:id/erase`:
    - owner-only and audited
    - an explicit human action, never an AI proposal
    - one `executeAudited` command transaction
  - **Scrub:**
    - the `customers` row and `customer_contacts`
    - SMS conversations and message bodies
    - customer-linked notes
    - `call_transcript_turns`, `call_summaries`, `knowledge_chunks` by source
    - `voice_sessions.transcript`, `voice_recordings.transcript`
    - stored audio (S3 and Twilio)
    - entity aliases and correction lessons that reference the customer
    - `ai_runs` content for the subject's sessions; historical rows are covered by the U4 age-based
      purge plus a documented manual step
  - **Anonymize** the customer link on invoices, payments and estimates, and keep the amounts for
    tax and legal retention.
  - **Keep** `consent_events` and DNC rows as suppression records, hashing the phone if counsel
    requires it.
- **Test scenarios:** one Docker-gated integration test that seeds a customer across every store,
  erases them, and asserts:
  - each store is scrubbed
  - financial amounts remain
  - suppression remains
  - an audit event is written
  - a non-owner gets 403
  - another tenant's data is untouched

### U8. Money cap on AI spend per tenant (the GATEWAY-05 follow-up) — after U3, needs an owner decision

- **Goal:** a tenant's AI spend can be capped in money, which the token buckets cannot do.
- **Dependencies:** U3, plus owner decision 2 below.
- **Approach:**
  - A nullable `tenant_settings` monthly ceiling in integer cents (new idempotent migration). Null
    means no cap, so nothing changes until one is set.
  - Check it before dispatch in the gateway, including on failover and streaming.
  - Charge it from `computeCostMicroCents` on completion.
  - Reject with a typed error that the voice path turns into its existing hold-line / Gather behaviour.
  - Alert at 80% through `alertOperator`.
- **Test scenarios:**
  - **Unit:** a call is admitted under the cap and rejected over it.
  - **Unit:** failover is charged once.
  - **Integration:** the monthly window resets and the spend sum matches `ai_runs`.

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
