/**
 * VQ2-001 — WhisperRealProvider.
 *
 * Composes a buffer-capable Whisper inner with three concerns Layer 2 of
 * the Voice Quality harness needs but the production Whisper provider
 * deliberately omits:
 *
 *   1. **Bounded 429 retry.** The production
 *      `WhisperTranscriptionProvider` (`packages/api/src/voice/transcription-providers.ts`)
 *      maps 429 to a typed `WhisperRateLimitError` and explicitly does
 *      NOT retry — "Retries are the worker's job." For Layer 2's
 *      offline harness we are the worker; one retry with a 500ms
 *      backoff is enough to ride out the rare CI flake without masking
 *      a real outage.
 *
 *   2. **Cost tracking.** Each successful call adds the per-minute
 *      Whisper cost (rounded up to the nearest cent) to a shared
 *      {@link WhisperCostTracker}. Errors do not consume budget.
 *
 *   3. **Observability.** Every call emits exactly one
 *      `lookup_executed` event on a shared {@link AgentEventBus}, so
 *      Phase-3 graders can assert on transcription latency / failure
 *      rate without reaching into Whisper internals.
 *
 * # Why a buffer-capable inner?
 *
 * The production `WhisperTranscriptionProvider` accepts a signed audio
 * URL (`transcribe(audioUrl: string)`); it fetches, validates, and
 * uploads in one shot. Layer 2 already has the audio in-process —
 * either synthesized via OpenAI TTS (VQ2-002) or captured off the
 * mediastream emulator — so paying the round-trip to mint a signed URL
 * just to fetch it back is wasteful. We thread a small interface
 * (`WhisperBufferTranscriber`) so the wrapper composes equally well
 * with: (a) a thin Buffer→multipart shim around `WhisperTranscriptionProvider`'s
 * private upload path; or (b) a stub in tests. The seam is documented
 * here so VQ2-002 / VQ2-003 don't have to re-derive it.
 */
import { performance } from 'node:perf_hooks';

import type { AgentEventBus } from '../event-bus';
import { lookupExecutedEvent } from '../events';

/**
 * OpenAI whisper-1 pricing as of 2026-04-30: $0.006 per minute = 0.6 cents/minute.
 *
 * Hoisted as a named constant for maintainability — pricing changes require a
 * deliberate edit, not a magic-number hunt across the file.
 */
export const WHISPER_CENTS_PER_MINUTE = 0.6;

/**
 * Backoff schedule (ms) for 429 retries. The first entry is the wait
 * BEFORE the first attempt (zero — no delay). The second entry is the
 * wait before the retry. Hard-coded rather than configurable: Layer 2
 * is an internal harness; tunability here is yagni and would obscure
 * the "two attempts max" invariant the test suite asserts.
 */
const BACKOFFS_MS: readonly number[] = [0, 500];

/** Result shape returned by the inner Whisper transcriber. */
export interface WhisperBufferTranscriptionResult {
  transcript: string;
  metadata: Record<string, unknown>;
}

/**
 * Minimal buffer-in / transcript-out interface the wrapper depends on.
 * Production wires this to a thin shim around the existing
 * `WhisperTranscriptionProvider`; tests wire it to `vi.fn()` mocks.
 */
export interface WhisperBufferTranscriber {
  transcribeBuffer(audio: Buffer): Promise<WhisperBufferTranscriptionResult>;
}

/**
 * Cost accumulator the wrapper feeds. Mirrors `runner.ts`'s
 * `CostTracker` shape (we re-declare here rather than import to avoid
 * pulling the heavier runner module into the audio package — the
 * runner can pass its tracker in by structural typing).
 */
export interface WhisperCostTracker {
  addCents(n: number): void;
  totalCents(): number;
}

export interface WhisperRealProviderDeps {
  inner: WhisperBufferTranscriber;
  bus: AgentEventBus;
  costTracker: WhisperCostTracker;
}

export class WhisperRealProvider {
  constructor(private readonly deps: WhisperRealProviderDeps) {}

  /**
   * Transcribe a Buffer of audio. Returns the transcript text on
   * success; throws the underlying inner-provider error on failure
   * (after retrying once if the first failure was a 429).
   *
   * `scriptId` is accepted for future use (cassette key / structured
   * logging) but currently not surfaced — keeping it in the signature
   * now means VQ2-002+ can wire it without breaking call-sites.
   */
  async transcribeBuffer(
    audio: Buffer,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _scriptId: string,
  ): Promise<string> {
    const t0 = performance.now();
    const audioSeconds = estimateAudioSeconds(audio);
    let lastErr: unknown;

    for (let attempt = 0; attempt < BACKOFFS_MS.length; attempt += 1) {
      const backoff = BACKOFFS_MS[attempt]!;
      if (backoff > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, backoff));
      }
      try {
        const result = await this.deps.inner.transcribeBuffer(audio);
        const ms = performance.now() - t0;
        const cents = Math.ceil(
          (audioSeconds / 60) * WHISPER_CENTS_PER_MINUTE,
        );
        this.deps.costTracker.addCents(cents);
        this.deps.bus.record(
          lookupExecutedEvent('whisper.transcribe', ms, true),
        );
        return result.transcript;
      } catch (err) {
        lastErr = err;
        if (!isRateLimitError(err)) {
          // Non-429 errors fail immediately — don't burn the retry budget.
          this.deps.bus.record(
            lookupExecutedEvent(
              'whisper.transcribe',
              performance.now() - t0,
              false,
              errorMessage(err),
            ),
          );
          throw err;
        }
        // Otherwise loop and retry (subject to BACKOFFS_MS exhaustion).
      }
    }

    // All retries exhausted; the final attempt was also a 429.
    this.deps.bus.record(
      lookupExecutedEvent(
        'whisper.transcribe',
        performance.now() - t0,
        false,
        errorMessage(lastErr) ?? '429 retries exhausted',
      ),
    );
    throw lastErr ?? new Error('Whisper rate-limited; retries exhausted');
  }
}

/**
 * Estimate audio duration in seconds from a raw buffer.
 *
 * We deliberately use a single conservative byte-rate rather than
 * sniffing WAV headers: Layer 2 controls the input format end-to-end
 * (TTS-rendered fixtures or μ-law frames captured from the emulator),
 * and a parsing step here would invite "what if the header is
 * malformed" branches that don't pay rent. The cost overestimates
 * slightly for compressed inputs and underestimates for higher sample
 * rates — both acceptable: cost tracking is for budget caps, not
 * line-item accuracy. A future story can swap in a precise reader if
 * the budget delta proves material.
 *
 * Reference rates:
 *   - WAV mono 8 kHz μ-law: 8000 bytes/second
 *   - 16-bit PCM mono 8 kHz: 16 000 bytes/second   ← default heuristic
 *   - 16-bit PCM mono 16 kHz: 32 000 bytes/second
 *
 * Layer 2's pipeline (VQ2-003 codec helpers) standardizes on telephony
 * 8 kHz 16-bit PCM mono after μ-law decode, so 16 000 bytes/sec is the
 * realistic byte rate for buffers that reach this estimator. The earlier
 * 32 000 default assumed 16 kHz and undercharged the cost tracker by 2x,
 * which could let a long suite silently exceed the suite cost cap
 * (Gemini #2 on PR #334).
 */
function estimateAudioSeconds(audio: Buffer): number {
  // 16-bit PCM mono 8 kHz (telephony standard); WhisperBufferTranscriber
  // consumers upstream of this wrapper convert from μ-law if needed.
  const BYTES_PER_SECOND_DEFAULT = 16_000;
  return audio.length / BYTES_PER_SECOND_DEFAULT;
}

/**
 * Detect a rate-limit error coming back from the inner provider.
 *
 * The OpenAI SDK throws errors with `.status === 429`; the production
 * `WhisperTranscriptionProvider` wraps these in `WhisperRateLimitError`
 * (which exposes `code === 'WHISPER_RATE_LIMITED'`); generic HTTP
 * libraries sometimes use `.statusCode`. Detect all three so the
 * wrapper degrades gracefully regardless of which inner it composes
 * with.
 */
function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
  };
  if (e.status === 429 || e.statusCode === 429) return true;
  if (e.code === 'WHISPER_RATE_LIMITED') return true;
  return false;
}

function errorMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return undefined;
}
