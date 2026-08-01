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
 * # Production agent path
 *
 * The production media-streams `speechTurn` handler delegates to
 * `TwilioGatherAdapter#processCallerUtterance`. That body (plus its
 * helpers — cost tracking, audit + proposal side effects, FSM dispatch,
 * end-of-call summary) has been extracted into a reusable
 * `createVoiceTurnProcessor` factory at
 * `packages/api/src/ai/voice-turn/`. This suite wires the factory with
 * in-memory repos + a real Layer-2 LLM gateway so the mediastream
 * server now exercises the real agent loop end-to-end. Whisper
 * transcripts and the graders therefore see actual agent replies.
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
import { createRealLayerTwoGateway } from '../../src/ai/gateway/real-layer-two-factory';
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
import { createVoiceTurnProcessor } from '../../src/ai/voice-turn';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryLeadRepository } from '../../src/leads/in-memory-lead';

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
    // In CI mode (VOICE_QUALITY_LAYER2=true), missing keys must FAIL the gate,
    // not skip — a skipped test exits 0 and allows a false-green deploy.
    // Local/dev runs (VOICE_QUALITY_LAYER2 unset) still skip gracefully.
    const isLayer2CIMode = process.env.VOICE_QUALITY_LAYER2 === 'true';
    if (isLayer2CIMode) {
      it('VQ2-016 — Layer 2 requires ANTHROPIC_API_KEY + OPENAI_API_KEY (CI mode — must fail)', () => {
        throw new Error(
          'Layer 2 CI mode requires ANTHROPIC_API_KEY and OPENAI_API_KEY. ' +
            'One or both are missing. This is a gate failure, not a skip.',
        );
      });
      return;
    }
    writeEmptyReport();
    it.skip(
      'VQ2-016 — Layer 2 requires ANTHROPIC_API_KEY + OPENAI_API_KEY (skipping in local env without keys)',
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

    // Build a Layer-2 LLM gateway for the agent loop. The same factory the
    // graders use for judge calls, but with no event bus / no shared cost
    // tracker — agent calls don't need to count toward suite cost in this
    // wiring (Layer 2 cost accounting tracks Whisper + TTS + judge LLM).
    const agentGateway = createRealLayerTwoGateway({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      bus: new AgentEventBus(),
      costTracker: suiteState.suiteCostTracker,
    });

    // Real agent processor — replaces the no-op stub. Wires the in-memory
    // repos the corpus exercises (audit + proposal + the read-only
    // lookup family). Optional deps (pool, callControl, voicePersonaResolver,
    // etc.) are left undefined; the processor's helpers degrade
    // gracefully ("not wired" log + skip).
    // Mutable holder so the onSessionTerminated hook (constructed below
    // BEFORE the processor reference exists) can call back into the
    // processor's `runSummary`. We can't reference `processor` directly
    // inside the literal because the literal is the constructor arg.
    const processorRef: { current: ReturnType<typeof createVoiceTurnProcessor> | null } = {
      current: null,
    };
    const processor = createVoiceTurnProcessor({
      store: suiteState.voiceSessionStore,
      gateway: agentGateway,
      auditRepo: new InMemoryAuditRepository(),
      proposalRepo: new InMemoryProposalRepository(),
      customerRepo: new InMemoryCustomerRepository(),
      appointmentRepo: new InMemoryAppointmentRepository(),
      jobRepo: new InMemoryJobRepository(),
      invoiceRepo: new InMemoryInvoiceRepository(),
      estimateRepo: new InMemoryEstimateRepository(),
      leadRepo: new InMemoryLeadRepository(),
      businessName: 'Test Tenant',
      systemActorId: 'voice-quality-layer2',
      // Codex P1 round 5 — `await` the summary so its agent gateway
      // spend lands in `suiteState.suiteCostTracker` BEFORE speechTurn
      // returns. The runner snapshots the tracker immediately after
      // each speechTurn iteration to compute per-run `agentCents`; if
      // the summary were fire-and-forget (production behavior in
      // twilio-adapter), its cents would either miss the snapshot
      // entirely or contaminate the next run's delta.
      onSessionTerminated: async (session) => {
        if (processorRef.current) {
          await processorRef.current.runSummary(session);
        }
      },
    });
    processorRef.current = processor;

    const { dispose } = attachMediaStreamServer(httpServer, {
      store: suiteState.voiceSessionStore,
      streamingProvider,
      // VQ2-FOLLOWUP — replaces the no-op stub with the real agent loop
      // extracted from TwilioGatherAdapter#processCallerUtterance. The
      // factory closure-captures all helpers (cost, audit, proposal,
      // FSM dispatch) so the harness exercises the production code path.
      speechTurn: processor.speechTurn,
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
          // `driverDeps.gateway` is built via `createRealLayerTwoGateway`,
          // which already wraps the gateway to add per-call cost into
          // `suiteState.suiteCostTracker`. Tell the runner so it skips
          // its own redundant `suiteCostTracker.addCents(runCents)` —
          // otherwise grader spend would be counted twice and the
          // suite cap would trip at half the real spend (Codex P1).
          gatewayReportsToSuiteTracker: true,
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

  // Codex P1 fix — launchGate.pass enforcement.
  //
  // The pre-deploy CI workflow gates release on the exit status of
  // `npm run voice-quality:layer2`. Before this assertion existed,
  // the suite could exit 0 even when `buildLayer2Report(...).launchGate.pass`
  // was false: regressions in TTFA P95, perceived-completion rate,
  // overall pass rate, or cost-capped scripts all slipped through
  // because the per-script `it.each` block only checked the floor.
  //
  // This final `it` runs after the `it.each` block (vitest preserves
  // source-order test enqueue), rebuilds the launch-gate verdict from
  // the same `suiteState.perScriptResults` the `afterAll` will write
  // to disk, and asserts `pass === true`. When false, the assertion
  // message names every blocker so the CI consumer can act without
  // opening the report file.
  it('VQ2-LAYER2 — launch gate verdict', () => {
    // Empty-corpus / no-keys skip paths are handled by the early
    // returns above (the surrounding `describe` returns before
    // reaching this block). If we somehow arrive here with no
    // recorded results, treat that as "no data" and skip rather than
    // fail — the launch gate consumer interprets an empty report the
    // same way.
    if (suiteState.perScriptResults.length === 0) return;

    const report = buildLayer2Report(suiteState.perScriptResults);
    expect(
      report.launchGate.pass,
      `Layer 2 launch gate failed:\n${report.launchGate.blockers.join(
        '\n',
      )}\nMeasured: ${JSON.stringify(report.launchGate.measured, null, 2)}`,
    ).toBe(true);
  });
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
