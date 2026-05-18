/**
 * Canonical filler library. Each entry is pre-rendered to a PCM file
 * named `<id>.pcm` by `scripts/render-fillers.ts` at deploy time.
 *
 * Rules:
 *   - Six to ten entries — fewer feels robotic on repeat, more is overkill.
 *   - Short (~150-400ms) — fillers buy time, they don't pad it.
 *   - Tone: neutral, warm, professional. No exclamations.
 *   - Avoid words the FSM may accidentally repeat in the real response.
 */
export interface Filler {
  id: string;
  text: string;
  /** Approximate playback duration in milliseconds, set after rendering. */
  approxDurationMs: number;
}

export const FILLER_LIBRARY: ReadonlyArray<Filler> = [
  { id: 'mm-hmm', text: 'Mm-hmm.', approxDurationMs: 320 },
  { id: 'okay', text: 'Okay.', approxDurationMs: 260 },
  { id: 'got-it', text: 'Got it.', approxDurationMs: 340 },
  { id: 'one-moment', text: 'One moment.', approxDurationMs: 480 },
  { id: 'let-me-check', text: 'Let me check on that.', approxDurationMs: 720 },
  { id: 'let-me-see', text: 'Let me see.', approxDurationMs: 520 },
  { id: 'sure-thing', text: 'Sure thing.', approxDurationMs: 380 },
  { id: 'absolutely', text: 'Absolutely.', approxDurationMs: 540 },
];
