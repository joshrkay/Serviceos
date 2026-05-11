# Voice Quality v1 — Layer 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the **Layer 2 (caller-experience) voice quality test harness** — a vitest-based suite that runs 10–15 audio-eligible scripts end-to-end through the **real audio path** (Twilio Media Streams emulator → real Whisper STT → real Claude live LLM → real OpenAI TTS → InMemory or Pg repos), grades each call against the same 12-criterion rubric **plus six caller-experience metrics** (TTFA, lookup→speak latency, reprompt rate, recovery turns, total duration, perceived completion), survives non-determinism via 2-of-3 voting, and produces a **launch-gate-grade** report that is the go/no-go signal for shipping to the first paying tenant.

**Architecture:** A new `AudioModeDriver` implements the existing `AgentDriver` interface introduced by Layer 1 (VQ-007) but routes turns through a **local Twilio Media Streams emulator** that opens a WebSocket to the real `twilio-mediastream-server`, streams μ-law audio synthesized from each script turn (rendered via real OpenAI TTS so STT sees realistic prosody), captures inbound TTS frames the agent emits, decodes them, and measures TTFA against monotonic timestamps. Inbound STT goes through the real `OpenAiWhisperProvider` (we replace the streaming Deepgram leg with a Whisper batch leg for parity-with-design + cost determinism). The LLM is the real Anthropic gateway — no cassettes. Non-determinism is contained via **2-of-3 majority voting**: each script runs three times in a worker pool; majority pass = pass for floor + disposition; the median of three latency samples is used for caller-experience grading. Caller-experience graders consume the same `Observation` type Layer 1 emits, with a new `audioTimings` sub-record. CI runs Layer 2 in a dedicated workflow gated on `pre-deploy` and `weekly-trend` triggers; never on PR.

**Tech Stack:** TypeScript / vitest / Zod / `@anthropic-ai/sdk` (real, with prompt caching) / OpenAI Whisper + TTS (real) / `ws` (existing) / `wavefile` for PCM/μ-law conversion / Layer 1's `AgentEventBus`, `Observation`, `runner.ts`, `report.ts`, golden files (extended), and `corpus/scripts/`.

**Spec:** `docs/superpowers/specs/2026-05-03-voice-quality-v1-design.md` §4 (two-layer architecture) + §6 (Layer 2 sketch).

**Prerequisite:** Layer 1 plan (`docs/superpowers/plans/2026-05-03-voice-quality-v1-layer-1.md`) is **landed**. This plan reuses VQ-001 schema (with the `layer2Eligible` flag), VQ-003 event bus, VQ-004 observation, VQ-007 `AgentDriver` interface, VQ-008 runner core, VQ-020/021/022 graders, VQ-023 report aggregator. Layer 2 adds, never forks.

**Scope:** Layer 2 only. Layer 3 (live-traffic sampling) is post-launch.

---

## Context

Layer 1 catches code regressions: classifier prompts drift, router skill mapping breaks, repo contracts violate isolation, proposal payloads regress. Layer 1 cannot answer four questions that decide whether a real caller has a tolerable experience:

1. **Does Whisper actually understand our scripts?** Cassettes can't hear audio.
2. **Does Claude live (real model, not frozen) still classify intents correctly?** Cassettes hide model regressions.
3. **Is TTFA acceptable?** Caller-perceived latency is the dominant abandonment driver in voice (Twilio's published research: >1.2s TTFA → 14% abandon). Layer 1 measures only orchestration latency, not audio-path latency.
4. **Does the agent recover from misunderstanding within two turns?** Layer 1's text mode never produces misunderstanding because Whisper is bypassed.

Layer 2 is the **launch gate**. The spec (§7.4) says: "Layer 2 shows ≥85% pass and TTFA P95 <800ms for 1 consecutive week" before pilot tenant onboards. Without Layer 2, "ship to a real paying customer" is a coin flip.

**Why now:** Layer 1 lands an honest regression instrument but its cassette mocking explicitly cannot catch model-update breakage. Anthropic ships model updates approximately every 6–10 weeks; every update needs Layer 2 to re-confirm the agent still works on the live model before deploy. Without Layer 2 in CI, "we updated the model" becomes a guess-and-pray.

**Risk Layer 2 absorbs:** real LLM calls + Whisper + TTS cost real money. Mitigation is in §6 (cost containment) — capped to ~$5–10/run, ~$40–80/week.

---

## File Structure

All Layer 2 code extends Layer 1's `packages/api/src/ai/voice-quality/` tree. New files only; no Layer 1 file is rewritten (only extended at three documented seams).

```
packages/api/
├── src/ai/voice-quality/
│   ├── audio/                                       # NEW (Layer 2 only)
│   │   ├── audio-mode-driver.ts                     # AgentDriver impl over Media Streams
│   │   ├── twilio-stream-emulator.ts                # Local WS client that pretends to be Twilio
│   │   ├── pcm-codec.ts                             # PCM16↔μ-law helpers (re-exports Layer 1's mulaw-codec)
│   │   ├── tts-fixture-cache.ts                     # Caches caller-utterance audio (TTS'd from script text)
│   │   ├── whisper-real-provider.ts                 # Wraps OpenAiWhisperProvider w/ retry + cost tracking
│   │   └── audio-timings.ts                         # Monotonic clocks: t_caller_silence, t_first_outbound_frame
│   ├── voting/                                      # NEW
│   │   ├── majority-vote.ts                         # 2-of-3 verdict aggregation
│   │   └── median-of-three.ts                       # Latency aggregation
│   ├── graders/
│   │   ├── caller-experience.ts                     # NEW — TTFA / lookup→speak / reprompt / recovery / duration
│   │   └── perceived-completion.ts                  # NEW — LLM-judged whole-call satisfaction (criterion 12 extended)
│   ├── corpus/
│   │   ├── manifest.layer2.gen.ts                   # NEW — emits a manifest filtered to layer2Eligible scripts
│   │   └── golden-audio/<scriptId>.json             # NEW — expected caller-experience metric ranges
│   └── report-layer2.ts                             # NEW — extends report.ts with caller-experience roll-up
├── test/voice-quality/
│   ├── voice-quality.layer2.test.ts                 # NEW vitest entry (gated on env, does not run on PR)
│   └── factories/
│       └── audio-fixtures.ts                        # NEW — synthesizes caller utterance audio at test time
├── package.json                                     # MODIFY — add `voice-quality:layer2` + `:layer2:weekly` scripts
└── .github/workflows/
    ├── voice-quality-pre-deploy.yml                 # NEW — gates merges to `release/*` branches
    └── voice-quality-weekly-trend.yml               # NEW — scheduled cron, Slack alert on regression
```

**Touched but not restructured (extension seams introduced by Layer 1):**
- `packages/api/src/ai/voice-quality/schema.ts` — Layer 1 already includes `layer2Eligible: z.boolean()` and `expectedCallerMetrics`; Layer 2 lights them up.
- `packages/api/src/ai/voice-quality/runner.ts` — Layer 1 takes a driver factory; Layer 2 passes `AudioModeDriver` in. No edits to runner needed beyond a new `runScriptLayer2(...)` thin wrapper that wires voting.
- `packages/api/src/ai/voice-quality/event-bus.ts` — Layer 2 adds a new event variant `audio_frame_emitted { ts, byteCount }` to the `VoiceSessionEvent` union (one-line addition; emit site is the existing `mediastream-adapter.ts` outbound path).
- `packages/api/src/telephony/media-streams/twilio-mediastream-server.ts` — adds an `AUTH_TEST_MODE` flag that bypasses Twilio signature verification when `VOICE_QUALITY_LAYER2=true`. No production behavior change.

**Naming convention:** every Layer 2 task uses `VQ2-NNN — description` (parallel to Layer 1's `VQ-NNN`).

---

## Phase 0 — Audio pipeline foundation (sequential; ~5 tasks; estimated 2 days)

These tasks build the audio primitives Layer 2 depends on. Sequential because each builds on the prior. Single agent, single worktree.

### Task VQ2-001 — Real Whisper provider wiring + cost tracking

**Files:**
- Create: `packages/api/src/ai/voice-quality/audio/whisper-real-provider.ts`
- Test: `packages/api/test/voice-quality/audio/whisper-real-provider.test.ts`

**Why first:** Every other Phase 0 task consumes transcripts. Without a deterministic Whisper wrapper that retries on rate-limit, accumulates cost, and surfaces transcripts on the event bus, the rest of the pipeline is untestable.

**Steps:**
- [ ] **Step 1: Write the failing test.** Mock `fetch` to return a Whisper response; assert `transcribeAudio(buf, scriptId)` returns transcript, emits `lookup_executed`-style cost event, retries once on `429`, and fails after two retries.
- [ ] **Step 2: Run → FAIL** (`npm test -- voice-quality/audio/whisper-real-provider`).
- [ ] **Step 3: Implement the wrapper.** Compose the existing `OpenAiWhisperProvider` (`packages/api/src/voice/transcription-providers.ts:18`) with:
  ```ts
  // Whisper-1 pricing as of 2026-04: $0.006 / minute = 0.6 cents / minute.
  // Hoisted to a named constant so a future price change is one line, not
  // a magic-number hunt across the file.
  const WHISPER_CENTS_PER_MINUTE = 0.6;

  export class WhisperRealProvider {
    constructor(
      private readonly inner: OpenAiWhisperProvider,
      private readonly bus: AgentEventBus,
      private readonly costTracker: { addCents: (n: number) => void }
    ) {}
    async transcribeBuffer(audio: Buffer, scriptId: string): Promise<string> {
      const t0 = performance.now();
      const audioSeconds = estimateAudioSeconds(audio);
      const result = await retryOn429(
        () => this.inner.transcribe(uploadAsBlob(audio)),
        { attempts: 2, backoffMs: [500] }
      );
      const ms = performance.now() - t0;
      const cents = Math.ceil((audioSeconds / 60) * WHISPER_CENTS_PER_MINUTE);
      this.costTracker.addCents(cents);
      this.bus.emit({ type: 'lookup_executed', skillName: 'whisper.transcribe', durationMs: ms, success: true, ts: Date.now() });
      return result.transcript;
    }
  }
  ```
- [ ] **Step 4: Run → PASS.** Assert: 200 path returns transcript, 429 retried once then succeeds, double-429 throws, cost tracker incremented per call.
- [ ] **Step 5: Commit:** `feat(voice-quality): VQ2-001 — real Whisper provider with retry + cost tracking`

**Skill to use:** `superpowers:test-driven-development`.

### Task VQ2-002 — TTS fixture cache for caller utterances

**Files:**
- Create: `packages/api/src/ai/voice-quality/audio/tts-fixture-cache.ts`
- Create: `packages/api/test/voice-quality/factories/audio-fixtures.ts`
- Test: `packages/api/test/voice-quality/audio/tts-fixture-cache.test.ts`

**Why:** Each script defines caller turns as text. To exercise the real Whisper path, the test must inject **audio** matching that text. Generating audio fresh on every run wastes ~$0.30/script and is noisy; caching by content hash keeps cost honest.

**Cache layout:**
```
packages/api/src/ai/voice-quality/corpus/audio-fixtures/
└── <sha256(text + voice + tts-model)>.wav   # 8 kHz μ-law 1-channel for fast Whisper round-trip
```

**Voice rotation for adversarial coverage:** Three distinct OpenAI TTS voices (`alloy`, `nova`, `onyx`) cycle per script index modulo 3. Justification: Whisper accuracy varies by voice; rotating reveals voice-specific failure modes. The voice used IS pinned per script for cache stability — same script always uses same voice — but spreads across the corpus.

**Steps:**
- [ ] **Step 1: Failing test.** `getOrSynthesize({ text: 'Hi I have an appointment tomorrow', voice: 'alloy' })` returns Buffer, second call returns cached, hash collision yields cache hit.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Use the existing `OpenAiTtsProvider` (`packages/api/src/ai/tts/tts-provider.ts:46`); request `response_format: 'wav'`; write to `audio-fixtures/<sha>.wav`; on hit, read from disk; flock during write to avoid 4-worker collision (mirrors Layer 1's cassette write lock).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit:** `feat(voice-quality): VQ2-002 — TTS fixture cache for caller audio`

**Skill to use:** `superpowers:test-driven-development`.

### Task VQ2-003 — μ-law / PCM16 codec helpers

**Files:**
- Create: `packages/api/src/ai/voice-quality/audio/pcm-codec.ts`
- Test: `packages/api/test/voice-quality/audio/pcm-codec.test.ts`

**Why:** Twilio Media Streams sends μ-law 8 kHz; Whisper expects PCM16; OpenAI TTS returns MP3 we must decode to PCM16 for streaming. Layer 1's codec lives at `packages/api/src/telephony/media-streams/mulaw-codec.ts` — re-export and add three helpers Layer 2 needs (no rewrite of the production codec):

```ts
export { decodeTwilioInboundFrame, encodeTwilioOutboundFrame, pcm16ToMulaw, mulawToPcm16 } from '../../../telephony/media-streams/mulaw-codec';

/** Convert Buffer of MP3 (from OpenAI TTS) → PCM16 mono 8 kHz. Uses ffmpeg via fluent-ffmpeg
 *  if available; otherwise throws with install hint. CI runner has ffmpeg pre-installed. */
export async function mp3ToPcm16Mono8k(mp3: Buffer): Promise<Buffer> { ... }

/** Frame a PCM16 buffer into 20ms chunks (160 samples @ 8kHz) and convert to μ-law base64
 *  payloads suitable for Twilio Media Streams. Returns Array<base64>. */
export function frameForTwilio(pcm16: Buffer): string[] { ... }

/** Concatenate inbound base64 μ-law frames received from the agent → one PCM16 buffer
 *  for measurement and (optional) on-disk WAV dump for failure debugging. */
export function decodeAgentOutbound(frames: Array<{ payload: string; ts: number }>): { pcm16: Buffer; firstFrameTs: number } { ... }
```

**Steps:**
- [ ] **Step 1: Failing tests** for each of the three new helpers using a synthesized 1 kHz sine wave reference WAV (1-second, known sample count).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** with `fluent-ffmpeg` (already a transitive dep of recording-webhook) and pure-TS framing.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit:** `feat(voice-quality): VQ2-003 — PCM/μ-law codec helpers`

**Skill to use:** `superpowers:test-driven-development`.

### Task VQ2-004 — Audio timing instrumentation

**Files:**
- Create: `packages/api/src/ai/voice-quality/audio/audio-timings.ts`
- Modify: `packages/api/src/ai/voice-quality/event-bus.ts` — add one new event variant
- Modify: `packages/api/src/telephony/media-streams/mediastream-adapter.ts` — emit the new event on first outbound frame
- Test: `packages/api/test/voice-quality/audio/audio-timings.test.ts`

**Why:** TTFA = time-to-first-audio. The clock starts when **the caller stops talking** (Whisper-final detected) and ends when **the first outbound audio frame is emitted to the WebSocket**. Two existing seams must be instrumented:

1. **End-of-speech timestamp.** Currently `mediastream-adapter.ts:14` calls `speechTurn(...)` on Deepgram-final; for Whisper-batch mode (Layer 2) the same callback fires when Whisper returns. Tag the entry into `speechTurn` with `t_caller_silence = performance.now()` and stash on the session.
2. **First-outbound-frame timestamp.** The adapter currently sends frames in `sendAudio(...)`; on the *first* call after a `speechTurn`, emit a new event:
   ```ts
   { type: 'audio_frame_emitted', ts: performance.now(), byteCount: pcm16.length }
   ```
   Subsequent frames in the same turn do not re-emit (one event per turn).

**TTFA computation** (in `audio-timings.ts`):
```ts
export function ttfaPerTurn(events: VoiceSessionEvent[]): number[] {
  const ttfas: number[] = [];
  let pendingSilenceTs: number | null = null;
  for (const e of events) {
    // Layer 2 uses Whisper batch (not streaming VAD), so the TTFA
    // start is the moment the transcript is returned — not a silence
    // detector firing. The event name is `transcript_received`; we
    // keep the variable name `pendingSilenceTs` for readability since
    // semantically it's still "the moment the caller stopped talking".
    if (e.type === 'transcript_received') pendingSilenceTs = e.ts;
    else if (e.type === 'audio_frame_emitted' && pendingSilenceTs !== null) {
      ttfas.push(e.ts - pendingSilenceTs);
      pendingSilenceTs = null;
    }
  }
  return ttfas;
}
```

**Steps:**
- [ ] **Step 1: Failing test.** Synthesize an event sequence; assert `ttfaPerTurn` returns expected per-turn millisecond array.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Add `transcript_received` and `audio_frame_emitted` to `VoiceSessionEvent` union; add emit sites in `mediastream-adapter.ts` (5 lines each). Verify all existing `mediastream-adapter` tests still pass. (Layer 2 uses Whisper batch — the TTFA-start event is the moment Whisper returns, not a streaming-VAD silence trigger.)
- [ ] **Step 4: Implement** `audio-timings.ts` with `ttfaPerTurn`, `lookupToSpeakLatency`, `totalCallDurationMs` helpers.
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit:** `feat(voice-quality): VQ2-004 — audio timing events + helpers`

**Skill to use:** `superpowers:test-driven-development` + `superpowers:verification-before-completion` (existing media-streams tests must remain green).

### Task VQ2-005 — Real Anthropic gateway wiring (no cassettes)

**Files:**
- Create: `packages/api/src/ai/voice-quality/audio/real-llm-gateway-factory.ts`
- Test: `packages/api/test/voice-quality/audio/real-llm-gateway-factory.test.ts`

**Why:** Layer 1 always returns the `CassetteLLMGateway`. Layer 2 must return a gateway that hits the real Anthropic endpoint, **with prompt caching enabled**, and tracks cost on the same `costTracker` used by Whisper/TTS so the per-run budget is enforced uniformly.

**Implementation:**
```ts
export function createRealLLMGatewayForLayer2(
  config: AppConfig,
  bus: AgentEventBus,
  costTracker: CostTracker
): LLMGateway {
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const provider = new AnthropicProvider(anthropic, {
    enablePromptCaching: true,
    cacheBreakpoints: ['system', 'tools'],
  });
  const gateway = new LLMGateway(provider, { ... });
  // Hoisted constants so a Haiku price update (or a model swap) is a
  // one-line change instead of a magic-number hunt across the file.
  const HAIKU_INPUT_CENTS_PER_MTOKEN = 300;
  const HAIKU_OUTPUT_CENTS_PER_MTOKEN = 1500;
  const HAIKU_CACHE_READ_CENTS_PER_MTOKEN = 30;
  // Wrap to intercept response.usage and emit cost_incurred events
  return wrapWithCostTracking(gateway, bus, costTracker, {
    inputCostPerMTokens: HAIKU_INPUT_CENTS_PER_MTOKEN,
    outputCostPerMTokens: HAIKU_OUTPUT_CENTS_PER_MTOKEN,
    cacheReadCostPerMTokens: HAIKU_CACHE_READ_CENTS_PER_MTOKEN,
  });
}
```

**Decision:** model is **Claude Haiku 4.7** for the agent (matches production); judge model for perceived completion is **Claude Haiku 4.5** (cheaper, validated quarterly per Layer 1 spec §5.4). Both pinned in `rubric.v1.json` so a model bump is an explicit, reviewable rubric-version change.

**Steps:**
- [ ] **Step 1: Failing test.** Mock the Anthropic SDK; assert the factory wires prompt caching, the wrapper emits `cost_incurred` per call with token-derived cents, and rate-limit (429) surfaces as a typed error the runner can retry.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit:** `feat(voice-quality): VQ2-005 — real LLM gateway factory with cost tracking`

**Skill to use:** `superpowers:test-driven-development` + `claude-api` (prompt caching pattern).

---

## Phase 1 — Telephony emulator (sequential; ~3 tasks; estimated 1.5 days)

### Architectural decision: telephony emulator choice

**Three candidates evaluated:**

| Option | Pro | Con |
|---|---|---|
| **A. Twilio test rig (real Media Streams, real number)** | Maximum fidelity — exercises the actual Twilio leg, signature path, codec quirks. | Slow (each "call" = ~30s of Twilio signaling), requires a paid Twilio test number per worker, network flake leaks into CI, can't run offline, runs against ServiceOS production webhook URL — needs ngrok-style tunnel. |
| **B. sipsorcery / Pion local SIP** | Fully offline, deterministic, no Twilio cost. | We don't speak SIP today — adoption forces a SIP→Twilio shim that doesn't exist in production, so we're testing a code path we don't ship. |
| **C. Custom WebSocket client speaking Twilio Media Streams protocol** | Offline, deterministic, exercises the **exact same** `mediastream-adapter.ts` and `twilio-mediastream-server.ts` production runs, no new protocols, no cost. | Doesn't catch Twilio-side regressions (signature verification path, TwiML rendering). |

**Recommendation: Option C.** Justification:
1. The Twilio-edge concerns (signature verification, TwiML) are already covered by Layer 1's text-mode driver going through `voice-action-router` and by integration tests on the recording webhook. Layer 2's job is to grade caller experience over the audio pipeline; the audio pipeline begins at the Media Streams WebSocket boundary.
2. Option A's network flake would dominate the failure noise floor and make 2-of-3 voting unreliable (we'd be voting against Twilio infrastructure variance, not agent quality).
3. Option B requires building infrastructure ServiceOS doesn't ship; testing fictional code is worse than testing nothing.

Option C is what the rest of this plan implements.

### Task VQ2-006 — Twilio Media Streams emulator (WebSocket client)

**Files:**
- Create: `packages/api/src/ai/voice-quality/audio/twilio-stream-emulator.ts`
- Test: `packages/api/test/voice-quality/audio/twilio-stream-emulator.test.ts`

**Behavior:** Opens a `ws` connection to `ws://localhost:<port>/twilio-stream` (the existing Layer 1 + Layer 2 in-test server, started by the runner via `twilio-mediastream-server.ts:start({ authTestMode: true })`). Sends the canonical Twilio handshake frames:
1. `{ event: 'connected', protocol: 'Call', version: '1.0.0' }`
2. `{ event: 'start', streamSid, start: { callSid: <emulated>, accountSid: 'AC_TEST', tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }`

For each script turn, the emulator:
1. Loads cached caller-utterance audio (Buffer) from `tts-fixture-cache`.
2. Frames it as 20ms μ-law base64 chunks via `frameForTwilio()`.
3. Sends each chunk paced at 20ms wall-clock interval (mirrors how a real phone delivers audio — important for adapter backpressure assertions).
4. On final chunk, sends a `{ event: 'mark', mark: { name: 'eot-<turnIndex>' } }` to signal end-of-turn.
5. **Records `t_caller_silence = performance.now()` on the session bus** (this is the TTFA start).
6. Listens for inbound `media` frames from the server (the agent's TTS); on the **first** inbound frame post-turn, the adapter has already emitted `audio_frame_emitted` (VQ2-004) — emulator just collects.
7. Continues collecting until 1.5s of silence (no inbound frame) or `mark` echo signaling agent finished speaking.

**Public surface:**
```ts
export class TwilioStreamEmulator {
  constructor(private readonly serverUrl: string, private readonly bus: AgentEventBus) {}
  async start(callSid: string): Promise<void>;
  async sendCallerUtterance(audio: Buffer, turnIndex: number): Promise<{ agentAudio: Buffer; ttfaMs: number }>;
  async hangup(): Promise<void>;
}
```

**Steps:**
- [ ] **Step 1: Failing test.** Spin up `twilio-mediastream-server` in test fixture pointing at a stub `speechTurn` that returns a hardcoded `tts_play` side effect with a known WAV. Drive emulator → assert it produces handshake frames in order, transmits audio, captures agent response within 800ms, returns TTFA matching the bus's `audio_frame_emitted` event delta.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** using `ws` client + monotonic timing + the codec helpers from VQ2-003.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit:** `feat(voice-quality): VQ2-006 — Twilio Media Streams emulator`

**Skill to use:** `superpowers:test-driven-development`.

### Task VQ2-007 — `AUTH_TEST_MODE` bypass on the Media Streams server

**Files:**
- Modify: `packages/api/src/telephony/media-streams/twilio-mediastream-server.ts`
- Test: `packages/api/test/telephony/media-streams/twilio-mediastream-server.test.ts` (extend existing)

**Why:** The production server validates Twilio signatures on the WebSocket upgrade request. Tests can't sign because they aren't Twilio. Add a single boolean dep, gated by env, that disables signature checks when explicitly set:

```ts
export interface TwilioMediaStreamServerDeps {
  // ... existing
  authTestMode?: boolean;  // NEW. Default false. NEVER read from env in production code paths.
}
```

The flag is passed by `voice-quality.layer2.test.ts` only. Production code (`app.ts`) never sets it. A unit test asserts: `authTestMode: true` → server accepts unsigned upgrade; `authTestMode: false` (default) → server rejects unsigned upgrade with 401.

**Steps:**
- [ ] **Step 1: Failing test** for both branches.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Add the dep + branch.** Production `app.ts` is not modified.
- [ ] **Step 4: Run → PASS** (existing media-streams tests + new ones).
- [ ] **Step 5: Commit:** `feat(voice-quality): VQ2-007 — auth-test-mode flag for Media Streams server`

**Skill to use:** `superpowers:test-driven-development` + `superpowers:verification-before-completion`.

### Task VQ2-008 — `AudioModeDriver` implementing the `AgentDriver` interface

**Files:**
- Create: `packages/api/src/ai/voice-quality/audio/audio-mode-driver.ts`
- Test: `packages/api/test/voice-quality/audio/audio-mode-driver.test.ts`

**Why:** Layer 1's `AgentDriver` interface (VQ-007) was designed so Layer 2 plugs in here:

```ts
export class AudioModeDriver implements AgentDriver {
  constructor(
    private readonly emulator: TwilioStreamEmulator,
    private readonly whisper: WhisperRealProvider,
    private readonly ttsCache: TtsFixtureCache,
    private readonly bus: AgentEventBus,
  ) {}

  async startSession(tenantId, callerId, callerIdBlocked) {
    const sessionId = `vq2_${crypto.randomUUID()}`;
    const callSid = `CA_TEST_${sessionId}`;
    // 1. Pre-create the session in VoiceSessionStore so the server can find it on `start`
    await preSeedSession({ sessionId, callSid, tenantId, callerId, callerIdBlocked });
    // 2. Open the WS handshake
    await this.emulator.start(callSid);
    return { sessionId };
  }

  async speak(sessionId, callerTranscript) {
    // 1. Get cached audio for this transcript
    const audio = await this.ttsCache.getOrSynthesize({ text: callerTranscript, voice: pickVoice(sessionId) });
    // 2. Stream to server, collect agent audio + TTFA
    const { agentAudio, ttfaMs } = await this.emulator.sendCallerUtterance(audio, this.turnIndex++);
    // 3. Optional: Whisper the agent's audio to recover the spoken text for grading criterion 12
    const agentTranscript = await this.whisper.transcribeBuffer(agentAudio, sessionId);
    return { agentResponse: agentTranscript, latencyMs: ttfaMs };
  }

  async hangup(sessionId) { await this.emulator.hangup(); }
  async endSession(sessionId) { /* tear down */ }
}
```

**Critical:** `speak()` returns the **Whisper-recovered transcript** of the agent's response, not a synthetic string. This is the whole point — criterion 12 ("right caller-facing answer") now grades what the caller would actually hear, run through the same STT a downstream tool would use. If Whisper mis-transcribes the agent ("I'll book that for Friday" → "I'll book that fourth day"), grading catches the regression.

**Steps:**
- [ ] **Step 1: Failing test.** End-to-end fixture: pre-seed a VoiceSession, drive a single turn through `AudioModeDriver`, assert: agent transcript returned, TTFA <800ms (test-server has artificial-delay env var to control this), Whisper called once.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit:** `feat(voice-quality): VQ2-008 — AudioModeDriver`

**Skill to use:** `superpowers:test-driven-development`.

---

## Phase 2 — Caller-experience graders (PARALLEL — 3 tasks; ~1.5 days wall-clock)

Each grader is independent and operates on `Observation` (extended with audio timings). Dispatch in parallel via `dispatching-parallel-agents`.

### Caller-experience thresholds (mechanical; encoded in `rubric.v1.json` extension)

| Metric | Threshold | Source of truth |
|---|---|---|
| TTFA (time-to-first-audio) | **P95 ≤ 800 ms** across all turns in run | `audio_frame_emitted.ts - transcript_received.ts` |
| Lookup → speak latency | **P95 ≤ 2000 ms** | `audio_frame_emitted.ts - lookup_executed.ts` (only turns containing a lookup) |
| Reprompt rate | **≤ 10%** of turns | turns where agent's response classifies as a reprompt (LLM-judged binary) divided by total turns |
| Misunderstanding recovery | **≤ 2 turns** to resolution | from first reprompt to first non-reprompt response in the same intent thread |
| Total happy-path duration | **≤ 90 s** wall-clock for buckets 01-02-03 | `last_event.ts - first_event.ts` |
| Caller-perceived completion | **≥ 90% of scripts pass** LLM judge | full-call-transcript judgment, see VQ2-010 |

These thresholds live in `rubric.v1.json` under a new `layer2CallerExperience` block; bumping a threshold = bumping the rubric version (per Layer 1's versioning discipline).

### Task VQ2-009 — Mechanical caller-experience grader

**Files:**
- Create: `packages/api/src/ai/voice-quality/graders/caller-experience.ts`
- Test: `packages/api/test/voice-quality/graders/caller-experience.test.ts`

**Function:**
```ts
export function gradeCallerExperience(
  obs: Observation,
  script: VoiceQualityScript,
  rubric: Rubric
): CallerExperienceResult {
  const ttfas = ttfaPerTurn(obs.events);
  const lookupLatencies = lookupToSpeakLatency(obs.events);
  const totalMs = totalCallDurationMs(obs.events);
  const ttfaP95 = percentile(ttfas, 95);
  const lookupP95 = percentile(lookupLatencies, 95);
  return {
    ttfaP95Ms: ttfaP95,
    lookupP95Ms: lookupP95,
    totalDurationMs: totalMs,
    passes: {
      ttfa: ttfaP95 <= rubric.layer2CallerExperience.ttfaP95MaxMs,
      lookupSpeak: lookupP95 <= rubric.layer2CallerExperience.lookupP95MaxMs,
      duration: !script.isHappyPath || totalMs <= rubric.layer2CallerExperience.happyPathMaxMs,
    },
    failedMetrics: [...],
  };
}
```

**Steps:**
- [ ] **Step 1: Failing tests** — five independent assertions, one per metric, each with a synthetic Observation that violates exactly that metric. Assert grader fails only the right one.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** with pure functions on `Observation`. No I/O. No LLM calls.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**

**Skill to use:** `superpowers:test-driven-development`.

### Task VQ2-010 — LLM-judged perceived-completion grader

**Files:**
- Create: `packages/api/src/ai/voice-quality/graders/perceived-completion.ts`
- Test: `packages/api/test/voice-quality/graders/perceived-completion.test.ts`

**Why:** "Did the caller experience this as a successful interaction?" cannot be reduced to mechanical thresholds. Examples:
- TTFA was 600ms but the agent confidently spoke the wrong customer's name → mechanically pass, perceptually fail.
- TTFA was 850ms (mechanical fail) but everything else was great → mechanical pass-or-fail-or-warn judgment alone misses nuance.

**Implementation:** Single batched call to Claude Haiku 4.5 per script with the **full transcript** (caller utterances + agent Whisper-recovered responses + event-bus summary), prompt-cached on the rubric prompt prefix. Returns:

```ts
{
  perceivedSatisfaction: 'good' | 'acceptable' | 'poor',
  rationale: string,           // <= 200 chars, surfaces in failure report
  abandonmentRisk: 0 | 1 | 2,  // 0=none, 2=likely
}
```

A script passes criterion 12 if `perceivedSatisfaction !== 'poor'` AND `abandonmentRisk !== 2`. Each verdict is hashed and cached so 2-of-3 voting doesn't triple-judge.

**Quarterly validation hook:** Same as Layer 1 (spec §5.4) — sample 20 random verdicts, human-grade, recalibrate prompt if <90% agreement.

**Steps:**
- [ ] **Step 1: Failing tests.** Mock Anthropic SDK to return preset verdicts; assert pass/fail boundaries match. Three test transcripts (good, acceptable, poor) → three verdicts → three pass/fail outcomes.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** with prompt caching, batched per `Promise.all` (cap concurrency at 3 to avoid Anthropic rate limits during 15-script × 3-vote = 45 judge calls).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**

**Skill to use:** `superpowers:test-driven-development` + `claude-api` (prompt-caching pattern).

### Task VQ2-011 — Reprompt + recovery grader

**Files:**
- Create: contributes one function exported from `graders/caller-experience.ts` (lives alongside VQ2-009; keeps sibling concerns together)
- Test: `packages/api/test/voice-quality/graders/reprompt-recovery.test.ts`

**Reprompt detection:** A turn is a reprompt if the agent's Whisper-recovered transcript matches one of:
- Asks the same intent slot the prior agent turn asked for
- Contains hedging phrases ("I didn't catch that", "could you say that again", "sorry")
- Issues a generic clarification ("could you tell me more about", "what would you like to do")

**Strategy:** A small classifier — one Claude Haiku call per turn, batched, prompt-cached on a fixed prefix listing reprompt patterns. Returns `{ isReprompt: boolean, reason: string }`.

**Recovery turns:** Counted as the integer number of turns from the first reprompt in an intent thread to the first non-reprompt agent turn that successfully advances the intent (i.e., the next turn that emits a `proposal_created` or `lookup_executed` corresponding to the intent).

**Steps:**
- [ ] **Step 1: Failing tests** with three synthetic transcripts: zero reprompts, one reprompt resolved in one turn, three reprompts that never resolve.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**

**Skill to use:** `superpowers:test-driven-development`.

---

## Phase 3 — 2-of-3 voting harness (sequential after Phases 1 & 2; ~2 tasks; estimated 1 day)

### Voting strategy (the architectural decision)

**Problem:** Real Claude is not deterministic. Re-running the same script may produce slightly different intent confidence, slightly different slot extraction (e.g., "Friday at 2pm" vs "Friday afternoon at 2"), slightly different TTFA. A single run can't be the verdict.

**Decision: Run each script three times in sequence per worker; verdict = majority pass (2-of-3) per criterion, latency = median-of-three per metric.**

**Definition of "majority pass" when slot extraction varies:**
- **Floor criteria 1-8:** every run must pass independently. Majority is unanimous-of-three (3-of-3). Reasoning: a floor failure is a regression even if it only manifests once — these are safety properties, not statistical ones.
- **Disposition criteria 9, 11 (intent classified, escalation):** 2-of-3 must pass.
- **Disposition criterion 10 (slots) — hard fields (IDs, enums, dates after normalization):** 2-of-3 must produce the same value AND match golden. Two different values across three runs → fail (model nondeterminism is the regression).
- **Disposition criterion 10 — soft fields (notes):** LLM judge per run, 2-of-3 judge passes = pass.
- **Disposition criterion 12 (caller-facing answer):** 2-of-3 perceived-completion verdicts must be `acceptable` or `good`.
- **Caller-experience metrics:** report median-of-three; threshold applied to median, not P95-of-three (P95 across three samples is statistically meaningless).

**Why not 5-of-7?** Cost: 7 runs × 15 scripts × ~$0.40/run = $42/run. 3 runs × 15 × $0.40 = $18 — still under budget but with adequate variance handling. We can revisit if 2-of-3 produces too many flake-driven failures (open question Q4).

### Task VQ2-012 — Majority vote aggregator

**Files:**
- Create: `packages/api/src/ai/voice-quality/voting/majority-vote.ts`
- Create: `packages/api/src/ai/voice-quality/voting/median-of-three.ts`
- Test: `packages/api/test/voice-quality/voting/majority-vote.test.ts`

**Surface:**
```ts
export interface PerRunResult {
  floor: { passed: boolean; failedCriteria: number[] };
  disposition: { passed: boolean; failedCriteria: number[]; slotValues: Record<string, unknown> };
  callerExperience: { ttfaMs: number; lookupMs: number; durationMs: number; reprompts: number; recovery: number };
  perceivedCompletion: { satisfaction: 'good' | 'acceptable' | 'poor'; abandonmentRisk: 0 | 1 | 2 };
}

export function aggregate(runs: [PerRunResult, PerRunResult, PerRunResult]): AggregatedResult {
  return {
    floor: { passed: runs.every(r => r.floor.passed), ... },           // unanimous
    disposition: majority(runs.map(r => r.disposition.passed)),         // 2-of-3
    slotsAgree: countDistinctSlotValues(runs) <= 1,                    // <=1 distinct value across 3
    ttfaMedianMs: median(runs.map(r => r.callerExperience.ttfaMs)),
    perceivedCompletion: majority(runs.map(r => r.perceivedCompletion.satisfaction !== 'poor')),
    flakeIndicator: countDistinctVerdicts(runs) > 1,                   // surfaces nondeterminism
  };
}
```

**`flakeIndicator`** is critical: when 2-of-3 disagrees, the report flags the script as flake-prone so engineers can investigate before treating the verdict as truth.

**Steps:**
- [ ] **Step 1: Failing tests.** Five fixtures: unanimous-pass, 2-of-3 pass with one fail, unanimous-fail, slot-agreement-fail, flake (one of three differs).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** as pure functions.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**

**Skill to use:** `superpowers:test-driven-development`.

### Task VQ2-013 — Layer 2 runner: voting wrapper around Layer 1's `runScript`

**Files:**
- Create: `packages/api/src/ai/voice-quality/runner-layer2.ts`
- Test: `packages/api/test/voice-quality/runner-layer2.test.ts`

**Surface:**
```ts
export async function runScriptLayer2(
  script: VoiceQualityScript,
  ctx: { driverFactory: () => AudioModeDriver; costTracker: CostTracker; rubric: Rubric }
): Promise<AggregatedResult> {
  if (!script.layer2Eligible) throw new Error(`script ${script.id} is not layer2-eligible`);
  const runs: PerRunResult[] = [];
  for (let i = 0; i < 3; i++) {
    const driver = ctx.driverFactory();
    // Reuse Layer 1's runner core but force the audio driver:
    const obs = await runScriptCore(script, { driver, repoMode: 'memory' });
    const floor = gradeFloor(obs, script);
    const dispStruct = gradeDispositionStructured(obs, script);
    const dispLlm = await gradeDispositionLLM(obs, script);
    const callExp = gradeCallerExperience(obs, script, ctx.rubric);
    const perc = await gradePerceivedCompletion(obs, script);
    runs.push({ ... });
    if (ctx.costTracker.totalCents() > ctx.rubric.layer2CallerExperience.perRunCostCapCents) {
      throw new CostCapExceededError(`script ${script.id} cost-capped at run ${i+1}`);
    }
  }
  return aggregate(runs as [PerRunResult, PerRunResult, PerRunResult]);
}
```

**Key constraint:** the three runs are **sequential**, not parallel, on a single worker. Reasoning: parallel runs on the same `twilio-mediastream-server` instance would interleave their callSids and confuse session resolution. Spawning three servers per script triples memory; the simpler invariant is "one server per worker, three runs each."

**Cost cap enforcement:** A `CostCapExceededError` thrown mid-script is caught by the outer test, which marks the script `cost-capped` (counts as a non-pass for the launch gate but distinguishable in the report). A whole-suite cap at $10 fail-fasts the entire run.

**Steps:**
- [ ] **Step 1: Failing test.** Stub `runScriptCore` + graders to return preset verdicts. Drive 3 runs → assert aggregated result matches expected per the voting rules from VQ2-012. Test cost cap raises after configured cents.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**

**Skill to use:** `superpowers:test-driven-development`.

---

## Phase 4 — Corpus selection + report extension (sequential after Phase 3; ~2 tasks; estimated 0.5 day)

### Corpus selection: which 12 scripts get `layer2Eligible: true`

The spec §6 says "10–15 scripts (subset of Layer 1's, full audio)." Selection criteria:
1. **All happy paths get included** (buckets 1, 2, 3 — they ARE the launch gate's positive cases): 6 + 4 + 3 = 13 scripts. That's already at the upper bound.
2. **Drop one happy-path lead-capture (the half-broken `create_customer` until P17-001 ships)** — Layer 2 should not gate launch on a known-broken case. Net: 12 scripts.
3. **No edges or adversarial cases.** Justification: those buckets are statistical (≥90% threshold, ≥70% threshold) — they make sense at Layer 1's 40-script scale, but at 12 scripts the statistics are too thin to be meaningful, and the cost-per-run multiplies quickly.
4. **Add 2 hand-picked edge cases that ONLY caller-experience can surface** to bring the corpus to 14:
   - One **mumbled / accented** ambiguity script (bucket 8) — Whisper is the only thing that can mis-hear; cassettes can't simulate this.
   - One **mid-sentence pause** script (synthesized via the TTS fixture cache with a 700ms silence injected) — exercises the agent's end-of-speech detector, which Layer 1 cannot exercise.

**Final Layer 2 corpus (14 scripts):**

| Script ID | Bucket | Layer 2 justification |
|---|---|---|
| `lookup-account-summary` | 01 | Most common lookup; Whisper must hear customer name correctly |
| `lookup-customer` | 01 | Identity confirmation; tests slot extraction across audio |
| `lookup-jobs` | 01 | Multi-result lookup; tests agent's spoken summarization |
| `lookup-appointments` | 01 | Date-time formatting in spoken response is a known weak point |
| `lookup-invoices` | 01 | Money amounts in spoken response |
| `lookup-estimates` | 01 | Less frequent; tests agent's handling of "no results" gracefully |
| `create-appointment-happy` | 02 | The single most important happy path |
| `reschedule-appointment-happy` | 02 | Two-step disambiguation in audio |
| `cancel-appointment-happy` | 02 | Confirmation TTS must summarize accurately |
| `two-step-booking-happy` | 02 | Multi-turn coherence over real audio |
| `find-or-create-lead-happy` | 03 | Lead capture from new caller |
| `create-customer-happy` | 03 | Gated on P17-001; flag as `layer2Eligible: true` after P17-001 lands |
| `mumbled-name-recovery` | 08 (new) | Whisper-only failure mode |
| `mid-sentence-pause` | 08 (new) | EOS detector exercise |

The two new bucket-08 scripts are added under Layer 1's manifest as `layer2Eligible: true` but `layer2Only: true` (a new flag) so they are **excluded from Layer 1's PR gate** (Layer 1 cassettes can't fairly grade them) but counted in Layer 2.

### Task VQ2-014 — Mark scripts `layer2Eligible` + author the two bucket-08 audio-only scripts

**Files:**
- Modify (Layer 1 corpus): set `layer2Eligible: true` on the 12 selected Layer 1 scripts
- Create: `packages/api/src/ai/voice-quality/corpus/scripts/08-ambiguity/mumbled-name-recovery.json`
- Create: `packages/api/src/ai/voice-quality/corpus/scripts/08-ambiguity/mid-sentence-pause.json`
- Create: `packages/api/src/ai/voice-quality/corpus/golden-audio/<14 files>.json` — expected caller-experience metric ranges per script (e.g., `{ ttfaP95MaxMs: 800, lookupP95MaxMs: 2000, ... }`)
- Modify: `packages/api/src/ai/voice-quality/schema.ts` — add `layer2Only: z.boolean().default(false)`

**Steps:** Standard authoring per Layer 1's bucket-2 pattern. Each script is committed with its golden-audio file. The two new scripts are validated by running them through `AudioModeDriver` once and asserting expected metric ranges.

**Skill to use:** `superpowers:test-driven-development`.

### Task VQ2-015 — Report extension for Layer 2

**Files:**
- Create: `packages/api/src/ai/voice-quality/report-layer2.ts`
- Test: `packages/api/test/voice-quality/report-layer2.test.ts`

**Surface:** Wraps Layer 1's `report.ts:rollup(...)` and adds a Layer 2 section:

```ts
export interface Layer2Report extends Layer1Report {
  layer2: {
    overallPassRate: number;
    perScriptVerdicts: Array<{ scriptId: string; aggregated: AggregatedResult }>;
    callerExperience: {
      ttfaMedianMs: { p50: number; p95: number };
      lookupMedianMs: { p50: number; p95: number };
      reprompRateOverall: number;
      perceivedCompletionRate: number;
    };
    cost: { totalCents: number; byProvider: Record<string, number> };
    flakes: string[];   // scriptIds where 2-of-3 voting disagreed
    costCapped: string[]; // scriptIds aborted by cost cap
  };
}
```

**Launch gate decision** (consumed by CI step in VQ2-016):
- All 14 scripts must pass the floor unanimously (3-of-3).
- ≥85% (≥12 of 14) must pass disposition + caller-experience by majority.
- Median TTFA P95 across all turns ≤ 800ms.
- Perceived-completion pass rate ≥ 90%.
- No script in `costCapped`.

**Markdown PR/Slack output:** A 30-line summary block listing pass rate, TTFA medians, flake list, cost. Failures show: scriptId → which criterion failed → which run(s) failed → link to per-run transcript artifact.

**Steps:**
- [ ] **Step 1: Failing tests** — synthetic per-script aggregated results → assert correct rollup + correct gate verdict.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**

**Skill to use:** `superpowers:test-driven-development`.

---

## Phase 5 — CI integration (sequential after Phase 4; ~2 tasks; estimated 1 day)

### CI integration architecture

**Decision: pre-deploy gate is a separate workflow + manual trigger + scheduled cron.**

| Trigger | Workflow | Behavior |
|---|---|---|
| Push to `release/*` branch | `voice-quality-pre-deploy.yml` | **Required check.** Blocks deploy if the launch gate criteria fail. |
| `workflow_dispatch` (manual) | Same workflow | Allows engineering lead to run on demand against any branch. |
| Cron: every Monday 06:00 UTC | `voice-quality-weekly-trend.yml` | Runs against `main`, posts trend report to Slack `#voice-quality`, opens GitHub issue auto-assigned to the voice owner if pass rate drops >5% week-over-week. |

**Never on PR.** Cost ($5–10/run) makes per-PR runs unsustainable. Per-PR is Layer 1's job.

### Task VQ2-016 — Pre-deploy workflow

**Files:**
- Create: `.github/workflows/voice-quality-pre-deploy.yml`
- Create: `packages/api/vitest.voice-quality-layer2.config.ts`
- Modify: `packages/api/package.json` — add scripts `voice-quality:layer2` and `voice-quality:layer2:weekly`

**Workflow:**
```yaml
name: Voice Quality Layer 2 (pre-deploy)

on:
  push:
    branches: [ "release/*" ]
  workflow_dispatch:

jobs:
  layer2:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    concurrency:
      group: voice-quality-layer2-${{ github.ref }}
      cancel-in-progress: false   # don't cancel; cost already incurred
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      VOICE_QUALITY_LAYER2: 'true'
      VOICE_QUALITY_REPO: memory
      VOICE_QUALITY_COST_CAP_CENTS: '1000'  # $10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'npm' }
      - run: sudo apt-get install -y ffmpeg
      - run: npm ci
      - run: npm run voice-quality:layer2 --workspace=packages/api
        id: layer2
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: voice-quality-layer2-report
          path: |
            packages/api/voice-quality-layer2-report.json
            packages/api/voice-quality-layer2-failures/*.json
      - name: Post failure to Slack
        if: failure()
        run: node .github/scripts/post-voice-quality-slack.ts
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_VOICE_QUALITY_WEBHOOK }}
```

**Vitest config:** isolates Layer 2 (1 worker, sequential — voting is already inherently sequential). Does NOT use the 4-worker pool from Layer 1.

**Steps:**
- [ ] **Step 1: Author the workflow YAML.**
- [ ] **Step 2: Author `vitest.voice-quality-layer2.config.ts`** with `pool: 'forks', poolOptions: { forks: { maxForks: 1, minForks: 1 } }`.
- [ ] **Step 3: Add npm scripts.**
- [ ] **Step 4: Local verification.** Run `npm run voice-quality:layer2` against a fresh checkout with real keys; assert: completes <30 min, produces report JSON, gate verdict matches expectation, total cost <$10.
- [ ] **Step 5: Push to a `release/test-vq2-ci` branch; verify the workflow runs and gates correctly.**
- [ ] **Step 6: Commit:** `feat(voice-quality): VQ2-016 — Layer 2 pre-deploy CI workflow`

**Skill to use:** `superpowers:verification-before-completion` (the workflow itself MUST run green on a test branch before this task is "done").

### Task VQ2-017 — Weekly trend workflow + Slack alerting

**Files:**
- Create: `.github/workflows/voice-quality-weekly-trend.yml`
- Create: `.github/scripts/voice-quality-trend-report.ts`
- Create: `.github/scripts/post-voice-quality-slack.ts`

**Trend persistence:** Each weekly run uploads its report JSON to a fixed S3 prefix (`s3://serviceos-ci-artifacts/voice-quality/<YYYY-MM-DD>.json`). `voice-quality-trend-report.ts` reads the last 8 weekly reports, computes pass-rate delta + TTFA median delta, formats a Markdown trend block.

**Slack message format (weekly run):**
```
[Voice Quality — weekly trend]
This week: 13/14 (92.8%), TTFA P95 median 720ms, cost $7.40
Vs last week: -1 script (was 14/14), -+ TTFA -30ms (faster), cost +$0.20
Recent regressions: lookup-invoices (was passing 4 weeks)
Report: <github-actions-artifact-link>
```

**Auto-issue:** If overall pass-rate drops >5pp week-over-week, `gh issue create --assignee voice-team-lead --label voice-quality-regression`.

**Steps:**
- [ ] **Step 1: Author workflow YAML** with `schedule: - cron: '0 6 * * 1'`.
- [ ] **Step 2: Implement trend report TS** — read last 8 reports, diff, format. Unit-tested with synthetic report fixtures.
- [ ] **Step 3: Implement Slack poster** — webhook POST with formatted blocks.
- [ ] **Step 4: Verify on a manual `workflow_dispatch`.**
- [ ] **Step 5: Commit:** `feat(voice-quality): VQ2-017 — weekly trend + Slack alerting`

**Skill to use:** `superpowers:verification-before-completion`.

---

## Phase 6 — Documentation (parallel; ~2 tasks; estimated 0.5 day)

### Task VQ2-018 — Layer 2 runbook

**Files:**
- Create: `docs/superpowers/runbooks/voice-quality-layer2.md`

**Contents:**
- When Layer 2 runs (pre-deploy + weekly), explicitly NOT on PR
- How to trigger manually (`gh workflow run voice-quality-pre-deploy.yml`)
- Cost expectations + cap policy
- How to interpret a flake-flagged script
- How to override a Layer 2 fail when shipping a hotfix (requires VP-eng + product approval; create issue first)
- 2-of-3 voting reasoning
- Whisper accent / voice-rotation explanation
- How to debug a single failed script (artifact paths, per-run transcript JSON, replaying locally with `VOICE_QUALITY_LAYER2_SCRIPT=<id>`)

### Task VQ2-019 — Launch gate documentation update

**Files:**
- Modify: `docs/superpowers/runbooks/voice-quality-launch-gate.md` (created in Layer 1 VQ-027) — add a Layer 2 section
- Modify: `docs/superpowers/specs/2026-05-03-voice-quality-v1-design.md` §7.4 — link to Layer 2 runbook + update gate language to reflect Layer 2 thresholds verbatim

The launch decision flow (spec §7.4 step 2) becomes:
> 2. Layer 2 shows ≥85% pass, TTFA P95 median ≤ 800ms, perceived-completion ≥ 90%, no flakes on happy-path scripts, total cost <$10/run for 1 consecutive week (4 consecutive weekly runs).

---

## Parallelization Map

| Phase | Tasks | Parallelism |
|---|---|---|
| 0 — Audio pipeline | VQ2-001..005 | **Sequential.** Each builds on prior. Single agent, single worktree. |
| 1 — Telephony emulator | VQ2-006..008 | Sequential. |
| 2 — Caller-experience graders | VQ2-009..011 | **3-way parallel** via `dispatching-parallel-agents` + worktree per grader. |
| 3 — Voting harness | VQ2-012..013 | Sequential. |
| 4 — Corpus + report | VQ2-014..015 | Sequential (corpus must exist before report can be tested). |
| 5 — CI integration | VQ2-016..017 | Sequential. |
| 6 — Docs | VQ2-018..019 | **2-way parallel.** |

**Critical path:** VQ2-001 → VQ2-002 → VQ2-003 → VQ2-004 → VQ2-005 → VQ2-006 → VQ2-007 → VQ2-008 → (parallel: VQ2-009 + VQ2-010 + VQ2-011) → VQ2-012 → VQ2-013 → VQ2-014 → VQ2-015 → VQ2-016 → VQ2-017 → (parallel: VQ2-018 + VQ2-019).

Estimated wall-clock with parallelism: **6–8 working days** assuming Layer 1 has fully landed. Without parallelism: ~2.5 weeks.

---

## Skills usage during execution

| When | Skill | Why |
|---|---|---|
| Each task | `superpowers:test-driven-development` | Red → green → refactor → commit per file. |
| Before claiming any task complete | `superpowers:verification-before-completion` | Run targeted suite + Layer 1 suite (must remain green) + typecheck. |
| Phase 2 (parallel batch) | `superpowers:dispatching-parallel-agents` | One agent per grader. |
| Phase 2 + Phase 6 | `superpowers:using-git-worktrees` | One worktree per parallel agent. |
| Phase 0 task VQ2-005 + Phase 2 task VQ2-010 | `claude-api` | Real Anthropic SDK with prompt caching — get the caching breakpoints right. |
| Phase 1 task VQ2-006 (the WS emulator) | `superpowers:systematic-debugging` | When timing flakes show up, isolate before fixing. |
| Phase 5 (CI integration) | `superpowers:verification-before-completion` | The workflow MUST be observed running green on a `release/test-*` branch before declaring done. |
| End of plan (after VQ2-019) | `superpowers:requesting-code-review` | Full Layer 2 review before merging to main. |

---

## Verification (how we know Layer 2 is done)

A reviewer running these commands locally on a clean checkout of the merged Layer 2 branch should observe:

1. **Type-check passes:**
   ```
   cd packages/api && npx tsc --project tsconfig.build.json --noEmit
   ```
   Exit 0.

2. **Layer 1 still passes** (Layer 2 is purely additive; this is the regression check):
   ```
   cd packages/api && npm run voice-quality
   ```
   Same threshold met. Wall-clock <5 min.

3. **Layer 2 passes against the corpus with real keys:**
   ```
   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... cd packages/api && npm run voice-quality:layer2
   ```
   Exit 0. Output: ≥85% pass, TTFA P95 median ≤ 800ms, perceived completion ≥ 90%, total cost ≤ $10, no `costCapped` scripts, no flakes on bucket-1/2 scripts.

4. **Two consecutive Layer 2 runs:**
   ```
   npm run voice-quality:layer2 && npm run voice-quality:layer2
   ```
   Both pass the gate. Verdicts may differ slightly per script (acceptable nondeterminism); aggregate gate verdict identical.

5. **Pre-deploy workflow runs green** on a `release/test-vq2-final` branch.

6. **Weekly workflow `workflow_dispatch` succeeds**, posts a Slack message to a test channel, and uploads the trend report artifact.

7. **Existing voice + Twilio tests still pass:**
   ```
   cd packages/api && npm test
   ```
   No regressions in `test/telephony/media-streams/*`, `test/voice/*`, `test/workers/voice-action-router.test.ts`.

8. **Spec coverage:** every Layer 2 element in spec §6 + §7 maps to a task here. Gaps → file follow-up issues.

---

## Open questions (to resolve before execution starts)

1. **Telephony emulator choice — final.** This plan recommends Option C (custom WebSocket client). Confirm with engineering lead before VQ2-006 starts. If we instead want to pay the Twilio test-rig cost for higher fidelity, the emulator becomes a thin wrapper around a real Twilio number and tasks VQ2-006 and VQ2-007 expand significantly (~3 extra tasks for Twilio rig setup, ngrok tunnel, signature handling).

2. **Audio fixture format — WAV vs μ-law-WAV.** This plan stores fixtures as 8 kHz μ-law mono WAV (smallest, matches Twilio's wire format, fastest cache hit). Alternative is 16 kHz PCM16 WAV (better for human review of fixtures, larger). **Recommendation:** μ-law for cache; ship a `npm run voice-quality:layer2:dump-wav` helper that converts to PCM16 for human listening when debugging.

3. **Judge model for perceived completion — Haiku 4.5 vs Sonnet 4.6.** This plan uses Haiku 4.5 for cost ($0.05/script vs $0.30/script). Quarterly validation hooks the same as Layer 1. **Recommendation:** Haiku 4.5; revisit if quarterly validation drops <90% agreement.

4. **2-of-3 vs 3-of-5 voting.** This plan uses 2-of-3. If pilot weeks reveal frequent flakes (>20% of scripts flagged flake-prone), bump to 3-of-5 (cost: +$5/run). **Recommendation:** ship 2-of-3; revisit after 4 weekly runs.

5. **Per-run cost cap.** This plan caps at $10/run, ~$80/month at weekly cadence + ~$10–20 per release. If finance pushes back, the cheapest cut is dropping voice rotation (one voice instead of three) for ~$3/run savings at the cost of accent coverage. **Recommendation:** $10/run is fine; don't pre-optimize.

6. **Should Layer 2 block merges to `release/*` or just warn?** This plan blocks. Override path is documented in VQ2-018 (issue + VP-eng approval). **Recommendation:** block; a warn-only Layer 2 is the same as not having Layer 2.

7. **Storage of weekly trend reports — S3 vs GitHub Actions artifacts.** Actions artifacts retain 90 days by default; weekly trend wants ≥1 year. **Recommendation:** S3 prefix as in VQ2-017; the workflow already has S3 creds for the recording webhook bucket.

---

## What this plan does NOT cover

- **Layer 3 (live-traffic sampling).** Continuous sampling of real production calls into the rubric. Requires post-launch traffic; deferred to v1.5.
- **Spanish corpus (multi-language).** Whisper supports Spanish; OpenAI TTS ships Spanish voices; Claude is multilingual. Adding Spanish is a corpus-authoring exercise plus a `tts-fixture-cache` voice-set extension. Deferred to v1.5 per spec §1.
- **Real Twilio test-rig integration.** Option A from the emulator decision. If higher fidelity is desired post-launch, a follow-up plan can add a parallel Layer 2.5 rig.
- **Real Pg in Layer 2.** Layer 2 uses InMemory repos because the additional testcontainer spin-up cost ($0 but 30s/run) doesn't add caller-experience signal — Layer 1 nightly already covers Pg. If a Pg Layer 2 variant is wanted, add a workflow that sets `VOICE_QUALITY_REPO=pg`.
- **Latency profiling beyond TTFA / lookup-speak.** No flame graphs, no per-skill latency drill-down. Those live in observability tooling (Honeycomb / OpenTelemetry), not in the launch-gate rubric.
- **Whisper-side accuracy benchmarking.** This plan grades the agent's response, not Whisper's transcript. If Whisper accuracy itself becomes suspect (e.g., a model update degrades it), a separate STT-quality benchmark suite is warranted; out of scope here.
- **Adversarial / abuse scripts at Layer 2.** The corpus selection deliberately excludes them — Layer 1 grades them mechanically and Layer 2's per-script cost is too high for adversarial coverage to be worth it. If a specific adversarial case (e.g., audio-injection of a prompt-injection string) becomes a concern, add it as a one-off Layer 2 script.

---
