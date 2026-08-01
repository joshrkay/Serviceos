# feat: Voice→transcript fidelity + per-path agent execution hardening

**Created:** 2026-07-17
**Depth:** Deep
**Status:** plan

## Summary
Two coordinated tracks that raise the quality of the voice product end to end.
**Track A** improves what the agent *hears*: the voice→text→transcript pipeline
that feeds every path (correction pass, tenant-dynamic vocabulary, working STT
boosting, acoustic-confidence reprompts, per-surface accuracy measurement).
**Track B** improves what the agent *does* with that transcript: the execution
chains for the nine business paths (create account, update schedule, create/
update job, create/update estimate, create invoice, send invoice, invoice
follow-up), closing per-surface divergences, capability holes, and the
resolution loop that lets an operator approve a gated proposal in one tap.

Tracks are independent and shippable in either order; within each track the
units are dependency-ordered. This is a program of work — `ce-work` can take the
highest-value slice (A1, B1) first and proceed incrementally.

## Problem Frame
Discovery (three deep explorations of this branch) found the two halves of the
voice product are each leaking quality in ways that compound:

- **The transcript the agent acts on is barely processed.** The live media-
  streams path (highest traffic) gets *no* correction at all; the recording
  correction pass is fully implemented but **dead-wired** (`app.ts` never passes
  the gateway/glossary, so it never runs); tenant-specific vocabulary (catalog
  items, customer names, technician names) reaches *nothing*; the one wired STT
  boost emits Deepgram's legacy `keywords=` param on a Nova-3 model that likely
  ignores it; Spanish is doubly degraded; and acoustic STT confidence is read
  and then ignored on every surface, so a misheard caller is never asked to
  repeat.
- **Execution diverges by surface and has real holes.** The assistant chat
  surface silently supports only 7 of the ~33 proposal-driving intents — the
  scheduling family, `create_job`, and the entire invoice follow-up family
  classify but produce no draft. `update_job` does not exist at all. `create_job`
  ignores an already-resolved `customerId`. `draft_invoice` demands a `jobId`
  the estimate path would auto-create. And until this branch's fixes, several
  money paths were approvable-but-doomed; the fixes added `missingFields` gates
  but the operator-facing **resolution loop that clears those gates is a dead
  end** — the web card says "Tap Edit to fill" but `editProposal` never clears
  `missingFields`, and the assistant money cards render no Edit button.

## Requirements
- **R1.** Live-call and recording transcripts are corrected for trade + tenant
  vocabulary before intent classification (today correction targets only
  recordings, and even that is dead-wired).
- **R2.** Tenant-dynamic vocabulary (catalog item names, customer names,
  technician names) biases the correction pass and, where the engine supports
  it, the STT layer.
- **R3.** STT term boosting actually works on Nova-3 (keyterm, not legacy
  keywords) and reaches Gather, recordings, and operator dictation, including
  Spanish.
- **R4.** Low acoustic STT confidence triggers a targeted "could you repeat
  that?" reprompt instead of acting on a likely-misheard transcript.
- **R5.** Per-surface transcript accuracy (WER) is measured with committed
  baselines so regressions are visible.
- **R6.** Every gated money proposal has a working resolution path on both the
  inbox and assistant surfaces — the `missingFields` approval gate is never a
  dead end.
- **R7.** Free-text invoice/estimate references resolve to candidate lists the
  operator picks in one tap; ambiguity never silently dead-ends.
- **R8.** Edit-action catalog conflicts/ambiguities get the same one-tap
  resolution that draft line items already have.
- **R9.** `issue_invoice` resolves "the one we just drafted" from conversation
  context on the assistant surface, gated when unresolved.
- **R10.** The assistant chat surface supports the same nine-path intent set as
  the voice worker (scheduling edits, `create_job`, invoice follow-up family) —
  no silent per-surface divergence.
- **R11.** `create_job` consumes an already-resolved `customerId`; `draft_invoice`
  proceeds when only a customer is resolved (job auto-create parity with the
  estimate path).
- **R12.** An `update_job` capability exists end to end (status/priority/
  description edits) with a human-approval gate and audit.
- **R13.** `create_customer` runs draft-time duplicate detection on all surfaces
  (today only the telephony FSM does), surfacing an advisory warning before
  approval.

## Key Technical Decisions
- **Correction and glossary share one seam.** Wire the existing (dead) correction
  pass in `workers/transcription.ts` by passing `gateway` + a real
  `TranscriptionGlossaryProvider` at the `app.ts` composition root, rather than
  writing a new pipeline. Rationale: the machinery already exists and is tested
  in isolation; the only bug is the missing wiring. (Alternative — a new live
  correction stage inside `mediastream-adapter` — rejected as a larger, latency-
  sensitive surface; do live correction only after the batch path proves the
  glossary, see A1 non-goals.)
- **Boost via keyterm, keep keywords as a versioned fallback.** Migrate Deepgram
  to `keyterm=` for Nova-3 but detect the model family so a future Nova-2 pin
  still works. Rationale: silent no-op boosting is worse than none.
- **Acoustic-confidence reprompt is a distinct signal from classifier
  confidence.** Add a dedicated low-STT-confidence branch that reprompts *before*
  classification, rather than overloading the existing `confidence_low` FSM event
  (which keys on the LLM classifier). Rationale: they fail for different reasons
  and want different copy ("I didn't catch that" vs "I'm not sure what you'd
  like").
- **Resolution loop: clear-on-fill, candidates layered on top of the gate.**
  `editProposal` removes a `missingFields` entry only when that exact top-level
  key was edited and is now non-empty — never a full schema recompute (a recompute
  would clear execution-required-but-schema-optional gates like `send_invoice`'s
  `invoiceId` and reintroduce the doomed-approval bug). Candidates are an
  affordance layered on top of the gate; when resolution finds nothing the card
  degrades to the Edit path. (Full rationale + rejected alternatives in the
  strategy notes folded into B1–B4.)
- **`dropUnverifiedIds` is honored, not bypassed.** Any DB-resolved id that must
  survive the assistant scrub is admitted via an explicit `sourceContext.
  verifiedIds` allowlist stamped only by repo-lookup code paths — never copied
  from LLM JSON. Rationale: the scrub exists to kill hallucinated ids; the
  allowlist is verifiable by construction.
- **`update_job` is scoped to safe field edits.** Status, priority, title/
  description, scheduled-window-independent fields — NOT money or schedule (those
  have their own paths). Rationale: keep the new capability small and
  `capture`-class; reuse the estimate-edit gating pattern for the `jobId` target.

## Scope Boundaries
**In scope:** the 13 requirements above across `packages/api` (voice, ai,
proposals, workers) and `packages/web` (inbox + assistant review cards).

**Non-goals:**
- Live in-call transcript correction (A1 does the batch/recording path + proves
  the glossary; live correction is a follow-up once latency is characterized).
- Real invoice-delivery bytes (the `NoopInvoiceDeliveryProvider` swap is a
  separate integration).
- The negotiation/complaint extended-intent surface (`extendedIntentsEnabled`).
- MMS/photo-quote pipeline (not a voice surface).

### Deferred to follow-up work
- Estimate trigram index + `PgEntityResolver` estimate-kind implementation
  (repo ILIKE search in B2 lights up the loop; trigram improves recall only).
- Consolidating the two divergent Whisper implementations
  (`transcription-providers.ts` vs `voice-service.ts`).
- `endpointing`/`utterance_end_ms` latency tuning (dead config today).
- Live-call acoustic-confidence tuning thresholds beyond an initial conservative
  default.

## Repository invariants touched
- **Integer cents:** all money-path units (B2–B4, B6) keep cents integer; no new
  float math.
- **tenant_id + RLS:** the glossary provider (A1) and reference-candidate search
  (B2) are tenant-scoped queries; `update_job` (B7) carries `tenant_id`.
- **Audit events:** `update_job` execution emits `job.updated`; resolution
  mutations reuse `proposal.line_resolved` / `proposal.entity_resolved`;
  `editProposal` records `clearedMissingFields`.
- **LLM gateway:** correction pass (A1) and any new handler route through the
  gateway with top-level `tenantId` (the strict guard added this branch).
- **Zod proposals:** `update_job` gets a `PROPOSAL_TYPE_SCHEMAS` entry +
  `assertValidProposalPayload`; candidate/editAction resolution keeps payloads
  schema-valid.
- **Catalog resolver:** B3 unwinds the "ambiguous == uncatalogued" collapse in
  `edit-action-grounding.ts`, recording candidates instead of discarding them.
- **Entity resolver:** B2 reuses the resolver/repo-search machinery; never
  auto-approves on a resolved id (gate stays).
- **Human approval:** every path keeps the approval gate; no auto-execution.

## High-Level Technical Design

```
TRACK A — transcript fidelity (feeds every path)
  audio ─▶ STT (Deepgram/Whisper/Gather) ─▶ [A2 boost] ─▶ raw transcript
                                              │
                                        [A3 confidence gate] ─▶ reprompt?
                                              ▼
                            [A1 correction + tenant glossary] ─▶ clean transcript
                                              ▼
                                        classifyIntent ──────────────┐
  [A4 WER harness measures each surface's raw transcript vs ref]     │
                                                                     ▼
TRACK B — execution (per path)                              INTENT_TO_PROPOSAL_TYPE
  classify ─▶ task handler ─▶ proposal (Zod) ─▶ [gate] ─▶ approve ─▶ execute ─▶ audit
                    │                              ▲
                    │                    [B1 editProposal clears missingFields]
                    │                    [B2 reference→candidates] [B3 edit-conflict one-tap]
                    └─ [B5 wire missing assistant intents] [B6 resolved-id reuse]
                       [B7 new update_job] [B8 create_customer dedup parity]
```

## Implementation Units

### Track A — Transcript fidelity

### A1. Wire the correction pass + build a tenant glossary provider
- **Goal:** Recording transcripts are actually corrected, biased by tenant
  vocabulary (catalog/customer/technician names), before the agent sees them.
- **Requirements:** R1, R2.
- **Dependencies:** none.
- **Files:**
  - Modify `packages/api/src/app.ts` (~1616-1652): pass `llmGateway` and a new
    glossary provider into `createTranscriptionWorker` (today only `onTranscribed`
    + encryption key are passed, so the `if (options.gateway …)` block at
    `workers/transcription.ts:249` is dead).
  - Create `packages/api/src/voice/tenant-glossary-provider.ts`: implements the
    existing `TranscriptionGlossaryProvider` interface
    (`workers/transcription.ts:39-41`); sources per-tenant catalog item names
    (catalog repo), active customer display names, and technician names — capped
    and deduped, tenant-scoped queries.
  - Modify `packages/api/src/workers/transcription.ts` only if the glossary hook
    signature needs widening (prefer not to).
  - Tests: `packages/api/test/voice/tenant-glossary-provider.test.ts` (unit,
    mocked repos); `packages/api/test/workers/transcription.test.ts` (extend:
    correction runs when gateway+glossary present, falls back to raw on the
    length guard, skips cleanly when absent); Docker integration
    `packages/api/test/integration/transcription-correction.test.ts` (real
    catalog/customer rows → glossary terms reach the correction prompt).
- **Approach:** the correction system prompt already exists
  (`transcription.ts:137-140`) and prefixes glossary terms; the only work is a
  real provider + composition-root wiring. Keep the existing length-guard
  fallback (corrected < 40% of raw ⇒ keep raw). Glossary query must be bounded
  (cap term count; the correction taskType is lightweight-tier, `maxTokens:2048`).
- **Patterns to follow:** `VerticalTerminologyProvider`
  (`voice/vertical-terminology-provider.ts`) for the provider shape; the
  lightweight-tier correction taskType wiring in `config/ai-routing.ts`.
- **Test scenarios:**
  - Happy: raw "call the Hendersen job" + glossary {Henderson} → corrected
    "Henderson".
  - Edge: empty glossary → correction still runs on trade terms only; over-cap
    glossary → truncated deterministically.
  - Failure: gateway error → raw transcript passthrough, mutation never blocked.
  - Integration: real catalog/customer rows produce the expected glossary terms
    (pin real columns, not a mocked repo).
- **Verification:** a recording with a tenant-specific name is stored corrected;
  the previously-dead `if (options.gateway …)` branch executes in a run.

### A2. Fix Nova-3 keyterm boosting and extend boosting across surfaces
- **Goal:** STT term boosting actually biases recognition on every surface and
  isn't a silent no-op.
- **Requirements:** R2, R3.
- **Dependencies:** A1 (reuses the glossary provider as a boost source alongside
  vertical keywords).
- **Files:**
  - Modify `packages/api/src/voice/transcription-providers.ts` (`buildWsUrl`
    ~300-316): emit `keyterm=` for Nova-3 (detect model family; keep `keywords=`
    only for a Nova-2 pin). Confirm against Deepgram behavior on a live check.
  - Modify `packages/api/src/telephony/media-streams/mediastream-adapter.ts`
    (~1418-1425): stop suppressing boosting on Spanish; supply an es keyterm set;
    include tenant glossary terms (from A1) in the boost list.
  - Modify `packages/api/src/routes/telephony.ts` / `telephony/twilio-adapter.ts`
    Gather TwiML (`buildCallbackGatherTwiml` ~960-972): add `<Gather hints="…">`
    from vertical + glossary terms and set `speechModel="phone_call"` /
    `enhanced`.
  - Modify `packages/web/src/hooks/useDeepgramDictation.ts` + `routes/voice.ts`
    stream-token minting: pass session/tenant language and keyterms to the
    dictation WS.
  - Tests: `packages/api/test/voice/transcription-providers.test.ts` (keyterm vs
    keywords by model family; es no longer suppressed); telephony adapter tests
    asserting Gather `hints` present; a dictation-token test for language/keyterm
    threading.
- **Approach:** centralize the "terms for this tenant+language" computation so all
  four surfaces draw from one source (vertical `sttKeywords` ∪ A1 glossary),
  language-gated. Keep the 50-term cap discipline.
- **Patterns to follow:** existing `openSession({keywords})` threading
  (`mediastream-adapter.ts:881,1418`); `VerticalTerminologyProvider.getKeywords`.
- **Test scenarios:**
  - Happy: Nova-3 session URL contains `keyterm=furnace:3` (not `keywords=`).
  - Edge: Spanish session includes es keyterms (previously empty).
  - Edge: Gather TwiML includes `hints` and `speechModel`.
  - Failure: glossary/vertical lookup error → bare STT, never a thrown turn.
- **Verification:** a live or recorded Nova-3 call shows the keyterm param in the
  handshake; a Gather callback TwiML carries hints.

### A3. Gate low acoustic STT confidence into a targeted reprompt
- **Goal:** A mumbled/accented turn the STT engine flags as low-confidence is
  reprompted, not acted on as if correctly heard.
- **Requirements:** R4.
- **Dependencies:** none (independent of A1/A2).
- **Files:**
  - Modify `packages/api/src/telephony/media-streams/mediastream-adapter.ts`
    (`onTranscriptEvent` ~1115): read the already-received Deepgram `confidence`
    on finals; below a conservative threshold, emit a dedicated reprompt turn
    (reuse the VOX-35c recovery/reprompt machinery shipped this branch) instead
    of dispatching `speechTurn`.
  - Modify `packages/api/src/routes/telephony.ts` (~545) / `twilio-adapter.ts`
    (`_handleGatherLocked` ~1719-1732): use the parsed Gather `Confidence` (today
    destructured then ignored) to drive a `<Say>`+`<Gather>` reprompt below
    threshold.
  - Add a per-session consecutive-low-confidence counter to avoid loops
    (mirror the VOX-35c consecutive-failure cap → escalate/hand off).
  - Tests: `packages/api/test/telephony/media-streams/mediastream-adapter.test.ts`
    (low-confidence final → reprompt, not speechTurn; counter resets on a good
    turn; repeated low-confidence → hand off); Gather-path test in the
    twilio-adapter suite.
- **Approach:** a distinct signal from the classifier `confidence_low` path —
  reprompt copy is "I didn't quite catch that, could you say it again?" and lives
  next to the existing repair templates (localized). Threshold is env-overridable
  and conservative to start.
- **Patterns to follow:** the VOX-35c `recoverFromSpeechTurnFailure` /
  consecutive-failure design (`mediastream-adapter.ts`); localized copy in
  `ai/agents/customer-calling/tts-copy.ts` / `repair-templates.ts`.
- **Test scenarios:**
  - Happy: confidence 0.35 final → localized reprompt, transcript not dispatched.
  - Edge: es session reprompts in Spanish.
  - Edge: two consecutive low-confidence turns → graceful hand-off, no loop.
  - Failure: missing confidence field → treated as high (never blocks a turn).
- **Verification:** a synthetic low-confidence final produces a reprompt in the
  media-streams emulator; Gather `Confidence` below threshold yields a reprompt
  TwiML.

### A4. Per-surface WER measurement + committed baselines
- **Goal:** Transcript accuracy is measured per surface (not just Whisper-on-
  fixtures) so the A1–A3 changes are provably better and regressions are visible.
- **Requirements:** R5.
- **Dependencies:** none (measures the others; run after A1–A3 to record deltas).
- **Files:**
  - Modify `packages/api/src/ai/voice-quality/dialect/dialect-runner.ts` +
    `dialect-report.ts`: add a Deepgram (streaming) transcriber path alongside
    `makeWhisperDialectTranscriber`, so the harness grades the live-path engine,
    not only batch Whisper.
  - Add committed baselines: extend `data/VOICE-CORPUS-REPORT.md` with per-surface
    WER numbers (Whisper, Deepgram; note Gather/live are not offline-measurable
    and say so).
  - Tests: `packages/api/test/voice-quality/dialect/` extend for the Deepgram
    transcriber path (mock the engine; assert WER computation + per-surface
    rollup).
- **Approach:** reuse the canonical `wer.ts` (edit-distance DP) and
  `DialectEvalCase` fixtures; add a surface dimension to the report rollup. Keep
  it offline/credential-gated like the live voice-eval; do not spend in PR CI.
- **Patterns to follow:** `dialect-runner.ts` ASR-only mode; the credential-gated
  cost-capped pattern from `voice-eval-live.yml`.
- **Test scenarios:**
  - Happy: known transcript vs reference → expected WER, attributed to the right
    surface.
  - Edge: empty reference / perfect match boundaries.
  - Test expectation: harness/measurement code — unit-test the computation; no
    real audio spend in CI.
- **Verification:** the report shows a per-surface WER table with a committed
  baseline number.

### Track B — Path execution

### B1. Resolution-loop foundation: `editProposal` clears filled gates + assistant Edit form
- **Goal:** Filling a gated field actually lifts the approval gate, and the
  assistant money card renders an Edit control — so every `missingFields` gate
  shipped this branch has a working unblock path.
- **Requirements:** R6.
- **Dependencies:** none. **Must precede B2–B4, B5–B8's approval steps** (every
  "…and then approve" is broken without it).
- **Files:**
  - Create `packages/api/src/proposals/missing-fields.ts`:
    `clearSatisfiedMissingFields(missingFields, editedKeys, payload)` — removes a
    top-level flat key only when it was edited and is now non-empty; never touches
    path-shaped entries (`lineItems[i].catalogItemId`,
    `editActions[i].lineItem.catalogItemId`) owned by resolve-line.
  - Modify `packages/api/src/proposals/actions.ts` (`editProposal` ~553-646):
    after validation, recompute+persist `sourceContext.missingFields` via the
    helper; record `clearedMissingFields` in the `proposal.edited` audit metadata.
    No status transition.
  - Modify `packages/api/src/routes/assistant.ts` (`proposalToUI` ~400-437): when
    `sourceContext.missingFields` is non-empty, emit `editFields` (labelled inputs
    keyed by the payload field name, prefilled with the free-text reference as
    read-only context) so the existing edit-then-approve UI can fill them.
  - Tests: `packages/api/test/proposals/actions.test.ts` (edit fills `invoiceId`
    → approvable; unrelated edit → gate intact; empty-string → gate intact;
    path-shaped entry never cleared by an edit); `assistant.route.test.ts` (gated
    cards carry `editFields`); optional `packages/web` card test.
- **Approach:** clear-on-fill, not schema recompute (see Key Decisions — a
  recompute reopens the `send_invoice` doomed-approval bug). Backward compatible:
  in-flight proposals keep stale lists until their next edit.
- **Patterns to follow:** `missingFieldsFor` (`proposals/proposal.ts:245`);
  `approveProposal` gate (`actions.ts:195`); the edit-then-approve flow in
  `packages/web/src/components/assistant/AssistantPage.tsx`.
- **Test scenarios:**
  - Happy: gated `update_invoice`, edit supplies UUID `invoiceId` → approve
    succeeds.
  - Edge: `update_invoice` Zod requires `invoiceId` uuid — an edit lacking it
    400s (pin as documented behavior, not a surprise).
  - Failure: edit of an unrelated field leaves the gate intact.
- **Verification:** an operator edit that fills the missing id flips the card from
  blocked to approvable on both inbox and assistant surfaces.

### B2. Reference→ID candidates for money paths (light up the picker)
- **Goal:** A gated invoice/estimate reference offers a one-tap candidate list
  instead of a dead-end card.
- **Requirements:** R6, R7.
- **Dependencies:** B1 (gate-clearing) — pick must be able to unblock approve.
- **Files:**
  - Create `packages/api/src/ai/resolution/reference-candidates.ts`:
    `candidatesForReference({tenantId, reference, kind, invoiceRepo?, estimateRepo?})`
    → `EntityCandidate[]` from the repos' `findByTenant({search, limit:5})` ILIKE
    search; failure-soft → `[]`.
  - Modify `packages/api/src/proposals/resolve-entity.ts` (annotate-only path
    ~387-455): clear the resolved field from `missingFields` (B1 helper) and
    promote draft→ready_for_review only when the remaining list is empty (today it
    promotes unconditionally). No redraft for already-typed money proposals (they
    must NOT stamp `originalIntent`).
  - Modify the money handlers to stamp `sourceContext.entityCandidates` +
    `entityKind` + `entityReference` (never payload): `SendInvoiceTaskHandler`
    (`ai/tasks/voice-extended-tasks.ts`), `InvoiceEditTaskHandler`,
    `EstimateEditTaskHandler` (both already resolve — widen search to record
    candidates when 0<n≤5); keep the flat `missingFields` gate.
  - Wire `invoiceRepo`/`estimateRepo` into `candidatesForReference` at both call
    sites (`routes/assistant.ts`, `workers/voice-action-router.ts`).
  - Tests: handler tests (candidates recorded; gate always present for non-UUID
    refs; zero-match → gate + no candidates → Edit fallback);
    `packages/api/test/proposals/resolve-entity.test.ts` (pick on typed
    `send_invoice` stamps id, clears gate, ready_for_review, audit, idempotent
    double-tap); Docker `packages/api/test/integration/resolve-entity-money.test.ts`
    (seed invoices → gated draft → resolve → approve).
- **Approach:** layer candidates ON TOP of the gate (see Key Decisions). Candidates
  in `sourceContext` survive `dropUnverifiedIds` (it only strips payload id keys);
  the resolve-time payload stamp is applied by the proposals route, after the
  scrub, so it survives too.
- **Patterns to follow:** `resolve-entity.ts` annotate-only path;
  `readCandidates` shape; existing `resolveLineItemToCatalog` candidate shape.
- **Test scenarios:** happy (single/multi candidate pick → id + gate cleared);
  edge (zero match → Edit fallback, no picker); idempotent double-tap; integration
  (real invoices).
- **Verification:** a gated `send_invoice` on a real tenant shows a candidate list;
  one tap enables Approve.

### B3. One-tap resolution for edit-action catalog conflicts/ambiguities
- **Goal:** The `editActions` resolution contract deferred by
  `edit-action-grounding.ts` — edit lines get the same one-tap picker draft lines
  have.
- **Requirements:** R8.
- **Dependencies:** B1 (clearing philosophy). Independent of B2/B4.
- **Files:**
  - Modify `packages/api/src/ai/resolution/edit-action-grounding.ts`: on
    `ambiguous`, record `catalogResolution` keyed by edit-action index (candidates
    are already computed by `resolveLineItemToCatalog` — currently discarded) and
    emit `editActions[i].lineItem.catalogItemId` missingFields; on exact/high with
    price conflict, record the catalog + synthetic `spoken:{i}` candidate. Split
    `anyAmbiguousWithCandidates` (resolvable gate) from `anyUncatalogued` (sticky
    low-confidence) — rewrite the "ambiguous == uncatalogued" doc.
  - Modify `packages/api/src/proposals/resolve-line.ts`: branch on
    `Array.isArray(payload.editActions)` → stamp the chosen candidate onto
    `editActions[i].lineItem` (`unitPrice` executable + `unitPriceCents` mirror,
    `catalogItemId`/`pricingSource`/quantity-default-1); clear the editAction
    missingFields + `editActions[i]`-prefixed markers (parametrize
    `recomputeMeta`'s prefix). Same route, same body — no API change.
  - Modify `packages/api/src/ai/tasks/{invoice-edit-task,estimate-edit-task}.ts`:
    merge grounding `catalogResolution` + missingFields into sourceContext.
  - Modify `packages/web/src/components/inbox/InboxPage.tsx`: add an editActions
    picker branch beside the lineItems one.
  - Tests: `edit-action-grounding.test.ts` (candidates + missingFields; uncatalogued
    still caps); `resolve-line.test.ts` (editAction branch: pick, spoken-pick,
    wrong-candidate 400, gate clears, invoiceId gate independent); Docker extend
    `test/integration/resolve-line.test.ts` with an update_invoice flow;
    `InboxPage.test.tsx`.
- **Approach:** reuse resolve-line's route/permission/audit — do NOT build a
  parallel endpoint (semantically identical). The invoiceId gate (B2) and
  editAction gates are disjoint strings; they compose in either order.
- **Patterns to follow:** `resolve-line.ts` lineItems branch; the draft path's
  `spoken:{i}` synthetic candidate; `AmbiguityPicker`.
- **Test scenarios:** happy (pick catalog / keep spoken); edge (uncatalogued still
  caps, no candidate); ambiguous-only edit cannot auto-approve (missingFields
  forces draft); integration round-trip.
- **Verification:** an ambiguous edit line renders a picker; one tap resolves it.

### B4. Unified context-backed `issue_invoice` on both surfaces
- **Goal:** "Issue the one we just drafted" works on the assistant surface, and
  the voice surface stops emitting ungated empty-invoiceId proposals.
- **Requirements:** R9.
- **Dependencies:** soft on B2 (candidate helper). Independent otherwise.
- **Files:**
  - Modify `packages/api/src/ai/orchestration/task-router.ts`
    `IssueInvoiceTaskHandler` to be the single handler: optional
    `{proposalRepo?, invoiceRepo?, thresholdResolver?}`. Resolution ladder:
    UUID/INV-number reference → `payload.invoiceId` ungated; else `conversationId`
    → most-recent same-conversation `draft_invoice` with `resultEntityId` →
    `payload.invoiceId` + `sourceContext.verifiedIds={invoiceId}`; else gate +
    (B2) candidates from recent open invoices.
  - Delete the duplicate handler in `workers/voice-action-router.ts` (~463-525);
    construct the unified one with full deps.
  - Modify `packages/api/src/routes/assistant.ts`: construct with
    `proposalRepo`+`invoiceRepo`, thread `conversationId` into TaskContext (today
    absent), and extend `dropUnverifiedIds` to keep an id present in
    `sourceContext.verifiedIds`.
  - Tests: `ai/orchestration/invoice-intents.test.ts` (ladder + gate); voice-router
    parity; `assistant.route.test.ts` (conversation-resolved id survives scrub;
    hallucinated id still dropped); Docker for the conversation-resolution path.
- **Approach:** `verifiedIds` allowlist stamped only by repo-lookup paths (the
  unit's security-review surface). Voice behavior change to note in the PR:
  unresolvable `issue_invoice` now lands gated (was ungated empty payload).
- **Patterns to follow:** the existing voice-router context resolution;
  `invoice-edit-task.ts` dropUnverifiedIds doc.
- **Test scenarios:** happy (conversation-resolved issue); edge (INV-number
  reference); failure (nothing resolvable → gated + candidates); security
  (hallucinated UUID still stripped).
- **Verification:** assistant "issue the one we just drafted" produces an
  approvable `issue_invoice` with the right invoice.

### B5. Wire the missing nine-path intents into the assistant surface
- **Goal:** The assistant chat surface drafts the same nine-path intents as the
  voice worker — scheduling edits, `create_job`, and the invoice follow-up family
  — instead of silently replying without a draft.
- **Requirements:** R10.
- **Dependencies:** B1 (their gated proposals need a working unblock); benefits
  from B2 (reference candidates).
- **Files:**
  - Modify `packages/api/src/routes/assistant.ts` (chain map ~586, single map
    ~672): add `reschedule_appointment`, `cancel_appointment`,
    `reassign_appointment`, `confirm_appointment`, `create_job`,
    `send_payment_reminder`, `apply_late_fee`, `send_estimate_nudge`,
    `batch_invoice`, `create_invoice_schedule`, `record_payment`, `notify_delay`
    → their existing handlers, wiring the deps each needs (appointment/job/invoice
    repos, entity resolver) exactly as `workers/voice-action-router.ts:527`
    (`buildHandlers`) does.
  - Tests: `assistant.route.test.ts` — each newly-wired intent produces the
    correct proposal type with correct gating (mirror the worker's tests); at
    least one scheduling, one job, one follow-up intent end-to-end.
- **Approach:** reuse the worker's `buildHandlers` wiring rather than duplicating
  factory logic — ideally extract a shared handler-registry builder both surfaces
  call, so they can't diverge again (this branch exists because they diverged).
  Respect `dropUnverifiedIds` and the gating each handler already sets.
- **Patterns to follow:** `workers/voice-action-router.ts` `buildHandlers`;
  the existing assistant factory maps.
- **Test scenarios:** happy (reschedule/create_job/record_payment via assistant →
  right proposal type); edge (unresolved reference → gated, not doomed); parity
  (same transcript → same proposal type on worker and assistant).
- **Verification:** an assistant "reschedule the Smith appointment to Friday"
  drafts a `reschedule_appointment` proposal (today: no draft).

### B6. `create_job` consumes resolved `customerId`; `draft_invoice` job auto-create parity
- **Goal:** Remove two friction points where a resolvable reference still stalls
  at review.
- **Requirements:** R11.
- **Dependencies:** none (small, targeted).
- **Files:**
  - Modify `packages/api/src/ai/tasks/voice-extended-tasks.ts`
    `CreateJobVoiceTaskHandler` (~1222): read `context.existingEntities.customerId`
    (populated by the router entity resolver) and only gate `customerId` when it's
    genuinely absent — mirror `LogTimeEntryTaskHandler`/`CreateInvoiceScheduleTaskHandler`.
  - Modify `packages/api/src/proposals/execution/invoice-execution-handler.ts` +
    `draftInvoicePayloadSchema` (`proposals/contracts.ts:247`): allow
    `draft_invoice` with only `customerId` and auto-open a job at execution when
    `jobId` is absent, matching `DraftEstimateExecutionHandler` (`handlers.ts:654`).
  - Tests: `CreateJobVoiceTaskHandler` unit (new — resolved customerId not gated;
    absent → gated); invoice execution integration (customer-only draft opens a
    job); contract test for the relaxed schema.
- **Approach:** the estimate path is the reference implementation for job
  auto-create; copy its `jobRepo`+`locationRepo` open-on-execute path. Keep the
  `customerId` requirement (a job needs a customer).
- **Patterns to follow:** `DraftEstimateExecutionHandler` job auto-create;
  `LogTimeEntryTaskHandler` resolved-id consumption.
- **Test scenarios:** happy (create_job with resolved customer drafts unblocked);
  happy (invoice with only customer executes, job created + audited); edge (no
  customer → gated); integration (real job row created).
- **Verification:** "create a job for the Henderson account" (customer resolvable)
  drafts without a customer gate; "invoice the Smith job" with only a customer
  resolves proceeds.

### B7. New `update_job` capability (the largest hole)
- **Goal:** A caller/operator can change a job's status, priority, or
  title/description through the same propose→approve→execute→audit chain.
- **Requirements:** R12.
- **Dependencies:** B1 (its `jobId` gate needs the unblock path).
- **Files:**
  - Add intent `update_job` to `packages/api/src/ai/orchestration/intent-classifier.ts`
    taxonomy + `INTENT_TO_PROPOSAL_TYPE` (`workers/voice-action-router.ts:414`).
  - Add proposal type `update_job` to `PROPOSAL_TYPE_SCHEMAS`
    (`proposals/contracts.ts:468`) with a Zod payload (`jobId` uuid + a bounded
    set of editable fields: status enum, priority, title, description).
  - Create `packages/api/src/ai/tasks/job-edit-task.ts` (`UpdateJobTaskHandler`):
    LLM field extraction, `jobId` target resolution + gate mirroring
    `EstimateEditTaskHandler.resolveEstimateIdGate` (defdd2e) — UUID ungated,
    free-text resolved-but-gated.
  - Create `packages/api/src/proposals/execution/update-job-handler.ts`
    (`UpdateJobExecutionHandler`): validate `jobId`, apply the field delta, emit
    `job.updated` audit; register in `handlers.ts`. `capture` action class.
  - Wire into `buildHandlers` (worker) and the assistant map (B5's shared builder).
  - Tests: `job-edit-task.test.ts` (extraction + gate); `update-job-handler.test.ts`;
    contract test; Docker `test/integration/update-job-execution.test.ts` (real
    job row status/priority change + audit row).
- **Approach:** deliberately scoped to safe field edits (NOT money/schedule —
  those have their own paths). Reuse the estimate-edit gating pattern verbatim for
  the target `jobId`. Keep it `capture`-class (human approval always).
- **Patterns to follow:** `EstimateEditTaskHandler` (structure + `resolveEstimateIdGate`
  gate); `UpdateEstimateExecutionHandler` (execution shape + revision/audit);
  `job.created` audit for the `job.updated` shape.
- **Test scenarios:** happy ("mark the Smith job in-progress" → update_job draft →
  approve → status changed + audited); edge (free-text job reference → gated);
  edge (invalid status enum → Zod reject); failure (nonexistent jobId at execute →
  clean error, no partial write); integration (real column + audit).
- **Verification:** a voice/assistant "change the job priority to high" flows all
  the way to a persisted, audited job update.

### B8. `create_customer` draft-time duplicate detection parity
- **Goal:** Duplicate-customer warnings surface before approval on all surfaces,
  not only the telephony FSM.
- **Requirements:** R13.
- **Dependencies:** none.
- **Files:**
  - Modify the worker + assistant `create_customer` wiring
    (`workers/voice-action-router.ts`, `routes/assistant.ts:716`) to use the
    dedup-aware `CreateCustomerVoiceTaskHandler`
    (`ai/tasks/create-customer-task.ts`) with a `duplicateLoader`
    (`checkCustomerDuplicatesPg`), as the FSM does (`twilio-adapter.ts:2600`) —
    instead of the thin passthrough `CreateCustomerTaskHandler`.
  - Surface the advisory dupe warning in the proposal `_meta`/review card
    (non-blocking, matching `createCustomer`'s existing advisory posture).
  - Tests: worker + assistant create_customer tests asserting a dupe warning
    marker when a near-match exists; the thin passthrough is removed from these
    surfaces (dead-code check per CLAUDE.md).
- **Approach:** advisory only (never blocks) — parity with the existing
  `customers/customer.ts:332` behavior; the point is *when* the warning appears
  (draft time, all surfaces) not a new blocking rule.
- **Patterns to follow:** `CreateCustomerVoiceTaskHandler` + `duplicateLoader`
  wiring in `twilio-adapter.ts`.
- **Test scenarios:** happy (near-duplicate name → advisory marker on the draft);
  edge (no match → clean draft); failure (dedup query error → draft proceeds,
  warning omitted).
- **Verification:** a voice memo creating a near-duplicate customer shows the
  advisory before approval on the worker and assistant surfaces.

## Risks & Dependencies
- **`dropUnverifiedIds` interactions (B2, B4)** are the highest-risk surface:
  candidates must live in `sourceContext` (survives the scrub); resolve-time
  payload stamps happen post-scrub; conversation-resolved ids need the explicit
  `verifiedIds` allowlist stamped only by repo lookups. Pin each with a test.
- **`editProposal` recompute semantics (B1)**: clear-on-fill is mandatory; a full
  schema recompute reopens the `send_invoice` doomed-approval bug — pin that exact
  case.
- **In-flight proposals**: no row migration; every change is read-tolerant of old
  shapes (missing candidates → Edit fallback; old edit proposals stay
  review-blocked as today).
- **`update_estimate`/`update_invoice` Zod strictness**: `update_invoice` requires
  a UUID `invoiceId`, so a gated edit's Edit form (B1) must include that field.
- **Deepgram keyterm behavior (A2)** needs a live confirmation — the legacy
  `keywords=` may already be a silent no-op; treat A2 as verify-then-migrate.
- **Sequencing:** B1 precedes every other B unit's approval step. A1 precedes A2's
  glossary reuse. Everything is independent of Track A vs Track B.

## Open Questions (deferred to implementation)
- Exact low-confidence threshold for A3 (start conservative, tune with A4 data).
- Whether A2's Deepgram change needs a Nova-2 fallback pin at all (depends on the
  live keyterm confirmation).
- Final glossary term cap for A1 (bounded by the lightweight-tier `maxTokens`).
- Whether B5 extracts a shared handler-registry builder now or duplicates the
  worker wiring (prefer extract; confirm the dep shapes line up on both surfaces).

## Sources & Research
Three branch explorations (transcript layer, nine-path inventory, resolution-loop
strategy) + the merged money-path fixes on `claude/voice-ai-improvements-rly3mt`.
No external research was load-bearing (codebase has strong local patterns for
every unit).
