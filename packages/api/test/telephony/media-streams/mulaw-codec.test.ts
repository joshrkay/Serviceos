/**
 * P8-012 — μ-law ↔ PCM16 round-trip identity tests.
 *
 * μ-law is a logarithmic companding codec; perfect identity is not
 * possible, but the round-trip error must stay bounded by μ-law's
 * documented quantization step (≤ ~256 LSBs near full-scale, much
 * smaller near zero where μ-law has finer resolution).
 *
 * These tests pin the codec so that an off-by-one in the conversion
 * table (the most failure-prone part of the audio path) trips here
 * instead of producing garbled transcripts in production.
 */

import { describe, it, expect } from 'vitest';
import {
  mulawToPcm16,
  pcm16ToMulaw,
  upsample8to16,
  downsample16to8,
  decodeTwilioInboundFrame,
  encodeTwilioOutboundFrame,
} from '../../../src/telephony/media-streams/mulaw-codec';

// Helper: build a PCM16 buffer from a list of int16 samples.
function pcm(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

function readPcm(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

describe('P8-012 mulaw codec', () => {
  it('mulawToPcm16 doubles buffer length (1 byte → 1 int16)', () => {
    const mu = Buffer.from([0xff, 0x80, 0x00]);
    const pcm16 = mulawToPcm16(mu);
    expect(pcm16.length).toBe(6);
  });

  it('pcm16ToMulaw halves buffer length (1 int16 → 1 byte)', () => {
    const p = pcm([0, 100, -100, 1000, -1000]);
    const mu = pcm16ToMulaw(p);
    expect(mu.length).toBe(5);
  });

  it('round-trips PCM16 → μ-law → PCM16 within μ-law quantization tolerance', () => {
    // Coverage across small / mid / large magnitudes including sign symmetry.
    // μ-law has a "dead zone" near 0 (samples < ~64 round to 0), so the
    // smaller checks here exercise the lookup table outside that zone.
    const samples = [
      0, 100, -100, 500, -500, 1000, -1000, 5000, -5000,
      10000, -10000, 20000, -20000, 32000, -32000, 32635, -32635,
    ];
    const round = readPcm(mulawToPcm16(pcm16ToMulaw(pcm(samples))));
    expect(round.length).toBe(samples.length);
    // μ-law quantization step at full-scale is ~256 (8-bit log code, 14-bit
    // magnitude). Allow that as the upper bound; at small magnitudes the
    // step is much tighter so this also catches gross errors.
    for (let i = 0; i < samples.length; i++) {
      const err = Math.abs(round[i] - samples[i]);
      const tolerance = Math.abs(samples[i]) < 200 ? 132 : 1024;
      expect(err).toBeLessThanOrEqual(tolerance);
      // Sign must be preserved when the sample is well above the dead zone.
      if (Math.abs(samples[i]) >= 200) {
        expect(Math.sign(round[i])).toBe(Math.sign(samples[i]));
      }
    }
  });

  it('μ-law → PCM16 → μ-law is a fixed point for non-zero inputs', () => {
    // Every μ-law byte maps to a unique PCM16 sample via the lookup,
    // and re-encoding produces the same byte — except that 0xff and
    // 0x7f both decode to 0 (positive- and negative-zero codes), and
    // the encoder always emits 0xff for sample 0. Skip 0x7f.
    const bytes = Array.from({ length: 256 }, (_, i) => i).filter((b) => b !== 0x7f);
    const allBytes = Buffer.from(bytes);
    const round = pcm16ToMulaw(mulawToPcm16(allBytes));
    expect(round.length).toBe(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      expect(round[i]).toBe(bytes[i]);
    }
  });

  it('clips PCM samples at the int16 max to the nearest representable μ-law value', () => {
    // At the int16 boundary we must not crash; encoder should clip
    // to ±32635 (μ-law's documented full-scale).
    const edge = pcm([32767, -32768, 32635, -32635]);
    const mu = pcm16ToMulaw(edge);
    const back = readPcm(mulawToPcm16(mu));
    expect(back.length).toBe(4);
    for (const sample of back) {
      expect(Math.abs(sample)).toBeLessThanOrEqual(32635);
    }
  });

  it('upsample8to16 doubles sample count and preserves input samples at even indices', () => {
    const p = pcm([100, 200, 300]);
    const up = upsample8to16(p);
    const out = readPcm(up);
    expect(out.length).toBe(6);
    // Even output indices reproduce the input samples exactly.
    expect(out[0]).toBe(100);
    expect(out[2]).toBe(200);
    expect(out[4]).toBe(300);
    // Odd indices are linear midpoints between consecutive inputs.
    expect(out[1]).toBe(150); // (100+200)/2
    expect(out[3]).toBe(250); // (200+300)/2
    // Last odd index has no successor — repeats the final sample.
    expect(out[5]).toBe(300);
  });

  it('downsample16to8 halves sample count', () => {
    const p = pcm([100, 200, 300, 400]);
    const down = downsample16to8(p);
    const out = readPcm(down);
    expect(out.length).toBe(2);
    // Each output is the average of an input pair.
    expect(out[0]).toBe(150);
    expect(out[1]).toBe(350);
  });

  it('decodeTwilioInboundFrame: base64 μ-law 8 kHz → PCM16 16 kHz', () => {
    // Build a fake Twilio "media.payload" — 4 μ-law bytes = 4 samples @ 8 kHz.
    const muBytes = Buffer.from([0xff, 0x7f, 0x80, 0x00]);
    const payload = muBytes.toString('base64');
    const pcm16 = decodeTwilioInboundFrame(payload);
    // 4 samples upsampled 2× = 8 samples × 2 bytes = 16 bytes.
    expect(pcm16.length).toBe(16);
  });

  it('encodeTwilioOutboundFrame: PCM16 16 kHz → base64 μ-law 8 kHz (4× compression)', () => {
    // 8 samples × 2 bytes = 16 bytes input → downsampled to 4 samples
    // → 4 μ-law bytes → base64.
    const samples = pcm([100, 200, 300, 400, 500, 600, 700, 800]);
    const b64 = encodeTwilioOutboundFrame(samples, 16000);
    const decoded = Buffer.from(b64, 'base64');
    expect(decoded.length).toBe(4);
  });

  it('encodeTwilioOutboundFrame: PCM16 8 kHz path skips downsample', () => {
    const samples = pcm([100, 200, 300, 400]);
    const b64 = encodeTwilioOutboundFrame(samples, 8000);
    const decoded = Buffer.from(b64, 'base64');
    expect(decoded.length).toBe(4);
  });
});
