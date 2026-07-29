# Rivet Voice Phase 1 — Run Log

Run started 2026-07-29. Branch: `claude/rivet-voice-master-prompt-xwz102` (from `main` @ 5b5538d,
post-PR-784). Master prompt: `projects/rivet-voice-19/master-prompt.md`. Every judgment call made
during this run is logged here, per Guardrail 1 (never ask).

## Judgment calls / decisions

| # | Item | Decision | Rationale |
|---|------|----------|-----------|
| 1 | — | Run started; branch reset to merged main containing the master prompt (PR #784). | The designated branch had no unique commits; the master prompt arrived via PR #784. |

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

(remaining citations verified by the read-only verification agent — report appended below when received)

## C1 red→green transition

(to be recorded when C1 lands)

## Found-by-proof defects

(none yet)
