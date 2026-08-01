# fix: Make the operator voice top-50 complete end-to-end

**Created:** 2026-07-21  
**Depth:** Deep  
**Status:** plan

## Summary
The confirmed live operator voice probe improved from 0/50 to 23/50 proposal
passes after restoring provider health, classifier deadlines, and quota
isolation. The remaining 27 cases split into classifier gaps (8), unresolved
entity references (18), and one emergency escalation that is correct but
mis-scored. This plan makes the voice flow reliably classify, resolve
operator-owned references against a purpose-built QA fixture catalog, and
score emergency callback/appointment routing as a valid outcome.

## Problem Frame
An authenticated operator must be able to speak a CRM/money/scheduling request,
confirm it when requested, and receive a persisted proposal—never an invented
success response, silent guess, or inappropriate on-call escalation.

Live evidence: `voice-50-post-716` on Development:

| Result | Count | Root cause |
|--------|------:|------------|
| PASS | 23 | Intent classified, confirmation accepted, proposal persisted |
| DEGRADED | 8 | Classifier unknown/error → `confidence_low` reprompt |
| PARTIAL | 18 | Classified intent → missing fixture entity → escalation |
| PARTIAL (valid) | 1 | Emergency dispatch → on-call notification |

## Requirements
- R1. All 50 corpus cases run as an honest multi-turn voice flow: utterance,
  then `yes` only when the FSM asks to confirm.
- R2. Mutation cases create a persisted, tenant-scoped proposal after
  confirmation; human approval remains mandatory.
- R3. Read-only lookup cases return a typed voice result or a reviewable
  proposal according to the existing handler contract; they must not fall into
  a false low-confidence reprompt.
- R4. Emergency dispatch counts as PASS only when it creates a callback or
  appointment/on-call routing path; it does not require a proposal.
- R5. All entity references used by the live corpus are resolved through the
  entity resolver or become a `voice_clarification`; never silently guessed.
- R6. Live QA fixtures are idempotent, scoped to the QA Mobile tenant, retain
  provenance, and emit audits for every canonical write.
- R7. The post-fix live acceptance run reaches 50/50 valid outcomes with no
  classifier reprompt caused by provider, deadline, or quota failure.

## Key Technical Decisions
- **Classify success separately from entity success** — Each failing case is
  bucketed by classifier, entity resolver, handler, or confirmation outcome.
  This avoids changing prompts to mask a missing CRM fixture.
- **Use a dedicated QA fixture runner, not matrix SQL fixtures** — The
  top-50 targets the fixed QA Mobile tenant, while matrix fixtures target other
  tenants and bypass audit/domain behavior. The new runner uses production
  repositories/domain functions, stable provenance keys, and RLS tenant scope.
- **Use the in-app operator session without a caller customer identity** —
  Authenticated `userId` is an actor, not a CRM `customerId`. PR #717 implements
  this prerequisite.
- **Preserve emergency escalation** — The accepted outcome is an on-call
  callback/dispatch event (or emergency appointment path), not an auto-executed
  or ordinary proposal.
- **Make in-app classification match voice router context** — Pass the allowed
  extended/owner context explicitly; do not rely on a generic LLM fallback for
  operator commands.

## Scope Boundaries
**In scope:**
- The 27 non-PASS top-50 cases, their fixture references, and their
  classifier/entity/handler paths.
- Development QA Mobile fixtures and repeatable live verification.
- Emergency PASS scoring based on durable/on-call callback evidence.

**Non-goals:**
- Auto-approving or executing a proposal.
- Changing production tenant data or weakening tenant isolation.
- Treating a generic LLM text reply as success.
- PSTN/telephony soak beyond the in-app voice API path.

## Repository invariants touched
- All AI calls remain through `packages/api/src/ai/gateway`.
- Every fixture/canonical write carries the QA tenant ID, respects RLS, and
  emits an audit event with fixture provenance.
- Money stays integer cents in fixture invoices/estimates.
- Free-text entity refs resolve through the entity resolver; ambiguity produces
  clarification, never a silent match.
- All generated mutations stay as typed, Zod-validated proposals requiring
  human approval.

## Implementation Units

### U1. Make the live probe a truthful operator voice acceptance harness
- **Goal:** Score persisted proposals after the required confirmation turn;
  accept emergency on-call callback/appointment routing as PASS.
- **Requirements:** R1, R4, R7
- **Dependencies:** none
- **Files:** `scripts/probe-operator-voice-50-live.mjs`,
  `packages/api/test/ai/agents/customer-calling/inapp-adapter.test.ts`,
  `docs/verification-runs/`
- **Approach:** Retain first-turn state and confirmation response per case.
  Require a non-empty `proposalIds` only for proposal-driven intents. For
  `emergency_dispatch`, require an `emergency_dispatch` audit plus
  `notify_oncall` (or the supported emergency appointment callback effect).
  Persist the raw state/effect evidence in results, never secrets.
- **Patterns to follow:** Existing `scoreVoice()` and adapter two-turn
  confirmation test.
- **Test scenarios:**
  - Proposal intent: `intent_confirm` → `yes` → persisted proposal ID → PASS.
  - No confirmation request: no automatic `yes`.
  - Emergency: on-call side effect → PASS without a proposal ID.
  - Reprompt: `confidence_low` remains DEGRADED.
- **Verification:** The harness distinguishes proposal, emergency callback,
  entity clarification, and provider failure in its results JSON.

### U2. Close classifier coverage and operator-context gaps
- **Goal:** Eliminate the eight `intent_capture` reprompts for unambiguous
  operator phrasing.
- **Requirements:** R2, R3, R5, R7
- **Dependencies:** U1
- **Files:** `packages/api/src/ai/orchestration/intent-classifier.ts`,
  `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts`,
  `packages/api/src/workers/voice-action-router.ts`,
  `packages/api/test/ai/orchestration/intent-classifier.test.ts`,
  `packages/api/test/ai/agents/customer-calling/inapp-adapter.test.ts`
- **Approach:** Add deterministic safe matches/examples for `add customer`,
  `convert lead`, terse `open job`, possessive customer updates, bare account
  lookups, and `INV-*` update phrasing. Thread allowed extended/owner context
  through the in-app adapter using the same policy gates as the voice action
  router. Keep model failures separately observable from low-confidence audio.
- **Patterns to follow:** `isCreateCustomerSignupPhrasing`,
  `voice-action-router.ts` context construction, classifier launch fixtures.
- **Test scenarios:**
  - Each of cases 1, 2, 3, 6, 7, 8, 9, and 26 reaches a classified FSM event.
  - Extended lookup is unavailable without authorized context and available
    with it.
  - Provider/quota/deadline errors do not masquerade as a semantic intent.
- **Verification:** Those eight corpus utterances leave `intent_capture`
  deterministically in mocked handler tests and live acceptance.

### U3. Add an audited, idempotent QA Mobile operator-voice fixture runner
- **Goal:** Seed exactly the CRM entities required for the live corpus without
  mutating unrelated data or creating duplicates on retries.
- **Requirements:** R2, R5, R6, R7
- **Dependencies:** U1
- **Files:** `fixtures/voice/operator-voice-fixture-catalog.json`,
  `packages/api/src/seed/operator-voice-fixture-plan.ts`,
  `packages/api/src/seed/operator-voice-fixture-runner.ts`,
  `packages/api/scripts/seed-operator-voice-fixtures.ts`,
  `packages/api/test/seed/operator-voice-fixture-plan.test.ts`,
  `packages/api/test/integration/operator-voice-fixtures.test.ts`,
  `packages/api/test/integration/operator-voice-fixture-idempotency.test.ts`,
  `docs/runbooks/operator-voice-fixture-seed.md`
- **Approach:** Require explicit QA tenant and actor IDs; refuse unscoped runs
  and production targets without an intentional safety override. Use
  production repositories/domain creation paths and audit repository. Tag only
  fixture records with `qa-operator-voice:v1:<key>` provenance. Create
  resolver-compatible customer display names, job summaries, estimate/invoice
  customer messages, fixed document numbers, Garcia Tuesday appointment,
  Carlos technician, and Greenfield lead. Never seed customers for cases
  intended to create a new customer.
- **Patterns to follow:** `packages/api/src/seed/seed-runner.ts`,
  `packages/api/scripts/verify-seed.mjs`,
  `packages/api/scripts/bootstrap-mobile-qa-user.ts`.
- **Test scenarios:**
  - Run twice → stable IDs and no duplicate rows.
  - Every corpus reference resolves through the real Postgres resolver.
  - Surname-only references meet the real similarity threshold.
  - Fixture money values are integer cents.
  - Every fixture write has tenant scope and audit provenance.
- **Verification:** Docker-gated integration tests pass and live preflight
  confirms all required fixture keys in QA Mobile before the 50-run.

### U4. Extend voice entity resolution for document and operator references
- **Goal:** Resolve estimates/invoices and intent-specific references instead
  of escalating valid operator commands.
- **Requirements:** R2, R3, R5, R7
- **Dependencies:** U2, U3
- **Files:** `packages/api/src/ai/agents/customer-calling/entity-resolution.ts`,
  `packages/api/src/ai/resolution/pg-entity-resolver.ts`,
  `packages/api/test/ai/agents/customer-calling/inapp-entity-resolution-safety.test.ts`,
  `packages/api/test/integration/entity-resolution.test.ts`,
  `packages/api/test/ai/agents/customer-calling/voice-reschedule.test.ts`,
  `packages/api/test/ai/agents/customer-calling/voice-cancel.test.ts`,
  `packages/api/test/ai/agents/customer-calling/voice-reassign.test.ts`
- **Approach:** Add invoice/estimate reference resolution only for intents that
  require those documents. Resolve appointment references for scheduling
  mutations, including Garcia/date references. Preserve the ambiguity →
  `voice_clarification` rule. For new-customer intents, do not attempt to
  resolve a customer before drafting the creation proposal.
- **Patterns to follow:** Existing `resolveSchedulingEntities` and
  `PgEntityResolver` candidate ranking.
- **Test scenarios:**
  - `Khan` customer, `EST-0042`, `INV-0042`, Garcia appointment, and Carlos
    resolve in integration tests.
  - Ambiguous Smith-like references surface clarification, never a choice by
    recency.
  - New customer creates proceed without an entity lookup.
  - Unknown non-emergency refs result in clarification rather than on-call
    escalation where the product contract permits.
- **Verification:** The former 18 fixture-dependent escalation cases reach
  confirmation/proposal flow against the QA fixture tenant.

### U5. Run the live acceptance loop and close each residual case
- **Goal:** Demonstrate all 50 have their required valid outcome.
- **Requirements:** R1–R7
- **Dependencies:** U1–U4
- **Files:** `docs/verification-runs/operator-voice-50-live-2026-07-21-final.md`,
  `docs/verification-runs/operator-voice-50-live-2026-07-21-final.results.json`
- **Approach:** Seed the QA fixture catalog; run Development first, then
  production when its auth path supports the probe. Group any residual
  failures by exact state/effect and fix with a test before retrying only that
  group. Do not count generic text or unpersisted cards as PASS.
- **Test scenarios:**
  - 49 mutation/read-only corpus cases: persisted typed proposal or documented
    read-only handler outcome after required confirmation.
  - Emergency case: durable `emergency_dispatch` audit plus on-call callback
    or emergency appointment routing.
  - Provider completion remains healthy before and after the run.
- **Verification:** Final dated artifact shows 50/50 valid outcomes and
  records proposal IDs or emergency callback evidence for every case.

## Risks & Dependencies
- The QA fixture runner writes canonical test data; it must require explicit
  tenant/actor environment variables and stay Development-scoped by default.
- Real Postgres resolver behavior—not mocked columns—determines success; U3/U4
  require Docker-gated integration tests.
- The emergency path must not be weakened simply to satisfy proposal scoring.
- Live provider rate/cost remains bounded by classifier quota profiles and
  sequential probe execution.

## Open Questions
- Whether production can accept a real Clerk QA token for the final 50-run;
  Development remains the authenticated canary until then.
- Whether read-only lookups should be represented as a typed response rather
  than a proposal. The final scorer must follow the existing handler contract.
