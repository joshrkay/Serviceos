# A. Turn latency budget — realtime (Media Streams) and Gather

Branch `plan/voice-parity-bland-avoca`, read-only trace. All paths under `packages/api/src/`. "Knowledge" = not in repo, from my training data; verify before quoting.

## 1. Audio in: Twilio → μ-law → Deepgram

- Twilio sends 20 ms frames (160 B μ-law @ 8 kHz, base64) — `telephony/media-streams/mulaw-codec.ts:4-6`.
- `handleMedia` (`mediastream-adapter.ts:1837-1859`) decodes **per frame, no batching**: base64 → table lookup → linear 2× upsample to PCM16@16k (640 B) → `deepgram.send(pcm16)` immediately (`:1852-1853`; `voice/transcription-providers.ts:615-617`, `ws.send` per chunk). Cost ≈ tens of µs/frame.
- Frames are dropped (not queued) until the disclosure has played (`captureEnabled`, `:1846`; set on the `silence-arm-` mark ack `:1270-1280`) and while a Deepgram reopen is in flight (`:2509-2510`).
- Deepgram WS URL (`transcription-providers.ts:480-484`): `model=nova-3&language=..&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true&endpointing=600`; `keyterm=` on Nova-3 (`:508`). `endpointingMs` is an option (`:478`) but **no caller passes it** — the adapter only passes `keywords` (`mediastream-adapter.ts:2400-2406`) — so 600 ms is the effective value everywhere.
- Message handling (`:590-603`): only `type==='Results'`; empty transcripts dropped; `type` = `is_final ? 'final' : 'partial'`; `confidence ?? 1`. **`speech_final` is never read; `UtteranceEnd`/`SpeechStarted` are ignored.** Handshake bounded at 5 s (`:420-428`).

## 2. Endpoint detection

- A "turn" = any `Results` with `is_final:true` (`mediastream-adapter.ts:1888` onward). Because `speech_final` is ignored, a long utterance that Deepgram finalises in two segments (Deepgram emits `is_final` at internal segment boundaries, not only at the endpoint — knowledge) dispatches **two speechTurns**, the second serialised behind the first by the session lock.
- Caller silence required: 600 ms endpointing + Deepgram finalisation/network (~100–250 ms, knowledge) ≈ **0.7–0.9 s** before the server even knows the turn ended. No minimum/maximum utterance window exists in code.
- Pre-dispatch serial awaits on the final (`:1910-1941`): explicit language-switch scan (in-memory regex; consumes the turn and reopens Deepgram ≈ 1 WS RTT if it switches), first-final language detection (one-shot), low-STT-confidence gate (`isLowSttConfidence`, reprompt instead of dispatch).
- Silence reprompt: 8 s (`DEFAULT_SILENCE_REPROMPT_MS`, `:1051`), armed only when Twilio acks the end-of-utterance `silence-arm-${turnId}` mark (`:3811-3818`, `:1290-1297`), expiry runs under the session lock (`:3754-3800`).
- Hold line: if no real audio by 4.5 s after STT-final, `TURN_HOLD_COPY` is spoken (`DEFAULT_TURN_HOLD_DEADLINE_MS`, `:1071`, `armTurnHold :3005-3030`).

## 3. Early filler

- Armed at STT-final before `speechTurn` (`:1962`), timer `deps.fillerDelayMs ?? 250` (`:2970`; dep at `:315`; app.ts does not set it → 250). On fire: `engine.selectNext({language})`, `cache.get(id)` (pre-rendered PCM16@16k, `ai/agents/customer-calling/filler-audio-cache.ts:65-68`, synthesised at boot if missing `:115-132`), bumps `outboundTurnId`, sets `agentSpeaking=true, fillerActive=true`, streams via `streamPcmAsMedia(pcm, turnId, isFiller=true)` (`:2984-2990`). Clips: "Mm-hmm." 320 ms … "Let me check on that." 720 ms (`fillers/manifest.ts:35-42`; es `:44-51`).
- A **second** filler timer runs inside `runTurnWithFiller` (`:3091-3117`) covering TTS TTFB, only for the first line of a reply (`allowFiller`, `:2727-2731`, `:2798`).
- Cancelled: timer-only when the turn has a `tts_play` (`:2022`); clip + timer when no TTS (`:2020`), on speechTurn failure (`:1997`), when the hold line fires (`:3026`), on barge-in (`:3540-3550`); an in-flight clip is cut by the first real PCM chunk via `cancelActiveFiller` (`:3103-3114`).
- Metrics: the filler's first frame **does** consume `turnLatencyStartMs` → `voice_turn_latency_ms` records first-audible (`:3444-3463`); `audio_frame_emitted` (Layer-2 TTFA) is emitted only on the first real chunk (`:3469-3480`). See §6.

## 4. speechTurn — every awaited I/O, in order

Entry: `onTranscriptEvent` → `store.withSessionLock(session.id, () => deps.speechTurn(...))` (`:1973-1980`). The lock is an in-memory promise chain (`ai/agents/customer-calling/voice-session-store.ts:791-810`); typical wait 0 ms. **Every interim** also takes this lock for `scanInterimForEmergency` (`:2231-2238`, no keyword pre-filter before locking) — cheap (in-memory keyword scan) but serialised with the final.

`deps.speechTurn` = `twilioAdapter.processCallerUtterance` (`app.ts:4863-4869`) → `ai/voice-turn/create-voice-turn-processor.ts:5659`. Serial awaits (no `Promise.all` anywhere on this path; the only parallelism is `Promise.allSettled` for escalation notifications `:3676-3693`):

| # | Step | I/O | file:line |
|---|---|---|---|
| a | `appendTranscript` (caller) | in-memory push; DB `recordTurn` fire-and-forget | `voice-session-store.ts:833-870`; `twilio-adapter.ts:2014+` |
| b | `runDeterministicSafetyScan` | in-memory | `twilio-adapter.ts` (processCallerUtterance) |
| c | `handlePendingVoiceApproval`, `handlePendingConsentCapture`, `handlePendingServiceAreaCheck`, `handleCallerIdentityCheck`, `handlePendingRebookOffer` | null fast-paths; DB only when a dialogue is pending | `:5700-5712`, `:5790`, `:5830`, `:5900` |
| d | `handleAskCaller` (state `ask_caller` only) | customer lookup by phone (DB) | `:5814` |
| e | `buildPhoneClassifyContext` | `resolveVerticalPromptSection` (5-min cache, `verticals/resolve-active-pack.ts:94-120`) **then** `resolvePlanPromptSection` (DB when `customerId`) — sequential | `:1372-1377` |
| f | `classifyIntent` → `gateway.complete` | LLM | `:5943`; `ai/orchestration/intent-classifier.ts:3193-3221` |
| g | `auditOffSurfaceClassification` (off-surface only), `recordCost`, `releaseHeldCallerForRequest`, `callerRecordIsArchived` (DB, memoised per session `:4715`), `crossCustomerRefusal` | 0–2 DB reads | `:5959-6150` |
| h | lookup intents → `answerPhoneLookup` (DB) and return | | `:6161` |
| i | `serviceAreaGate` / `staleAppointmentGate` (booking intents; DB) | | `:6390-6430` |
| j | `session.machine.dispatch(classifierEvent)` | sync FSM | `:6432` |
| k | `resolveTurnEntityEvent` → `runTurnResolution`: `resolveSessionTimezone` (60 s cache, `app.ts:1353-1362`) + `resolveSchedulingEntities` → pg-entity-resolver SELECTs (1–3 queries, e.g. `ai/resolution/pg-entity-resolver.ts:1420,1589,1669`) | DB | `:6440-6452`, `:1951-1965` |
| l | `executeSideEffects` — sequential `for`: `audit_log` → `auditRepo.create` (INSERT) ; `create_proposal` → `handleCreateProposal`: `resolveThresholdOverride` (cached), `buildVoiceProposalPayload`, `groundLineItemPricing` (catalog DB), `proposalRepo.create` (INSERT), `auditRepo.create` (INSERT); booking intents add `settingsRepo.findByTenant` + `resolveAndPlaceAppointmentHold` (availability read + hold write) | 2–6 DB round-trips | `:3696-3735`, `:1703`, `:2258-2560`, `:2782-2811` |
| m | `appendAgentTts` | in-memory + fire-and-forget DB | `voice-turn/transcript-append.ts:73-86` |

Classifier (step f): task `classify_intent` → tier `lightweight` (`config/ai-routing.ts:199`), model `AI_LIGHTWEIGHT_MODEL || 'meta-llama/llama-3.1-8b-instruct'` via OpenRouter (`:34-35`; `.env.production.example:99`; gpt-4o-mini is the commented alternative `:108`), `temperature 0, maxTokens 1024` (`:261`). Deadline `resolveClassifyIntentDeadlineMs()` = 4 000 ms default, **12 000 ms on production** (`ai-routing.ts:110-121`; `.env.production.example:113`); the 1.5 s lightweight tier deadline (`:100`) is overridden by it. Retries inside that deadline: `DEFAULT_RETRY` 3 attempts, 100 ms base full-jitter (`ai/gateway/retry.ts:34-36`; `compose-resilience.ts:114-122`). Prompt size, measured by executing `buildClassifierSystemPrompt` (`ai/orchestration/classifier-profile.ts`): **caller profile 12 195 chars ≈ 3.0k tokens** (inbound unknown caller, `classifierProfileForSession :643-647`), field_tech 15.7k chars ≈ 3.9k tokens, **operator/owner line 61 116 chars ≈ 15k tokens**; plus optional sections (vertical ctx, fence 706 chars, protection 2 474 chars) and the utterance. Output ≈ 60–150 JSON tokens.

Fire-and-forget after the reply is queued (not under the lock): sentiment classifier (`:2083-2100`) and vulnerability triage (`:2107-2128`) — both are extra LLM calls per turn when enabled and share the tenant's gateway quota (concurrency 8, `intent-classifier.ts:3203-3208`), so they can delay the *next* turn's classify under load.

## 5. TTS

- `emitSideEffects` (`mediastream-adapter.ts:2722`) walks `tts_play` effects **sequentially**; each line: `renderTtsText` (sync) → `runTurnWithFiller` (`:3074`) → `ttsProvider.synthesizeStream` → `new ElevenLabsStreamConnection` → **new WebSocket per line** (`ai/tts/elevenlabs-stream.ts:114-121`; `tts-provider.ts:240-249`). Handshake (DNS+TCP+TLS+WS upgrade to api.elevenlabs.io) ≈ 150–400 ms (knowledge).
- Model `eleven_turbo_v2_5` (`tts-provider.ts:161`), `eleven_multilingual_v2` for es (`:241-242`, slower), `output_format=pcm_16000` (`elevenlabs-stream.ts:116`). On open: BOS `{text:' ', xi_api_key, voice_settings}` then **the whole text in one message** then EOS `{text:''}` (`:195-202`). No sentence splitting, no `flush`, no `chunk_length_schedule`, no `auto_mode`, no `optimize_streaming_latency` (grep: none in `src`). First audio after EOS ≈ 150–300 ms for turbo (file's own estimate "~250–800 ms" `:16`; `tts-provider.ts:150-152` claims ~250 ms). Chunk size is provider-chosen (typically a few KB ≈ 100–300 ms audio).
- Per chunk: `streamPcmAsMedia` (`:3419`) slices 640 B (20 ms) frames, `encodeTwilioOutboundFrame` (average-pair downsample + closed-form μ-law, `mulaw-codec.ts:142-182`, <0.1 ms/frame), enqueues on `BoundedSendQueue`, drained by sequential `ws.send` (`:4416-4445`; `ws/bounded-send-queue.ts:137-153`). A `mark` every 25 frames (500 ms) and at line end (`:3485-3498`); `TWILIO_MAX_UNACKED_MARKS=3` (`:931`) → up to ~1.5 s of audio sits in Twilio's buffer; back-pressure wait polls 20 ms up to 200 ms (`:3509-3521`). Twilio playout adds ~100–200 ms (knowledge).
- Stall bound 4 s per frame (`elevenlabs-stream.ts:20`). Recovery path uses REST `synthesize()` (3 s × 2, `:1060-1067`, `:1110`) which returns `audio/mpeg` and is therefore **dropped** (`:3230-3241`) → the only working recovery is a filler clip.

## 6. Metrics — do they agree?

- `voice_turn_latency_ms` (`monitoring/metrics.ts:299-304`): start = `Date.now()` at STT-final before `speechTurn` (`:1957`); stop = first outbound chunk enqueued — **filler or real, whichever first**; after a filler consumed it the real-TTS observe is a no-op (`:3444-3463`, `:3471-3474`). The help text "Excludes filler chunks" (`metrics.ts:301`) is wrong whenever a filler engine is wired (it always is in prod, `app.ts:4626-4631,4857-4858`). The SLO alarm (3 500 ms, `workers/slo-monitor.ts:27,65`) therefore watches first-audible (~250–450 ms when a filler fires), not the reply gap.
- Layer 2: `transcript_received` emitted at the same instant (`:1958`), `audio_frame_emitted` on the first **real** chunk (`:3475-3479`); `ttfaPerTurn` pairs them (`ai/voice-quality/audio/audio-timings.ts:34-46`), `firstAudiblePerTurn` also accepts `filler_fired` (`:56-71`). Grader threshold `ttfaP95MaxMs: 800` (`graders/caller-experience.ts:39-48`); the Layer-2 report relaxes answer-audio to 4 000 ms and uses 800 ms for first-audible (`report-layer2.ts:24-25,88-104`). Start points agree; **stop points disagree when a filler plays** (Prom = filler, L2 `ttfa` = real reply). Neither includes the 0.7–0.9 s Deepgram endpoint; in Layer 2 the emulator synthesises `transcript_received` after a 1 500 ms Whisper silence window (`audio/twilio-stream-emulator.ts:51,302`).

## 7. Barge-in

- Condition: any non-final event with non-empty text (provider drops empties `transcription-providers.ts:597`) while `agentSpeaking` (`:1891-1894`). **No word-count, char, or confidence gate.** A filler counts as speaking (`:2986`), so a cough-word during "Mm-hmm" cancels it.
- Suppressed only while `bargeInHoldFromTurnId` is set, i.e. a `tts_play` with `holdBargeInUntilPlayed` (`:2790-2794`) — set by the FSM for the E1 911 line (`transitions.ts:666`, adapter `:3920`). The **disclosure is not protected by this flag**; it is protected because inbound audio is dropped until the disclosure's mark is acked (`:1846`, `:1270-1280`), so no interim can exist.
- `bargeIn()` (`:3535-3565`): clears silence timer + early-filler timer, `ttsController.abort()` (closes the ElevenLabs WS `elevenlabs-stream.ts:299-305`), bumps `outboundTurnId`, `agentSpeaking=false`, `queue.clear()`, `unackedMarks=0`, sends Twilio `clear`.
- The in-flight `speechTurn` is **not** cancelled and there is no generation check after the lock returns (`:1973-1989`, `:2025`): `emitSideEffects` still speaks the interrupted turn's reply under a fresh turnId, and its proposal/audit rows were already written. The caller's next final queues behind the lock and produces a second reply afterwards → stale reply + possible duplicate draft. Only E1 lines are shielded from this.

## 8. Gather path

`buildTwiML` (`telephony/twilio-adapter.ts:728-730`): `<Gather input="speech" speechTimeout="auto" language="en-US|es-US" speechModel="phone_call" hints=… actionOnEmptyResult="true">`; `<Say voice="Polly.Joanna">` precedes it (`:652,:693`), so Say is **not interruptible** and there is no filler. Serial budget: Twilio `auto` endpointing (~1–2 s, knowledge) → webhook POST + signature check (~50–150 ms) → `handleGather` under the session lock (`:2252-2265`): append, safety scan, `maybeEndForMaxCallDuration`, frustration, pending approval, low-STT ladder, then the same classify/FSM/executeSideEffects chain (≈ §4 minus the WS adapter) → `finalizeTwiml` + `resolveGatherHints` (glossary 5-min cache, `voice/tenant-glossary-provider.ts:24-25`) → TwiML → Polly synth before first audio (~300–600 ms, knowledge). **Typical ≈ 3–5 s** from last word to first reply audio; nothing audible in between.

## 9. Cost (per turn / per minute) — prices are knowledge unless cited

| Item | Basis | Per turn | Per min |
|---|---|---|---|
| Deepgram Nova-3 streaming | ~$0.0077/min PAYG (knowledge; env `DEEPGRAM_COST_CENTS_PER_HOUR` is blank `.env.production.example:232`); audio streamed continuously incl. silence (`:1852`) | — | $0.008 |
| ElevenLabs turbo | 0.5 credit/char; ~$0.06–0.15 per 1k chars on paid tiers (knowledge; env `ELEVENLABS_COST_CENTS_PER_1000_CHARS` blank `:233`); reply ≈ 100–150 chars (`session.ttsCharacters`, `:3089`) | $0.01–0.02 | $0.03–0.06 (3–4 agent lines/min) |
| Classify LLM | caller profile ≈ 3.3k in / 100 out tokens. llama-3.1-8b OpenRouter ~$0.03/M in (knowledge) → $0.0001; gpt-4o-mini $0.15/$0.60 per M → $0.0006; operator profile (15k tokens) × gpt-4o-mini → $0.0023. ×2–3 if sentiment + vulnerability hooks enabled | $0.0001–0.003 | <$0.02 |
| Twilio voice inbound | $0.0085/min local (knowledge) | — | $0.0085 |
| Twilio Media Streams | ~$0.004/min per stream (knowledge — verify) | — | $0.004 |
| Gather alt. | speech recognition ~$0.02 per 15 s utterance + Polly standard ~$0.0008/100 chars (knowledge — verify) | ~$0.02 | ~$0.08 |

Realtime total ≈ **$0.05–0.10/min**, i.e. $1–2 per 20-min Starter allotment against $79 software + $1.25/min overage (`docs/plans/per-call-pricing.md:16-24`, which assumes ~$0.25/min all-in — conservative by 2–5×).

## 10. Unused provider capabilities (grep over `packages/api/src`)

| Param | Status |
|---|---|
| Deepgram `endpointing` | used, fixed 600 (`transcription-providers.ts:480`) |
| `utterance_end_ms`, `vad_events`, `speech_final`, `UtteranceEnd` | **absent** |
| `smart_format` | on (`:484`) — adds formatting latency on finals (knowledge) |
| `keyterm` | on for Nova-3 (`:508`) |
| ElevenLabs `optimize_streaming_latency`, `auto_mode`, `chunk_length_schedule`, `flush`, `eleven_flash_v2_5`, persistent socket / `inactivity_timeout` | **all absent**; only `model_id` + `output_format` (`elevenlabs-stream.ts:116`) |

## 11. Budget table — realtime, one caller turn

| Stage | S/P | Best / typical / worst ms | file:line | Lever |
|---|---|---|---|---|
| Caller stops → Deepgram `is_final` | S | 650 / 800 / 1 200 | `transcription-providers.ts:480`, `:590-603` | endpointing 300 + `utterance_end_ms`; use `speech_final` |
| Lock + lang/confidence pre-checks | S | 1 / 2 / 50 (behind interim scan) | `mediastream-adapter.ts:1910-1941`, `:2231` | keyword pre-filter before locking |
| Early filler audible | P | 250 + ~150 playout | `:2970`, `:2984-2990` | 250 → 150 ms; or pre-connect TTS instead |
| Safety scan + pending-dialogue fast paths | S | 1 / 5 / 30 | `twilio-adapter.ts:2014+`; processor `:5700-5712` | — |
| Classify context (vertical + plan) | S | 1 / 10 / 80 | processor `:1372-1377` | `Promise.all`; prefetch on interim |
| Classify LLM (3.3k-token prompt, 8B/4o-mini) | S | 500 / 1 000 / 4 000 (12 000 prod deadline; retries) | `intent-classifier.ts:3193-3221`; `ai-routing.ts:110-121`, `:261`; `retry.ts:34` | speculative classify on stable interim; prompt caching; `maxTokens` 1024→256 |
| Post-classify gates + entity resolution | S | 5 / 30 / 300 | processor `:5959-6150`, `:6440-6452`, `pg-entity-resolver.ts` | memoise per session |
| `executeSideEffects` (audit + proposal + hold) | S | 10 / 40 / 300 | processor `:3696-3735`, `:2258-2560` | overlap synthesis with the inserts; release audio only after the proposal insert resolves (U2 item 5) |
| ElevenLabs WS handshake | S | 150 / 250 / 400 | `elevenlabs-stream.ts:114-121` | persistent per-call socket or pre-connect at STT-final |
| ElevenLabs TTFB (turbo) | S | 150 / 250 / 800 | `:191-202`, `:16` | `eleven_flash_v2_5` (~75 ms model latency, knowledge) |
| μ-law encode + ws.send + Twilio playout | S | 100 / 150 / 250 | `:3419-3498`, `mulaw-codec.ts:175-182` | — |
| Hold line (if still thinking) | — | fires at 4 500 | `:1071`, `:3005` | — |

**Critical path, last caller word → first real reply audio**: best ≈ 1.6 s, **typical ≈ 2.5 s** (≈ 1.7 s as the Prom/L2 metrics count it, from STT-final), worst without failure ≈ 7 s. First *audible* (filler): ≈ 1.2 s after the last word. Gather: 3–5 s with nothing audible.

## 12. Top 5 changes, ranked by ms saved per unit of risk

1. **Pre-connect / persist the ElevenLabs socket** (−150–400 ms/turn, low risk). Open the WS at STT-final (inside `armEarlyFiller`/`onTranscriptEvent`) so the handshake overlaps the LLM; keep it per call with `inactivity_timeout`, fall back to a fresh socket on error. Files: `ai/tts/elevenlabs-stream.ts`, `ai/tts/tts-provider.ts`, `telephony/media-streams/mediastream-adapter.ts`. Test: mock WS server counting connections per call (`test/ai/tts/elevenlabs-persistent-socket.test.ts`) + adapter test that a barge-in abort does not kill the next turn's socket.
2. **Endpoint tuning: `endpointing=300` + `utterance_end_ms=1000`, dispatch on `UtteranceEnd` (or on `speech_final` only for an enumerated short-confirmation allowlist — formatter punctuation is not an end-of-turn signal; see U2 item 2), buffer non-final `is_final` segments** (−300 ms of silence per turn, and no more mid-utterance double turns; medium risk of clipping fast talkers). Files: `voice/transcription-providers.ts` (expose options, read `speech_final`, emit `utterance_end`), `mediastream-adapter.ts` (`onTranscriptEvent` concatenates segments until endpoint; adapter passes `endpointingMs`). Tests: `transcription-providers.endpointing.test.ts` (URL + event mapping), adapter test "two is_final without speech_final → one speechTurn", Layer-2 mid-sentence-pause script.
3. **Swap `eleven_turbo_v2_5` → `eleven_flash_v2_5` for en** (−100–200 ms TTFB, low risk, env/const change). File: `tts-provider.ts:161` (+ `scripts/render-fillers.ts` so filler voice matches). Test: provider model-selection unit test; Layer-2 pronunciation scripts for regression.
4. **Speculative classify on a stable interim** (−500–1 000 ms when the final matches; medium risk: cost ×1.3, duplicate-proposal hazard — must be classify-only, FSM dispatch stays on the final). Files: `mediastream-adapter.ts` (stable-interim timer ≥300 ms, ≥3 words), `create-voice-turn-processor.ts` (accept a pre-computed classification keyed by normalised transcript), `intent-classifier.ts` untouched. Tests: `speculative-classify.test.ts` (cache hit/miss, exactly one proposal), cost-cap test.
5. **Trim serial work before and after the LLM**: `Promise.all` the two prompt-section resolvers (`:1376-1377`); drop `maxTokens` 1024→256 for `classify_intent`; start synthesis for the `tts_play` text concurrently with the `audit_log`/`create_proposal` inserts and **release audio to Twilio only after `proposalRepo.create` resolves** (buffer-then-release; an insert failure discards the buffered audio and speaks the failure copy, so success audio never precedes the commit it describes — an earlier draft of this item said "emit audio, then persist", which U2 item 5 supersedes); add a barge-in **generation check** after the lock so an interrupted turn's reply is discarded (keep its proposal) and gate barge-in on ≥2 words (−30–100 ms steady state, large tail wins; low–medium risk). Files: processor `:1372-1377`, `:3696-3735`; adapter `:1973-2025`, `:1891-1894`. Tests: processor unit test on call order, adapter barge-in test "interim during thinking → stale reply not spoken, next turn runs".

Also fix (not latency, but it hides latency): `voice_turn_latency_ms` help/SLO contradiction — either add a second histogram for first-real-audio or stop letting filler consume `turnLatencyStartMs` (`:3454-3463`, `metrics.ts:301`).
