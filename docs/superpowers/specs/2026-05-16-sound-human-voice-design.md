# Sound Human — Calling Agent Pacing & Latency Design

*Date: 2026-05-16*
*Status: Draft — pending review*
*Owner: TBD*

## Strategic Frame

**Goal:** Beat Avoca at inbound AI calling.
**Wedge:** Sound more human than Avoca.
**Positioning:** Full receptionist replacement — AI answers every inbound call by default; handoff to humans only on escalation.

This spec covers the **first two layers of the four-layer "Sound Human" plan**: foundation (audio pipeline) and pacing (the perceptual qualities that make a call feel natural). Persona (Layer 3) and Quality / coaching (Layer 4) are scoped separately and not addressed here.

## Why This Matters

The voice pipeline is largely shipped: Twilio Media Streams, Deepgram streaming STT, FSM-driven turn orchestration, per-call cost guardrails, barge-in detection, and outbound backpressure are all in production behind the `TWILIO_MEDIA_STREAMS_ENABLED` flag. What remains is the difference between "functional AI receptionist" and "did I just talk to a person."

The remaining work concentrates on two things:

1. **Reduce time-to-first-audio (TTFA).** Today the TTS provider buffers a complete utterance before any bytes leave the server; that adds 400–800ms of pure dead air on every agent turn.
2. **Eliminate the perceptual "thinking" gap.** Even with streaming TTS, the LLM still needs 300–1500ms to start producing text. During that window the caller hears silence. Human receptionists fill that gap automatically with "mm-hmm" or "let me check that for you."

These two changes, plus two smaller fixes (Deepgram endpoint tuning for HVAC vocab, and structured repair templates for low-confidence turns), are the highest-leverage perceptual improvements available without re-architecting the agent.

## Current State (Verified)

| Capability | Status | Evidence |
|---|---|---|
| Twilio Media Streams (`<Connect><Stream>`) | Shipped | `packages/api/src/telephony/media-streams/` |
| Deepgram Nova-3 streaming STT | Shipped | `transcription-providers.ts:217-338` |
| Per-call session orchestrator | Shipped | `voice-session-store.ts` + `mediastream-adapter.ts` |
| FSM-driven turn loop with session lock | Shipped | `mediastream-adapter.ts:504` |
| Inbound call lifecycle (webhook → session → media stream) | Shipped | `twilio-adapter.ts:479-496` |
| Per-call cost / duration / token caps | Shipped | `session-cost-tracker.ts` |
| Barge-in (interim transcript cancels agent speech) | Shipped | `mediastream-adapter.ts:659-670` |
| Outbound backpressure via Twilio mark acks | Shipped | `mediastream-adapter.ts:588` |
| Slow consumer detection + disconnect | Shipped | `mediastream-adapter.ts:778-809` |
| TTFA telemetry (VQ2-004) | Shipped | per-turn `audio_frame_emitted` event |
| ElevenLabs TTS provider | Partial — REST only | `tts-provider.ts:91-141` |
| Backchannel / filler speech during LLM latency | Not built | — |
| Deepgram keyword boost for HVAC/plumbing | Not built | — |
| Structured repair templates for low-confidence turns | Not built | — |

## In-Scope Features

### F3 — ElevenLabs WebSocket Streaming TTS

**Problem.** `ElevenLabsTtsProvider.synthesize()` calls the REST endpoint and awaits the full audio buffer before returning. The adapter then chunks the buffer into Twilio frames. End-to-end, the first audio byte reaches the caller 400–800ms after the LLM finishes generating text — most of that latency is pure buffering.

**Change.** Use ElevenLabs' WebSocket streaming API (`/v1/text-to-speech/{voice_id}/stream-input`). Audio chunks arrive ~250ms after the WebSocket open and continue streaming as the model synthesizes. The adapter consumes the chunk stream and forwards directly to the existing `streamPcmAsMedia` loop without buffering.

**Surface changes.**
- Extend `TtsProvider` with `synthesizeStream(args): AsyncIterable<{ pcm: Buffer; isFinal: boolean }>` alongside the existing `synthesize()`. REST providers can leave it unimplemented and the adapter falls back to buffered mode.
- `mediastream-adapter.emitSideEffects()` prefers `synthesizeStream` when present. The barge-in path (`bargeIn()` + `outboundTurnId` guard) already handles mid-stream cancellation correctly; the streaming variant just needs to check `turnId !== outboundTurnId` between chunks and abandon the iterator.
- Add a small jitter buffer (~80ms / ~4 frames) before emission to smooth over occasional sub-frame chunks from ElevenLabs and avoid audio clicks.

**Provider selection.** `TTS_PROVIDER=elevenlabs` (existing env var) gates the path. Default stays OpenAI TTS for safety until ElevenLabs streaming has soaked.

**Risk.** ElevenLabs WS occasionally returns partial frames mid-word or partial chunks on the last frame. The jitter buffer handles the former; the streaming-iterator contract requires the provider to flush a final partial chunk on close.

**Effort.** 2–3 days.

### P2-1 — Backchannel / Filler Engine

**Problem.** Between the final Deepgram transcript and the first chunk of agent TTS, the caller hears dead silence for 300–1500ms (LLM latency + tool calls + entity resolution). Even with streaming TTS, this gap is perceptually obvious and is the single biggest "tell" that the caller is talking to a machine.

**Change.** Insert a low-latency canned filler ("mm-hmm, let me check on that…") if the real agent response hasn't started streaming within ~250ms of the final transcript. Cancel the filler cleanly if the real response arrives mid-filler — never overlap.

**How it works.**
- Pre-synthesize a small library (~6–10 fillers per voice) at deploy time. Cache the PCM on disk; never re-generate at call time. Examples: `mm-hmm`, `let me see`, `one moment`, `let me check that for you`, `okay`, `got it`.
- `mediastream-adapter` exposes a `runTurnWithFiller(turnFn)` wrapper. The wrapper:
  - Starts a 250ms timer when `onTranscriptEvent` receives a final transcript.
  - If the timer fires before `emitSideEffects` produces the first audio chunk, pick a filler (rotate or random; tracked per session so we don't repeat back-to-back) and emit it.
  - Track `fillerInFlight: boolean` on session state. When the real response's first chunk is ready, finish the current filler frame cleanly (no mid-word cut) and immediately start streaming the real response.
- Filler selection rules:
  - Never play a filler if the previous turn ended with one.
  - Skip fillers entirely when state is `emergency_dispatch` — emergencies feel less serious if the agent says "hmm".
  - Skip fillers if total estimated turn latency (LLM tier × intent confidence) predicts <250ms — handled by classifier hint, not measured per call.

**Why pre-synthesized.** Generating fillers on demand would defeat the purpose — the whole point is sub-300ms latency. Pre-rendering also lets us hand-pick the warmest takes from ElevenLabs rather than accepting whatever streaming TTS produces in the moment.

**Why the cancellation logic is the hard part.** A filler is playing → real response arrives → we need to stop the filler at a clean frame boundary, drain Twilio's outbound buffer for the filler, and start the real response without overlap or audible glitch. The existing barge-in machinery (`outboundTurnId` + `clear` event) gives us most of this for free; the new logic is the "wait for current frame boundary" gate so we don't truncate fillers mid-word.

**Risk.** Misfires when the agent has a fast response — feels chatty if a filler plays and the real answer arrives 50ms later. Mitigation: the 250ms timer is tunable per tenant; observability dashboard tracks filler-cancellation rate as a quality metric.

**Effort.** 3–4 days.

### P2-2 — Deepgram Endpoint Tuning + Keyword Boost

**Problem.** Default Deepgram endpointing settings clip mid-word on HVAC/plumbing jargon: "...com-pressor" becomes "...com" in the final transcript when the speaker breathes between syllables. The 800ms default silence threshold also feels sluggish at the end of caller turns.

**Change.**
- Add `keywords=furnace:5,compressor:5,condenser:5,thermostat:5,P-trap:5,...` (full list from each vertical pack) to the Deepgram WebSocket URL. Keyword boost raises the model's prior probability for these tokens.
- Reduce endpointing silence threshold from 800ms (default) to 600ms. Fixed global setting initially; add per-tenant override only if data shows it matters.
- Add a per-tenant override map for shop-specific terminology that vertical packs miss (e.g., a shop that calls its diagnostic visit a "house call").

**Surface changes.**
- [transcription-providers.ts:283-287](packages/api/src/voice/transcription-providers.ts#L283-L287): URL builder pulls keywords from a `VerticalTerminologyProvider` (new) seeded from the vertical pack and merged with tenant overrides.
- Vertical packs already carry terminology arrays (per remaining-features.md §3B); this work consumes them.

**Risk.** Over-boosting keywords causes false positives ("furnace" detected when caller said "for instance"). Boost levels are per-keyword; default to 3 (mild boost) and escalate only for terms we observe missed in production.

**Effort.** 1–2 days.

### P2-3 — Conversational Repair Templates

**Problem.** When the agent can't classify intent confidently — STT confidence below 0.7, or FSM intent classifier returns low-confidence — today it falls back to a generic "I'm sorry, can you repeat that?" That phrasing tells the caller "I didn't hear you," which is the most robot-feeling response possible.

**Change.** Add a `clarify_low_confidence` skill that emits structured, contextual repair turns based on what the agent *did* hear:

| Trigger | Repair turn |
|---|---|
| Partial entity match (one of two interpretations) | "Just to make sure, did you say [Smith] or [Smyth]?" |
| Partial intent (multiple candidates) | "Is this about scheduling a visit, or is something not working right now?" |
| Low overall STT confidence | "I'm having trouble hearing you — could you say that one more time?" |
| Vertical-specific (HVAC) | "Is this for your heating or your cooling?" |
| Vertical-specific (plumbing) | "Is this an emergency, like a leak or flooding, or can we schedule a visit?" |

**Surface changes.**
- New skill in `packages/api/src/ai/agents/customer-calling/skills/` named `clarify_low_confidence.ts`.
- FSM `intent_capture` state dispatches to this skill when `confidence < τ_int` (tunable per vertical).
- Vertical-specific templates live in the vertical packs (matches the disambiguation pattern in remaining-features.md §3D).
- A repair turn does NOT reset the FSM — the next caller utterance is treated as a continuation of the same intent, with the partial context retained.

**Risk.** Templates can feel scripted if overused. Add a per-session repair-attempt counter; after 2 repairs in a row, escalate to human rather than try a third clarification.

**Effort.** 3 days.

### P2-4 — Greeting Soft Prompt Cue

**Problem.** Today the greeting ends and the agent immediately enters listening state. Some callers pause, expecting more speech. That gap is small but feels stilted.

**Change.** Greeting TTS ends with an explicit conversational prompt: "...what can I help you with today?" or contextual variants ("...is this about your Thursday appointment?") rather than just stopping. The prompt is part of the same TTS turn, so the caller never hears a hand-off between two TTS clips.

**Surface changes.**
- Update the `greeting` state skill prompt template to always end with a question or invitation.
- One-line change per template; included here for completeness rather than as a separate effort line.

**Effort.** <1 day.

## Out of Scope (Tracked Separately)

- **Persona (Layer 3):** shop-specific voice selection, voice cloning, vertical terminology *in prompts*, maintenance plan greeting personalization, emergency fast-path routing, live customer context pre-load. Maps to remaining-features.md §3A, §3B (prompts side), §3C, §4A.
- **Quality (Layer 4):** call quality scoring dashboard, CSR coaching surface. Maps to remaining-features.md §4B.
- **Escalation (Theme B):** P8-013 warm-transfer-to-on-call, P8-014 call recording integration.
- **Whole-pipeline replacement** with OpenAI Realtime or Gemini Live. Rejected during brainstorming: loses per-shop voice cloning and forces a re-architecture of the proposal/tool flow.

## Success Criteria

- TTFA p50 drops from current measurement (TBD — pull from VQ2-004 dashboard) to under 600ms.
- No silence gap on any agent turn exceeds 400ms in live calls (measured: time between caller's last STT-final and agent's first audio frame, modulo filler).
- Filler cancellation rate stays below 20% (above that, the 250ms threshold is too aggressive).
- Repair templates fire on <15% of intent-capture turns (above that, STT or intent classifier need tuning, not more repairs).
- Subjective listener test: 8/10 internal listeners can't reliably distinguish a Serviceos call from a human receptionist on a 30-second clip. (Set up via Layer 4 work; mentioned here as the qualitative bar.)

## Open Questions

1. **Filler voice consistency.** When per-shop voice cloning ships (Layer 3), do we re-render the filler library per voice, or use a neutral filler voice across all shops? Re-rendering is operationally heavier but more cohesive.
2. **Endpointing tuning per call.** Should we drop the silence threshold further (e.g., 400ms) for callers who speak in short bursts, and raise it for callers who pause mid-sentence? Adaptive endpointing is real Deepgram functionality but adds complexity. Defer until we have call data.
3. **Filler library size.** Six fillers risks repetition feeling robotic; twenty risks operational overhead. Suggest start with eight, expand based on session repetition data.
4. **ElevenLabs jitter buffer size.** 80ms is a guess. Tune empirically once streaming is live.

## Risks

- **R1. ElevenLabs WS reliability.** Streaming WebSockets fail more often than REST endpoints. Need explicit fallback path: on WS open failure or mid-stream error, fall through to buffered REST synthesis for the remainder of the turn. Reuse the LLM gateway's breaker pattern.
- **R2. Filler-cancellation race.** Wrong cancellation logic produces audible glitches (clicks, mid-word cuts, double-speak). Spec a tight test harness with synthetic latency injection before merging.
- **R3. Keyword boost regressions.** Aggressive boost values can degrade general transcription quality. Roll out per-tenant behind a flag; measure WER (word error rate) before/after on a held-out call sample.
- **R4. Tenant override map abuse.** Tenants adding 100+ custom terms could degrade Deepgram performance or exceed URL length limits. Cap per-tenant overrides at 50 terms; reject excess at the settings UI.

## Verification Plan

- Unit tests for filler cancellation race scenarios (fast response, slow response, response exactly at 250ms boundary).
- Integration test: mocked ElevenLabs WS emitting chunks at varying jitter, asserting no gaps in outbound media frames.
- Load test: 50 concurrent calls with filler engine active; confirm no orchestrator memory growth or CPU spikes.
- Manual A/B listening test: 10 paired calls (with/without each P2-N feature) reviewed by 3 internal listeners, scored on naturalness.

## Sequencing Recommendation

Ship in this order to capture perceptual wins early:

1. **F3 — ElevenLabs streaming TTS** (biggest single TTFA win; unblocks the rest)
2. **P2-2 — Deepgram keyword boost + endpoint tuning** (independent; small fix, large daily impact)
3. **P2-4 — Greeting soft prompt cue** (one-line prompt change; ship with F3)
4. **P2-3 — Conversational repair templates** (medium effort; matters most in low-quality audio conditions)
5. **P2-1 — Backchannel / filler engine** (highest perceptual impact but riskiest; ship last with most testing)

Estimated total effort: 9–13 engineer-days end-to-end. Parallelizable across two engineers as 6–8 calendar days.
