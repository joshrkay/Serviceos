import { FILLER_LIBRARY, type Filler } from './fillers/manifest';

export interface FillerSelectContext {
  /** Caller opts out of fillers (e.g. emergency in progress, or post-greeting silence). */
  skipFillers?: boolean;
  /**
   * UB-C2 — session language. Selection only ever returns clips of this
   * language; a Spanish call must never hear an English filler (and vice
   * versa). Defaults to 'en' for callers that predate language threading.
   */
  language?: 'en' | 'es';
}

/**
 * Selection logic for the filler library. Tracks the previously-emitted
 * filler PER LANGUAGE so we never repeat back-to-back within a language.
 * Pure — no I/O. The audio playback path (loading the PCM from disk,
 * emitting Twilio media frames) lives in mediastream-adapter; when the
 * selected clip is missing on disk the adapter plays nothing (silence),
 * never a clip from the other language.
 *
 * Decoupled from CallingAgentState on purpose — emergency routing
 * lives in Layer 3 and the caller (mediastream-adapter) decides
 * whether to suppress fillers based on whatever signal it has.
 */
export class FillerEngine {
  private readonly lastIdByLang = new Map<'en' | 'es', string>();
  private readonly cursorByLang = new Map<'en' | 'es', number>();

  selectNext(ctx: FillerSelectContext = {}): Filler | undefined {
    if (ctx.skipFillers) return undefined;
    const language = ctx.language ?? 'en';
    const pool = FILLER_LIBRARY.filter((f) => f.language === language);
    if (pool.length === 0) return undefined;
    const cursor = this.cursorByLang.get(language) ?? 0;
    const lastId = this.lastIdByLang.get(language);
    // Round-robin with skip on repeat — stable, predictable, no RNG.
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[(cursor + i) % pool.length];
      if (candidate.id !== lastId) {
        this.cursorByLang.set(language, (cursor + i + 1) % pool.length);
        this.lastIdByLang.set(language, candidate.id);
        return candidate;
      }
    }
    return undefined;
  }
}
