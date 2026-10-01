/**
 * #1331 — Layer 2 filler clips, so the harness measures FIRST-AUDIBLE
 * latency the way production delivers it (owner decision 2026-10-01).
 *
 * Production wires the media-streams adapter with a `FillerEngine` and a
 * `FillerAudioCache` loaded from `ai/agents/customer-calling/fillers/`; the
 * adapter plays one clip 250 ms after the caller finishes when the answer is
 * not ready. Those clips are rendered offline (ElevenLabs,
 * scripts/render-fillers.ts) and are NOT in the repo, so a CI checkout has
 * none. The harness therefore loads whatever production would load from that
 * directory and synthesizes each missing ENGLISH clip once per suite through
 * its own TTS leg (the clip's content does not matter to the timing; its
 * existence does). Spanish clips are never synthesized: a missing Spanish
 * clip is silence in production (UB-C2), and the harness keeps that.
 */
import { FillerAudioCache } from '../../agents/customer-calling/filler-audio-cache';
import { FILLER_LIBRARY } from '../../agents/customer-calling/fillers/manifest';

export interface Layer2FillerCacheInput {
  /** The production fillers directory (where rendered `<id>.pcm` clips live). */
  fillerDir: string;
  /** Harness TTS: filler text → raw PCM16 @ 16 kHz mono (the adapter's format). */
  synthesize: (text: string) => Promise<Buffer>;
}

export interface Layer2FillerCache {
  cache: { get(id: string): Buffer | undefined };
  /** How many clips came from disk vs. the harness TTS — logged per suite. */
  source: { onDisk: number; synthesized: number };
}

export async function buildLayer2FillerCache(
  input: Layer2FillerCacheInput,
): Promise<Layer2FillerCache> {
  // Missing clips are expected in CI; the count is reported via `source`.
  const disk = new FillerAudioCache(input.fillerDir, { warn: () => {} });
  disk.load();

  const synthesized = new Map<string, Buffer>();
  for (const filler of FILLER_LIBRARY) {
    if (filler.language !== 'en' || disk.has(filler.id)) continue;
    synthesized.set(filler.id, await input.synthesize(filler.text));
  }

  return {
    cache: { get: (id) => disk.get(id) ?? synthesized.get(id) },
    source: { onDisk: disk.size(), synthesized: synthesized.size },
  };
}
