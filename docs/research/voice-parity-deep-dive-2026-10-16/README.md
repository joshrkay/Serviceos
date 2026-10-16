---
title: "Voice parity deep dive — how the phone agent actually behaves, and what Bland and Avoca do differently"
date: 2026-10-16
status: analysis (feeds docs/plans/2026-10-16-001-feat-voice-parity-bland-avoca-plan.md)
tags: [voice-ai, latency, booking, onboarding, knowledge-base, tcpa, avoca, bland]
---

# Voice parity deep dive

This is the mechanism-level companion to the plan. Five traces were run against HEAD 306337a on
2026-10-16, each with file:line citations; they are filed as appendices A–E in this directory.
This README is the synthesis: what each trace changes about the picture, and the numbers the
plan now rests on. Where a figure is an estimate from outside the repo it says so; the
appendices mark those "knowledge" or "[UNVERIFIED]".

| Appendix | What it traces |
|---|---|
| [A — turn latency budget](./appendix-a-turn-latency-budget.md) | One caller turn on Media Streams and on Gather, every serial await, the metrics, barge-in, cost per minute |
| [B — booking, hand-off, callback machines](./appendix-b-booking-handoff-callback-machines.md) | D-015 lane gates and the coupling bug, transfer ladder, recording, dropped-call recovery, consent ledger, what an AI outbound leg needs |
| [C — knowledge, prompt, persona](./appendix-c-knowledge-prompt-persona.md) | Classifier prompt assembly and token budget, spoken-copy catalog, lookup surface, RAG feasibility, vertical packs, a concrete design for business answers and persona |
| [D — onboarding state machine](./appendix-d-onboarding-state-machine.md) | Step completion rules, provisioning worker, voice gate and go-live, test call, 17 failure modes, the reordered-flow spec |
| [E — external](./appendix-e-external-turn-taking-competitors-compliance.md) | 2026 turn-taking engineering, Bland pathway and testing mechanics, Avoca's knowledge model and go-live, seven SMB comparables, TCPA and recording rules for an AI callback |

## 1. The headline corrections to the first-pass plan

The first pass said "three areas". The traces say the three areas are right, but three of the
assumptions underneath them were wrong, and each wrong assumption changes a unit.

**"Booking on the call is a default-off toggle."** It is not reachable at all for the primary
use case. The live-path lane fires only when `customerId && jobId && dateTimeDescription`
(`create-voice-turn-processor.ts:2787`). New work (`create_appointment` with a `jobTitle`) has no
`jobId` by design, because the job is opened at execution. So "I need someone Thursday for a
leaking water heater" from a known customer never places a hold and never evaluates the lane,
whatever the toggle says; the caller hears "I've reserved … our team will confirm". The lane
works today only for an identified customer whose request resolves to an existing job. Two more
gaps sit behind that one: the owner UNDO SMS exists only on the owner-memo path
(`workers/voice-action-router.ts:2695-2737`), never on a live call, and `placeAppointmentHold`
does no slot-conflict check, which is why corpus bucket 09's "slot just taken" script is a
documented known failure. The threshold-coupling bug the first pass named is real but is the
smallest of the four. (Appendix B §1.)

**"Latency needs an LLM-streaming rewrite."** It does not, because the phone speaks no
LLM-generated prose at all. The only gateway calls on the caller path are `classify_intent`
(JSON) and owner-facing summaries; the 90 spoken lines are a fixed EN+ES catalog
(`tts-copy.ts`). The reply gap is therefore classify time plus serial I/O plus a fresh TTS
handshake, and all three are addressable without changing what the agent says. Typical last
word → first real reply audio is about 2.5 s; the five changes in Appendix A §12 take it to
roughly 1.0–1.3 s with no new runtime. (Appendix A §4, §11, §12; Appendix C §2.)

**"Knowledge answers need a bounded LLM answer step."** They should not, at least not first. The
no-LLM-prose invariant is what makes the floor criteria (no PII leak, no tenant leak, no
fabricated action) mechanically provable. Business questions decompose into ~12 structured
topics that are template answers, plus free-form FAQ entries the owner authored, which can be
spoken verbatim from retrieval. That keeps the invariant, costs no classifier budget beyond one
intent block (~130 tokens against a budget pinned at 86% full), and runs inside the existing
lookup surface, which already has the default-deny allowlist and telemetry a new intent needs.
(Appendix C §3, §4, Design A.)

## 2. The numbers

### 2.1 One realtime turn, as shipped (Appendix A §11)

| Stage | Serial? | Best / typical / worst ms | Lever |
|---|---|---|---|
| Caller stops → Deepgram `is_final` (endpointing fixed at 600; `speech_final` and `utterance_end_ms` unused) | S | 650 / 800 / 1,200 | endpointing 300 + utterance_end 1000, trigger on `speech_final`, buffer segments |
| Early filler audible (armed at STT-final, 250 ms delay) | P | ~400 to caller | keep; this is why the caller hears *something* at ~1.2 s |
| Classify context (vertical then plan sections, sequential) | S | 1 / 10 / 80 | `Promise.all` |
| Classify LLM (3.3k-token prompt, llama-3.1-8b via OpenRouter; deadline 4 s default, **12 s in production**, 3 retries) | S | 500 / 1,000 / 4,000 | speculative classify on stable interim; maxTokens 1024→256 |
| Gates + entity resolution (1–3 selects) | S | 5 / 30 / 300 | memoise |
| `executeSideEffects` (audit insert, proposal insert + audit, hold) before any audio | S | 10 / 40 / 300 | overlap synthesis with the inserts; release audio only after the proposal insert commits (U2 item 5) |
| ElevenLabs WebSocket handshake, **new socket per spoken line** | S | 150 / 250 / 400 | pre-connect at STT-final, keep per call |
| ElevenLabs TTFB (`eleven_turbo_v2_5`, whole text in one message) | S | 150 / 250 / 800 | `eleven_flash_v2_5` |
| μ-law encode, send, Twilio playout | S | 100 / 150 / 250 | — |
| **Last word → first real reply audio** | | **≈1.6 / 2.5 / 7 s** | target ≈ 0.8 p50, ≤ 1.5 p95 |

Gather, the production default: 3–5 s with nothing audible, Polly `<Say>` not interruptible.

Two measurement facts matter as much as the budget. The production histogram
`voice_turn_latency_ms` stops at the **first audible frame, filler included** (a deliberate
"caller hears something" choice in `mediastream-adapter.ts:3444-3463`), so the 3.5 s SLO watches
a number that is ~250–450 ms when a filler fires; the real reply gap is unmeasured in
production. And the Layer 2 grader's `ttfa` stops at the first *real* chunk. The two agree on
the start and disagree on the stop. Neither includes the 0.7–0.9 s Deepgram endpoint wait.

Barge-in fires on **any** non-empty interim while the agent (or a filler) is speaking, with no
word or confidence gate; only the E1 911 line is shielded. An interrupted turn is not cancelled:
its reply is still spoken under a fresh turn id and its proposal persists, and the caller's next
final queues behind the lock, so a cough during "Mm-hmm" can produce a stale reply, a second
reply, and a duplicate draft. (Appendix A §7.)

### 2.2 Where the market is (Appendix E §1.5–1.6)

| Source | Caller-perceived p50 / p95 |
|---|---|
| OpenBenchmarks, real PSTN: Bland | 1,520 / 2,248 ms |
| same: Vapi, Retell, ElevenLabs, Telnyx | 1,296–1,740 / 1,768–2,259 ms |
| Vendor-run Telnyx test (voice-to-voice) | 680–850 / 920–1,180 ms |
| Recommended target for our stack | **700–900 / ≤ 1,500 ms** |

Our 2.5 s typical is about one second behind the market's caller-perceived p50. The marketing
"200–400 ms" figures are model-only. A real 0.8 s p50 on PSTN would beat every platform on the
public benchmark. The field has also moved past fixed-silence endpointing: Deepgram's Nova-3
default is 10 ms (ours is 60× that), Deepgram Flux accepts 8 kHz μ-law directly and emits
`EagerEndOfTurn`/`TurnResumed` for speculation, and LiveKit's learned detector cuts false
cutoffs from 55% (VAD-only) to 10% at a 300 ms budget. Flux is the natural second step after the
Nova-3 tuning in the plan; it is not required for the first second of savings.

### 2.3 Economics (Appendix A §9)

Realtime all-in provider cost is roughly **$0.05–0.10 per minute** (Deepgram ~$0.008, ElevenLabs
~$0.03–0.06, classify LLM < $0.02, Twilio ~$0.013; prices from knowledge, env cost variables are
blank). The pricing doc assumes ~$0.25/min and charges $1.25/min overage, so margin is not the
constraint. The constraint is the allotment: Starter's 20 minutes is about five calls a month,
against Rosie's 250 minutes at $49 and Jobber's 30 conversations at $29. The comparables' most
repeated commercial complaint is unpredictable overage (Goodcall, Rosie, Smith.ai). Speculative
classify adds roughly 30% to a cost line that is under two cents a minute; it is not a pricing
question.

### 2.4 Onboarding, as shipped (Appendix D §4, §9, §11)

Twelve to twenty minutes with four background waits the UI handles poorly (Stripe webhook shows
the plan picker again; "Claiming…" shows before anything is being bought; retries-forever on a
Twilio credential problem). The test-call step detects a call by `inboundCallCount > 0`, never
tells the owner what to say, and the owner's own call reaches the agent only with
`TN-Validation-Passed-A` attestation; B, C or missing goes to voicemail with "This line isn't
using our AI assistant yet". Then `maybeAutoGoLiveOnInboundEnd` flips the tenant live on **any**
ended inbound session, and the only inbound session that can end pre-live is the owner's test
call, so in practice "owner hung up ⇒ live" with no outcome check. Of the 17 failure modes in
Appendix D §11, five are severity-high and three of those are in this one step.

## 3. The booking path, exactly (Appendix B §1)

```
caller-id match ──► session.customerId          no match ──► leadId only (no customerId)
        │
classify ──► create_appointment {dateTimePhrase, jobTitle}
        │
runTurnResolution: chrono + luxon in tenant tz; "Thursday" with no time ──► voice_clarification
        │
if (customerId && jobId && dateTimeDescription)   ◄── jobId absent for NEW work ⇒ skip all of this
   resolveAndPlaceAppointmentHold (24 h hold, NO conflict check)
   evaluateAutonomousBookingLane: platform kill switch, tenant flag (default OFF),
     capture class, negotiation flag only (emergency/vulnerability NOT threaded),
     _meta confidence, missingFields NOT threaded, hold placed, hold unexpired,
     slot within business hours, confidence ≥ max(0.90, tenant threshold ?? 0.95)
   eligible ⇒ create_booking {appointmentId}, sourceTrustTier 'autonomous'
        │
buildProposal(... tenantThresholdOverride ...)      ◄── supervisorMode/Present NOT passed
   decideInitialStatus ⇒ resolveAutoApproveThreshold returns LEGACY 0.9 (never null)
   ⇒ lane's own threshold branch is dead; generic 0.9 check approves
        │
execution sweep after UNDO_WINDOW_MS = 5 s ⇒ CreateBookingExecutionHandler flips hold,
   enqueues SMS+email confirmation (consent-gated)      ◄── no owner UNDO SMS on this path
```

Spoken outcomes: eligible → "You're booked for {time}. I'll text you a confirmation — reply if
you need to change it." Lane off or ineligible, hold placed → "I've reserved {time} for you. Our
team will confirm shortly and you'll get a text." (Identical copy for off and ineligible.) The
"I'll text you" promise is itself exposed: SMS consent is asked only on the quote-close path,
never on the booking path, and `TCPA_CONSENT_ENFORCEMENT` defaults to `block` in production, so
the confirmation can be suppressed after the agent promised it.

Linkage for a verified test booking does not exist yet: `voice_sessions` has no caller-number
column, `appointments` has no `voice_session_id` or `proposal_id`; the only joins are the hold's
idempotency key `inbound-book:{session}:{job}` and `proposals.source_context.sessionId`.

## 4. Hand-off, recording, callback (Appendix B §2–3)

The transfer ladder is sound and recently hardened (#1676): `escalateToHuman` dials
`transfer_number` or walks the on-call rotation with a whisper, emergency legs are press-1
screened, `/dial-result` cascades to `call_me_back` and voicemail, the emergency pager sends
three SMS pages two minutes apart on a durable queue. What is missing is narrow: target selection
has no hours or schedule term; the only DTMF handler is the press-1 screen; the escalation
outcome route validates and returns 200 without persisting; and a tenant-scoped recording
playback endpoint already exists (`GET /api/voice/recordings/:id/audio`) but the call log does
not use it.

A consented AI callback reuses more than the first pass assumed: the consent ledger, DNC, the
`block`-mode gate, the media-stream server and `buildConnectStreamTwiml` all exist. What does
not: an outbound answer endpoint that binds a `voice_outbound` session, a `voice` consent kind
(today the voice capture writes `sms` consent only, and outbound voice consent is an
operator-set `customers.consent_status`), AMD handling, and a billing direction. The compliance
reading (Appendix E §4) is that an AI voice is "artificial" under FCC 24-17, there is **no
callback exemption** for cell phones, and the defensible basis is the "knowingly provided the
number for this purpose" doctrine plus an explicit consent utterance logged as an audit event;
the call must open with the business name and that it is an automated assistant; STOP by any
reasonable means; and A attestation requires a per-tenant Trust Hub Business Profile. Legal
review is required before the unit ships, and the design in Appendix E §4 is the minimum
viable shape.

## 5. Knowledge and persona, exactly (Appendix C)

The classifier prompt is seven system messages totalling ~7,600 tokens on a worst-case first
turn against a 9,000 budget pinned at 86%; a new intent block must be paid for by trimming. The
lookup surface (`phone-lookup-surface.ts` → `voice-lookup-answer.ts`) is the right home for a
`lookup_business_info` intent: default-deny allowlist, RBAC map, telemetry, and chat and memo get
the intent for free. Retrieval is feasible inside a turn only in parallel with classify or
against pre-embedded FAQ rows; `knowledge_chunks` already has the cosine ivfflat index and a
0.75 default floor.

Persona today is three columns (`voice_agent_name`, `voice_greeting`, `voice_id`) written only
by the onboarding voice step, no settings sheet, and the streaming path reads one env-wide
ElevenLabs voice id. Appendix C Design B is the resolver, provider-signature, Polly-mapping and
filler-cache change set. Persona never touches classifier text, so cassette hashes stay stable.

The vertical packs carry content the agent never speaks: intake questions, objection reframes,
and repair templates reach only the classifier prompt or the in-app surface. That is a cheaper
quality lever than any new table and is noted in the plan's deferred list.

## 6. What Avoca's customers actually configure (Appendix E §3.1)

Knowledge Base (hours by timezone, policies, emergency guidance, after-hours and callback
policy) → Booking Windows (service → appointment type → when offered) → Fees and Rulesets
(name, "applies to" text, amount; attached to windows and conditions) → Bookability →
Transfer Destinations with open hours and pre-call transfer rules → Call Reasons synced from
ServiceTitan. Recommended order: KB → windows → bookability → transfers → simulations and test
calls → review live calls. Human in the loop: AI handles ~80–85%, the rest warm-transfers to
Avoca-employed CSRs; Coach scores every call and tags why qualified calls did not book. Go-live:
Launchpad checklist, registered test numbers excluded from leads, guided test scenarios, a
readiness review, "most customers live within 2 weeks".

The SMB turnkey set (Rosie, Goodcall, Smith.ai, Jobber, Housecall Pro, Workiz) converges on
the same two product complaints: **bookings with no problem description** and **cannot say a
price**. Rivet's catalog-grounded quoting is the direct answer to the second; the first is a
slot-capture quality bar the corpus should pin.

## 7. What this means for the plan

The plan keeps its eight units and U-IDs. What changes is inside them:

- U2 is now five concrete code changes with measured savings, ordered by ms per unit of risk,
  plus the histogram fix so the result is visible.
- U5 drops the LLM answer step: template topics plus verbatim FAQ through the lookup surface.
- U6 grows from "flip a default" to the four fixes that make the lane reachable and safe (open
  the job for new work, thread the supervisor mode, send the owner UNDO on the live path, check
  the slot before holding) plus the consent ask the confirmation promise needs, and the
  verified-test-booking gate replaces auto-go-live with the linkage columns it needs.
- U8 carries the compliance prerequisites as blocking items, not notes.
- The onboarding section is now the nine-step state machine in Appendix D §12 with the
  failure-mode table behind it.
