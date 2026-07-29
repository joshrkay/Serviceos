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
| 5 | Baseline | Docker-gated integration baseline captured BEFORE any change: **179 files / 925 tests / 0 failures** (2026-07-29 04:04-04:06). | Every later integration count is judged against a measured baseline, not a remembered one. |

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

(to be recorded when C1 lands)

## Found-by-proof defects

(none yet)
