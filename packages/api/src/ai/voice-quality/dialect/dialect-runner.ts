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
 *                        `whisper-real-provider` via `makeWhisperDialectTranscriber`;
 *                        tests pass canned hypotheses.
 *   - `evaluateAgent`  — (case, transcript) → observed intent + clarification
 *                        behavior. OPTIONAL: omit it to run in ASR-only mode
 *                        (measure WER per dialect without driving the agent).
 *
 * Per-case failures (a transcription outage, a missing fixture) are captured
 * in `errors` rather than silently dropped — a caller MUST treat a non-empty
 * `errors` list as a failed run (the WER/intent gate only reflects the cases
 * that actually transcribed, so an outage must not read as "pass").
 */
import { wordErrorRate } from './wer';
import {
  scoreDialectCase,
  buildDialectReport,
  DEFAULT_DIALECT_THRESHOLDS,
  type DialectEvalCase,
  type DialectEvalResult,
  type DialectReport,
  type DialectThresholds,
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
): Promise<DialectEvalResult> {
  const transcript = await deps.transcribe(evalCase);
  if (!deps.evaluateAgent) {
    // ASR-only: measure transcription accuracy; intent is "not evaluated"
    // (null), not "failed" — don't penalize for skipping the agent.
    return {
      caseId: evalCase.id,
      dialect: evalCase.dialect,
      wer: wordErrorRate(evalCase.referenceTranscript, transcript),
      intentMatched: null,
      clarified: false,
    };
  }
  const observed = await deps.evaluateAgent(evalCase, transcript);
  return scoreDialectCase(evalCase, {
    transcript,
    actedIntent: observed.actedIntent ?? null,
    clarified: observed.clarified,
  });
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
          return { ok: true as const, result: await scoreOne(evalCase, deps) };
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
