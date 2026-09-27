/**
 * #1387 — Layer 2 audio driver wiring.
 *
 * Builds the per-run audio stack (Twilio stream emulator → Whisper → the
 * AudioModeDriver) on the bus the runner grades from. `runScript` builds the
 * observation from the bus it passes to the driver factory; every component
 * that records timing / agent-speech events must write to THAT bus, or the
 * graders see an empty call (weekly run 35600368305: TTFA 0 ms, duration
 * 0 ms and disposition 0/40 across the whole corpus).
 *
 * Call once per run from inside the `driverFactory`, passing
 * `factoryCtx.bus`, and `dispose()` each returned stack after the script.
 */
import type { AgentEventBus } from '../event-bus';
import type { VoiceSessionStore } from '../../agents/customer-calling/voice-session-store';
import { AudioModeDriver, type AudioModeDriverDeps } from './audio-mode-driver';
import { TwilioStreamEmulator } from './twilio-stream-emulator';
import {
  WhisperRealProvider,
  type WhisperBufferTranscriber,
  type WhisperCostTracker,
} from './whisper-real-provider';
import type { TtsFixtureCache } from './tts-fixture-cache';

export interface Layer2AudioDriverDeps {
  /** Media-streams WS URL of the server under test. */
  serverUrl: string;
  voiceSessionStore: VoiceSessionStore;
  ttsCache: TtsFixtureCache;
  whisperTranscriber: WhisperBufferTranscriber;
  costTracker: WhisperCostTracker;
  /** Streaming-STT bridge into the production adapter (live harness). */
  deliverFinalTranscript?: (transcript: string) => void | Promise<void>;
  onSessionCreated?: AudioModeDriverDeps['onSessionCreated'];
  onSessionEnded?: AudioModeDriverDeps['onSessionEnded'];
  decodeTtsAudio?: AudioModeDriverDeps['decodeTtsAudio'];
  silenceWindowMs?: number;
  firstAudioTimeoutMs?: number;
}

export interface Layer2AudioDriver {
  driver: AudioModeDriver;
  /** Hang up this run's emulator socket. Idempotent. */
  dispose: () => Promise<void>;
}

export function createLayer2AudioDriver(
  bus: AgentEventBus,
  deps: Layer2AudioDriverDeps,
): Layer2AudioDriver {
  const emulator = new TwilioStreamEmulator({
    serverUrl: deps.serverUrl,
    bus,
    ...(deps.deliverFinalTranscript
      ? { deliverFinalTranscript: deps.deliverFinalTranscript }
      : {}),
    ...(deps.silenceWindowMs !== undefined ? { silenceWindowMs: deps.silenceWindowMs } : {}),
    ...(deps.firstAudioTimeoutMs !== undefined
      ? { firstAudioTimeoutMs: deps.firstAudioTimeoutMs }
      : {}),
  });
  const whisper = new WhisperRealProvider({
    inner: deps.whisperTranscriber,
    bus,
    costTracker: deps.costTracker,
  });
  const driver = new AudioModeDriver({
    emulator,
    whisper,
    ttsCache: deps.ttsCache,
    bus,
    voiceSessionStore: deps.voiceSessionStore,
    ...(deps.onSessionCreated ? { onSessionCreated: deps.onSessionCreated } : {}),
    ...(deps.onSessionEnded ? { onSessionEnded: deps.onSessionEnded } : {}),
    ...(deps.decodeTtsAudio ? { decodeTtsAudio: deps.decodeTtsAudio } : {}),
  });
  return {
    driver,
    dispose: async () => {
      try {
        await emulator.hangup();
      } catch {
        /* best-effort */
      }
    },
  };
}
