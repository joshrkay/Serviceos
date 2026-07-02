/**
 * Canonical filler library. Each entry is pre-rendered to a PCM file
 * named `<id>.pcm` by `scripts/render-fillers.ts` at deploy time.
 *
 * Rules:
 *   - Six to ten entries PER LANGUAGE — fewer feels robotic on repeat,
 *     more is overkill.
 *   - Short (~150-400ms) — fillers buy time, they don't pad it.
 *   - Tone: neutral, warm, professional. No exclamations.
 *   - Avoid words the FSM may accidentally repeat in the real response.
 *
 * UB-C2 — Spanish entries: the filler engine keys selection by session
 * language, so a Spanish call only ever hears `language: 'es'` clips.
 * When a clip file is missing from disk the FillerAudioCache skips it
 * and the adapter plays NOTHING for that turn (silence) — it must never
 * fall back to an English filler on a Spanish call.
 *
 * DEPLOY-TIME STEP: the Spanish clips do not exist until
 * `ELEVENLABS_API_KEY=... npx tsx scripts/render-fillers.ts` is re-run
 * (the script renders `language: 'es'` entries with the
 * eleven_multilingual_v2 model). Until then Spanish calls degrade
 * gracefully to silent fillers.
 */
export interface Filler {
  id: string;
  text: string;
  /** Approximate playback duration in milliseconds, set after rendering. */
  approxDurationMs: number;
  /** UB-C2 — session language this clip belongs to. */
  language: 'en' | 'es';
}

export const FILLER_LIBRARY: ReadonlyArray<Filler> = [
  { id: 'mm-hmm', text: 'Mm-hmm.', approxDurationMs: 320, language: 'en' },
  { id: 'okay', text: 'Okay.', approxDurationMs: 260, language: 'en' },
  { id: 'got-it', text: 'Got it.', approxDurationMs: 340, language: 'en' },
  { id: 'one-moment', text: 'One moment.', approxDurationMs: 480, language: 'en' },
  { id: 'let-me-check', text: 'Let me check on that.', approxDurationMs: 720, language: 'en' },
  { id: 'let-me-see', text: 'Let me see.', approxDurationMs: 520, language: 'en' },
  { id: 'sure-thing', text: 'Sure thing.', approxDurationMs: 380, language: 'en' },
  { id: 'absolutely', text: 'Absolutely.', approxDurationMs: 540, language: 'en' },
  // ── Spanish (UB-C2) — mirror the English set, one clip per beat ──────
  { id: 'es-aja', text: 'Ajá.', approxDurationMs: 300, language: 'es' },
  { id: 'es-de-acuerdo', text: 'De acuerdo.', approxDurationMs: 420, language: 'es' },
  { id: 'es-entendido', text: 'Entendido.', approxDurationMs: 440, language: 'es' },
  { id: 'es-un-momento', text: 'Un momento.', approxDurationMs: 480, language: 'es' },
  { id: 'es-dejeme-revisar', text: 'Déjeme revisar eso.', approxDurationMs: 720, language: 'es' },
  { id: 'es-dejeme-ver', text: 'Déjeme ver.', approxDurationMs: 520, language: 'es' },
  { id: 'es-claro', text: 'Claro.', approxDurationMs: 360, language: 'es' },
  { id: 'es-por-supuesto', text: 'Por supuesto.', approxDurationMs: 540, language: 'es' },
];
