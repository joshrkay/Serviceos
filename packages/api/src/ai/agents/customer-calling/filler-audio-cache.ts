import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FILLER_LIBRARY } from './fillers/manifest';

/**
 * Loads pre-rendered filler audio from disk into memory at boot. The
 * audio is raw PCM 16-bit signed little-endian @ 16 kHz mono, as
 * produced by `scripts/render-fillers.ts` (ElevenLabs pcm_16000 format).
 * The mediastream-adapter passes the bytes directly to `streamPcmAsMedia`
 * without any further decoding (see decode-filler.ts).
 *
 * Missing files do NOT throw — they are simply skipped. This lets a
 * partial render survive boot; the unrendered fillers are unavailable
 * but other fillers still play. Logs a warning so the gap is visible.
 */
export class FillerAudioCache {
  private readonly cache = new Map<string, Buffer>();

  constructor(
    private readonly rootDir: string,
    private readonly logger: { warn: (msg: string, meta?: unknown) => void } = console,
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
