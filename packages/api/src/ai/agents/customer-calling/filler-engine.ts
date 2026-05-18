import { FILLER_LIBRARY, type Filler } from './fillers/manifest';

export interface FillerSelectContext {
  /** Caller opts out of fillers (e.g. emergency in progress, or post-greeting silence). */
  skipFillers?: boolean;
}

/**
 * Selection logic for the filler library. Tracks the previously-emitted
 * filler so we never repeat back-to-back. Pure — no I/O. The audio
 * playback path (loading the PCM from disk, emitting Twilio media
 * frames) lives in mediastream-adapter.
 *
 * Decoupled from CallingAgentState on purpose — emergency routing
 * lives in Layer 3 and the caller (mediastream-adapter) decides
 * whether to suppress fillers based on whatever signal it has.
 */
export class FillerEngine {
  private lastId: string | null = null;
  private cursor = 0;

  selectNext(ctx: FillerSelectContext = {}): Filler | undefined {
    if (ctx.skipFillers) return undefined;
    if (FILLER_LIBRARY.length === 0) return undefined;
    // Round-robin with skip on repeat — stable, predictable, no RNG.
    for (let i = 0; i < FILLER_LIBRARY.length; i++) {
      const candidate = FILLER_LIBRARY[(this.cursor + i) % FILLER_LIBRARY.length];
      if (candidate.id !== this.lastId) {
        this.cursor = (this.cursor + i + 1) % FILLER_LIBRARY.length;
        this.lastId = candidate.id;
        return candidate;
      }
    }
    return undefined;
  }
}
