# Rivet Voice Phase 1 — Run Log

Run started 2026-07-29. Branch: `claude/rivet-voice-master-prompt-xwz102` (from `main` @ 5b5538d,
post-PR-784). Master prompt: `projects/rivet-voice-19/master-prompt.md`. Every judgment call made
during this run is logged here, per Guardrail 1 (never ask).

## Judgment calls / decisions

| # | Item | Decision | Rationale |
|---|------|----------|-----------|
| 1 | — | Run started; branch reset to merged main containing the master prompt (PR #784). | The designated branch had no unique commits; the master prompt arrived via PR #784. |
| 2 | D-013 | The hard stop is the **voice-approval** D-013 (PRD-v4-part-E-state.md:282), NOT `docs/decisions.md`'s D-013 (QuickBooks sync status) — a decision-ID collision across two documents. Enforcement sites pinned: `voice-action-router.ts:1321-1339`, `routes/assistant.ts:1058-1090`, ownerSession origin in `create-voice-turn-processor.ts`, task-level re-check in `proposal-approval-task.ts`. Any diff touching these is reverted. | Ambiguity resolved by evidence, not assumption; recorded so a reviewer can check diffs against the right sites. |
| 3 | Part F | Part F had no file. Created `docs/PRD-v4-part-F-decisions.md` with entries F-1…F-6 (B9.1 issuance PROPOSED, B1.18 lock-as-tap PROPOSED, B5.5 direct-act RECORDED, B7.5 billing-document landing RECORDED, B1.19 wizard-default RECORDED, deferred-set integrity RECORDED). | The master prompt requires Part F entries; a register that doesn't exist can't hold them. PROPOSED vs RECORDED distinguishes "needs product-owner ratification before it can move a score" from "scoping call inside this run's mandate." |
| 4 | Fixtures | Regression/unit/integration tests land in the SAME commit as their fix (Guardrail 5, strictly). Voice-quality **rubric fixtures** land in a grouped fixtures commit rather than strictly per-item. | Guardrail 5's same-commit rule is about proof of the fix; the rubric suite is additive eval coverage with its own runner (`npm run voice-quality`) and cassette conventions. Logged so the deviation is visible, not silent. |
| 6 | B1.19 (scope) | **The five `onboarding_*` proposal types have NO execution handler.** Building them is IN SCOPE for B1.19. | Found by exploration, verified directly by the orchestrator: `onboarding_tenant_settings`, `onboarding_service_category`, `onboarding_estimate_template`, `onboarding_team_member`, `onboarding_schedule` are created (`onboarding-conversation.ts:351-456`), prioritized (`prioritization.ts:81-85`) and time-credited (`reports/time-credits.ts:42-46`), but `createExecutionHandlerRegistry` registers none of them — `executor.ts:167-173` throws `HANDLER_NOT_FOUND` (400). So today a tenant can talk through onboarding, approve all five cards, and configure **nothing**. That is the same "approves, then fails at execution" class as B7.4 — the exact failure the north star forbids — and AC-5's "same tenant configuration the wizard produces … asserted against real Postgres" is unachievable without the apply step. Rung 5 by the MISSION's own definition requires `execution → persisted row + audit event`. Flagged as a **found-by-exploration defect**, not silently absorbed. |
| 7 | B1.19 (parity) | The apply handlers write through the SAME functions the wizard's routes use (`PUT /api/onboarding/identity` → tenant_settings upsert; `POST /api/onboarding/pack` → catalog/template seed under the per-(tenant,pack) advisory lock), never re-implementing them. | Parity of outcome is only meaningful if both surfaces share one write path; two implementations would drift exactly the way the three intent maps did. The timezone regression pin (`routes/onboarding.ts:230-234`, never write a fallback zone) is thereby inherited rather than re-asserted by copy. |
| 5 | Baseline | Docker-gated integration baseline captured BEFORE any change: **179 files / 925 tests / 0 failures** (2026-07-29 04:04-04:06). Unit baseline: **1050 files / 11977 tests**. Voice-quality rubric v1 baseline (CI, post-B7.4): **launch gate PASS, 67/67 = 100%** against a 90% threshold, every bucket meeting its own floor. | Every later count is judged against a measured baseline, not a remembered one. Guardrail 6 requires the rubric to stay ≥ current thresholds, so "current" is pinned here with a number. |

## Break-point re-verification (pre-change)

_Every `file:line` cited in the master prompt is re-verified below before any change. Status:
CONFIRMED (matches the cited break), MOVED (exists but at different lines), or CHANGED (code has
materially changed since Part E — noted)._

Verified directly by the orchestrator (Fable):

| Citation | Status | Evidence |
|---|---|---|
| `voice-extended-tasks.ts:460-484` add_note sets only `targetReference`, empty `missingFields` when a reference exists | CONFIRMED | `AddNoteTaskHandler.handle` at 460-484: `payload.targetReference = ee.jobReference ?? ee.customerName`, never `targetId`; `missing` stays `[]` when a reference or `noteTargetKind` exists |
| `voice-extended-handlers.ts:94-99` handler requires UUID `targetId` | CONFIRMED | `AddNoteExecutionHandler.execute` 92-97: `if (!isUuid(payload.targetId)) return { success:false, error:'Payload must include a valid targetId UUID …' }` |
| `proposals/actions.ts:214-219` approveProposal throws on missingFields | CONFIRMED | `missingFieldsFor(proposal)` guard → `ValidationError('Cannot approve proposal with unfilled required fields …')` |
| `voice-extended-tasks.ts:378` reassign pushes `appointmentId` unconditionally | CONFIRMED | `ReassignAppointmentTaskHandler.handle` 377-378: `missing.push('appointmentId')` with no `existingEntities.appointmentId` check |
| `voice-extended-tasks.ts:667` nudge `missing=['estimateId']` unconditional by design comment | CONFIRMED | `SendEstimateNudgeTaskHandler.handle` 661-667 + design comment 662-666 |
| `voice-intent-map.ts` single source of truth, 35 intents, `voice_clarification` default | CONFIRMED | `INTENT_TO_PROPOSAL_TYPE` 54-93; lookup_* deliberately omitted (P11-001 comment) — the documented non-proposal set precedent for B5.5's `en_route` |
| Drafting registry | CONFIRMED | `ai/orchestration/handler-registry.ts buildTaskHandlers` covers 33 mapped types; `review_response_proposal` + `create_standing_instruction` registered surface-side in `voice-action-router.ts:478-484`; synthetic `_complaint`/`_negotiation` keys 490-507 |
| Execution handlers validate payload BEFORE repo use | CONFIRMED (C1 design hinge) | `AddNoteExecutionHandler` / `RecordPaymentExecutionHandler` / `SendEstimate*` all validate payload shape first, then `handler_not_wired:*` / synthetic-id path — dep-less construction turns them into pure payload validators, which is what C1 exploits |

Verified by the read-only verification agent (2026-07-29, full report in agent transcript; deltas that matter):

| Citation | Status | Correction / key fact |
|---|---|---|
| `voice-extended-handlers.ts:94-99` | MOVED | UUID gate actually at 92-97, same content |
| `complaint-task.ts:94-97` | CONFIRMED | Tiered pattern 92-108: jobId → resolvedCustomerId → free-text reference → gate |
| `voice-action-router.ts:1498-1500` | CONFIRMED | existingEntities threads customerId/jobId/invoiceId/estimateId/appointmentId/technicianId (1490-1508) |
| `pg-entity-resolver.ts:397-437` | CONFIRMED | `resolveUpcomingAppointment` tenant-wide soonest-first, reached when no date phrase AND no job anchor (252-269) |
| `dispatch/routes.ts:262-310` | CONFIRMED | POST /appointments/:id/en-route → `DelayNotificationCoordinator.enqueueEnRouteNotice` (delay-notifications.ts:419-498), audit `appointment.en_route_triggered` (routes.ts:41-59), branded `renderEnRouteTemplate` ETA SMS, DNC-suppressed |
| `tech-status-event.ts:70` | CONFIRMED | `packages/shared/src/contracts/tech-status-event.ts` — `TECH_STATUS_KEYWORDS = ['out','sick','unavailable']` |
| shared `contracts.ts:306-329` | CHANGED (path) | `lineItemSchema` is `packages/shared/src/contracts/money.ts:20-47`; no `unit` field — confirmed. `billing-engine.ts` LineItem 19-58 (api/src/shared), no unit. `catalog-resolver.ts:558` drops catalog unit — confirmed |
| `estimate-editor.ts:30-44` | CONFIRMED | `packages/api/src/estimates/estimate-editor.ts` (NOT proposals/estimate-editor.ts — two files share the name) |
| BrandVoice | CONFIRMED | Six fields: register, opening_lines, sign_off, banned_phrases, persona_name, pronoun. `brand_voice_locked` schema.ts:5948. Versions: pg-brand-voice-repository.ts (INSERT :137); cooldown BRAND_VOICE_COOLDOWN_MS=15min, BrandVoiceCooldownError, TOCTOU-safe under row lock |
| onboarding FSM | CONFIRMED | States: profile/category/pricing/team/schedule_capture, review, completed, capped — `tools` missing as cited. Route mounted app.ts:5491-5499 → `routes/onboarding-conversation.ts`. Zero web callers — confirmed |
| D-013 sites | PINNED | Recorder gate `voice-action-router.ts:1321-1339` (RV-071/225); in-app `routes/assistant.ts:1058-1090` (`assistant.voice_approval_refused`); ownerSession origin `create-voice-turn-processor.ts` (multiple), task-level re-check `proposal-approval-task.ts`. NOTE: docs/decisions.md has an UNRELATED D-013 (QuickBooks) — ID collision, the hard stop is the voice-approval one per PRD-v4-part-E-state.md:282 |
| `decideInitialStatus` | CONFIRMED | proposal.ts:436+; `actionClassForProposalType` 282-418; money/irreversible never auto-approve |
| Voice-quality rubric | CHANGED (path) | Rubric suite = `packages/api/src/ai/voice-quality/` (rubric.v1.json, runner, cassette corpus `src/ai/voice-quality/corpus/cassettes/*.json`, tests `test/voice-quality/corpus/*.test.ts`, run via `npm run voice-quality`). `packages/voice-eval` is a separate standalone harness. `test:voice-fixtures` = classifier launch fixtures from repo-root `fixtures/ai/transcripts/*.json` + `test/voice/launch-slots.test.ts` |
| Integration runner | CONFIRMED | testcontainers pgvector/pg16, global-setup applies migrations, honors EXTERNAL_TEST_DB_URL; suite includes voice-inbound-appointment, estimate-nudge, issue-invoice-conversation-resolution, onboarding-conversation (:128 cross-tenant negative) |

**Verdict: every break point the master prompt relies on is real at HEAD. No CHANGED-in-substance findings; the run proceeds on the master prompt as written.**

## C1 red→green transition

**2026-07-29.** `packages/api/test/proposals/voice-payload-contract.test.ts` added — the
table-driven payload-contract drift test (design: `projects/rivet-voice-19/c1-design.md`), one row
per intent in `INTENT_TO_PROPOSAL_TYPE` (35 rows), completeness-checked both directions against the
map. 20 rows are `mode:'resolves'` (drafts ungated with resolver-style `existingEntities` AND the
real execution handler accepts the payload); 15 are `mode:'gated'` (today's honest gating, pinned).

The `add_note` row is the required RED — it drafts through the REAL `AddNoteTaskHandler` with
`existingEntities: { jobId, jobReference: 'the Henderson job', noteTargetKind: 'job', noteBody: ... }`,
producing `missingFields: []` (the handler sets `payload.targetReference` but never
`payload.targetId`), then executes through the REAL `AddNoteExecutionHandler` (constructed
dep-less, `auditRepo` stubbed since it's a structurally-required ctor param). Verbatim failing
assertion, captured before any other change:

```
FAIL  test/proposals/voice-payload-contract.test.ts > C1 — voice payload-contract drift (per mapped intent) > add_note (add_note, resolves) — RED — see B7.4 / run-log.md "C1 red→green transition". AddNoteTaskHandler sets payload.targetReference but never payload.targetId, so missingFields is empty while AddNoteExecutionHandler demands a targetId UUID.
AssertionError: C1 DRIFT for 'add_note': missingFields was empty but the real execution handler rejected the payload — Payload must include a valid targetId UUID (resolve targetReference at review time first): expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ test/proposals/voice-payload-contract.test.ts:744:9
    742|         result.success || isWiringRefusal,
    743|         `C1 DRIFT for '${row.intent}': missingFields was empty but the…
    744|       ).toBe(true);
       |         ^
    745|     });
    746|   }

Test Files  1 failed (1)
     Tests  1 failed | 35 passed (36)
```

All 35 other rows pass (34 assertion rows + the completeness-check row). One deviation from the
design's suggested `'resolves'` set: `record_payment` moved to `'gated'` —
`RecordPaymentTaskHandler` never reads `existingEntities.invoiceId` (the real resolver seam) at
all, only `ee.jobReference`/`ee.customerName` (classifier free text), so `invoiceId` stays gated
even with a resolver-verified id in `existingEntities`; it is not provably resolver-completable
today (a same-class latent gap to `add_note`, out of this story's scope — noted in the row's
`note` field for the next agent).

Green arrives with the B7.4 fix (a separate work item) — do not "fix" `AddNoteTaskHandler` here to
make this row pass; the row is the point.

**GREEN (2026-07-29, after the B7.4 fix):** same command →
`Test Files 1 passed (1) · Tests 36 passed (36)`. The transition is therefore observed in both
directions. C1 and the fix ship in ONE commit so `main` never carries a red test; the permanent
in-CI proof of the red state is the regression pin in
`test/ai/tasks/add-note-voice-task.test.ts` ("REGRESSION PIN (B7.4): the pre-fix payload shape is
no longer producible"), which asserts the exact `targetReference` + no `targetId` + empty
`missingFields` combination can no longer be produced.

**`record_payment` deviation, adjudicated:** the C1 agent's finding is correct and is the same
latent class as B7.4 — `RecordPaymentTaskHandler` ignores the resolver's `invoiceId` seam. It is
**left gated and NOT fixed in this run**: `record_payment` is money movement, it is not in the
focus eight, and the deferred list is explicit that C1 *pins* current honest gating for
non-focus intents rather than fixing them. Gating is the safe state (the proposal cannot approve),
so no user-visible loss occurs — unlike B7.4, where the gate was missing entirely. Recorded here
as a known follow-up for the next phase.

## Found-by-proof defects

| # | Item | Defect | Disposition |
|---|------|--------|-------------|
| P-1 | B1.19 | The five `onboarding_*` proposal types have no execution handler; `executor.ts:167-173` throws `HANDLER_NOT_FOUND`. Approving a completed conversational onboarding configures nothing. | Found by exploration (not by a test). In scope — see decision #6. |
| P-2 | B7.4 | `ComplaintTaskHandler` (`complaint-task.ts:98-103`) carried the **same** silent-loss defect on its two free-text tiers: `targetReference` set, `missingFields` left empty → approvable → `AddNoteExecutionHandler` refuses on the UUID check. A complaint note dictated on a call was lost the same way a job note was. | **Fixed in B7.4's commit** — a complaint note *is* an `add_note` proposal, so fixing the contract without fixing this producer would have left the hole open. C1 does not cover it (`_complaint` is a synthetic key outside `INTENT_TO_PROPOSAL_TYPE`), so three regression tests pin both gated tiers and the resolved-id path. |
| P-4 | B1.19 | `OnboardingConversationOrchestrator.emitProposalBatches` (`onboarding-conversation.ts`) collected only the category/team/schedule proposal IDs into its return value, silently dropping `onboarding_tenant_settings` and `onboarding_estimate_template`. Both rows were persisted but no caller — including the review inbox — could see them. | **Fixed** (found by the parity test failing three ways). All persisted IDs are now collected. |
| P-5 | B1.19 | The team extractor's per-member `needsClarification` was hardcoded `false`, so an ambiguous role ("me and my cousin Carlos") never triggered the clarification loop the PRD requires. | **Fixed** — per-member confidence gate now actually fires; AC-4's scripted test proves the follow-up question is asked and `clarificationCountByState` increments. |
| P-3 | Item 9 → B4.7 | `RescheduleAppointmentTaskHandler` and `CancelAppointmentTaskHandler` never read `existingEntities.appointmentId`; they re-resolved via `resolveActiveAppointmentId`, which only answers when the tenant has **exactly one** active appointment. In any shop with two jobs on the books, "Move the Garcia job to Thursday at 10" gated as unresolvable — even though the router had already disambiguated the reference and threaded the correct id. Found empirically: a shared two-appointment fixture made the second test fail with `Payload must include a valid appointmentId`. | **Fixed** — resolver-verified id now wins, single-active fallback retained for the SCH-03 first-turn case. Five regression tests, the key one using the two-appointment fixture that used to fail. Same defect class as B5.3's reassign gate. |

## Item completion ledger

| Item | Status | Proof |
|------|--------|-------|
| B7.4 | ✅ green | `AddNoteTaskHandler` resolves the target from `existingEntities` and gates honestly (`voice-extended-tasks.ts`). Proof: 9 unit tests + regression pin (`test/ai/tasks/add-note-voice-task.test.ts`), 3 complaint-path regressions, C1 row red→green, and `test/integration/add-note-voice-execution.test.ts` (real Postgres: note row with the verbatim dictated body on the job · exactly one note audit event with actor · cross-tenant negative). AC-3 (ambiguity → `voice_clarification`) is satisfied upstream: the router short-circuits an ambiguous reference to a clarification picker before drafting, so no ambiguous reference reaches this handler — the handler-level guarantee proven here is that an *unresolved* target always gates. |
| B4.7 | ✅ restored | `test/integration/reschedule-appointment-voice.test.ts` (3) + `cancel-appointment-voice.test.ts` (4): task-produced payloads through approval and the production registry; row change · one audit event with the right actor · cross-tenant negative; cancel additionally sweeps every trust tier × confidence × supervisor mode/presence × threshold override through `decideInitialStatus` proving the irreversible class never auto-approves, with a positive control so the sweep can't pass vacuously. Plus the P-3 fix this proof surfaced. |
| B7.6 / B8.1 / B9.1 (proof legs) | ✅ restored | `draft-estimate-execution.test.ts` (catalog-grounded integer-cents lines — the LLM's 14950¢ overridden by the catalog's 15000¢ · one `estimate.created` audit · cross-tenant negative); `update-estimate-execution.test.ts` (first-ever coverage of `UpdateEstimateExecutionHandler` itself · totals/version recomputed · `estimate.updated` audit · cross-tenant negative both by scoped read and a forged cross-tenant execute); `issue-invoice-conversation-resolution.test.ts` extended with B9.1's missing cross-tenant negative on the issue transition. **B9.1's rung 5 still depends on Part F entry F-1 being ratified** — the proof leg alone does not restore it. |
| B5.3 | ✅ green | Reassign consumes the resolver-verified `appointmentId` instead of gating unconditionally. Resolver fix scoped exactly as designed: a NAMED reference that matched nothing no longer falls through to the tenant-wide soonest-upcoming branch, while a genuinely nameless reference still resolves (SCH-03 unbroken) — both sides pinned. 3 classifier launch fixtures decide the minimal pair by test (`reassign-carlos-johnson-job`, `reassign-carlos-garcia-instead-of-me`, `add-crew-carlos-garcia-appointment`). C1 row flipped `gated`→`resolves`. Integration: `test/integration/reassign-appointment-voice.test.ts`. |
| B1.19 (backend half) | ✅ green | **The found-by-proof gap (P-1) is closed**: all five `onboarding_*` execution handlers exist (`proposals/execution/onboarding-handlers.ts`), are registered (`handlers.ts:1399-1416`) and wired in `app.ts`. Each writes through the SAME shared function the wizard's routes use — `upsertIdentityFields` (new, atomic partial upsert) and `activatePackWithSeed` (extracted from `POST /pack`) — so the never-guess-a-timezone rule is inherited, not recopied. `tools` capture state added (AC-3). Proof: `test/integration/onboarding-conversation-parity.test.ts` drives a scripted conversation AND the real wizard routes for identical facts and compares the resulting configuration, + audit events + cross-tenant negative (14/14 with the existing suite). AC-4 clarification-loop test added; the team extractor's per-member confidence gate was hardcoded `false` and now actually fires. **Second found-by-proof defect (P-4), fixed:** `emitProposalBatches` silently dropped the `onboarding_tenant_settings` and `onboarding_estimate_template` proposal IDs from its return value — both persisted but invisible to any caller (review inbox included). **Honest partials, not claimed as parity:** team members return `handler_not_wired` with an actionable message (invitations need an email voice can't capture; the wizard has no team step to match), and no `onboarding_*` payload carries a timezone so only the safe half is asserted (wizard stores the confirmed value; conversation leaves NULL). |
| B5.5 | ✅ green | `en_route` intent (taxonomy 1.4.0, coordinated pins updated) + `dispatch/en-route-voice.ts` + `sms/tech-status/en-route-keyword.ts`. Both legs call `triggerEnRoute`, extracted from the app-button route so all three surfaces share ONE implementation. Speaker-scoped: `assignmentRepo.findByTechnician` is the only candidate query, asserted on call args. Confidence floor needed no new code — `classifyIntentRaw`'s existing 0.6 threshold already gates low-confidence intents to `unknown`; pinned by fixture. Idempotence is the coordinator's existing `${appointmentId}:en_route` key in `delay_notice_state` (verified, not invented). Proof: 12 unit + 7 SMS + 3 integration (real Postgres: audit with tech actor · dispatch row · idempotence · cross-tenant negative) + 3 launch fixtures incl. the "running 20 minutes late" → `notify_delay` negative pin. `en_route` documented in the non-proposal set (catalog §F); both contract tests green. |
| B1.19 (web half) | ✅ green | `ConversationStep.tsx` + `useOnboardingConversation.ts` wire the FIRST client of `POST /api/onboarding/conversation/turn` (the engine had zero). Mic via the existing `useConversationVoice` seam (barge-in, silence timeout) plus an always-present typed fallback so the journey is drivable without a mic in CI. Form wizard stays default + only edit surface; B1.20 guard tests untouched and green (10/10). Session **and transcript** survive refresh — the turn response carries only the latest assistant message, so history is persisted client-side per tenant and re-synced on resume without duplicating the tail bubble. Playwright: 11-exchange journey (in [10,15]) across all six capture states with 3 clarifications, ending at CRM unlocked; plus 320px/390px overflow + 44px tap-target specs and a jsdom class-contract test. Web suite **258 files / 1845 tests green**, `tsc --noEmit` clean. |
| B6.3 | ✅ green | `test/integration/log-time-entry-execution.test.ts` — 4 assertions (row 120min + resolved jobId · exactly one `time_entry.logged_completed` audit with actor · cross-tenant scoped-read negative · `getJobProfit` labor rollup). Drafts through the REAL `LogTimeEntryTaskHandler` with resolver-style `existingEntities`, executes through the production registry. Integration suite 180 files / 929 tests (baseline 179/925 — adds exactly 1 file / 4 tests, no regressions). `tsc --project tsconfig.build.json` clean. No defects found. Cross-tenant form matches the bar Part E already accepted at rung 5 (`draft-invoice-execution.test.ts:194-198`). |
