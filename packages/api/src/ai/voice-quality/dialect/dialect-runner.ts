/**
 * Dialect eval — runner.
 *
 * Orchestrates the dialect/accent eval end to end: for each `DialectEvalCase`
 * it transcribes the case's audio fixture (ASR), optionally runs the agent
 * over that transcript, scores the case (`scoreDialectCase`), and rolls the
 * results up into a `DialectReport`.
 *
 * The I/O is injected — exactly the seam `runner.ts` uses with its
 * `driverFactory`:
 *   - `transcribe`     — case → ASR hypothesis text. Production wires this to
 *                        `whisper-real-provider` via `makeWhisperDialectTranscriber`,
 *                        or to a Deepgram engine via `makeDeepgramDialectTranscriber`;
 *                        tests pass canned hypotheses.
 *   - `evaluateAgent`  — (case, transcript) → observed intent + clarification
 *                        behavior. OPTIONAL: omit it to run in ASR-only mode
 *                        (measure WER per dialect without driving the agent).
 *
 * Per-case failures (a transcription outage, a missing fixture) are captured
 * in `errors` rather than silently dropped — a caller MUST treat a non-empty
 * `errors` list as a failed run (the WER/intent gate only reflects the cases
 * that actually transcribed, so an outage must not read as "pass").
 *
 * A4 — SURFACE dimension: today the harness grades ONLY Whisper (batch) via
 * `makeWhisperDialectTranscriber`, so Deepgram (the live media-streams
 * engine) accuracy is never measured — the A1-A3 transcript-quality changes
 * can't be proven better per surface. `runDialectEval` now accepts an
 * optional `options.surface` label it stamps onto every result
 * (`DialectEvalResult.surface`), and `runMultiSurfaceDialectEval` runs the
 * same case set through several engines (e.g. `{ whisper: ..., deepgram:
 * ... }`) and rolls the combined results up per surface via
 * `buildSurfaceRollup` (`dialect-report.ts`). This is purely additive: a
 * caller that never sets `surface` gets byte-identical behavior to before
 * (results carry `surface: undefined`, `buildDialectReport`'s per-dialect
 * gate is untouched).
 */
import { wordErrorRate } from './wer';
import {
  scoreDialectCase,
  buildDialectReport,
  buildSurfaceRollup,
  DEFAULT_DIALECT_THRESHOLDS,
  type DialectEvalCase,
  type DialectEvalResult,
  type DialectReport,
  type DialectThresholds,
  type SurfaceStat,
} from './dialect-report';

/** Transcribe one case's audio fixture → ASR hypothesis text. */
export type DialectTranscriber = (evalCase: DialectEvalCase) => Promise<string>;

/** What running the agent over an ASR transcript revealed. */
export interface DialectAgentObservation {
  /** Intent the agent acted on (null/undefined when none). */
  actedIntent?: string | null;
  /** Whether the agent confirmed understanding instead of guessing. */
  clarified: boolean;
}

/** Run the agent over an ASR transcript → observed intent + clarification. */
export type DialectAgentEvaluator = (
  evalCase: DialectEvalCase,
  transcript: string,
) => Promise<DialectAgentObservation>;

export interface DialectRunDeps {
  transcribe: DialectTranscriber;
  /** Optional — omit for ASR-only mode (WER per dialect, no intent grading). */
  evaluateAgent?: DialectAgentEvaluator;
}

export interface DialectRunOptions {
  thresholds?: DialectThresholds;
  /** Record a failing case and keep going, vs. abort the whole run. Default true. */
  continueOnError?: boolean;
  /** Bounded concurrency for transcription + agent eval. Default 4. */
  concurrency?: number;
  /**
   * A4 — label stamped onto every result's `DialectEvalResult.surface`
   * (e.g. 'whisper' | 'deepgram'). Optional; omit for a single-surface run
   * where the surface axis isn't tracked (results get `surface: undefined`,
   * same as before this option existed).
   */
  surface?: string;
}

export interface DialectRunError {
  caseId: string;
  dialect: string;
  error: string;
}

export interface DialectRunOutcome {
  report: DialectReport;
  /** Per-case results for cases that transcribed successfully. */
  results: DialectEvalResult[];
  /** Cases that threw during transcription / agent eval. */
  errors: DialectRunError[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Score one case given its ASR transcript + (optional) agent observation. */
async function scoreOne(
  evalCase: DialectEvalCase,
  deps: DialectRunDeps,
  surface?: string,
): Promise<DialectEvalResult> {
  const transcript = await deps.transcribe(evalCase);
  if (!deps.evaluateAgent) {
    // ASR-only: measure transcription accuracy; intent is "not evaluated"
    // (null), not "failed" — don't penalize for skipping the agent.
    return {
      caseId: evalCase.id,
      dialect: evalCase.dialect,
      ...(surface !== undefined ? { surface } : {}),
      wer: wordErrorRate(evalCase.referenceTranscript, transcript),
      intentMatched: null,
      clarified: false,
    };
  }
  const observed = await deps.evaluateAgent(evalCase, transcript);
  const scored = scoreDialectCase(evalCase, {
    transcript,
    actedIntent: observed.actedIntent ?? null,
    clarified: observed.clarified,
  });
  return surface !== undefined ? { ...scored, surface } : scored;
}

/**
 * Run the dialect eval over a set of cases. Cases run in bounded-concurrency
 * batches (default 4). Returns the per-dialect report, the successful
 * per-case results, and any per-case errors.
 */
export async function runDialectEval(
  cases: ReadonlyArray<DialectEvalCase>,
  deps: DialectRunDeps,
  options: DialectRunOptions = {},
): Promise<DialectRunOutcome> {
  const continueOnError = options.continueOnError ?? true;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const thresholds = options.thresholds ?? DEFAULT_DIALECT_THRESHOLDS;

  const results: DialectEvalResult[] = [];
  const errors: DialectRunError[] = [];

  for (let start = 0; start < cases.length; start += concurrency) {
    const batch = cases.slice(start, start + concurrency);
    const settled = await Promise.all(
      batch.map(async (evalCase) => {
        try {
          return { ok: true as const, result: await scoreOne(evalCase, deps, options.surface) };
        } catch (err) {
          return {
            ok: false as const,
            error: { caseId: evalCase.id, dialect: evalCase.dialect, error: errorMessage(err) },
          };
        }
      }),
    );

    for (const s of settled) {
      if (s.ok) {
        results.push(s.result);
      } else {
        errors.push(s.error);
        if (!continueOnError) {
          throw new Error(
            `dialect eval aborted on case ${s.error.caseId}: ${s.error.error}`,
          );
        }
      }
    }
  }

  return {
    report: buildDialectReport(results, thresholds),
    results,
    errors,
  };
}

/**
 * Bridge a buffer-in Whisper transcriber (e.g. `WhisperRealProvider`) + an
 * audio loader into a `DialectTranscriber`. `loadAudio` reads a case's
 * `audioFixture` key into a Buffer (production: fs.readFile / S3 fetch;
 * tests: a map lookup). Throws when a case has no `audioFixture`.
 */
export function makeWhisperDialectTranscriber(
  provider: { transcribeBuffer(audio: Buffer, scriptId: string): Promise<string> },
  loadAudio: (audioFixture: string) => Promise<Buffer>,
): DialectTranscriber {
  return async (evalCase) => {
    if (!evalCase.audioFixture) {
      throw new Error(`dialect case ${evalCase.id} has no audioFixture to transcribe`);
    }
    const audio = await loadAudio(evalCase.audioFixture);
    return provider.transcribeBuffer(audio, evalCase.id);
  };
}

/**
 * A4 — Deepgram (streaming) engine seam for the dialect harness.
 *
 * Production Deepgram STT (`DeepgramStreamingProvider`,
 * `packages/api/src/voice/transcription-providers.ts`) is a live WebSocket:
 * `openSession()` streams PCM frames in and fires interim/final events back.
 * The dialect harness grades a fixed corpus offline (bounded concurrency
 * batches, no live call), so rather than fork the runner around a
 * streaming callback contract, this seam asks for the SAME buffer-in /
 * transcript-out shape `makeWhisperDialectTranscriber` already uses.
 * Production wires `engine` to a thin adapter that opens a Deepgram session,
 * streams the fixture buffer's frames through `send()`, calls `finish()`,
 * and resolves with the concatenated final transcript(s); tests wire it to
 * a stub — no network, no `DEEPGRAM_API_KEY` required to exercise the WER
 * math or the surface rollup.
 */
export interface DeepgramBufferTranscriber {
  transcribeBuffer(audio: Buffer, caseId: string): Promise<string>;
}

/**
 * Bridge a buffer-in Deepgram engine + an audio loader into a
 * `DialectTranscriber`. Mirrors `makeWhisperDialectTranscriber` exactly (same
 * `loadAudio` seam, same missing-`audioFixture` guard) so the two surfaces
 * compose identically in `runMultiSurfaceDialectEval`.
 */
export function makeDeepgramDialectTranscriber(
  engine: DeepgramBufferTranscriber,
  loadAudio: (audioFixture: string) => Promise<Buffer>,
): DialectTranscriber {
  return async (evalCase) => {
    if (!evalCase.audioFixture) {
      throw new Error(`dialect case ${evalCase.id} has no audioFixture to transcribe`);
    }
    const audio = await loadAudio(evalCase.audioFixture);
    return engine.transcribeBuffer(audio, evalCase.id);
  };
}

/**
 * A4 — credential gate for the Deepgram surface. Mirrors
 * `resolveLiveApiKey` (`packages/voice-eval/live-support.ts`): returns the
 * trimmed key, or `null` when unset/blank. Callers that assemble a
 * multi-surface run (e.g. a report-refresh script) use this to skip the
 * Deepgram surface — rather than throw — when no credential is configured,
 * so the harness stays offline-safe in PR CI (no spend) and only spends
 * when a live key is explicitly present (weekly/dispatch runs, mirroring
 * `voice-eval-live.yml`'s ANTHROPIC_API_KEY gate).
 */
export function resolveDeepgramApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const key = env.DEEPGRAM_API_KEY;
  return key && key.trim().length > 0 ? key.trim() : null;
}

/**
 * A4 — run the same case set through several ASR surfaces (engines) and
 * roll the combined results up per surface. Each entry in `surfaces` is a
 * label (e.g. 'whisper', 'deepgram') → the `DialectRunDeps` for that engine;
 * `runDialectEval` runs once per surface with `options.surface` set to the
 * label, so every result in every per-surface outcome (and in
 * `combinedResults`) carries its `surface`. `perSurfaceReports` keeps each
 * engine's own per-dialect gate (`DialectReport.pass`/`blockers`) intact —
 * multi-surface does not average away a per-dialect regression on one
 * engine; `surfaceRollup` is the additional per-surface measurement view
 * (`buildSurfaceRollup`, `dialect-report.ts`).
 *
 * Surfaces run sequentially (not `Promise.all`) so a caller passing a
 * shared cost tracker / rate-limited engine across surfaces sees bounded,
 * predictable concurrency — within a surface, `runDialectEval` already
 * bounds concurrency via `options.concurrency`.
 */
export interface MultiSurfaceDialectOutcome {
  /** Each surface's own run outcome (report/results/errors), keyed by label. */
  bySurface: Record<string, DialectRunOutcome>;
  /** Every result from every surface, each tagged with its `surface`. */
  combinedResults: DialectEvalResult[];
  /** Per-surface WER/intent/clarification rollup over `combinedResults`. */
  surfaceRollup: SurfaceStat[];
}

export async function runMultiSurfaceDialectEval(
  cases: ReadonlyArray<DialectEvalCase>,
  surfaces: Readonly<Record<string, DialectRunDeps>>,
  options: DialectRunOptions = {},
): Promise<MultiSurfaceDialectOutcome> {
  const bySurface: Record<string, DialectRunOutcome> = {};
  const combinedResults: DialectEvalResult[] = [];

  for (const [surface, deps] of Object.entries(surfaces)) {
    const outcome = await runDialectEval(cases, deps, { ...options, surface });
    bySurface[surface] = outcome;
    combinedResults.push(...outcome.results);
  }

  return {
    bySurface,
    combinedResults,
    surfaceRollup: buildSurfaceRollup(combinedResults),
  };
}
