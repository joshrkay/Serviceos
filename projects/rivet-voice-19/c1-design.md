# C1 — Payload-contract drift test: design (Fable-authored)

**File:** `packages/api/test/proposals/voice-payload-contract.test.ts` (vitest, unit-tier, runs in `npm test`)

**Invariant (per mapped intent):** the payload produced by the REAL drafting task handler, given
resolver-style `existingEntities`, must either
(a) execute cleanly through the REAL execution handler (success, or a wiring-class
`handler_not_wired:*` refusal when constructed dep-less), or
(b) carry honest, non-empty `missingFields` (which `approveProposal` is separately proven to block on).
Any row where `missingFields` is empty AND the execution handler rejects the payload
(validation-class error, e.g. `/^Payload must/`) is a drift failure — the exact B7.4 class.

## Mechanics

- Iterate `INTENT_TO_PROPOSAL_TYPE` from `src/proposals/voice-intent-map.ts` (the single map).
  The test FAILS if a mapped intent has no row in the table (new intents must add a row — that is
  the permanent CI gate) and fails if a row references an unmapped intent.
- Drafting: `buildTaskHandlers` from `ai/orchestration/handler-registry.ts` with a per-row mocked
  gateway (repo convention: `mockGateway(json)` as in `test/ai/tasks/estimate-edit-task.test.ts`)
  plus in-memory repos where the handler needs them to draft. `review_response_proposal` and
  `create_standing_instruction` are constructed the way `voice-action-router.ts:478-484` does.
- Execution: construct the real execution-handler class for the row's proposal type. Prefer
  in-memory repos (`InMemory*Repository`) where they exist so execution completes fully; otherwise
  construct dep-less so the handler acts as a pure payload validator (validation precedes the
  wiring check in every voice-extended handler — verified). Stub structurally-required ctor deps
  (e.g. AddNote's `auditRepo`) with no-op fakes.
- Row shape: `{ intent, message, existingEntities, gatewayJson?, mode: 'resolves' | 'gated' }`.
  - `mode:'resolves'`: assert `missingFields` empty AND execution result is success or
    `handler_not_wired:*`.
  - `mode:'gated'`: assert `missingFields` non-empty (pins today's honest gating — deferred
    intents) OR proposal type degraded to `voice_clarification` whose payload satisfies
    `voiceClarificationPayloadSchema`.
  - Rows in `'resolves'` mode with resolver-style ids: initially `add_note` (RED today — the
    required red→green), `log_time_entry`, `reschedule_appointment`, `cancel_appointment`,
    `confirm_appointment`, `record_payment` (UUID invoiceId via existingEntities…verify),
    `create_customer`, `create_job`, `update_job`, plus LLM-drafting types with canned gateway
    JSON. Everything not provably resolver-completable today starts `'gated'`; focus-item fixes
    flip their rows to `'resolves'` in the same commit as the fix.
- Resolver-style `existingEntities` keys are the seams the router actually threads:
  `technicianId` (U1), `appointmentId`, `jobId`, `customerId`, `invoiceId`, `estimateId` — the
  implementing agent must verify each key against `voice-action-router.ts` (resolution threading
  near :1498) and use only real seams; never invent keys.

## Verification demands on the implementer

1. Run the new test BEFORE any fix: the `add_note` row (mode `'resolves'`) must FAIL with the
   execution handler's `Payload must include a valid targetId UUID…` error. Capture the failing
   output verbatim into `projects/rivet-voice-19/run-log.md` § "C1 red→green transition".
2. Then flip nothing else; the suite's other rows must pass (adjust `mode` per real behavior,
   never by weakening the invariant).
3. `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` green (test files are not
   in the build tsconfig, but any src change would be — none expected here).
4. `npm test --workspace=packages/api` — full unit suite green except the one intended C1 red.
