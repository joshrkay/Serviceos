/**
 * μ-law (G.711 mu-law) ↔ linear PCM16 codec for Twilio Media Streams.
 *
 * Twilio sends inbound audio as 8 kHz μ-law in base64-encoded chunks of
 * 160 bytes (20 ms frames). Deepgram's streaming endpoint expects raw
 * PCM16 LE at 16 kHz. So inbound conversion is:
 *
 *   base64 → μ-law bytes → PCM16 8 kHz → PCM16 16 kHz (linear upsample)
 *
 * Outbound TTS is the reverse — PCM16 (typically 16 kHz from the TTS
 * provider) → 8 kHz → μ-law → base64.
 *
 * The conversion uses a small precomputed table (256 entries) for the
 * μ-law → PCM direction; PCM → μ-law uses a closed-form bit-twiddling
 * routine. Both are inverses: round-tripping a PCM16 sample through
 * μ-law and back is loss-bounded by μ-law's logarithmic quantization
 * (at most ~one bit of precision in the LSBs of small samples).
 *
 * This module is pure / synchronous / no I/O. Tests cover the
 * round-trip identity within tolerance.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** μ-law bias used by the standard G.711 algorithm. */
const MULAW_BIAS = 0x84;
/** Maximum positive PCM sample before clipping in encoder. */
const MULAW_CLIP = 32635;

// ─── Decode: μ-law → PCM16 LE ────────────────────────────────────────────────

/**
 * Precomputed μ-law → PCM16 lookup table. Indexed by μ-law byte value
 * (0..255). Values are signed 16-bit linear samples.
 *
 * Algorithm: invert the μ-law byte (since the sign and magnitude are
 * stored as the bitwise complement on the wire), extract sign + 3-bit
 * exponent + 4-bit mantissa, reconstruct the magnitude, then re-apply
 * the sign and subtract the bias.
 */
const MULAW_DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80 ? -1 : 1;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let magnitude = ((mantissa << 3) + MULAW_BIAS) << exponent;
    magnitude -= MULAW_BIAS;
    table[i] = sign * magnitude;
  }
  return table;
})();

/**
 * Decode a μ-law byte buffer to a PCM16 LE buffer. Output length is
 * 2× input length (each μ-law byte → one int16 sample).
 */
export function mulawToPcm16(input: Buffer): Buffer {
  const out = Buffer.alloc(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    out.writeInt16LE(MULAW_DECODE_TABLE[input[i]] ?? 0, i * 2);
  }
  return out;
}

// ─── Encode: PCM16 LE → μ-law ────────────────────────────────────────────────

/**
 * Encode a single PCM16 sample to a μ-law byte. Standard G.711
 * algorithm: clip → bias → log → quantize → invert.
 */
function encodePcmSampleToMulaw(sample: number): number {
  let s = sample;
  // Clip and capture sign.
  let sign = 0;
  if (s < 0) {
    s = -s;
    sign = 0x80;
  }
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s = s + MULAW_BIAS;
  // Find the exponent: position of the highest set bit, minus 7.
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  // Invert per spec.
  const muByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return muByte;
}

/** Encode a PCM16 LE buffer to μ-law bytes. Output is half the input size. */
export function pcm16ToMulaw(input: Buffer): Buffer {
  const sampleCount = Math.floor(input.length / 2);
  const out = Buffer.alloc(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const sample = input.readInt16LE(i * 2);
    out[i] = encodePcmSampleToMulaw(sample);
  }
  return out;
}

// ─── Resampling (8 kHz ↔ 16 kHz) ─────────────────────────────────────────────

/**
 * Naive 2× linear-interpolation upsample from 8 kHz PCM16 to 16 kHz.
 * Doubles the sample count by emitting each input sample at the even
 * output index and a linearly-interpolated midpoint between adjacent
 * input samples at the odd output index. The final odd index has no
 * "next" input — it simply re-emits the last sample.
 *
 * Output layout for inputs [a, b, c]:
 *   [a, (a+b)/2, b, (b+c)/2, c, c]
 *
 * Intentionally lightweight — Deepgram's frontend handles its own
 * spectral cleanup, and a sinc filter would be overkill for an 8→16
 * doubling in production telephony bandwidth. Round-trip identity is
 * tested in the codec test.
 */
export function upsample8to16(pcm8: Buffer): Buffer {
  const inSamples = Math.floor(pcm8.length / 2);
  if (inSamples === 0) return Buffer.alloc(0);
  const out = Buffer.alloc(inSamples * 2 * 2); // 2× samples × 2 bytes/sample
  for (let i = 0; i < inSamples; i++) {
    const curr = pcm8.readInt16LE(i * 2);
    const next = i + 1 < inSamples ? pcm8.readInt16LE((i + 1) * 2) : curr;
    out.writeInt16LE(curr, (i * 2) * 2);
    out.writeInt16LE((curr + next) >> 1, (i * 2 + 1) * 2);
  }
  return out;
}

/**
 * Naive 2× decimation downsample from 16 kHz PCM16 to 8 kHz.
 * Averages every adjacent pair of input samples to produce one output
 * sample. Cheap and serviceable for outbound TTS that's already
 * voice-bandlimited; an FIR low-pass would reduce aliasing further but
 * is not required for telephony intelligibility.
 */
export function downsample16to8(pcm16: Buffer): Buffer {
  const inSamples = Math.floor(pcm16.length / 2);
  const outSamples = Math.floor(inSamples / 2);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const a = pcm16.readInt16LE((i * 2) * 2);
    const b = pcm16.readInt16LE((i * 2 + 1) * 2);
    out.writeInt16LE((a + b) >> 1, i * 2);
  }
  return out;
}

// ─── Convenience wrappers ────────────────────────────────────────────────────

/**
 * Convert a Twilio Media Streams inbound payload (base64-encoded
 * μ-law 8 kHz) to PCM16 LE 16 kHz suitable for Deepgram.
 */
export function decodeTwilioInboundFrame(base64Payload: string): Buffer {
  const mulaw = Buffer.from(base64Payload, 'base64');
  const pcm8 = mulawToPcm16(mulaw);
  return upsample8to16(pcm8);
}

/**
 * Convert PCM16 (any of: 8 kHz already, or 16 kHz) into a Twilio
 * outbound media payload — base64-encoded μ-law 8 kHz.
 *
 * Accepts an explicit `inputSampleRate` so the caller can avoid the
 * downsample step when their TTS already produces 8 kHz. Defaults to
 * 16 kHz which matches the OpenAI / ElevenLabs PCM output used by
 * the existing TtsProvider when configured to emit raw PCM.
 */
export function encodeTwilioOutboundFrame(
  pcm: Buffer,
  inputSampleRate: 8000 | 16000 = 16000,
): string {
  const pcm8 = inputSampleRate === 16000 ? downsample16to8(pcm) : pcm;
  const mulaw = pcm16ToMulaw(pcm8);
  return mulaw.toString('base64');
}
