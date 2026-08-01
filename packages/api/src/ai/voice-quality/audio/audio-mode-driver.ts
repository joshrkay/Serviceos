/**
 * VQ2-008 — AudioModeDriver.
 *
 * Layer 2 implementation of the {@link AgentDriver} contract first
 * defined by Layer 1's `text-mode-driver.ts`. Each scripted turn flows
 * through:
 *
 *   caller transcript
 *     → TtsFixtureCache.getOrSynthesize  (cached MP3 or fresh OpenAI tts-1)
 *     → mp3ToPcm16Mono8k                  (decode to the format Twilio expects)
 *     → TwilioStreamEmulator              (stream μ-law frames into the production WS server)
 *     → emulator collects agent audio    (TurnResult.agentAudio is PCM16 mono 8 kHz)
 *     → WhisperRealProvider               (transcribe what the caller would actually hear)
 *     → returned as `agentResponse`       (so criterion-12 graders judge the spoken-back text)
 *
 * # Why the AgentDriver contract is shared verbatim with TextModeDriver
 *
 * Layer 2 plugs into the same `runScriptCore` infrastructure Layer 1
 * already exercises by swapping driver factories — same scripts, same
 * graders, same observation log. The only difference is the I/O path:
 * Layer 1 short-circuits classifier → handler synchronously; Layer 2
 * goes through real audio + real Whisper. Forking the interface would
 * defeat the point.
 *
 * # Why this driver Whisper-decodes the agent's audio (and doesn't return
 *   the raw text the agent intended to speak)
 *
 * Criterion 12 ("right caller-facing answer") needs to grade what the
 * caller actually hears. If TTS pronunciation + Whisper STT silently
 * mangles a date ("Friday" → "fourth day") the regression must show up
 * in the harness, not at production cutover. So the agentResponse this
 * driver returns is the Whisper-recovered transcript, not a synthetic
 * pass-through.
 *
 * # Pre-seeding the VoiceSession
 *
 * The production media-streams server resolves the session by CallSid
 * on the WS `start` handshake (see `twilio-mediastream-server.ts`). We
 * MUST write the session to the store BEFORE the emulator's WS open
 * fires; otherwise the server falls through to its
 * "session not found" branch. Mirror the production session-creation
 * shape (`channel: 'telephony'` + `callSid`) so anything keyed off
 * `session.channel` works the same way the real call does.
 *
 * # MP3-decode injection
 *
 * `mp3ToPcm16Mono8k` shells out to `ffmpeg`. In tests we don't want to
 * run ffmpeg — and in production we do. The driver accepts an optional
 * `decodeTtsAudio` dep so tests can inject a synchronous stub. When
 * absent, the driver lazy-imports `pcm-codec` (avoids paying the
 * child_process import cost in non-audio call sites) and uses the
 * production decoder.
 */
import * as crypto from 'crypto';

import type {
  AgentDriver,
  AgentDriverSpeakResult,
  AgentDriverStartOpts,
} from '../text-mode-driver';
import type { AgentEventBus } from '../event-bus';
import type { VoiceSessionStore } from '../../agents/customer-calling/voice-session-store';
import { speechOutboundEvent } from '../events';
import type { TwilioStreamEmulator } from './twilio-stream-emulator';
import type { WhisperRealProvider } from './whisper-real-provider';
import type { TtsFixtureCache, SupportedVoice } from './tts-fixture-cache';
import { pickVoiceForScript } from './tts-fixture-cache';

/**
 * Decoder seam — Buffer (likely MP3) in, PCM16 mono 8 kHz Buffer out.
 * Matches the signature of `mp3ToPcm16Mono8k` in `pcm-codec.ts`. Exposed
 * as a dep so tests can avoid the ffmpeg dependency.
 */
export type TtsAudioDecoder = (audio: Buffer) => Promise<Buffer>;

export interface AudioModeDriverDeps {
  emulator: TwilioStreamEmulator;
  whisper: WhisperRealProvider;
  ttsCache: TtsFixtureCache;
  bus: AgentEventBus;
  voiceSessionStore: VoiceSessionStore;
  /**
   * Optional: pin voice for deterministic replay. When unset the driver
   * rotates alloy/nova/onyx across turns of a single script via
   * `pickVoiceForScript(turnIndex)`. For per-script voice rotation the
   * runner can pass an explicit voice based on script index.
   */
  voice?: SupportedVoice;
  /**
   * Optional MP3 → PCM16 decoder override. Production leaves this unset
   * to use the ffmpeg-backed decoder from `pcm-codec`. Tests inject a
   * stub so they don't shell out to ffmpeg.
   */
  decodeTtsAudio?: TtsAudioDecoder;
}

export class AudioModeDriver implements AgentDriver {
  private turnIndex = 0;
  private currentSessionId: string | null = null;

  constructor(private readonly deps: AudioModeDriverDeps) {}

  async startSession(opts: AgentDriverStartOpts): Promise<{ sessionId: string }> {
    // The store mints its own session id; we use that and derive a
    // CallSid from it so the production server's CallSid → session
    // lookup resolves in the WS `start` handshake. The `CA_TEST_`
    // prefix is unambiguous against real Twilio CallSids (which start
    // with `CA` followed by a hex blob).
    // WS21b — stamp the RV-070 ownerSession flag before the WS `start`
    // handshake so the production media-streams processor unlocks the
    // owner-only approve/reject/edit dialogue for this call. Layer 2 has no
    // settings repo of its own, so ownership comes from the fixture's explicit
    // `callerIsOwner` flag (the runner threads it through startSession).
    const session = this.deps.voiceSessionStore.create(opts.tenantId, 'telephony', {
      callSid: `CA_TEST_${crypto.randomUUID()}`,
      ...(opts.callerIsOwner === true ? { ownerSession: true } : {}),
    });
    const sessionId = session.id;
    const callSid = session.callSid!;

    // Subscribe the bus so events emitted on the per-session emitter
    // (intent_classified, lookup_executed, audio_frame_emitted, …) make
    // it into the harness observation log.
    this.deps.bus.subscribe(session);

    // Open the WS only after the session is in the store — otherwise
    // the production server's lookup-by-CallSid race-loses.
    await this.deps.emulator.start(callSid);

    this.currentSessionId = sessionId;
    this.turnIndex = 0;
    return { sessionId };
  }

  async speak(
    sessionId: string,
    callerTranscript: string,
  ): Promise<AgentDriverSpeakResult> {
    if (this.currentSessionId !== sessionId) {
      throw new Error(
        `AudioModeDriver: speak() called with mismatched sessionId (got ${sessionId}, current ${this.currentSessionId})`,
      );
    }

    // 1. Synthesize caller utterance audio (or hit the fixture cache).
    const voice = this.deps.voice ?? pickVoiceForScript(this.turnIndex);
    const cachedAudio = await this.deps.ttsCache.getOrSynthesize({
      text: callerTranscript,
      voice,
    });

    // 2. Decode TTS bytes (MP3 by default per the OpenAI tts-1 default)
    //    into the PCM16 mono 8 kHz Twilio expects.
    const pcm16 = await this.decodeTtsAudio(cachedAudio);

    // 3. Stream caller PCM into the server, collect the agent's audio
    //    + TTFA back. The emulator increments its own internal counter
    //    when no override is supplied; we pass our turn index explicitly
    //    so the eot-N marks in the WS log line up with our accounting.
    const turnIdx = this.turnIndex;
    this.turnIndex += 1;
    const turn = await this.deps.emulator.sendCallerUtterance(pcm16, turnIdx);

    // 4. Whisper-decode the agent's audio response — this is what would
    //    reach a downstream tool transcription pipeline. Criterion 12
    //    consumes this transcript. A whisper failure here is real but
    //    shouldn't kill the run: we record an empty transcript and let
    //    the grader decide. The emulator already wrote the relevant
    //    timing events (transcript_received / audio_frame_emitted) to
    //    the bus, so latency analysis still works.
    let agentTranscript = '';
    if (turn.agentAudio.length > 0) {
      try {
        const scriptTag = `${sessionId}-turn-${turnIdx}`;
        agentTranscript = await this.deps.whisper.transcribeBuffer(
          turn.agentAudio,
          scriptTag,
        );
      } catch {
        agentTranscript = '';
      }
    }

    // VQ2-followup: stamp the recovered agent transcript on the bus so
    // perceived-completion + reprompt graders can read the actual
    // caller-perceived utterance per turn (instead of leaning on the
    // script's `expected.spokenAnswerMatches` placeholder). `turnIdx`
    // is the just-completed turn's zero-indexed position — captured
    // before `this.turnIndex` was incremented above.
    this.deps.bus.record(
      speechOutboundEvent({
        transcript: agentTranscript,
        turnIndex: turnIdx,
      }),
    );

    return {
      agentResponse: agentTranscript,
      latencyMs: turn.ttfaMs,
    };
  }

  async hangup(sessionId: string): Promise<void> {
    if (this.currentSessionId !== sessionId) return;
    await this.deps.emulator.hangup();
  }

  async endSession(sessionId: string): Promise<void> {
    if (this.currentSessionId !== sessionId) return;
    const session = this.deps.voiceSessionStore.peek(sessionId);
    if (session) {
      this.deps.bus.unsubscribe(session);
      this.deps.voiceSessionStore.delete(sessionId);
    }
    this.currentSessionId = null;
  }

  /**
   * Decode TTS-cache bytes (likely MP3 — see `tts-fixture-cache.ts` notes)
   * into PCM16 mono 8 kHz Buffer suitable for the emulator's
   * `frameForTwilio`. Lazy-import `pcm-codec` so non-audio call sites
   * don't pay the child_process / ffmpeg dependency, and so tests that
   * inject `decodeTtsAudio` never hit the dynamic import path.
   */
  private async decodeTtsAudio(audio: Buffer): Promise<Buffer> {
    if (this.deps.decodeTtsAudio) {
      return this.deps.decodeTtsAudio(audio);
    }
    const { mp3ToPcm16Mono8k } = await import('./pcm-codec');
    return mp3ToPcm16Mono8k(audio);
  }
}

/**
 * Convenience factory: lets call-sites wire an AudioModeDriver from a
 * deps bundle without manually `new`-ing through the class. Mirrors
 * `createTextModeDriver` so the runner can swap factories without
 * shape drift.
 */
export function createAudioModeDriver(deps: AudioModeDriverDeps): AudioModeDriver {
  return new AudioModeDriver(deps);
}
