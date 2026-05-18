/**
 * Filler audio is pre-rendered as raw PCM 16-bit signed little-endian
 * @ 16 kHz mono (see scripts/render-fillers.ts — uses ElevenLabs
 * output_format=pcm_16000). The "decoder" is therefore just a
 * type-tightening pass-through — no actual decoding happens at runtime,
 * which keeps the hot path allocation-free.
 *
 * If the renderer is changed to emit a container format (mp3, wav),
 * this is the single hook to add real decoding without touching
 * mediastream-adapter.
 */
export function decodeFillerToPcm16k(raw: Buffer): Buffer {
  return raw;
}
