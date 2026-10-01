import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FILLER_LIBRARY, type Filler } from './fillers/manifest';
import type { TtsProvider } from '../../tts/tts-provider';

/**
 * #1534 — renders one filler clip as raw PCM16 LE @ 16 kHz mono (the format
 * the adapter streams). `signal` aborts when the clip's timeout elapses.
 */
export type FillerSynthesizer = (filler: Filler, signal: AbortSignal) => Promise<Buffer>;

/**
 * #1534 — the production synthesizer: the same TTS provider the media-streams
 * adapter speaks replies with, through the same `synthesizeStream` call shape
 * (text + language, no voice override), so a filler has the reply's voice and
 * the raw PCM16 @ 16 kHz format `streamPcmAsMedia` consumes. A Spanish filler
 * passes `language: 'es'`, which selects the provider's Spanish model.
 * Returns undefined when no TTS is configured or it cannot stream raw PCM
 * (`synthesize()` returns mp3, which the media path cannot play).
 */
export function fillerSynthesizerFromTts(
  provider: TtsProvider | undefined,
): FillerSynthesizer | undefined {
  if (!provider || typeof provider.synthesizeStream !== 'function') return undefined;
  const stream = provider.synthesizeStream.bind(provider);
  return async (filler, signal) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream({ text: filler.text, language: filler.language, signal })) {
      if (chunk.pcm.length > 0) chunks.push(chunk.pcm);
    }
    const pcm = Buffer.concat(chunks);
    if (pcm.length === 0) throw new Error(`TTS returned no audio for filler ${filler.id}`);
    return pcm;
  };
}

/**
 * #1534 — boot entry point. Starts filling the cache's missing clips with the
 * production TTS and returns the (never-rejecting) fill promise WITHOUT
 * awaiting it, so boot never blocks on TTS; the adapter keeps playing
 * nothing for a missing clip until it lands. Returns null (and the cache is
 * left as `load()` found it, its "missing" warning standing) when no TTS is
 * configured or it cannot stream raw PCM.
 */
export function startFillerSynthesis(
  cache: FillerAudioCache,
  provider: TtsProvider | undefined,
): Promise<void> | null {
  const synthesize = fillerSynthesizerFromTts(provider);
  if (!synthesize) return null;
  return cache.fillMissing(synthesize);
}

/** Per-clip bound on one synthesis; a hung TTS gives up on that clip only. */
const DEFAULT_FILL_TIMEOUT_MS = 10_000;

interface FillerCacheLogger {
  warn: (msg: string, meta?: unknown) => void;
  info?: (msg: string, meta?: unknown) => void;
}

/**
 * Loads pre-rendered filler audio from disk into memory at boot. The
 * audio is raw PCM 16-bit signed little-endian @ 16 kHz mono, as
 * produced by `scripts/render-fillers.ts` (ElevenLabs pcm_16000 format).
 * The mediastream-adapter passes the bytes directly to `streamPcmAsMedia`
 * without any further decoding.
 *
 * Missing files do NOT throw — they are simply skipped. This lets a
 * partial render survive boot; the unrendered fillers are unavailable
 * but other fillers still play. Logs a warning so the gap is visible.
 *
 * #1534 — the deploy image ships no rendered clips, so boot then calls
 * `startFillerSynthesis`, which fills each missing clip once in memory with
 * the production TTS (`fillMissing`). Clips on disk always win.
 */
export class FillerAudioCache {
  private readonly cache = new Map<string, Buffer>();

  constructor(
    private readonly rootDir: string,
    private readonly logger: FillerCacheLogger = console,
  ) {}

  load(): void {
    const missingIds: string[] = [];

    for (const filler of FILLER_LIBRARY) {
      // Prefer pcm (current renderer output). Allow mp3 or .bin overrides
      // for legacy render runs or alternate provider output.
      const candidates = ['pcm', 'mp3', 'bin'].map((ext) =>
        resolve(this.rootDir, `${filler.id}.${ext}`)
      );
      const path = candidates.find((p) => existsSync(p));
      if (!path) {
        missingIds.push(filler.id);
        continue;
      }
      this.cache.set(filler.id, readFileSync(path));
    }

    if (missingIds.length > 0) {
      this.logger.warn('filler audio missing', {
        missingCount: missingIds.length,
        loadedCount: this.cache.size,
        missingIds,
      });
    }
  }

  /**
   * #1534 — no clips ship in the image, so synthesize each FILLER_LIBRARY
   * clip that `load()` did not find on disk, once, into memory. Clips on
   * disk always win. Never throws: a failed or timed-out clip is logged and
   * stays missing (the adapter plays nothing for it, as before). Clips land
   * one by one, so `get()` serves each as soon as it is ready; callers run
   * this fire-and-forget so boot never waits on TTS.
   */
  async fillMissing(
    synthesize: FillerSynthesizer,
    opts: { timeoutMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_FILL_TIMEOUT_MS;
    const synthesized: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const filler of FILLER_LIBRARY) {
      if (this.cache.has(filler.id)) continue;
      try {
        const pcm = await synthesizeWithTimeout(synthesize, filler, timeoutMs);
        this.cache.set(filler.id, pcm);
        synthesized.push(filler.id);
      } catch (err) {
        failed.push({ id: filler.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (synthesized.length > 0) {
      this.logger.info?.('filler audio synthesized', {
        synthesizedCount: synthesized.length,
        failedCount: failed.length,
        synthesizedIds: synthesized,
      });
    }
    if (failed.length > 0) {
      this.logger.warn('filler audio synthesis failed', {
        failedIds: failed.map((f) => f.id),
        errors: failed,
      });
    }
  }

  get(id: string): Buffer | undefined {
    return this.cache.get(id);
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  size(): number {
    return this.cache.size;
  }
}

async function synthesizeWithTimeout(
  synthesize: FillerSynthesizer,
  filler: Filler,
  timeoutMs: number,
): Promise<Buffer> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`filler synthesis timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([synthesize(filler, controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
