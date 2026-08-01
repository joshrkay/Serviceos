# Operator Voice Top-50 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all 50 authenticated operator voice workflows produce a
tenant-scoped, auditable valid outcome without auto-executing proposals.

**Architecture:** A truthful live probe classifies each failure before product
changes. An audited, idempotent QA fixture runner makes corpus entity references
real resolver inputs. The voice path uses alias-first, intent-conditioned
resolution and bounded authorized classifier context. A final authenticated run
proves proposal persistence, human approval, emergency routing, audit records,
and RLS denial.

**Tech Stack:** TypeScript, Express, Vitest, PostgreSQL with RLS/pg_trgm,
Zod, Clerk, Railway Development.

## Global Constraints
- All canonical writes carry `tenant_id`, respect RLS, and emit audit events.
- Fixture writes are Development QA-tenant-only, provenance-tagged, idempotent,
  and cannot seed entities whose creation is under test.
- Every proposal remains Zod-validated and human-approved; emergency dispatch
  is a durable non-proposal result.
- Alias lookup precedes fuzzy resolution but verifies tenant, active lifecycle,
  and entity kind before returning a candidate.
- Classifier failures preserve provider/quota/deadline/parse distinctions; raw
  transcripts never enter context except as the user message.
- Money uses integer cents and all timestamps are UTC.

---

### Task 1: Truthful Top-50 acceptance harness

**Files:**
- Modify: `scripts/probe-operator-voice-50-live.mjs`
- Modify: `packages/api/test/ai/agents/customer-calling/inapp-adapter.test.ts`
- Create: `scripts/__tests__/probe-operator-voice-50-live.test.mjs`

**Interfaces:**
- Consumes: `/api/voice/sessions` state/events and proposal/audit read
  endpoints.
- Produces: one result per corpus item with `workflowId`, `classification`,
  `confirmationSent`, `proposalIds`, `emergencyEvidence`, and `failureKind`.

- [ ] **Step 1: Write failing scorer tests**
  - A proposal flow is PASS only after `intent_confirm` followed by an explicit
    confirmation and a persisted proposal ID.
  - A non-confirming turn never sends `yes`.
  - An emergency flow is PASS only with `emergency_dispatch` plus
    `notify_oncall` or an emergency appointment/callback effect.
  - `provider`, `quota`, `deadline`, and `parse` outcomes are distinct from
    semantic low confidence and unresolved references.

- [ ] **Step 2: Implement pure scoring extraction**
  - Export a side-effect-free scorer from the probe script or a colocated
    helper. It receives the first/second turn states and read-back evidence;
    it returns only the documented result structure.
  - Preserve source states/effects in JSON artifacts and never persist tokens.

- [ ] **Step 3: Update the probe orchestration**
  - Send confirmation only after `intent_confirm`.
  - Fetch created proposal/audit/effect evidence with the same tenant-scoped
    authentication used for the input turn.
  - Add a `read_only` accepted result matching the existing handler contract;
    do not invent a proposal requirement for lookup intents.

- [ ] **Step 4: Verify**
  - Run the scorer tests and
    `cd packages/api && npx vitest run test/ai/agents/customer-calling/inapp-adapter.test.ts`.
  - Commit: `test(voice): make top-50 acceptance scoring truthful`.

### Task 2: Operator classifier context and typed failure outcomes

**Files:**
- Modify: `packages/api/src/ai/orchestration/intent-classifier.ts`
- Modify: `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts`
- Modify: `packages/api/src/workers/voice-action-router.ts`
- Modify: `packages/api/src/app.ts`
- Modify: `packages/api/test/ai/orchestration/intent-classifier.test.ts`
- Modify: `packages/api/test/ai/agents/customer-calling/inapp-adapter.test.ts`

**Interfaces:**
- Consumes: authenticated session role/feature context and gateway typed errors.
- Produces: `ClassifyContext` parity across in-app, Twilio, and worker voice
  surfaces plus a typed safe reprompt cause.

- [ ] **Step 1: Pin the eight operator corpus phrases**
  - Add classifier tests for create customer, update customer, customer lookup,
    convert lead, create job, and `INV-0042` invoice update.
  - Assert unauthorized extended/owner context never expands allowed intents.

- [ ] **Step 2: Implement shared context wiring**
  - Thread the existing `extendedIntents` feature gate and authenticated
    owner-session flag into `InAppVoiceAdapter` without treating a `userId` as
    a CRM customer.
  - Align worker context only where it is safe; preserve its current
    authorization gates.

- [ ] **Step 3: Preserve infrastructure failure classes**
  - Replace the in-app adapter’s collapsed catch-to-`score: 0` path with a
    typed, safe reprompt event and metrics/audit-safe reason.
  - Keep semantic low confidence distinct and expose no raw provider payload.

- [ ] **Step 4: Verify**
  - Run classifier, in-app adapter, and router focused tests.
  - Re-record voice-quality cassettes if and only if a corpus-driven prompt
    changes; then run the voice-quality gate with zero cassette drift.
  - Commit: `fix(voice): align operator classifier context and failures`.

### Task 3: Audited idempotent QA fixture catalog

**Files:**
- Create: `fixtures/voice/operator-voice-fixture-catalog.json`
- Create: `packages/api/src/seed/operator-voice-fixture-plan.ts`
- Create: `packages/api/src/seed/operator-voice-fixture-runner.ts`
- Create: `packages/api/scripts/seed-operator-voice-fixtures.ts`
- Create: `packages/api/test/seed/operator-voice-fixture-plan.test.ts`
- Create: `packages/api/test/integration/operator-voice-fixtures.test.ts`
- Create: `packages/api/test/integration/operator-voice-fixture-idempotency.test.ts`
- Create: `docs/runbooks/operator-voice-fixture-seed.md`

**Interfaces:**
- Consumes: explicit `QA_TENANT_ID`, `QA_ACTOR_ID`, Development-target guard,
  and production domain/repository services.
- Produces: stable fixture record IDs and audit events keyed by
  `qa-operator-voice:v1:<key>`.

- [ ] **Step 1: Write fixture-plan unit tests**
  - Assert the catalog contains Khan, Johnson, Mrs Lee, ambiguous Smith,
    Garcia’s Tuesday appointment, `EST-0042`, `INV-0042`, Carlos, and the
    Greenfield lead.
  - Assert all money is integer cents and create-customer test names are not
    pre-seeded.

- [ ] **Step 2: Implement catalog validation and runner**
  - Require tenant and actor IDs; fail closed for non-Development targets
    unless an explicit documented override is set.
  - Use production create/update repositories and audit services; never issue
    raw SQL as the write path.
  - Make reruns look up the stable provenance key before any write.

- [ ] **Step 3: Add real-Postgres integration tests**
  - Run twice and prove stable IDs/no duplicate canonical rows.
  - Resolve every catalog reference through `PgEntityResolver`, including
    surname and document-number forms.
  - Prove each write/audit is tenant-scoped and a different tenant cannot read
    fixture rows.

- [ ] **Step 4: Verify**
  - Run unit tests and the two Docker-gated integration files.
  - Commit: `feat(voice): add audited operator QA fixtures`.

### Task 4: Alias learning lifecycle and alias-first resolution

**Files:**
- Create: `packages/api/src/learning/entity-aliases/pg-entity-alias.ts`
- Create: `packages/api/src/learning/entity-aliases/candidate-service.ts`
- Create: `packages/api/src/proposals/contracts/adopt-entity-alias.ts`
- Create: `packages/api/src/proposals/execution/entity-alias-handler.ts`
- Modify: `packages/api/src/proposals/contracts.ts`
- Modify: `packages/api/src/proposals/proposal.ts`
- Modify: `packages/api/src/proposals/execution/handlers.ts`
- Modify: `packages/api/src/ai/resolution/pg-entity-resolver.ts`
- Modify: `packages/api/src/app.ts`
- Create: `packages/api/test/learning/entity-aliases/candidate-service.test.ts`
- Create: `packages/api/test/proposals/execution/entity-alias-handler.test.ts`
- Create: `packages/api/test/integration/entity-alias-lifecycle.test.ts`
- Create: `packages/api/test/integration/entity-alias-resolution.test.ts`

**Interfaces:**
- Consumes: manual resolver selection/correction and owner approval.
- Produces: candidate `adopt_entity_alias` proposal, active canonical alias
  after approval, and soft-revoked inactive alias after owner action.

- [ ] **Step 1: Pin proposal and repository behavior in unit tests**
  - Normalize aliases, reject invalid/control-character input, deduplicate
    active aliases, and prevent cross-tenant/entity-kind target use.
  - Assert a manual correction produces an approval-gated proposal, never a
    direct canonical alias write.

- [ ] **Step 2: Implement the canonical alias writer and executor**
  - Use the existing `tenant_entity_aliases` RLS table with
    `withTenantConnection`.
  - Register `adopt_entity_alias` in the Zod contract and execution registry.
  - Make execution idempotent through proposal result state, emit audit events,
    and expose an owner-only revoke path.

- [ ] **Step 3: Implement alias-first resolver decoration**
  - Normalize reference, fetch active alias by tenant/kind, validate the
    referenced canonical entity is still active and in tenant, then return
    score `1.0`; delegate to existing pg_trgm resolution on a miss/stale target.
  - Preserve ambiguity as `voice_clarification`.

- [ ] **Step 4: Verify**
  - Run unit tests plus RLS lifecycle/resolution integrations against real
    PostgreSQL.
  - Commit: `feat(learning): add approved alias lifecycle and resolution`.

### Task 5: Voice document, appointment, technician, and read-only resolution

**Files:**
- Modify: `packages/api/src/ai/agents/customer-calling/entity-resolution.ts`
- Modify: `packages/api/src/ai/resolution/pg-entity-resolver.ts`
- Modify: `packages/api/src/workers/voice-action-router.ts`
- Modify: `packages/api/test/ai/agents/customer-calling/entity-resolution.test.ts`
- Modify: `packages/api/test/ai/agents/customer-calling/inapp-entity-resolution-safety.test.ts`
- Modify: `packages/api/test/integration/entity-resolution.test.ts`
- Modify: `packages/api/test/voice/invoice-edit-flow.test.ts`

**Interfaces:**
- Consumes: classified intent plus extracted invoice, estimate, appointment,
  customer, or technician reference.
- Produces: a resolved ID, typed ambiguity clarification, or typed not-found
  result; it never silently selects a fuzzy candidate.

- [ ] **Step 1: Write intent-conditioned resolution tests**
  - Pin `Khan`, `EST-0042`, `INV-0042`, Garcia Tuesday, and Carlos paths.
  - Pin two Smith-like candidates as an ambiguity clarification.
  - Pin new-customer intents to skip customer pre-resolution.

- [ ] **Step 2: Bridge existing document candidate logic into voice**
  - Reuse `candidatesForReference`/document handler semantics rather than
    duplicating SQL.
  - Add exact document-number handling and a real indexed estimate lookup if
    required by the resolver contract.
  - Limit invoice/estimate/technician lookups to compatible intent families.

- [ ] **Step 3: Wire the same safety policy into in-app and worker paths**
  - Feed resolver outcomes into the existing FSM/clarification events.
  - Keep read-only lookup output typed and avoid on-call escalation for normal
    unknown references.

- [ ] **Step 4: Verify**
  - Run focused voice tests and real-Postgres entity-resolution integration.
  - Commit: `fix(voice): resolve operator document and scheduling references`.

### Task 6: Authenticated final acceptance and release evidence

**Files:**
- Create: `docs/verification-runs/operator-voice-50-live-2026-07-22-final.md`
- Create: `docs/verification-runs/operator-voice-50-live-2026-07-22-final.results.json`

**Interfaces:**
- Consumes: authenticated Development QA operator browser session, seeded QA
  tenant, and healthy representative classifier probe.
- Produces: evidence for all 50 workflow IDs and a concise browser recording.

- [ ] **Step 1: Preflight**
  - Run the fixture runner twice, confirm the representative full classifier
    request is healthy three times, and record no secret values.

- [ ] **Step 2: Execute the full corpus**
  - Run every workflow sequentially through the in-app voice API.
  - Validate explicit confirmation behavior, proposal/emergency persistence,
    API read-back, approval’s domain result, audit actor/action/tenant, and
    cross-tenant denial.

- [ ] **Step 3: Capture authenticated browser evidence**
  - Record one complete voice command → proposal card → approve → saved
    job/invoice/appointment → inbox/audit flow.
  - Do not record authentication credentials or unrelated setup.

- [ ] **Step 4: Quality gate**
  - Run `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`,
    lint, unit tests, and affected Docker-gated integrations.
  - Review the final diff, fix findings, commit the evidence, and push.
