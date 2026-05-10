/**
 * VQ2-002 — TtsFixtureCache.
 *
 * Content-addressable disk cache for caller-utterance audio. The Layer 2
 * audio-mode driver (VQ2-008) calls `getOrSynthesize({ text, voice })` and
 * gets a Buffer back. First call synthesizes via the injected `TtsProvider`
 * (production: `OpenAiTtsProvider` from `packages/api/src/ai/tts/tts-provider.ts`)
 * and writes the bytes to disk under `<sha256>.wav`; subsequent calls for the
 * same `(text, voice, model)` tuple read from disk without paying the API
 * round-trip — saves ~$0.30/script and removes a major source of CI flake.
 *
 * # Audio format on disk
 *
 * The file extension is `.wav` (per VQ2 plan §"Cache layout") but the actual
 * bytes are whatever the underlying provider returns. The default
 * `OpenAiTtsProvider` in this repo hard-codes `response_format: 'mp3'` and
 * advertises `contentType: 'audio/mpeg'`, so cached files contain MP3 bytes
 * despite the `.wav` suffix. The PCM codec helpers landing in VQ2-003
 * (`mp3ToPcm16Mono8k`) decode whichever envelope they receive and produce
 * the PCM16 mono 8 kHz frames Twilio Media Streams expects. If a future
 * story flips the provider to emit true WAV, no consumer change is needed:
 * the codec sniffs the header.
 *
 * # Concurrency
 *
 * Multiple callers (different vitest workers, concurrent script runs) may
 * race on the same key. We mirror the cassette-gateway `wx`-flock pattern:
 * the writer creates `<filePath>.lock` with `fs.openSync(path, 'wx')` so
 * exactly one writer wins; losers spin-back-off, then re-check the cache
 * (a peer may have just finished writing it). This is best-effort — the
 * common case in Layer 2 is single-process — but it keeps the corpus
 * directory clean enough that `git status` is meaningful.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type {
  TtsProvider,
  TtsSynthesizeInput,
} from '../../tts/tts-provider';

/**
 * The three OpenAI tts-1 voices we rotate through in the corpus to expose
 * voice-specific Whisper failure modes (per plan §"Voice rotation for
 * adversarial coverage"). The voice used for a given script is pinned —
 * `pickVoiceForScript` is deterministic on the script index — so cache
 * keys are stable across runs.
 */
export const SUPPORTED_VOICES = ['alloy', 'nova', 'onyx'] as const;
export type SupportedVoice = (typeof SUPPORTED_VOICES)[number];

/**
 * OpenAI tts-1 pricing as of 2026-04-30: $0.015 per 1 000 characters
 * = 1.5 cents per 1 000 characters. Hoisted as a named constant so a
 * pricing change is a deliberate edit, not a magic-number hunt.
 */
export const TTS_CENTS_PER_1K_CHARS = 1.5;

/**
 * Cost accumulator the cache feeds when it actually synthesizes. Mirrors
 * the structural shape used by `WhisperRealProvider` (VQ2-001) and the
 * runner's `CostTracker`, so the runner can pass its tracker in without
 * an adapter.
 */
export interface TtsFixtureCostTracker {
  addCents(n: number): void;
}

export interface TtsFixtureCacheDeps {
  ttsProvider: TtsProvider;
  /** Optional — when present, cache misses charge cents per text length. */
  costTracker?: TtsFixtureCostTracker;
  /** Defaults to {@link defaultFixturesDir}. */
  cacheDir?: string;
  /** Defaults to 'tts-1' — included in the hash so cached audio invalidates if the model changes. */
  ttsModel?: string;
}

export interface SynthesizeOptions {
  text: string;
  voice: SupportedVoice;
}

/** Lock backoff schedule (ms). Total max wait ≈ 350ms before giving up. */
const LOCK_RETRY_BACKOFFS_MS: readonly number[] = [50, 100, 200];

export class TtsFixtureCache {
  constructor(private readonly deps: TtsFixtureCacheDeps) {}

  /**
   * Return audio bytes for the requested utterance. Cache hit reads from
   * disk; miss synthesizes via the injected provider, charges the cost
   * tracker, and persists the bytes under the content hash. Writes are
   * serialized via a per-file `wx` lock so concurrent workers don't both
   * pay the API.
   */
  async getOrSynthesize(opts: SynthesizeOptions): Promise<Buffer> {
    const dir = this.deps.cacheDir ?? defaultFixturesDir();
    fs.mkdirSync(dir, { recursive: true });

    const hash = this.hashKey(opts);
    const filePath = path.join(dir, `${hash}.wav`);

    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath);
    }

    return this.synthesizeUnderLock(filePath, opts);
  }

  /**
   * Sha256 over a canonical `(text, voice, model)` snapshot. Model is
   * included so flipping `ttsModel` (e.g. tts-1 → tts-1-hd) invalidates
   * the existing corpus rather than silently returning stale audio
   * encoded by the old model.
   */
  private hashKey(opts: SynthesizeOptions): string {
    const model = this.deps.ttsModel ?? 'tts-1';
    const canonical = JSON.stringify({
      text: opts.text,
      voice: opts.voice,
      model,
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Acquire the write lock, re-check the cache (a peer may have just
   * written it while we waited), then synthesize and persist. We only
   * call into the provider — and only charge the cost tracker — once
   * the lock is held AND the file is still missing.
   */
  private async synthesizeUnderLock(
    filePath: string,
    opts: SynthesizeOptions
  ): Promise<Buffer> {
    const lockPath = `${filePath}.lock`;
    let lockFd: number | null = null;

    // Attempt acquisition with bounded backoff. Between attempts we also
    // re-check the cache so a peer who finished writing wins the race
    // for us — we just read the bytes they produced.
    for (const backoff of [0, ...LOCK_RETRY_BACKOFFS_MS]) {
      if (backoff > 0) {
        if (fs.existsSync(filePath)) {
          // Peer wrote the file while we were waiting on the lock.
          return fs.readFileSync(filePath);
        }
        await sleep(backoff);
      }
      try {
        lockFd = fs.openSync(lockPath, 'wx');
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // Otherwise loop and retry (subject to backoff exhaustion).
      }
    }

    if (lockFd === null) {
      // Last-chance read: the holder may have finished and released
      // between our final retry and giving up.
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath);
      }
      throw new Error(
        `tts-fixture-cache: failed to acquire lock on ${lockPath} after retries`
      );
    }

    try {
      // Re-check INSIDE the lock so two writers serialized through the
      // lock don't both pay the API. The first writer creates the file;
      // the second observes it here and short-circuits.
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath);
      }

      const synthInput: TtsSynthesizeInput = {
        text: opts.text,
        voice: opts.voice,
      };
      const result = await this.deps.ttsProvider.synthesize(synthInput);

      if (this.deps.costTracker) {
        const cents = Math.ceil(
          (opts.text.length / 1000) * TTS_CENTS_PER_1K_CHARS
        );
        this.deps.costTracker.addCents(cents);
      }

      fs.writeFileSync(filePath, result.audio);
      return result.audio;
    } finally {
      try {
        fs.closeSync(lockFd);
      } catch {
        /* already closed */
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Canonical default fixtures dir: `<this-file>/../corpus/audio-fixtures`.
 * Mirrors `defaultCassettesDir()` in `cassette-gateway.ts` so we have a
 * single source of truth for "where Layer 2 audio fixtures live."
 */
export function defaultFixturesDir(): string {
  return path.resolve(__dirname, '..', 'corpus', 'audio-fixtures');
}

/**
 * Deterministically pick one of {@link SUPPORTED_VOICES} for a given
 * script index. Pinning by index (rather than e.g. random per run) keeps
 * the cache key stable so the corpus doesn't churn — but distributing
 * across the corpus catches voice-specific Whisper regressions a single
 * voice would mask.
 */
export function pickVoiceForScript(scriptIndex: number): SupportedVoice {
  const voice = SUPPORTED_VOICES[scriptIndex % SUPPORTED_VOICES.length];
  // Non-null assertion: modulo into a non-empty readonly tuple is total.
  return voice!;
}

/** Async sleep helper; isolated for readability and easy stubbing. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
