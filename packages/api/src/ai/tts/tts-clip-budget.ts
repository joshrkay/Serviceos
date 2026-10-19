import { MemoryStore, type Options, type Store } from 'express-rate-limit';

/**
 * S3-2 (plan U4) — the per-clip budget behind `POST /api/voice/tts` and
 * `POST /api/voice/tts/batch`.
 *
 * #1603 capped the single-clip route at `VOICE_TTS_PER_MIN` clips per user
 * per minute so no account can turn it into a free-text TTS proxy. The
 * onboarding prefetch asks for a whole turn (up to three clips) in one
 * request, and the batch must not be a way around that cap: a turn is
 * charged one unit per clip that is actually synthesized, never one per
 * request, and a turn that does not fit in what is left is refused whole.
 *
 * express-rate-limit's middleware charges exactly one hit per request and
 * has no n-unit API, so the budget is built directly on its `Store` —
 * the same store family the old `ttsLimiter` used (Redis-backed when
 * REDIS_URL is set, per-process otherwise), so the cap lives in one place.
 */
export type TtsClipCharge = { ok: true } | { ok: false; retryAfterMs: number };

export interface TtsClipBudget {
  /**
   * Takes `units` clips out of `key`'s budget for this window. Zero units is
   * always fine (a turn of cache hits costs nothing). A refusal gives back
   * every unit this call took, so the budget reads exactly as before it.
   */
  charge(key: string, units: number): Promise<TtsClipCharge>;
}

const DEFAULT_CLIPS_PER_MIN = 20;
const WINDOW_MS = 60_000;

/** `VOICE_TTS_PER_MIN` → clips per user per minute; garbage or unset → 20, never below 1. */
export function ttsClipsPerMinFromEnv(env: { VOICE_TTS_PER_MIN?: string }): number {
  return Math.max(1, Number(env.VOICE_TTS_PER_MIN) || DEFAULT_CLIPS_PER_MIN);
}

export function createTtsClipBudget(opts: { max: number; store?: Store; windowMs?: number }): TtsClipBudget {
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const max = Math.max(1, Math.floor(opts.max));
  const store = opts.store ?? new MemoryStore();
  // Both stores read only `windowMs` from the middleware options.
  void store.init?.({ windowMs } as Options);

  return {
    async charge(key, units) {
      let taken = 0;
      for (let i = 0; i < units; i += 1) {
        const { totalHits, resetTime } = await store.increment(key);
        taken += 1;
        if (totalHits > max) {
          for (let j = 0; j < taken; j += 1) await store.decrement(key);
          const resetAt = resetTime instanceof Date ? resetTime.getTime() : Date.now() + windowMs;
          return { ok: false, retryAfterMs: Math.max(0, resetAt - Date.now()) };
        }
      }
      return { ok: true };
    },
  };
}
