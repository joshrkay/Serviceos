/**
 * VQ2-016 — Layer 2 corpus runner entry.
 *
 * INTENT: run every layer2-eligible script through the AudioModeDriver
 * + 2-of-3 voting pipeline, apply caller-experience graders (TTFA,
 * perceived-completion, audio-quality), and write the final
 * `Layer2Report` to disk for the CI artifact step.
 *
 * # Skip-path semantics (no behavior change from the prior stub)
 *
 *   - Empty corpus → skip + write empty report.
 *   - Missing API keys (ANTHROPIC_API_KEY OR OPENAI_API_KEY) → skip +
 *     write empty report.
 *
 * Both paths still write a valid `Layer2Report` to disk so the CI
 * `actions/upload-artifact` step always finds the file. The empty
 * report has `launchGate.pass=false` (no scripts ran), which the
 * launch-gate consumer correctly interprets as "no data" rather than
 * "passed".
 *
 * # Real-mode wiring (this commit — VQ2-followup part 2)
 *
 * When both keys are present and the corpus is non-empty, the suite:
 *
 *   1. Boots ONE shared HTTP + media-streams server in beforeAll
 *      (`authTestMode: true`). All scripts share the server; each
 *      script gets its own `VoiceSession` via `AudioModeDriver`'s
 *      pre-seed-by-callSid pattern (see audio-mode-driver.ts
 *      "Pre-seeding the VoiceSession").
 *   2. Constructs `WhisperRealProvider` (wrapping a buffer adapter
 *      around `WhisperTranscriptionProvider`), `TtsFixtureCache` (with
 *      a real `OpenAiTtsProvider`), `TwilioStreamEmulator` pointed at
 *      the shared server, and `createRealLayerTwoGateway` for the
 *      LLM-judge graders.
 *   3. Runs each script via `it.each` so vitest reports per-script
 *      pass/fail. Sequential execution is enforced by the Layer 2
 *      vitest config (`maxForks: 1`) plus vitest's natural ordering.
 *   4. Threads a single `SuiteCostTracker` through every
 *      `runScriptLayer2` call so a runaway suite trips
 *      `CostCapExceededError(scope='per-suite')` instead of burning
 *      budget. The default suite cap is 1000¢ (~$10), overridable via
 *      `VOICE_QUALITY_COST_CAP_CENTS`.
 *   5. In `afterAll`, builds + writes the structured `Layer2Report`
 *      from collected per-script results. Always written, even when a
 *      mid-suite cost-cap or runtime error halted execution — partial
 *      data is more useful than no data for the launch gate.
 *
 * # Production agent path stub
 *
 * The production media-streams `speechTurn` handler delegates to
 * `TwilioGatherAdapter#processCallerUtterance`, which depends on the
 * full Express app + every agent dep (FSM, classifier, repos, audit,
 * proposals…). Wiring that up in the test would balloon to many
 * hundreds of lines and re-implement most of `app.ts`. For this
 * follow-up we ship a no-op `speechTurn` (returns []) so the
 * mediastream-server upgrade + audio-frame plumbing is real, but the
 * agent never speaks back. That means agent-audio is empty for now,
 * Whisper transcripts are empty strings, and graders produce
 * fail-everything verdicts. The test runs end-to-end — it just doesn't
 * yet exercise the production agent.
 *
 * The full agent wiring is tracked as a follow-up; the value here is
 * "every other piece of Layer 2 wiring is exercised when keys are
 * present" so the next follow-up can focus on the agent harness alone.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadLayer2Corpus } from '../../src/ai/voice-quality/corpus/loader';
import {
  buildLayer2Report,
  type Layer2Report,
} from '../../src/ai/voice-quality/report-layer2';
import {
  CostCapExceededError,
  runScriptLayer2,
  type RunScriptLayer2Result,
  type SuiteCostTracker,
} from '../../src/ai/voice-quality/runner-layer2';
import { AudioModeDriver } from '../../src/ai/voice-quality/audio/audio-mode-driver';
import { TwilioStreamEmulator } from '../../src/ai/voice-quality/audio/twilio-stream-emulator';
import {
  WhisperRealProvider,
  type WhisperBufferTranscriber,
} from '../../src/ai/voice-quality/audio/whisper-real-provider';
import { TtsFixtureCache } from '../../src/ai/voice-quality/audio/tts-fixture-cache';
import { createRealLayerTwoGateway } from '../../src/ai/voice-quality/audio/real-llm-gateway-factory';
import { OpenAiTtsProvider } from '../../src/ai/tts/tts-provider';
import { AgentEventBus } from '../../src/ai/voice-quality/event-bus';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import {
  attachMediaStreamServer,
  MEDIA_STREAM_PATH,
} from '../../src/telephony/media-streams/twilio-mediastream-server';
import type { StreamingTranscriptionProvider } from '../../src/voice/transcription-providers';
import type { VoiceQualityScript } from '../../src/ai/voice-quality/schema';
import type { AgentDriver } from '../../src/ai/voice-quality/text-mode-driver';
import type { DriverFactoryContext } from '../../src/ai/voice-quality/runner';

const REPORT_PATH = path.resolve(
  __dirname,
  '../../voice-quality-layer2-report.json',
);

const scripts = ((): VoiceQualityScript[] => {
  try {
    return loadLayer2Corpus();
  } catch {
    return [];
  }
})();

const hasKeys =
  !!process.env.ANTHROPIC_API_KEY && !!process.env.OPENAI_API_KEY;

function writeReport(report: Layer2Report): void {
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}

function writeEmptyReport(): void {
  writeReport(buildLayer2Report([]));
}

// ─── Skip-path branches ──────────────────────────────────────────────────────

describe('Voice Quality Layer 2 — corpus', () => {
  if (scripts.length === 0) {
    writeEmptyReport();
    it.skip('VQ2-016 — Layer 2 corpus empty', () => {
      expect(true).toBe(true);
    });
    return;
  }

  if (!hasKeys) {
    writeEmptyReport();
    it.skip(
      'VQ2-016 — Layer 2 requires ANTHROPIC_API_KEY + OPENAI_API_KEY (skipping in env without keys)',
      () => {
        expect(true).toBe(true);
      },
    );
    return;
  }

  // ─── Real-mode path ────────────────────────────────────────────────────────

  const suiteState: {
    httpServer: HttpServer | null;
    serverUrl: string;
    serverDispose: (() => void) | null;
    voiceSessionStore: VoiceSessionStore | null;
    suiteCostTracker: SuiteCostTracker;
    perScriptResults: RunScriptLayer2Result[];
    suiteCapTripped: boolean;
  } = {
    httpServer: null,
    serverUrl: '',
    serverDispose: null,
    voiceSessionStore: null,
    suiteCostTracker: makeSuiteCostTracker(),
    perScriptResults: [],
    suiteCapTripped: false,
  };

  beforeAll(async () => {
    // One shared HTTP server + media-streams attachment for the suite.
    const httpServer = createServer();
    await new Promise<void>((resolve) =>
      httpServer.listen(0, '127.0.0.1', resolve),
    );
    const port = (httpServer.address() as AddressInfo).port;
    suiteState.httpServer = httpServer;
    suiteState.serverUrl = `ws://127.0.0.1:${port}${MEDIA_STREAM_PATH}`;

    // VoiceSessionStore is shared across all scripts. Each script's
    // AudioModeDriver creates its own session via this store; they
    // coexist because the production server resolves by callSid.
    suiteState.voiceSessionStore = new VoiceSessionStore({
      startInterval: false,
    });

    // Streaming STT provider stub. The production path uses Deepgram;
    // the harness leaves it as a no-op since the emulator simulates
    // `transcript_received` directly (see twilio-stream-emulator.ts).
    const streamingProvider: StreamingTranscriptionProvider = {
      async openSession() {
        return {
          send: () => {},
          finish: () => {},
          destroy: () => {},
        };
      },
    };

    const { dispose } = attachMediaStreamServer(httpServer, {
      store: suiteState.voiceSessionStore,
      streamingProvider,
      // No-op speechTurn for now — see file header "Production agent
      // path stub" for why and what's tracked as follow-up.
      speechTurn: async () => [],
      authTokenGetter: () => 'test-token-unused',
      authTestMode: true,
    });
    suiteState.serverDispose = dispose;
  });

  afterAll(async () => {
    // Race-with-timeout the server close so a hung WS doesn't wedge
    // the suite's exit path.
    const closeWithTimeout = (closer: () => void, ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), ms);
        Promise.resolve()
          .then(() => closer())
          .finally(() => {
            clearTimeout(timer);
            resolve();
          });
      });

    if (suiteState.serverDispose) {
      await closeWithTimeout(suiteState.serverDispose, 5_000);
    }
    if (suiteState.httpServer) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 5_000);
        suiteState.httpServer!.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (suiteState.voiceSessionStore) {
      suiteState.voiceSessionStore.dispose();
    }

    // Always write a Layer2Report — partial data is more useful than
    // none, and the CI artifact step needs the file.
    writeReport(buildLayer2Report(suiteState.perScriptResults));
  });

  it.each(scripts)(
    'VQ2-LAYER2 — $bucket — $id',
    async (script: VoiceQualityScript) => {
      // Once the suite cap has tripped, record the remaining scripts
      // as cost-capped without paying for additional API calls.
      if (suiteState.suiteCapTripped) {
        suiteState.perScriptResults.push(makeCostCappedResult(script.id));
        // Mark this test as skipped — vitest doesn't have a per-iteration
        // skip API inside it.each, so we throw a soft assertion message.
        // Using `expect(...).toBeTruthy()` with a `costCapped: true`
        // marker keeps the test red but documented.
        expect.fail(
          `Suite cost cap previously tripped; ${script.id} skipped (recorded as costCapped in report)`,
        );
        return;
      }

      const driverDeps = await buildAudioModeDriverDeps(script, suiteState);

      let result: RunScriptLayer2Result;
      try {
        result = await runScriptLayer2(script, {
          driverFactory: (_factoryCtx: DriverFactoryContext): AgentDriver =>
            new AudioModeDriver(driverDeps.deps),
          repoMode: 'memory',
          gateway: driverDeps.gateway,
          suiteCostTracker: suiteState.suiteCostTracker,
          suiteCostCapCents: parseInt(
            process.env.VOICE_QUALITY_COST_CAP_CENTS ?? '1000',
            10,
          ),
        });
      } catch (err) {
        if (err instanceof CostCapExceededError) {
          suiteState.suiteCapTripped = err.scope === 'per-suite';
          // Synthesize a cost-capped result so the report reflects this
          // script attempted to run but was halted by the cap.
          result = makeCostCappedResult(script.id);
          suiteState.perScriptResults.push(result);
          expect.fail(
            `CostCapExceededError(${err.scope}) at ${script.id}: cap=${err.capCents}¢ observed=${err.observedCents}¢`,
          );
          return;
        }
        throw err;
      } finally {
        // Free per-script disposable state.
        await driverDeps.dispose();
      }

      suiteState.perScriptResults.push(result);

      // Per-script floor assertion. A "red but documented" run is
      // useful: the failure message names the failing criteria so the
      // CI consumer can act on it without opening the report file.
      expect(
        result.aggregated.floor.passed,
        `Script ${script.id} failed floor: ${JSON.stringify(
          result.aggregated.floor,
        )}`,
      ).toBe(true);
    },
  );
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Suite-level cost tracker shared across every script's
 * `runScriptLayer2` call so the suite cap fires across the whole run
 * (and not just per-script).
 */
function makeSuiteCostTracker(): SuiteCostTracker {
  let cents = 0;
  return {
    addCents(n: number): void {
      cents += n;
    },
    totalCents(): number {
      return cents;
    },
  };
}

/**
 * Synthesize a `RunScriptLayer2Result` for a script that was halted by
 * a cost cap before completing. The aggregated verdict is a fail-
 * everything stand-in so the launch gate properly flags the script as
 * non-passing in the report.
 */
function makeCostCappedResult(scriptId: string): RunScriptLayer2Result {
  return {
    scriptId,
    aggregated: {
      floor: { passed: false, runResults: [] },
      disposition: {
        passed: false,
        slotsAgree: false,
        distinctSlotValueCounts: {},
      },
      callerExperience: {
        ttfaMedianMs: 0,
        lookupMedianMs: 0,
        durationMedianMs: 0,
        repromptRatioMedian: 0,
        recoveryTurnsMedian: 0,
      },
      perceivedCompletion: { passed: false, satisfactions: [] },
      flakeIndicator: false,
    },
    perRunResults: [],
    totalCostCents: 0,
    costCapped: true,
    durationMs: 0,
  };
}

/**
 * Wrap the production `WhisperTranscriptionProvider` (URL-based) with
 * a buffer-in interface that posts directly to OpenAI's audio
 * transcriptions endpoint. Mirrors the production wire format
 * (multipart with `file` + `model` fields). Lives here as a wiring
 * adapter; promoting to a shared module is a follow-up if a second
 * call-site needs the buffer path.
 */
function makeWhisperBufferTranscriber(apiKey: string): WhisperBufferTranscriber {
  return {
    async transcribeBuffer(audio: Buffer) {
      const fd = new FormData();
      // Telephony is PCM16 mono 8 kHz; OpenAI accepts a wide format set
      // with the `.wav` content type as a tolerable hint. Whisper sniffs
      // bytes regardless.
      fd.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
      fd.append('model', 'whisper-1');
      const res = await fetch(
        'https://api.openai.com/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: fd,
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Surface 429s with a structured shape so WhisperRealProvider's
        // retry detection (`status === 429`) works.
        const err = new Error(`whisper transcribe failed: ${res.status} ${body.slice(0, 200)}`);
        (err as { status?: number }).status = res.status;
        throw err;
      }
      const data = (await res.json()) as { text?: string };
      return {
        transcript: data.text ?? '',
        metadata: { provider: 'openai-whisper-buffer', model: 'whisper-1' },
      };
    },
  };
}

interface BuiltDriverDeps {
  deps: ConstructorParameters<typeof AudioModeDriver>[0];
  gateway: ReturnType<typeof createRealLayerTwoGateway>;
  /** Free per-script disposables (emulator hangup, etc.). */
  dispose: () => Promise<void>;
}

/**
 * Construct the `AudioModeDriverDeps` bundle for a single script run,
 * sharing the suite-level voice session store + media-streams server
 * across scripts but minting fresh emulator/whisper/cache instances per
 * run so per-run accounting (cost, bus events) stays isolated.
 */
async function buildAudioModeDriverDeps(
  script: VoiceQualityScript,
  suiteState: {
    serverUrl: string;
    voiceSessionStore: VoiceSessionStore | null;
    suiteCostTracker: SuiteCostTracker;
  },
): Promise<BuiltDriverDeps> {
  const openaiKey = process.env.OPENAI_API_KEY!;
  const anthropicKey = process.env.ANTHROPIC_API_KEY!;
  if (!suiteState.voiceSessionStore) {
    throw new Error('buildAudioModeDriverDeps: voiceSessionStore not set up');
  }

  const bus = new AgentEventBus();

  const whisperInner = makeWhisperBufferTranscriber(openaiKey);
  const whisper = new WhisperRealProvider({
    inner: whisperInner,
    bus,
    costTracker: suiteState.suiteCostTracker,
  });

  const ttsCache = new TtsFixtureCache({
    ttsProvider: new OpenAiTtsProvider(openaiKey),
    costTracker: suiteState.suiteCostTracker,
    // Default cache dir colocated with the corpus per VQ2-002 file
    // header — first run pays for synthesis; subsequent runs hit the
    // disk cache.
  });

  const emulator = new TwilioStreamEmulator({
    serverUrl: suiteState.serverUrl,
    bus,
  });

  const gateway = createRealLayerTwoGateway({
    apiKey: anthropicKey,
    bus,
    costTracker: suiteState.suiteCostTracker,
  });

  void script;

  return {
    deps: {
      emulator,
      whisper,
      ttsCache,
      bus,
      voiceSessionStore: suiteState.voiceSessionStore,
    },
    gateway,
    dispose: async () => {
      try {
        await emulator.hangup();
      } catch {
        /* best-effort */
      }
    },
  };
}
