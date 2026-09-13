# In-app 50-case register → 50/50 (R0–R4)

**Created:** 2026-09-09 · **Status:** executing · **Branch:** `claude/50-cases-orchestration-m7c5yq`
**Register:** `fixtures/voice/inapp-50-cases.json` (R0 deliverable — 50 cases, severity map, scripted classifier output, machine-checkable expectations)
**Results:** `docs/verification-runs/inapp-50/run-*.json` + `latest.json` · dashboard `dashboard.html` · triage `triage-YYYY-MM-DD.md`

## Why this shape

The prior operator-voice-50 gates (v2–v6 corpora, `scripts/probe-operator-voice-50-live.mjs`) are LIVE probes: they need a deployed API, a Clerk JWT and a working LLM provider, and their history is dominated by infra noise (`LLM_PROVIDER_UNAVAILABLE`, breaker cascades, classify deadlines). They also score PASS as "any proposal id came back", so a booking whose payload is missing `scheduledStart` still counted.

This plan adds a **hermetic, deterministic** register that runs in CI in seconds against the REAL in-app pipeline — `InAppVoiceAdapter` → `CallingAgentStateMachine`/`transitions.ts` → `resolveSchedulingEntities` → `buildVoiceProposalPayload` → `InMemoryProposalRepository`, plus the shared lookup dispatch — with only the LLM classifier scripted per case. It scores the ACTION PATH (`intent_detected → entities_resolved → confirmation_asked → proposal_created → committed`, or `intent_detected → answered` for lookups) and records a root cause for every non-PASS. The same case file loads into the live probe (`cases[]` with `id/op/utterance/expectProposal/fixtureRefs/tags/disambiguationFollowUp`) so live runs and hermetic runs share one register.

## Gates (R3)

Release gate (`npm run check:inapp-50` at repo root → `scripts/inapp-50/release-gate.mjs`) fails unless, on `latest.json`:

1. `summary.PASS === 50`.
2. Zero **critical** cases in cluster `scheduling` / `search` / `confirmations` whose final stage is `intent_detected` with no proposal or answer (`intent_capture_only`).
3. Zero FAIL verdicts (contract violations / exceptions) at any severity.

## Harness (owner: Agent A)

Layout (all new files; nothing in the adapter changes for the harness itself):

```
packages/api/src/ai/voice-quality/inapp-50/
  register.ts        # load + validate fixtures/voice/inapp-50-cases.json (zod), types
  world.ts           # in-memory fixture world: repos + FixtureEntityResolver seeded from
                     #   fixtures/voice/operator-voice-fixture-catalog.json + register.harnessSeeds
  runner.ts          # runCase(): builds InAppVoiceAdapter per case, drives turns, returns CaseResult
  score.ts           # verdict + stage + rootCause derivation (pure; unit-tested)
  report.ts          # RunResult JSON writer (docs/verification-runs/inapp-50/), console table
packages/api/scripts/run-inapp-50.ts          # tsx CLI: --batch N (10 cases/batch, 1..5), --only k1,k2, --write
packages/api/test/voice/inapp-50-register.test.ts   # vitest gate: runs all 50, asserts gate rules
packages/api/test/ai/voice-quality/inapp-50/score.test.ts  # pure scoring unit tests
```

Adapter construction per case (same shape `app.ts` uses; see `test/ai/agents/customer-calling/inapp-adapter.test.ts`):
`new InAppVoiceAdapter({ store: new VoiceSessionStore({ startInterval: false }), gateway: scriptedGateway(case.llm), proposalRepo: guardVoiceProposalContract(new InMemoryProposalRepository()), auditRepo, onCallRepo, settingsRepo (timezone America/Phoenix), customerRepo, catalogRepo, entityResolver: world.resolver, extendedIntentsEnabled: async () => true, ownerLookupResolver / lookups: world bundle })`, `startSession(tenant, user, undefined, 'owner')`.

Turn driver (mirrors `runVoiceSessionProbe` in the live probe): send `case.turns ?? [case.utterance]` in order; then, unless `autoConfirm === false`: while `state === 'entity_resolution'` and `disambiguationFollowUp` → send it (max 2); while `state === 'entity_confirm'` → "yes"; while `state === 'intent_confirm'` → "yes". Hard cap 6 turns per case. Every turn records `{ text, stateBefore, stateAfter, ttsText, sideEffectTypes, auditEventTypes, proposalIds, trace? }` (`trace` is the adapter's `HandleInputResult.trace` once Agent C lands it; derive from side effects until then).

### Stage (furthest reached)

| stage | evidence |
|---|---|
| `none` | turn threw / HTTP 5xx |
| `intent_detected` | audit `agent.calling.intent_capture.intent_classified` or session-bus `intent_classified` with confidence ≥ 0.75 |
| `entities_resolved` | audit `entity_resolution.entity_resolved` / `entity_confirm_affirmed` |
| `clarification_asked` | audit `entity_resolution.entity_ambiguous` / `entity_confirm_candidate`, or lookup which-one line |
| `confirmation_asked` | state `intent_confirm` reached |
| `proposal_created` | `proposalIds.length > 0` |
| `committed` | audit `proposal_draft.proposal_queued` / state `closing` with a proposal |
| `answered` | lookup answer spoken (`lookup_executed` bus event or `tts_play` from lookup surface), no proposal |
| `escalated` | state `escalating` / `notify_oncall` |
| `guarded` | `confirm_without_pending`, refusal, language switch |

`intent_capture_only` ⇔ furthest stage ∈ {`intent_detected`, `clarification_asked`, `confirmation_asked`} AND no proposal AND no answer at the end of the case.

### Verdict

- **PASS** — `expect` fully satisfied (outcome, proposalType, status when given, `payloadContains` with fixture keys resolved to seeded ids, `payloadHas`, `missingFieldsContains`, `proposalCount`, `spokenMatches` / `forbidSpoken` (regex, case-insensitive, against the LAST spoken line unless `anyTurn`), `requireSideEffects` / `forbidSideEffects`, `allowedStates`, `stateAfterTurn`, `scheduledStartWeekday` (ISO weekday in tenant tz), `requireClarificationTurn`, `forbidProposalTypes`). A voice-proposal contract violation (`voiceProposalContractViolation`) on ANY minted proposal is a FAIL regardless.
- **PARTIAL** — intent detected but the case ended `intent_capture_only`, or a proposal exists but an expectation on it is unmet (wrong status / gated where not expected / payload key missing).
- **DEGRADED** — a fallback path replaced the expected one: `voice_clarification` minted for a mapped intent, unexpected escalation / on-call page, reprompt loop, `LOOKUP_UNAVAILABLE_LINE` / refusal on a lookup the operator is entitled to, classifier infra audit.
- **FAIL** — exception, contract violation, `voice.payload_contract_failed` / `proposal_persist_failed`.

### Root cause (one per non-PASS case)

| category | when |
|---|---|
| `intent` | classification unknown / < τ_int / off-surface / intent ≠ `case.intent` (live mode) / `classifier_*_failure` audit |
| `slot_capture` | expected payload key absent or unresolved (e.g. `technicianId`, `appointmentId`, `scheduledStart`), ambiguity not resolved by the follow-up, `entity_not_found` on a seeded fixture, `missingFields` gate where `status: ready_for_review` was expected |
| `proposal_generation` | proposal type ≠ expected, `voice_clarification` degrade, contract failure, persist failure |
| `fallback` | unexpected reprompt / escalation / guard / refusal / lookup-unavailable / dead clarification for a lookup |
| `infra` | live-only: http 5xx, provider/deadline/quota codes |

`rootCause.detail` is a one-line human explanation naming the evidence (audit event, missing key, spoken line).

### Run artifact `docs/verification-runs/inapp-50/run-<ISO>.json`

```jsonc
{
  "version": "inapp-50-run-v1", "runId": "2026-09-09T14-05-00Z", "mode": "hermetic",
  "registerVersion": "inapp-50-v1", "gitSha": "…", "startedAt": "…", "finishedAt": "…",
  "batch": null,                                   // or { "index": 1, "size": 10 }
  "summary": {
    "total": 50, "PASS": 0, "PARTIAL": 0, "DEGRADED": 0, "FAIL": 0,
    "bySeverity": { "critical": { "PASS": 0, "PARTIAL": 0, "DEGRADED": 0, "FAIL": 0 }, "core": {…}, "growth": {…} },
    "byCluster":  { "scheduling": {…}, "search": {…}, … },
    "byRootCause": { "intent": 0, "slot_capture": 0, "proposal_generation": 0, "fallback": 0, "infra": 0 },
    "intentCaptureOnlyCritical": ["search-02", …],
    "gate": { "pass": false, "reasons": ["PASS 31/50", "critical intent_capture_only: search-02"] }
  },
  "cases": [ { "id": 1, "key": "book-01", "cluster": "scheduling", "severity": "critical", "op": "…", "intent": "…",
               "verdict": "PASS", "reason": "proposal:create_appointment", "stage": "committed",
               "rootCause": null, "turns": [ … ], "proposals": [ { "id", "proposalType", "status", "missingFields", "payload" } ],
               "durationMs": 12 } ]
}
```
`latest.json` is a copy of the newest full (non-batch) run. Batch runs (`--batch N`) write `run-<ISO>-batch<N>.json` and merge into `latest.json` by case key.

## Cluster fixes (R1/R2/R3)

**Search (Agent B)** — in-app voice today intercepts ONLY `lookup_day_overview`, and only via `ownerLookupResolver` (`app.ts` ~6740). Every other `lookup_*` falls through the FSM into a dead `voice_clarification` card. Fix: give `InAppVoiceAdapter` a `lookups?: AssistantLookupDeps`-shaped bundle and route every `lookup_*` intent at confidence ≥ τ_int through a new thin surface adapter `ai/voice-turn/inapp-lookup-surface.ts` that calls the shared `dispatchAssistantLookup` (`ai/orchestration/lookup-dispatch.ts`) with `userId = session.userId` (RBAC fails closed in `executeLookupAnswer`), speaks `message.content`, emits `lookup_executed`, and leaves the FSM in `intent_capture`. Ambiguous name → the shared which-one line. Wire `app.ts` with the SAME `lookupAnswerDeps`/`sharedLookupRepos`/`sharedEntityResolver` bundle chat and phone use; delete `ownerLookupResolver` (dead once replaced — re-grep). Tests: adapter-level for answered / ambiguous / not-found / refused (technician asking revenue) / no-bundle unavailable line; route test unchanged.

**Confirmations & recovery (Agent C, R2)** — deterministic action path before any TTS:
1. `HandleInputResult.trace` (R1 instrumentation): `{ stage, intent?, confidence?, resolution?: 'resolved'|'ambiguous'|'not_found'|'low_confidence'|'skipped', proposalType?, fallbackReason?: 'reprompt'|'escalation'|'guard'|'refusal'|'clarification_card'|'classifier_failure:<class>'|'lookup_unavailable'|'lookup_refused', dedup?: 'duplicate_turn'|'noise' }` — also emitted on the SSE `transition` event and returned by `POST /:id/input`.
2. Duplicate-turn recovery: identical text (normalized) to the immediately preceding operator turn within 15 s → do NOT re-classify or re-dispatch; re-speak the last prompt (`dedup: 'duplicate_turn'`), audit `agent.calling.turn_deduplicated`. A repeated "yes" after a proposal was queued → `CONFIRM_NOTHING_PENDING_LINE` deterministically (no LLM), never a second proposal.
3. Noisy input: deterministic filler detector (`um`, `uh`, `hello?`, `testing`, `can you hear me`, `…`, ≤ 2 tokens of pure filler) → one gentle reprompt WITHOUT an LLM call and WITHOUT counting toward escalation (`dedup: 'noise'`); never on a confirm turn.
4. Noisy affirmation: `isAffirmation` strips leading fillers (`uh`, `um`, `er`, `well`, `okay so`, `yeah so`) and accepts `go ahead`, `book it`, `do that`, `that's correct`, `sounds right`, `yes please book it`, `yep go ahead`; `isNegation` likewise. Pin with tests.

**Scheduling & dispatch (Agent D)** —
1. `create_appointment` with `targetTechnicianName` resolves to `technicianId` (add to `TECHNICIAN_REF_INTENTS` for scheduling create; payload builder carries it).
2. `notify_delay` / `confirm_appointment` with a customer but no `appointmentReference`: resolve the customer, then pick that customer's single upcoming appointment; two or more → the existing one-tap disambiguation; none → honest not-found.
3. Operator (in-app, `ownerSession`/authenticated) `entity_not_found`: speak an honest "I couldn't find …" and return to `intent_capture` — no on-call page for an operator's own lookup miss (telephony behaviour unchanged).
4. `en_route` in-app: call the shared `dispatch/en-route-voice.ts#handleEnRouteForTechnician` core (same deps bundle chat uses) — audited act, spoken confirmation, no proposal.

## Dashboard, triage, gate (Agent F)

`scripts/inapp-50/build-dashboard.mjs` → `docs/verification-runs/inapp-50/dashboard.html` (self-contained: PASS/50 trend across runs, case × run heat-map, per-cluster and per-severity bars, root-cause distribution, list of `intentCaptureOnlyCritical`). `scripts/inapp-50/triage-report.mjs` → `triage-<date>.md` ("degradation causes": non-PASS grouped by root cause and cluster, top-3 clusters with owning fix, deltas vs previous run). `scripts/inapp-50/release-gate.mjs` implements the three gate rules. Root `package.json`: `inapp-50:run`, `inapp-50:dashboard`, `inapp-50:triage`, `check:inapp-50`.

## Trial / provisioning proof pack (Agent E, R4)

Docker-gated integration test `packages/api/test/integration/trial-provisioning-first-value.test.ts`: signed Clerk `user.created` → tenant + owner membership + settings → signed Stripe `customer.subscription.created` (`trialing`) → `GET /api/onboarding/status` shows `subscriptionStatus: 'trialing'` and billing step done → phone step provisioned by the dev stub worker (`+15005550006`) → authenticated `GET /api/me` → first-value action in-app: `POST /api/voice/sessions` + input "Book …" + "yes" → proposal → approve → appointment row exists. Doc: `docs/verification-runs/trial-provision-proof-pack-2026-09-09.md` with the exact commands and captured output.
