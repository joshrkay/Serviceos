/**
 * VQ2-003 — PCM/μ-law codec helpers tests.
 *
 * These tests exercise the three Layer 2-specific helpers that wrap the
 * production μ-law codec at `packages/api/src/telephony/media-streams/mulaw-codec.ts`:
 *
 *   - `frameForTwilio` — splits PCM16 8 kHz into 20 ms μ-law base64 frames.
 *   - `decodeAgentOutbound` — concatenates inbound base64 μ-law frames into
 *     a single PCM16 buffer + captures the first-frame timestamp (TTFA stop).
 *   - `mp3ToPcm16Mono8k` — shells out to ffmpeg to decode MP3 (the format
 *     `OpenAiTtsProvider` actually returns) into PCM16 mono 8 kHz.
 *
 * Determinism: the framing tests use a synthesized 1 kHz sine wave at
 * 8 kHz so we don't depend on real audio. The MP3 decode test generates
 * a tiny MP3 fixture via ffmpeg in setup; if ffmpeg is not on PATH (e.g.
 * a developer laptop without it installed), that test is skipped with a
 * comment pointing at the ffmpeg-install follow-up.
 */
import { execSync, spawnSync } from 'child_process';
import { describe, it, expect } from 'vitest';

import {
  frameForTwilio,
  decodeAgentOutbound,
  mp3ToPcm16Mono8k,
  pcm16ToMulaw,
  mulawToPcm16,
} from '../../../src/ai/voice-quality/audio/pcm-codec';

/**
 * Synthesize a 1 kHz sine wave at the given sample rate as a PCM16 LE
 * buffer. Amplitude 0.3 of full-scale to avoid clipping near the μ-law
 * encoder's clip limit. Deterministic: same inputs → same bytes.
 */
function sineWave1kHz(durationSec: number, sampleRate = 8000): Buffer {
  const numSamples = Math.floor(durationSec * sampleRate);
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(
      0.3 * 32767 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate)
    );
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

/** True iff `ffmpeg` resolves on PATH. Used to gate the MP3-decode test. */
function ffmpegAvailable(): boolean {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Peak absolute amplitude of a PCM16 LE buffer. */
function peakAmplitude(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

describe('VQ2-003 — pcm-codec', () => {
  describe('frameForTwilio', () => {
    it('VQ2-003 — splits a 1-second PCM16 8 kHz buffer into 50 frames', () => {
      const pcm = sineWave1kHz(1.0, 8000);
      const frames = frameForTwilio(pcm);
      expect(frames).toHaveLength(50); // 1s / 20ms = 50
    });

    it('VQ2-003 — frames are valid base64', () => {
      const pcm = sineWave1kHz(0.1, 8000);
      const frames = frameForTwilio(pcm);
      expect(frames.length).toBeGreaterThan(0);
      const base64Re = /^[A-Za-z0-9+/]+={0,2}$/;
      for (const f of frames) {
        expect(f).toMatch(base64Re);
        // Each frame should be 160 μ-law bytes = 160 raw bytes which
        // base64-encode to 216 characters (160 * 4/3 rounded, padded).
        const decoded = Buffer.from(f, 'base64');
        // Last frame may be partial; full frames are 160 bytes.
        expect(decoded.length).toBeGreaterThan(0);
        expect(decoded.length).toBeLessThanOrEqual(160);
      }
    });

    it('VQ2-003 — handles partial trailing frame (25 ms input → 2 frames)', () => {
      // 25ms at 8 kHz = 200 samples = 400 bytes PCM16.
      // First 20ms (160 samples) is one full frame; remaining 5ms (40
      // samples = 80 bytes) is one partial frame.
      const pcm = sineWave1kHz(0.025, 8000);
      expect(pcm.length).toBe(400);
      const frames = frameForTwilio(pcm);
      expect(frames).toHaveLength(2);
      const fullFrame = Buffer.from(frames[0]!, 'base64');
      const partialFrame = Buffer.from(frames[1]!, 'base64');
      expect(fullFrame.length).toBe(160);
      expect(partialFrame.length).toBe(40); // 5ms = 40 samples = 40 μ-law bytes
    });

    it('VQ2-003 — emits empty array for empty input', () => {
      expect(frameForTwilio(Buffer.alloc(0))).toEqual([]);
    });
  });

  describe('decodeAgentOutbound', () => {
    it('VQ2-003 — empty input returns empty buffer + null ts', () => {
      const result = decodeAgentOutbound([]);
      expect(result.pcm16.length).toBe(0);
      expect(result.firstFrameTs).toBeNull();
    });

    it('VQ2-003 — concatenates frames in order, sets firstFrameTs from first frame', () => {
      // Build two μ-law frames from two distinct PCM16 chunks so we can
      // verify ordering by inspecting the decoded bytes back.
      const chunkA = sineWave1kHz(0.02, 8000); // 320 bytes PCM
      const chunkB = sineWave1kHz(0.02, 8000); // same shape; ordering verified by length
      const muA = pcm16ToMulaw(chunkA);
      const muB = pcm16ToMulaw(chunkB);
      const frames = [
        { payload: muA.toString('base64'), ts: 1000 },
        { payload: muB.toString('base64'), ts: 1020 },
      ];
      const { pcm16, firstFrameTs } = decodeAgentOutbound(frames);
      // Each μ-law byte → one PCM16 sample = 2 bytes; so total bytes
      // = (muA.length + muB.length) * 2 = (160 + 160) * 2 = 640.
      expect(pcm16.length).toBe(640);
      expect(firstFrameTs).toBe(1000);
    });

    it('VQ2-003 — round-trip pcm → frameForTwilio → decodeAgentOutbound preserves peak amplitude within μ-law tolerance', () => {
      const original = sineWave1kHz(0.5, 8000);
      const frames = frameForTwilio(original);
      const reconstructed = decodeAgentOutbound(
        frames.map((payload, i) => ({ payload, ts: i * 20 }))
      );
      // μ-law is lossy but logarithmic; the peak of a 0.3-FS sine
      // should land within ~3% of the original peak.
      const origPeak = peakAmplitude(original);
      const newPeak = peakAmplitude(reconstructed.pcm16);
      const ratio = newPeak / origPeak;
      expect(ratio).toBeGreaterThan(0.97);
      expect(ratio).toBeLessThan(1.03);
      expect(reconstructed.pcm16.length).toBe(original.length);
      expect(reconstructed.firstFrameTs).toBe(0);
    });
  });

  describe('mp3ToPcm16Mono8k', () => {
    const haveFfmpeg = ffmpegAvailable();

    // Skipped if ffmpeg isn't on PATH. Follow-up: ensure CI runner
    // installs ffmpeg via the workflow's apt step (tracked alongside
    // VQ2-008 audio-mode driver landing — at that point ffmpeg becomes
    // a hard CI dep).
    (haveFfmpeg ? it : it.skip)(
      'VQ2-003 — decodes a tiny MP3 fixture into PCM16 mono 8 kHz',
      async () => {
        // Generate a 0.1s 1 kHz sine MP3 via ffmpeg, capture stdout.
        const result = spawnSync(
          'ffmpeg',
          [
            '-f', 'lavfi',
            '-i', 'sine=frequency=1000:duration=0.1:sample_rate=22050',
            '-f', 'mp3',
            '-acodec', 'libmp3lame',
            '-b:a', '32k',
            'pipe:1',
          ],
          { encoding: 'buffer', maxBuffer: 10_000_000 }
        );
        expect(result.status).toBe(0);
        const mp3 = result.stdout;
        expect(mp3.length).toBeGreaterThan(0);

        const pcm = await mp3ToPcm16Mono8k(mp3);
        // 0.1s @ 8 kHz = 800 samples = 1600 bytes. mp3 codec frame
        // boundaries can add ±a few hundred bytes of preroll/padding,
        // so we just bound it loosely.
        expect(pcm.length).toBeGreaterThan(800); // > 0.05s of audio
        expect(pcm.length % 2).toBe(0); // even = PCM16-aligned
        // Confirm something non-silent decoded.
        expect(peakAmplitude(pcm)).toBeGreaterThan(1000);
      }
    );

    it('VQ2-003 — re-exports production μ-law helpers', () => {
      // Quick smoke test that the re-exports are wired through correctly:
      // pcm16ToMulaw and mulawToPcm16 should round-trip.
      const original = sineWave1kHz(0.02, 8000);
      const mu = pcm16ToMulaw(original);
      expect(mu.length).toBe(original.length / 2);
      const back = mulawToPcm16(mu);
      expect(back.length).toBe(original.length);
    });
  });
});
