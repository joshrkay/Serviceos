# Seamless Handoff — Dispatcher Context + Escalation Triggers Design

*Date: 2026-05-17*
*Status: Draft — pending review*
*Owner: TBD*
*Parent theme:* "Full Receptionist Behavior" (Theme B from the Sound Human brainstorming).

## Strategic Frame

**Goal:** When the AI hands off a call to a human dispatcher, the dispatcher receives full caller context before saying "hello" — and the AI knows when to hand off without the caller having to fight for it.

**Positioning continuation:** Sound Human (PR #393) made the AI sound like a human receptionist. This spec makes the *handoff* feel human too. A cold-transferred caller is the inverse of warm — and the inverse of the entire wedge.

**Scope:** Theme B sub-projects B2 + B3 from the Sound Human brainstorming. Other Theme B work (voicemail, multi-channel continuity, routing rules UI) is tracked separately and explicitly out of scope here.

## Why This Matters

The Sound Human work shipped a calling agent that callers can't reliably distinguish from a human. But when escalation happens today, the dispatcher gets a cold dial with no context — they pick up and say "hello?" while the caller has already invested a minute explaining their problem to the AI. The dispatcher then makes the caller repeat everything. This single moment undoes most of the perceived AI quality.

The handoff also fires too rarely today. The only escalation trigger is sustained low-confidence intent classification (3 failed reprompts). A caller who says "this is ridiculous, let me talk to a person" today gets the AI trying once more. A frustrated caller hangs up before the FSM gives up.

This spec fixes both ends: more triggers, richer context on transfer.

## Current State (Verified)

| Capability | Status | Evidence |
|---|---|---|
| Twilio `<Dial>` transfer on escalation | Shipped | `twilio-call-control.ts` + `twilio-adapter.ts:354` |
| On-call rotation lookup | Shipped | `escalate-to-human.ts` queries `onCallRepo` |
| FSM emergency fast-path | Shipped | `transitions.ts:372-390` (skips entity_resolution/intent_confirm) |
| FSM sustained low-confidence escalation | Shipped | `transitions.ts:412-488` (TAU_INT + MAX_INTENT_CAPTURE_RETRIES) |
| `emergency_dispatch` intent | Shipped | `intent-classifier.ts:30,63,320-330` |
| `operator_request` intent | **Not built** | classifier has 15 intents, no explicit "talk to human" |
| Keyword frustration detection | **Not built** | no detector at all |
| LLM sentiment classification per-turn | **Not built** | post-call grading exists, per-turn does not |
| Dispatcher SMS with caller context | **Not built** | escalation skill emits no SMS side effect |
| Dispatcher in-app push (live panel) | **Not built** | SSE event bus exists, no escalation event variant |
| Twilio whisper TwiML on dispatcher answer | **Not built** | `<Dial>` produces bare `<Number>`, no `url=` attribute |
| Summary builder service | **Not built** | no service composes caller/intent/transcript into transfer-ready text |

## Architectural Decisions (Locked During Brainstorming)

1. **Delivery channel: Twilio Whisper** (chosen over push-then-dial and hybrid). The summary plays in the dispatcher's ear when they pick up; SMS + in-app act as persistent reference cards during the call. Reasoning: zero added latency for the caller, dispatcher cannot miss context (it's audio they're forced to hear), works for owner-on-phone shops where they can't read an SMS while driving.
2. **Dual surfaces: SMS + in-app, toggleable per shop.** SMB diversity demands both. Default both on, let tenants opt out of either.
3. **Summary builder is template-based, not LLM-backed.** Speed (must feel instant) + cost (runs on every transfer) + reliability (template can't hallucinate the caller's name). Transcript text is included verbatim in `panel_data`; only the whisper/SMS projections need composing, and they can be done from structured fields.
4. **All three sentiment triggers ship.** Explicit `operator_request` intent + keyword detector + LLM sentiment classifier. The LLM sentiment runs async (fire-and-forget after the turn) so it adds zero latency.
5. **Transcript in the in-app panel is a snapshot, not a live stream.** Captured at escalation time, rendered once. Live streaming deferred to v2 — it adds SSE load, privacy/consent complexity, and isn't worth the risk in v1.
6. **Per-tenant config defaults: all three channels ON, all triggers ON, LLM sentiment OFF.** LLM sentiment is opt-in because of its per-turn cost; the keyword detector + explicit intent cover most cases for free.

## In-Scope Features

### F1 — `EscalationSummaryBuilder` service

**Problem.** The escalation path has no central place to compose dispatcher-ready summaries. SMS + in-app + whisper would otherwise each compose their own (duplicated logic, drift risk).

**Change.** New pure-function service:

```typescript
// packages/api/src/ai/agents/customer-calling/escalation-summary-builder.ts
interface EscalationContext {
  caller: { name?: string; phone: string; customerId?: string; tags?: string[] }
  customer: { lastService?: { date: Date; type: string; amount?: number }; isMember?: boolean; memberTier?: string }
  intent: { type: IntentType; entities: Record<string, unknown>; confidence: number }
  escalationReason: 'low_confidence_intent' | 'operator_request' | 'keyword_frustration' | 'llm_sentiment' | 'emergency_dispatch'
  reasonDetail?: string  // matched keyword, sentiment score, etc.
  transcriptSnapshot: Array<{ role: 'caller' | 'ai'; text: string; ts: number }>  // last 4-6 turns
  shopName: string
}

interface EscalationSummary {
  whisper: string       // ≤25 words, TTS-friendly
  sms: string           // ≤160 chars, scannable
  panel: PanelData      // structured object for in-app render
}

export function buildEscalationSummary(ctx: EscalationContext): EscalationSummary
```

**Composition rules:**
- `whisper`: `"Incoming call from {caller.name or 'unknown caller'}{caller.phone formatted}. {intent_short}. {membership_phrase}. {reason_phrase}."` — capped at 25 words; truncate intent description if needed.
- `sms`: `"{shopName}: Incoming call from {caller.name} ({caller.phone}). Re: {intent_short}. {membership_tag}. Reason: {reason_short}. Details: {shortLink}"` — capped at 160 chars (one SMS segment).
- `panel`: full structured object — separate fields for each block in C1 (header, customer, last_interaction, intent, reason, transcript_snapshot, outcome_buttons).

**Effort.** 2 days (templates + tests + integration into existing escalation skill).

### F2 — `escalate_with_context` SideEffect

**Problem.** Current escalation emits `notify_oncall` which only drives `<Dial>`. There's no central side effect that bundles all three handoff channels.

**Change.** Add a new SideEffect type:

```typescript
// types.ts — extend SideEffectType union:
| 'escalate_with_context'

// payload shape:
{
  escalationId: string  // ULID
  summary: EscalationSummary
  dispatcher: { userId: string; phone: string }
  callSid: string
  tenantId: string
  channelPreferences: { sms: boolean; in_app: boolean; whisper: boolean }
}
```

**Emitted from:** `escalate-to-human.ts` skill, replacing the current `notify_oncall` emission. The skill resolves the on-call rotation, builds the summary via F1, and emits this single side effect carrying everything.

**Consumed by:** `mediastream-adapter.ts` (telephony) and `inapp-adapter.ts` (in-app channel — needs an equivalent no-op or in-app-only path since there's no Twilio whisper there).

**Effort.** 1 day (type + emission + handler stub).

### F3 — Twilio Whisper webhook + `<Dial url=...>` rewiring

**Problem.** Current `<Dial>` TwiML produces a bare `<Number>`. When the dispatcher answers, both legs connect immediately with no context.

**Change.**
1. **Extend `twilio-call-control.ts` `dialDispatcher()`** to include the `url=` attribute on `<Number>`:
   ```xml
   <Response>
     <Dial>
       <Number url="https://api.serviceos.app/api/telephony/whisper/{escalationId}">
         +15551234567
       </Number>
     </Dial>
   </Response>
   ```
2. **New route** `GET /api/telephony/whisper/:escalationId` — returns TwiML:
   ```xml
   <Response>
     <Say voice="Polly.Joanna">{whisper_text}</Say>
   </Response>
   ```
3. **Storage:** `escalationId → whisper_text` stored in a Redis-backed (or in-memory with TTL) cache with 5-minute expiry. Twilio fetches the URL within seconds of the dispatcher answering; the entry is reaped after.
4. **Fallback voice:** Reuses the per-tenant voice from the existing TTS config so the whisper sounds like the rest of the agent.

**Surface changes:**
- `packages/api/src/telephony/twilio-call-control.ts` — extend `dialDispatcher` signature with `whisperUrl?: string`
- `packages/api/src/telephony/whisper-cache.ts` — new, thin interface over Redis (or in-memory shim for tests)
- `packages/api/src/telephony/routes.ts` — new `GET /whisper/:escalationId` handler

**Effort.** 2 days (webhook + storage + integration test).

### F4 — Dispatcher SMS

**Problem.** No SMS goes to the dispatcher today.

**Change.** When the `escalate_with_context` side effect fires AND `channelPreferences.sms === true`, send the `summary.sms` text to `dispatcher.phone` via the existing Twilio delivery provider. Fire-and-forget; failures are logged but don't block the rest of the handoff.

**Surface:** Inside `mediastream-adapter.ts`'s handler for `escalate_with_context`. Uses existing `twilio-delivery-provider`.

**Short link generation:** `summary.sms` includes `app.serviceos.app/c/{escalationId}` — a short-link route in the web app that resolves the escalation and renders the mobile-friendly panel.

**Effort.** 1 day.

### F5 — In-app Live Panel (web frontend)

**Problem.** Dispatchers using the web app today get no real-time alert when an escalation happens.

**Change.**
- **New SSE event variant** `escalation_started` carrying `panel.PanelData`. Emitted from the `escalate_with_context` handler when `channelPreferences.in_app === true`.
- **New React component** `EscalationPanel` — floating overlay positioned top-right, dismissible only after the call ends. Renders the structured PanelData blocks (header, customer info, last interaction, intent, reason, transcript snapshot, outcome buttons).
- **New hook** `useEscalationStream` — subscribes to the SSE bus (extending the existing voice-quality event subscription), manages a queue of active panels (in case two escalations fire simultaneously to the same dispatcher), handles dismiss + outcome capture.
- **Mount point:** `EscalationPanelHost` rendered at the app root so panels overlay any page.

**Outcome buttons:** "Mark resolved" / "Customer hung up" / "Needs callback" — POST to a new `/api/escalations/:id/outcome` endpoint. Stored for later use by the call quality scoring spec (out of scope here).

**Mobile rendering:** The same `EscalationPanel` adapts for mobile viewports so the SMS short-link works.

**Effort.** 4 days (component + hook + SSE wiring + mobile responsive + outcome capture).

### F6 — Three new escalation triggers (B3)

#### F6a — `operator_request` intent (B3.1)
- Add `operator_request` to `IntentType` union, `SUPPORTED_INTENTS` array, and system prompt in `intent-classifier.ts`. Examples in the prompt: "let me talk to a human", "I want a person", "is anyone there", "transfer me to dispatch", "I don't want to talk to a bot".
- FSM handling in `transitions.ts`: when `intent_classified` event has `intentType === 'operator_request'`, transition directly to `escalating` with `escalationReason: 'operator_request'`. Mirrors the existing `emergency_dispatch` fast-path.
- Effort: <1 day.

#### F6b — Keyword frustration detector (B3.2)
- New file: `packages/api/src/ai/agents/customer-calling/frustration-detector.ts`.
- Pure function `detectFrustration(transcript: string): { matched: boolean; keyword?: string }`.
- Keyword list (initial): `['this is ridiculous', 'this is stupid', 'forget it', 'never mind', 'i want a human', 'real person', 'speak to a person', "i'm frustrated", "this isn't working", 'are you kidding', "i'll just hang up", 'this is wasting my time']`.
- Word-boundary regex; case-insensitive.
- Called from `processCallerUtterance` in `twilio-adapter.ts` BEFORE intent classification runs. If match → emit synthetic FSM event `frustration_detected` with `keyword` payload, bypassing classification.
- FSM handles `frustration_detected` → transition to `escalating` with `escalationReason: 'keyword_frustration'`, `reasonDetail: <keyword>`.
- False-positive guard: keyword list deliberately starts narrow; expansion based on call data after launch.
- Effort: 1 day.

#### F6c — LLM sentiment classifier per-turn (B3.3)
- New file: `packages/api/src/ai/agents/customer-calling/sentiment-classifier.ts`.
- `classifyTurnSentiment({ transcript, priorTurns, intent }) → Promise<{ frustrationScore: number; reasonHint?: string }>`.
- Uses the existing LLM gateway's tier-1 (lightweight, fast, cheap) model. ~150ms typical latency, ~$0.0001 typical cost.
- Called **async, fire-and-forget** after `processCallerUtterance` dispatches the turn. Does NOT block the audio response.
- If `frustrationScore >= threshold` (configurable per tenant, default 0.7), emit `frustration_detected` event into the FSM out-of-band. Same FSM handling as F6b; `escalationReason: 'llm_sentiment'`, `reasonDetail: sentiment score`.
- **Cost cap:** Reuses the existing per-session cost tracker. If cumulative sentiment-classifier cost exceeds 25% of session budget, drop further sentiment calls (keyword detector still active).
- **Default off** at tenant level (see F8 settings).
- Effort: 2 days.

### F7 — Telemetry events

Add to `packages/api/src/ai/voice-quality/events.ts`:

```typescript
escalationStartedEvent({ escalationId, reason, dispatcherUserId })
escalationSummaryBuiltEvent({ escalationId, durationMs })
whisperPlayedEvent({ escalationId, dispatcherCallSid })
dispatcherAnsweredEvent({ escalationId })
dispatcherNoAnswerEvent({ escalationId, secondsRing })
escalationOutcomeEvent({ escalationId, outcome: 'resolved' | 'hung_up' | 'needs_callback' })
```

Emitted at the corresponding points (summary builder, whisper webhook hit, Twilio call status callbacks, outcome button click). Consumed by the future call quality scoring spec — for now they're observable via the existing AgentEventBus.

**Effort.** 1 day (event types + emission points).

### F8 — Per-tenant `escalation_settings` config

**Surface:** Extend the existing tenant settings table with a new JSON column / settings record:

```typescript
{
  channel_sms: true,          // default ON
  channel_in_app: true,       // default ON
  channel_whisper: true,      // default ON
  trigger_low_confidence: true,    // baseline, always on
  trigger_explicit_request: true,  // free, default ON
  trigger_keyword_frustration: true, // free, default ON
  trigger_llm_sentiment: false,    // opt-in, default OFF
  llm_sentiment_threshold: 0.7,    // tunable when llm enabled
}
```

**Web UI:** New section in the existing Settings page: "Call Routing & Handoff." Reuses existing settings save flow.

**Effort.** 2 days (settings schema + web UI + load/save in the escalation skill).

## Out of Scope (Tracked Separately)

- **B1 last-10% (per-vertical emergency indicators in packs)** — Small follow-up; can be a 1-day PR after this spec lands.
- **B4 Voicemail fallback** — Spec: "Don't Lose The Call" (planned, future).
- **B5 Multi-channel continuity (SMS resume after drop)** — Same future spec.
- **B6 Business hours + routing rules UI** — Spec: "Operator Control" (planned, future).
- **Call recording integration (P8-014)** — Separate spec.
- **Call quality scoring dashboard** — Consumes the F7 telemetry; separate spec.
- **Live transcript streaming in the in-app panel** — Deferred to v2.
- **Per-shop voice cloning for the whisper voice** — Sound Human Layer 3 work; separate spec.

## Open Questions

1. **Whisper voice choice.** Sound Human ships ElevenLabs streaming for caller-facing speech. The whisper plays only to the dispatcher — should it use the same ElevenLabs voice (consistent brand) or a faster/cheaper OpenAI voice (whispers are short, latency doesn't matter as much)? Lean toward ElevenLabs for consistency; revisit if cost becomes an issue.
2. **Redis vs in-memory for the whisper cache.** Production is multi-instance (Railway); in-memory means a Twilio webhook could hit the wrong instance and 404. Lean toward a tiny Redis-backed cache. If the team prefers to avoid a new dependency, fall back to sticky sessions on the Twilio-facing routes (existing pattern?).
3. **SSE bandwidth for in-app panel.** The existing SSE bus already carries voice-quality events for every active call. Adding escalation events is low frequency (escalations are rare per shop) so this should be fine, but worth confirming the dispatch board doesn't already have SSE load issues at peak.
4. **Outcome capture timing.** The "Mark resolved / Hung up / Needs callback" buttons should appear *after* the call ends. We need a signal for "call ended" on the dispatcher's leg — Twilio call status callback. Verify the existing call-status-callback wiring covers dispatcher-leg termination, not just caller-leg.

## Risks

- **R1. LLM sentiment false positives.** A frustrated caller may genuinely be frustrated *at the problem*, not the AI ("this AC has been broken for a week, this is ridiculous"). Escalating in that case may be helpful OR may pull a dispatcher away from another call. Mitigation: ship with conservative threshold (0.7), default off, track precision over first 2 weeks, tune from data.
- **R2. Whisper webhook timeout.** If our `/whisper/:escalationId` endpoint is slow, Twilio gives up and connects without whisper. Mitigation: in-memory short-TTL cache (or Redis with low-latency lookup), aggressive timeout monitoring.
- **R3. Dispatcher phone offline when SMS sent.** Phone carrier latency could mean the SMS arrives mid-call or after. The whisper covers this — even if SMS is late, dispatcher already has audio context.
- **R4. SSE disconnect during escalation.** Web app dispatcher gets disconnected from SSE → no in-app panel → falls back to SMS + whisper. Acceptable degradation.
- **R5. Idempotency under Twilio retries.** Twilio retries 5xx responses on the whisper webhook. The webhook must be safe to call multiple times — it just reads from the cache, so this is fine by design.

## Verification Plan

- **Unit tests:**
  - `EscalationSummaryBuilder` — golden-file tests for whisper/sms/panel given representative `EscalationContext` fixtures (8-10 cases covering different reasons, identified vs anonymous callers, members vs non-members, with/without prior service).
  - `FrustrationDetector` — match cases, non-match cases including the "forget it" / "forget the AC" word-boundary edge case.
  - `SentimentClassifier` — mocked LLM responses, threshold logic, cost-cap behavior.
  - FSM transition tests — `operator_request` → escalating; `frustration_detected` → escalating; idempotency under repeated trigger events for the same session.

- **Integration tests:**
  - Mediastream-adapter handles `escalate_with_context` → asserts three parallel dispatches happen (SMS provider mock called, SSE event emitted to bus, whisper TwiML registered in cache and retrievable via webhook).
  - End-to-end via Vitest: simulated final transcript with `operator_request` → all four artifacts produced (whisper cached, SMS sent, in-app event emitted, Twilio `<Dial>` with whisper URL).

- **Manual test plan** (for the PR):
  - Real inbound call → say "let me talk to a human" → dispatcher receives SMS within 2s, sees in-app panel within 500ms, hears whisper when answering.
  - Same flow with frustration keyword.
  - Same flow with sustained low confidence (existing path) — confirm summary builder receives the right context.
  - Per-tenant config: turn off `channel_in_app` → only SMS + whisper fire.
  - Per-tenant config: turn on `trigger_llm_sentiment` → frustrated-but-no-keyword caller triggers escalation.

## Success Criteria

- **Time-to-context for dispatcher:** Whisper plays within 100ms of dispatcher answer (Twilio-controlled). SMS arrives within 2s of escalation (Twilio carrier latency). In-app panel renders within 500ms.
- **Escalation precision:** ≥80% of escalations are warranted (dispatcher confirms via outcome buttons). Sub-criterion: LLM sentiment trigger precision ≥70% (lower bar since it's the most speculative trigger).
- **Caller experience on transfer:** Caller never hears more than 1s of silence between AI's last utterance and dispatcher's "hello" (Twilio dial latency aside).
- **No regression on caller-facing audio path:** Filler engine and streaming TTS metrics from Sound Human stay within ±5% after this ships.
- **Trigger distribution at 2 weeks post-launch:** We can answer "what % of escalations came from each trigger?" If LLM sentiment is <5% precision AND adds <2% absolute escalation volume, drop it.

## Sequencing Recommendation

Ship in this order to capture user value early:

1. **F1 (Summary builder)** — pure function, no dependencies, deterministic. Lays the foundation everything else uses.
2. **F2 (`escalate_with_context` SideEffect)** — extends FSM contract, used by F3-F5.
3. **F6a (`operator_request` intent)** — tiny, unblocks the most user-visible improvement.
4. **F4 (SMS)** — simplest delivery channel, biggest user-visible win after F6a.
5. **F3 (Whisper webhook + `<Dial url=>`)** — second delivery channel, depends on F1+F2.
6. **F7 (Telemetry)** — slotted in alongside F3/F4 since events fire from those handlers.
7. **F6b (Keyword detector)** — independent, low risk.
8. **F5 (In-app panel)** — frontend work, can develop in parallel with backend; ships when ready.
9. **F8 (Tenant config)** — gates F5 and F6c rollouts.
10. **F6c (LLM sentiment)** — last, behind opt-in flag, easy to ship dark.

Estimated total effort: 16–18 engineer-days. Parallelizable across two engineers (one backend-focused on F1–F4, F6, F7; one frontend-focused on F5 + F8 UI) as ~9–10 calendar days.
