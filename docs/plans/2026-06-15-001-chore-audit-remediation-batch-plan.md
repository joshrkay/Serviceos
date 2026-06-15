# chore: AI Service OS audit remediation batch (7 workstreams)

**Created:** 2026-06-15
**Depth:** Deep
**Status:** plan

## Summary

Closes the seven gaps surfaced by `docs/feature-workflow-audit-2026-06-15.md`:
activate the built-but-unwired "I'm out" tech-status handler, surface the
P2-035 confidence/ambiguity signals (markers + one-tap picker) that already
ride to the inbox unused, turn the supervisor agent on by default
(advisory + budget-capped), cut the dead `ai/vulnerability` rule-modules and
extend the LLM triage grader to `<Gather>` calls, consolidate the duplicate
digest workers and add an "APPROVE ALL" P2-034 reply, add a held-slot reaper
plus a real conflict-checker integration test, and wire the structured
correction-lesson loop so the digest's "what I learned" reports real lessons.
Each unit is independently shippable; none changes the proposal-approval gate.

## Problem Frame

The audit verified wiring rather than doc claims and found a cluster of
"last-mile" defects: fully-built modules with no call site (`registerTechStatus
Keywords`, `recordCorrectionLessons`/`PgCorrectionLessonRepository`), backend
data emitted but never rendered (`pricingSource`, `catalogResolution`
candidates), a trust mechanism inert by default (supervisor `supervisor_agent`
flag), dead code that contradicts a marketing claim (rule-based
`ai/vulnerability/` + weather), and two redundant digest workers sharing a
duplicated `SWEEP_LOCK` key. These degrade exactly the trust differentiators
that `docs/decisions.md` D-011 commits to (the eleven wave-2 trust stories).
They affect the owner-operator persona directly: missed tech no-shows, hidden
uncertainty, no post-hoc review, stale "I learned" lines.

## Requirements

- R1. The "I'm out" tech-status keyword handler (P6-028) is registered and an
  OUT/SICK/UNAVAILABLE SMS from a verified technician routes end-to-end.
- R2. Proposal cards surface P2-035 per-line `pricingSource` markers + a 4-tier
  confidence signal; ambiguous catalog/entity lines render a one-tap picker
  that patches the draft (never auto-executes).
- R3. The supervisor agent's advisory annotator + downgrade-only policy run by
  default with budget caps, honoring D-004 (never upgrades to auto-approval).
- R4. The dead rule-based `ai/vulnerability/` subsystem + weather stubs are
  deleted; the wired LLM triage grader also runs on `<Gather>` calls.
- R5. The dead P5-020 digest worker is removed (resolving the `SWEEP_LOCK`
  collision); the daily digest gains an "APPROVE ALL" P2-034 reply that
  delegates to the existing batch-approve endpoint.
- R6. A held-slot reaper cancels expired holds; the conflict-checker query is
  pinned by a Docker-gated integration test.
- R7. Structured correction lessons are recorded on proposal execution and
  reverted on undo, so the digest "what I learned" shows real lessons.

## Key Technical Decisions

- **Supervisor stays advisory + downgrade-only (R3).** Turning it "on" means
  flipping the default of the existing `supervisor_agent` gate and provisioning
  `SupervisorRules` budget caps — not building auto-approval. The policy engine
  is already monotone-downgrade (`proposals/supervisor/policy.ts`), so D-004
  holds by construction. (Alternative: build a real second-classifier that can
  *hold* bookings — rejected for this batch as out of scope per the chosen fork;
  the advisory annotator + downgrade policy is the lowest-risk way to satisfy
  locked decision #5 now.)
- **Default-on via service default, gated by an explicit kill-switch (R3).**
  Change `SupervisorPolicyService` to treat "no flag set" as enabled (it already
  defaults `enabled = true` when `isEnabledForTenant` is absent), and keep the
  per-tenant flag as an opt-*out*. Rationale: matches D-011's intent that the
  trust mechanism is on for everyone; per-tenant disable remains for incidents.
- **Cut weather entirely, don't fake it (R4).** The wired LLM grader never has
  locale/weather and the rule-based path is dead. Delete both and remove the
  `weatherUnavailable: true` hardcode's reason-to-exist rather than wiring a
  provider (the chosen fork). (Alternative: real weather provider — rejected:
  external dependency for a signal the launch grader can't consume.)
- **Digest keeps per-item HMAC links AND gains one APPROVE-ALL reply (R5).**
  Per-item one-tap links are correct for a multi-item digest; a single "Y" can't
  disambiguate across items. The backlog's intent (item 6) is an APPROVE-ALL
  token delegating to `/api/proposals/approve-batch`. So we register a
  digest-scoped reply anchor in `proposal_sms_events`, not per-item Y/N.
  (Alternative: replace HMAC links with per-item Y/N — rejected: ambiguous.)
- **Ambiguity-picker resolution patches the draft, never executes (R2).**
  Selecting a candidate writes the chosen catalog item's cents price onto the
  line, clears `missingFields`, recomputes `_meta` confidence, and moves the
  proposal to `ready_for_review` — it does **not** approve. Honors D-004 +
  the catalog-grounding invariant.
- **Reaper cancels, audits, and is leader-locked (R6).** Mirror
  `appointment-reminder-worker.ts`; transition expired holds `scheduled →
  canceled` with `holdPendingApproval=false`, emit an `appointment.hold_expired`
  audit, idempotent by construction (only rows still `hold_pending_approval=true`
  and past `hold_expiry_at`). New lock key `590015`.

## Scope Boundaries

**In scope:** the seven workstreams above, each with unit + (DB-touching)
integration tests, in `/packages` only.

**Non-goals:**
- A real second-classifier that can *hold* bookings (supervisor fork chose
  "annotator on by default").
- A real weather provider / weather-aware triage (vuln fork chose "cut").
- Pg-backing `unavailableBlockRepo` if it is currently in-memory (note it; do
  not expand scope unless an integration test forces it).
- Reworking the per-item HMAC one-tap link UX (kept as-is).
- Brand-voice configurator, negotiation guardrail, dropped-call recovery — other
  D-011 stories, already shipped or out of this batch.

### Deferred to follow-up work
- Dropping the orphaned `digest_entries` table (migration 177) — leave the
  migration in place (additive history is immutable; see migration-discipline);
  only stop writing it. A separate archival/cleanup story can drop it.
- The orphaned `pages/dispatcher/ConversationalIntake*` surface (route it or
  delete it) — tracked, not in this batch.
- Resolving the duplicate `normalizeForMatch` in the catalog modules.

## Repository invariants touched

- **Human-approval gate / no auto-execute (D-004):** U3 supervisor is
  downgrade-only; U2 picker patches to `ready_for_review`, never approves; U5
  APPROVE-ALL reuses the existing batch-approve path (which respects each
  proposal's action class). Honored.
- **Audit events on every mutation:** U1 (tech-status), U6 (`hold_expired`), U7
  (`correction_lesson.applied`/`reverted`) all emit audits; U3 keeps the
  `onDecision` audit.
- **tenant_id + RLS:** U6 reaper and U7 lessons are tenant-scoped; the
  `correction_lessons` table is already FORCE-RLS (migration 185).
- **Integer cents:** U2 picker stamps catalog `unit_price_cents`; U3 budget caps
  are `*_cents`. No floats.
- **LLM gateway only:** U3 annotator, U4 grader, U7 lesson extraction all route
  through `packages/api/src/ai/gateway` (D-005); no provider SDKs added. U4
  *removes* the non-gateway weather HTTP client.
- **Catalog grounding:** U2 picker selects from `catalog-resolver` candidates;
  resolving to a catalog item is exactly the grounding the invariant wants.
- **Zod proposals:** U2/U5/U7 operate on typed proposal payloads; any new field
  (`_meta` already exists) stays Zod-validated.

## High-Level Technical Design

Most units are independent wiring/UI changes. Two have an internal seam worth
noting:

- **U2** splits into (a) markers — pure frontend reading `payload._meta` +
  `lineItems[].pricingSource`; (b) picker — a new backend
  `POST /api/proposals/:id/resolve-line` that consumes
  `sourceContext.catalogResolution[].candidates`, plus the frontend chooser.
  Land (a) first (no API), then (b).
- **U5** = remove dead worker, then add the APPROVE-ALL reply anchor. The reply
  path reuses `proposal_sms_events` (the P2-034 table) with a new digest-scoped
  `kind`, resolved by the existing inbound reply handler.

Sequencing: U1, U2a, U4-delete, U6-reaper, U7 are low-risk and parallelizable.
U3 (default flip) and U5 (transport) are the riskiest — land after the quick
wins so the batch de-risks progressively.

## Implementation Units

### U1. Wire the "I'm out" tech-status keyword handler  (R1 · JTBD #12 · P6-028)
- **Goal:** Register the already-built tech-status handler so OUT/SICK/
  UNAVAILABLE SMS from a verified tech create the unavailable block + reschedule
  proposals.
- **Dependencies:** none.
- **Files:**
  - `packages/api/src/app.ts` (~line 782, immediately after the STOP/START
    `registerKeywordHandler` calls) — add a `registerTechStatusKeywords({...},
    { overwrite: true })` call; all deps (`userRepo`, `settingsRepo`,
    `unavailableBlockRepo`, `proposalRepo`, `appointmentRepo`, `assignmentRepo`,
    `jobRepo`, `customerRepo`, brand-voice `gateway`+`settingsRepo`, `auditRepo`)
    are already in scope; instantiate `PgTechStatusTodayRepository(pool)` /
    in-memory fallback like the DNC repo pattern.
  - `packages/api/src/sms/tech-status/index.ts`, `.../handler.ts` — reference
    only (no change expected); confirm the deps interface matches what `app.ts`
    can supply.
  - **Test:** `packages/api/test/integration/tech-status-sms.test.ts` (new,
    Docker-gated) — drive `dispatchInboundSms` end-to-end through the registered
    handler against real Postgres.
- **Approach:** Mirror `app.ts:775-781` STOP/START registration exactly
  (`registerKeywordHandler(buildXKeywordHandler(deps), { overwrite: true })`).
  The inbound path (`webhooks/routes.ts` → `dispatchInboundSms` →
  `inbound-dispatch.ts` keyword registry) already invokes registered handlers;
  registration is the only missing wire.
- **Patterns to follow:** STOP/START keyword registration (`app.ts:775-781`);
  repo `pool ? new PgX(pool) : new InMemoryX()` pattern.
- **Test scenarios:**
  - Happy path: a technician's `OUT` SMS → unavailable block written +
    `reschedule_appointment` proposals drafted for the day's remaining
    appointments + audit emitted.
  - Anti-spoof: SMS from a non-technician / unknown number → `handled: false`,
    no block, no proposals.
  - Idempotency: a second `OUT` the same tenant-local day is a no-op (the
    `tech_status_today` claim).
  - Registration: assert `registerTechStatusKeywords` actually claims the
    OUT/SICK/UNAVAILABLE keywords in the dispatch registry (guards re-regression
    to unwired).
  - Integration (DB-touching): real Postgres round-trip pins the
    `unavailable_blocks` + `tech_status_today` columns.
- **Verification:** A simulated tech `OUT` SMS in the integration test produces
  a persisted block + reschedule proposals + audit; a non-tech sender does not.

### U2. Inbox confidence markers + ambiguity picker  (R2 · JTBD #2/#7 · P2-035)
- **Goal:** Render the "what I wasn't sure about" signals (per-line
  `pricingSource`, 4-tier confidence) and a one-tap picker for ambiguous catalog
  lines that patches the draft.
- **Dependencies:** none (a) before (b); (b) adds one endpoint.
- **Files:**
  - **(a) markers — frontend only:**
    - `packages/web/src/components/shared/AIProposalCard.tsx` (~lines 51-54,
      204-209) — extend `CONFIDENCE_CONFIG` to 4 tiers (high/medium/low/
      very_low) sourced from `payload._meta.overallConfidence`; render per-line
      `pricingSource` badges (catalog/ambiguous/uncatalogued) + `_meta.markers`.
    - `packages/web/src/components/invoices/InvoiceProposalReview.tsx` (~52-56) —
      same marker treatment for invoice review.
    - **Test:** `packages/web/src/components/shared/AIProposalCard.test.tsx`
      (new) — assert tier colors + marker badges render from `_meta`/
      `pricingSource`.
  - **(b) picker — backend + frontend:**
    - `packages/api/src/routes/proposals.ts` — add
      `POST /api/proposals/:id/resolve-line` (RBAC `proposals:approve`); body =
      `{ lineIndex, catalogItemId }`.
    - `packages/api/src/proposals/resolve-line.ts` (new) — pure-ish service:
      validate the candidate is in `sourceContext.catalogResolution[lineIndex]
      .candidates`, stamp the catalog item's `unitPriceCents` + `pricingSource:
      'catalog'`, clear that line's `missingFields`, recompute `_meta`
      confidence, persist, emit audit, move to `ready_for_review` if no
      remaining `missingFields`.
    - `packages/web/src/components/inbox/AmbiguityPicker.tsx` (new) — mirror
      `ClarificationCard`/`CatalogPicker` one-tap chips; POST to the new endpoint
      with the optimistic-update pattern from `InboxPage.tsx:138-149`.
    - `packages/web/src/components/inbox/InboxPage.tsx` — render the picker when a
      line has `pricingSource: 'ambiguous'`.
    - **Tests:** `packages/api/test/proposals/resolve-line.test.ts` (new, unit);
      `packages/web/src/components/inbox/AmbiguityPicker.test.tsx` (new).
- **Approach:** All data already arrives at the inbox: `_meta` (per
  `proposals/contracts.ts:58-73`), per-line `pricingSource`
  (`shared/contracts/money.ts:43`), and ambiguous `candidates` under
  `sourceContext.catalogResolution` (`catalog-resolver.ts:39-47`). (a) is pure
  rendering. (b) adds the resolve endpoint + chooser; resolution **never
  auto-approves** (D-004).
- **Patterns to follow:** `ClarificationCard.tsx` (one-tap chips),
  `CatalogPicker.tsx` (search→pick), `InboxPage.tsx:138-149` (optimistic POST +
  revert), `catalog-resolver.ts` tiers.
- **Test scenarios:**
  - Markers happy path: a payload with `_meta.overallConfidence='low'` + a
    `pricingSource:'uncatalogued'` line renders the low-tier bar + an
    uncatalogued badge.
  - Markers edge: missing `_meta` → falls back to today's coarse bar (no crash).
  - Picker happy path: choosing a candidate patches `unitPriceCents` +
    `pricingSource:'catalog'`, clears `missingFields`, recomputes `_meta`,
    transitions to `ready_for_review`.
  - Picker guard: a `catalogItemId` not in the line's candidate list →
    400/rejected (no silent off-catalog price; honors grounding invariant).
  - Picker safety: resolving the last ambiguous line does **not** approve a
    money proposal — it stops at `ready_for_review`.
  - Error path: resolve on a non-existent proposal/line → 404; optimistic UI
    reverts on failure.
- **Verification:** In the inbox, an ambiguous estimate shows candidate chips;
  tapping one fills the price and moves the card to ready-for-review without
  sending anything.

### U3. Supervisor agent: default-on advisory annotator + budget caps  (R3 · decision #5)
- **Goal:** Every booking/quote gets the post-hoc advisory review by default,
  with money budget caps, staying downgrade-only.
- **Dependencies:** none.
- **Files:**
  - `packages/api/src/proposals/supervisor/service.ts` (~line 247) — make the
    "no flag provisioned" case resolve to `enabled = true` and treat the
    per-tenant `supervisor_agent` flag as an explicit opt-*out* (kill switch).
  - `packages/api/src/app.ts` (~lines 4341, 4374-4385) — ensure the annotator
    sweep is scheduled whenever `AI_PROVIDER_API_KEY` is present regardless of
    the per-tenant flag default; provision a platform-default `SupervisorRules`
    (daily/per-proposal cents caps + `maxAutoApprovalsPerHour`).
  - `packages/api/src/proposals/supervisor/policies-repo.ts` /
    `budget-counters-repo.ts` — reference; confirm caps are read + counters
    increment.
  - **Tests:** extend `packages/api/test/proposals/supervisor/policy.test.ts`
    and `packages/api/test/workers/supervisor-review-worker.test.ts`; add
    `packages/api/test/integration/supervisor-default-on.test.ts` (new) pinning
    that an unprovisioned tenant gets annotation + cap enforcement.
- **Approach:** The downgrade-only engine, hook, annotator, and counters are all
  built; this unit flips the default and seeds caps. Keep the `onAutoApproved`/
  `recordExecutedProposalSpend` feedback loop intact. Annotator remains advisory
  (writes `payload._meta.supervisorAnnotation`, never changes status).
- **Patterns to follow:** existing supervisor wiring block (`app.ts:4323-4394`);
  `evaluateSupervisorPolicy` monotonicity tests.
- **Test scenarios:**
  - Default-on: a tenant with no flag row gets a `supervisorAnnotation` on a
    `ready_for_review` proposal within a sweep.
  - Downgrade-only invariant: policy never returns a verdict that *raises*
    status (re-assert `capInitialStatus` monotonicity) — D-004.
  - Budget cap: exceeding `dailySpendCapCents` forces `force_review` (caps at
    `ready_for_review`); exceeding `perProposalCapCents` blocks to `draft`.
  - Kill switch: a tenant explicitly disabling `supervisor_agent` gets no
    annotation/caps (opt-out still works).
  - Failure isolation: an annotator LLM error skips that proposal, sweep
    continues.
  - Integration (DB-touching): counters + policy rows round-trip in Postgres.
- **Verification:** With `AI_PROVIDER_API_KEY` set and no per-tenant flag, the
  annotator sweep tags new proposals and a money proposal over the daily cap is
  held at review.

### U4. Vulnerability triage: cut dead code + extend grader to `<Gather>`  (R4 · JTBD #11)
- **Goal:** Delete the unused rule-based subsystem + weather stubs; grade
  `<Gather>` calls with the existing LLM hook so triage isn't streaming-only.
- **Dependencies:** none.
- **Files (delete — confirmed zero non-test importers):**
  - `packages/api/src/ai/vulnerability/signal-extractor.ts`
  - `packages/api/src/ai/vulnerability/detectors/{age,medical,property-type,weather}-detector.ts`
  - `packages/api/src/integrations/weather/{weather-client,pg-weather-cache}.ts`
  - their tests: `packages/api/test/ai/vulnerability/{signal-extractor,detectors}.test.ts`
    (and any weather-cache test). Re-grep each before deleting (per CLAUDE.md).
- **Files (modify):**
  - `packages/api/src/ai/agents/customer-calling/vulnerability-triage-hook.ts`
    (~line 108) — remove the `weatherUnavailable: true` hardcode now that the
    weather path is gone (and any dead import).
  - `packages/api/src/telephony/twilio-adapter.ts` (`_handleGatherLocked`,
    ~lines 1711+, after FSM dispatch / before TwiML finalize) — attach the
    existing `vulnerabilityTriageHook` symmetric to
    `mediastream-adapter.ts:780-795` (fire-and-forget, flag-gated by the hook).
  - `packages/api/src/app.ts` (~line 2391 where `TwilioGatherAdapter` deps are
    assembled) — pass `vulnerabilityTriageHookDep` into the Gather adapter (it is
    currently only passed to the media-streams server at ~2973).
  - **Test:** `packages/api/test/telephony/gather-vulnerability-triage.test.ts`
    (new) — assert a `<Gather>` turn invokes the grader hook; reuse the
    media-streams hook test as the template.
- **Approach:** Deletion is pure hygiene (CLAUDE.md "remove built-but-never-
  wired"). The grader (`vulnerability-grader.ts`) and hook factory are reused
  unchanged — only the attachment point is added to the Gather path. The hook
  already owns its per-tenant `voice_vulnerability_triage` flag gate and
  fail-closed behavior, so Gather grading is additive and safe.
- **Patterns to follow:** `mediastream-adapter.ts:775-795` hook invocation;
  the deterministic safety scan ordering already in `_handleGatherLocked`
  (RV-140) — triage runs after safety, like streaming.
- **Test scenarios:**
  - Gather happy path: a `<Gather>` caller turn with a vulnerability cue invokes
    `gradeVulnerability` and, on an elevated grade, drives `evaluateTriage`.
  - Gather flag-off: with `voice_vulnerability_triage` disabled, no grader call
    (fail-closed, additive).
  - Failure isolation: a grader error in the Gather path is swallowed and the
    turn still produces TwiML.
  - Dead-code removal: a build/typecheck + grep proves no remaining importers of
    the deleted modules (`tsc --project tsconfig.build.json --noEmit` green).
- **Verification:** `tsc` build green after deletion; a Gather-mode test turn is
  graded; no references to `signal-extractor`/weather remain.

### U5. Digest consolidation: remove P5-020 + APPROVE-ALL via P2-034  (R5 · JTBD #7)
- **Goal:** Delete the redundant hourly digest worker (fixing the duplicate
  `SWEEP_LOCK` key) and add a single "APPROVE ALL" SMS reply that delegates to
  the batch-approve endpoint.
- **Dependencies:** remove-worker step lands before the transport step.
- **Files (remove dead P5-020):**
  - `packages/api/src/workers/digest-worker.ts` (delete `runDigestSweep`).
  - `packages/api/src/app.ts` (~lines 4210-4247) — remove the schedule block +
    `PgDigestEntryRepository` instantiation; remove `digest: 590014` from
    `SWEEP_LOCK` (resolves the `hfcrWeeklySend` collision).
  - `packages/api/src/digest/digest-types.ts` — drop `DigestEntry`/`DigestStatus`
    /`DigestSourceData` if now unused (re-grep).
  - `packages/api/test/workers/digest-worker.test.ts` (delete).
  - Leave migration 177 `digest_entries` in place (immutable history); just stop
    writing it (see Deferred).
- **Files (APPROVE-ALL transport):**
  - `packages/api/src/workers/daily-digest-worker.ts` (`buildApprovalLinks`
    ~479-512, and the SMS-send path ~427) — after sending the digest SMS, record
    a digest-scoped `proposal_sms_events` anchor (new `kind`, e.g.
    `digest_approve_all_rendered`) capturing the day's batch-approvable proposal
    ids; keep the per-item HMAC links unchanged.
  - `packages/api/src/proposals/sms/reply-handler.ts` (~481, 564+) — recognize an
    `APPROVE ALL` / `ALL` reply against the digest anchor and delegate to the
    existing `/api/proposals/approve-batch` path for the captured ids.
  - `packages/shared/src/contracts/proposal-sms.ts` — extend `parseProposalSms
    Reply` to classify `ALL`/`APPROVE ALL`.
  - **Tests:** `packages/api/test/workers/daily-digest-worker.test.ts` (extend —
    anchor recorded); `packages/api/test/proposals/sms/reply-handler.test.ts`
    (extend — ALL → batch approve); `packages/api/test/integration/proposal-sms-events.test.ts`
    (extend — digest anchor round-trip).
- **Approach:** Per the decision above, per-item one-tap HMAC links stay (correct
  for multi-item); the P2-034 wiring is a single APPROVE-ALL reply anchored in
  `proposal_sms_events` so identity + idempotency reuse the shipped reply
  handler. APPROVE-ALL reuses batch-approve, which already respects each
  proposal's action class (money/comms never slip through).
- **Patterns to follow:** the `onSmsSent` → `proposal_sms_events` render-record
  seam (`auto-approve.ts:583-589`); `findRecentOutbound` anchor lookup; the
  approve-batch endpoint already used by `ProposalChainCard`.
- **Test scenarios:**
  - Removal: typecheck/build green; `SWEEP_LOCK` has no duplicate; only the
    15-min `runDailyDigestSweep` remains scheduled (assert one digest path).
  - Anchor: sending a digest with N batch-approvable items records one
    `digest_approve_all_rendered` event with those ids + TTL.
  - APPROVE-ALL happy path: owner replies `ALL` from the verified owner phone →
    batch-approve runs for the captured ids; audit emitted.
  - Identity guard: a reply from a non-owner number is ignored.
  - Idempotency: a duplicate `MessageSid` / repeated `ALL` does not double-
    approve.
  - Gating: a money/low-confidence item is excluded from the APPROVE-ALL set
    (reuses the existing confidence + action-class gates).
  - Integration (DB-touching): `proposal_sms_events` digest anchor + consume
    round-trips in Postgres.
- **Verification:** One digest worker remains; an `ALL` reply approves the day's
  eligible items via batch-approve, money/low-confidence excluded.

### U6. Held-slot reaper + conflict-checker integration test  (R6 · JTBD #3)
- **Goal:** Cancel expired holds so they stop polluting raw appointment reads,
  and pin the conflict-checker query against real columns.
- **Dependencies:** none.
- **Files:**
  - `packages/api/src/workers/hold-reaper-worker.ts` (new) — `runHoldReaperSweep`
    mirroring `appointment-reminder-worker.ts`: per-tenant loop, find rows where
    `hold_pending_approval = true AND hold_expiry_at < now` (use the existing
    partial index `idx_appointments_hold_expiry`), transition `scheduled →
    canceled` + `holdPendingApproval=false`, emit `appointment.hold_expired`
    audit.
  - `packages/api/src/appointments/pg-appointment.ts` — add a tenant-scoped
    `findExpiredHolds(tenantId, now)` (or reuse `findByDateRange` + filter); add
    a `releaseExpiredHold` update if not expressible via existing update.
  - `packages/api/src/app.ts` (~1611-1651) — add `SWEEP_LOCK.holdReaper = 590015`
    and a `registerInterval` + `runAsLeader` schedule (15-min cadence).
  - **Tests:**
    - `packages/api/test/workers/hold-reaper-worker.test.ts` (new, unit) — reaper
      logic on mock repo.
    - `packages/api/test/integration/hold-reaper.test.ts` (new, Docker-gated) —
      real Postgres: an expired hold is canceled; a live hold + a normal
      appointment are untouched.
    - `packages/api/test/integration/slot-conflict-checker.test.ts` (new,
      Docker-gated) — pins `DefaultSlotConflictChecker.check` against real
      `PgAppointmentRepository` (the mocked-pool gap CLAUDE.md warns about).
- **Approach:** Lazy read-time filtering stays (defense in depth); the reaper is
  the durable cleanup. Idempotent by construction (only acts on still-expired
  holds). Conflict-checker test creates overlapping rows (active, canceled,
  expired-hold) and asserts the real query filters canceled + expired holds,
  pinning `scheduled_start/end`, `status`, `hold_pending_approval`,
  `hold_expiry_at`.
- **Patterns to follow:** `appointment-reminder-worker.ts` (tenant loop + leader
  lock + summary), `emergency-dispatch-hold.test.ts` / `appointments.test.ts`
  (real-DB hold assertions), the `SWEEP_LOCK` + `runAsLeader` registry.
- **Test scenarios:**
  - Reaper happy path: an appointment with `hold_pending_approval=true` and
    `hold_expiry_at` in the past → `canceled`, flag cleared, audit emitted.
  - Reaper no-touch: a live hold (future expiry) and a confirmed appointment are
    unchanged.
  - Reaper idempotency: a second sweep is a no-op (row already canceled).
  - Conflict-checker integration: overlapping active appointment blocks; a
    canceled one and an expired hold do not (real SQL, real columns).
  - Leader lock: two concurrent ticks don't double-process (advisory lock).
- **Verification:** After a sweep, expired holds are `canceled` in Postgres and
  absent from a raw appointment list; the conflict-checker integration test is
  green against real columns.

### U7. Wire the structured correction-lesson loop  (R7 · correction-loop UX)
- **Goal:** Record structured correction lessons on proposal execution and undo
  them on proposal undo, so the digest "what I learned" shows real lessons
  instead of the chunk-count fallback.
- **Dependencies:** none (independent of the RAG `proposal-correction-worker`,
  which keeps running).
- **Files:**
  - `packages/api/src/app.ts`:
    - Instantiate `PgCorrectionLessonRepository(pool)` (currently never wired).
    - Implement/assemble `ConfigPorts` (`setLaborRateCents`, `setSkuPriceCents`,
      `setBannedPhrases`, `setTemplateWeight`) over the existing settings/catalog
      repos.
    - In the executor `onExecuted` hook (~1500-1532, beside the existing
      `proposal_correction` enqueue, `status === 'succeeded'` branch), call
      `recordCorrectionLessons({ tenantId, sourceProposalId, ownerId, localDate,
      drafts }, { repository, ports, auditRepo })` — `localDate` derived from the
      tenant timezone; `drafts` from the same extraction the RAG worker uses
      (share the extractor in `learning/corrections`).
  - `packages/api/src/proposals/actions.ts` (`undoProposal` ~346-398) — after the
    proposal transitions to `undone`, call `undoCorrectionLesson` for lessons
    linked via `source_proposal_id` (reverse-lookup; no payload change needed).
  - `packages/api/src/digest/digest-builder.ts` (~114-204) — no change; the
    `status='applied'` query already exists and will now return rows.
  - **Tests:**
    - `packages/api/test/integration/correction-loop.test.ts` (extend — assert
      execution writes an applied lesson and the next same-day draft reflects the
      cascaded config; undo reverts it).
    - `packages/api/test/integration/digest-correction-lessons.test.ts` (new) —
      with applied lessons present, the digest "what I learned" shows summaries,
      not the chunk-count fallback.
- **Approach:** All machinery (extractors, applicators, repo, RLS table) exists
  and is integration-tested in isolation; this unit adds the two missing call
  sites + the repo/ports wiring. Lesson application cascades config forward
  (labor rate, SKU price, banned phrases, template weight) — keep it behind the
  same approval/execution gate (lessons are recorded only on *executed*
  proposals, i.e. already human-approved). Errors are logged, never rethrown
  (don't break execution/undo).
- **Patterns to follow:** the existing `onExecuted` enqueue block; the
  integration test in `test/integration/correction-loop.test.ts`; D-013's
  fail-closed config precedent for cascaded settings.
- **Test scenarios:**
  - Happy path: executing a corrected estimate (owner edited labor rate) records
    an `applied` lesson + `correction_lesson.applied` audit; the next same-day
    draft uses the new rate.
  - Undo: undoing that proposal reverts the lesson (`correction_lesson.reverted`
    audit) and the config returns to prior.
  - Digest: with applied lessons for the day, "what I learned" lists summaries;
    with none, it falls back to chunk-count (unchanged).
  - No-op: a clean approval (no drafted-vs-executed diff) records no lesson.
  - Failure isolation: a lesson-record error does not fail the execution.
  - Integration (DB-touching): real Postgres pins `correction_lessons` columns +
    RLS (the table is FORCE-RLS).
- **Verification:** Execute a corrected proposal → an applied lesson row + a
  forward-applied config change; the digest reports the real lesson; undo
  reverts both.

## Risks & Dependencies

- **U3 default-on blast radius:** flipping the supervisor default touches every
  tenant. Mitigate with conservative platform-default caps and the retained
  per-tenant kill switch; the annotator is advisory (no status change) and the
  policy is downgrade-only, so the worst case is "more proposals held for
  review," never an unwanted auto-approval.
- **U5 worker removal:** ensure nothing else imports `digest-worker.ts` /
  `DigestEntry*` before deleting (re-grep); the `digest_entries` table stays
  (immutable migration history) — only writes stop.
- **U4 deletions:** re-grep each module immediately before deleting (CLAUDE.md);
  a stale importer would break the `tsconfig.build.json` typecheck — which is the
  gate that proves the removal is safe.
- **Build gate:** every unit must pass `cd packages/api && npx tsc --project
  tsconfig.build.json --noEmit` + the named unit/integration tests before review.

## Open Questions (deferred to implementation)

- **U2/U7 extraction reuse:** the exact shared extractor signature feeding both
  the RAG `proposal-correction-worker` and `recordCorrectionLessons` (`drafts`)
  — confirm at implementation whether one extractor call can serve both or each
  needs its own projection.
- **U5 new `kind` value:** the precise enum string for the digest APPROVE-ALL
  anchor in `proposal_sms_events` (`digest_approve_all_rendered` is a
  placeholder) — pick to match the existing `kind` naming + any DB CHECK.
- **U6 expiry-find method:** whether to add `findExpiredHolds` or filter
  `findByDateRange` — decide against the real query plan using the partial index.
- **U3 caps source:** whether platform-default `SupervisorRules` live in env, a
  constant, or a seeded `supervisor_policies` row — choose per ops conventions.
