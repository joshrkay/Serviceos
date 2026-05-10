/**
 * VQ2-003 — PCM/μ-law codec helpers for the Layer 2 audio test harness.
 *
 * This module is the Layer 2 face of the production μ-law codec at
 * `packages/api/src/telephony/media-streams/mulaw-codec.ts`. It re-exports
 * every helper Layer 2 needs (so downstream files import from a single
 * voice-quality-local path, never reach across into telephony) and adds
 * three test-harness-specific helpers the production codec does not need:
 *
 *   1. {@link mp3ToPcm16Mono8k} — decode the MP3 bytes returned by
 *      `OpenAiTtsProvider` into the raw PCM16 mono 8 kHz Twilio expects.
 *      VQ2-002's TtsFixtureCache stores whatever the provider produced;
 *      the production provider hard-codes `response_format: 'mp3'` so the
 *      cache holds MP3 bytes despite the `.wav` filename suffix.
 *
 *   2. {@link frameForTwilio} — split a PCM16 8 kHz buffer into 20 ms
 *      μ-law base64 chunks suitable for Twilio Media Streams `media`
 *      events. The Layer 2 emulator paces these at 20 ms intervals to
 *      mirror real phone delivery so TTFA measurement is wall-clock honest.
 *
 *   3. {@link decodeAgentOutbound} — concatenate inbound base64 μ-law
 *      frames (the audio the agent emits *back* to the caller) into one
 *      PCM16 buffer, plus capture the wall-clock timestamp of the first
 *      frame, which is the TTFA stop-time per VQ2-004's audio-timings.
 *
 * # ffmpeg dependency
 *
 * {@link mp3ToPcm16Mono8k} shells out to `ffmpeg` via `child_process` —
 * we don't pull in a JS-only MP3 decoder because (a) every realistic
 * dev/CI environment already has ffmpeg installed and (b) ffmpeg's
 * format detection is bulletproof (sniffs MP3 vs WAV vs OGG so this
 * helper survives a future provider switch). If ffmpeg is missing,
 * the helper throws with an apt-get / brew install hint. Layer 2 CI
 * (`voice-quality-pre-deploy.yml`) installs ffmpeg explicitly. Locally,
 * developers without ffmpeg see the test for this helper SKIPPED rather
 * than fail.
 */

// ─── Re-exports from the production μ-law codec ──────────────────────────────
//
// Layer 2 stays composable with prod μ-law handling: any future tweak
// to the production codec (e.g. a switch to a different upsampler) is
// inherited automatically. Test code imports from here, never from the
// telephony tree.
export {
  mulawToPcm16,
  pcm16ToMulaw,
  upsample8to16,
  downsample16to8,
  decodeTwilioInboundFrame,
  encodeTwilioOutboundFrame,
} from '../../../telephony/media-streams/mulaw-codec';

import {
  mulawToPcm16,
  pcm16ToMulaw,
} from '../../../telephony/media-streams/mulaw-codec';

// ─── Constants ───────────────────────────────────────────────────────────────

/** 20 ms × 8 kHz = 160 PCM16 samples per Twilio Media Streams frame. */
const SAMPLES_PER_FRAME = 160;
/** PCM16 LE = 2 bytes per sample. */
const BYTES_PER_SAMPLE = 2;
/** PCM bytes per 20 ms frame: 160 * 2 = 320. */
const FRAME_BYTES = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE;

// ─── MP3 → PCM16 mono 8 kHz ──────────────────────────────────────────────────

/**
 * Decode MP3 bytes (as returned by `OpenAiTtsProvider`) into PCM16 LE
 * mono 8 kHz. This is the single bottleneck where Layer 2 turns the
 * cached caller-utterance audio into the format Twilio Media Streams
 * speaks. The output buffer is then framed via {@link frameForTwilio}
 * for delivery to the agent under test.
 *
 * Implementation: shell out to `ffmpeg` with the canonical decode flags.
 * Stdin = MP3 bytes; stdout = raw PCM16 LE bytes. We use raw PCM (not
 * a WAV envelope) because we don't need the header — the call path
 * already knows the rate and channel count.
 *
 * Throws with an apt install hint if ffmpeg isn't on PATH, so a
 * developer running Layer 2 locally for the first time gets a
 * one-line fix rather than an obscure ENOENT.
 */
export async function mp3ToPcm16Mono8k(mp3: Buffer): Promise<Buffer> {
  return spawnFfmpegConvert(mp3, [
    '-i', 'pipe:0',
    '-f', 's16le',           // raw PCM16 little-endian
    '-acodec', 'pcm_s16le',
    '-ac', '1',              // mono
    '-ar', '8000',           // 8 kHz
    'pipe:1',
  ]);
}

// ─── Twilio frame slicing ────────────────────────────────────────────────────

/**
 * Split a PCM16 mono 8 kHz buffer into 20 ms μ-law base64 frames.
 *
 * Each frame is 160 PCM samples (320 bytes), which converts to 160
 * μ-law bytes. Returned in chronological order. The caller (the
 * Twilio stream emulator) paces them at 20 ms intervals via
 * `setTimeout` so STT and TTFA measurement see realistic delivery.
 *
 * A trailing partial frame (e.g. when input length isn't a clean
 * multiple of 320 bytes) is emitted as-is; Twilio tolerates short
 * frames, and dropping them would shorten the caller utterance by
 * up to 19 ms — enough to confuse Whisper at the tail of a phrase.
 */
export function frameForTwilio(pcm16: Buffer): string[] {
  const frames: string[] = [];
  for (let offset = 0; offset < pcm16.length; offset += FRAME_BYTES) {
    const slice = pcm16.subarray(offset, offset + FRAME_BYTES);
    if (slice.length === 0) break;
    const mulaw = pcm16ToMulaw(slice);
    frames.push(mulaw.toString('base64'));
  }
  return frames;
}

// ─── Inbound (agent → caller) frame collection ───────────────────────────────

/**
 * Captured outbound frame as recorded by the Layer 2 emulator off the
 * Twilio Media Streams socket. Each frame carries the wall-clock
 * timestamp the emulator stamped at receive time so VQ2-004's audio
 * timings module can compute TTFA = `firstFrameTs - tCallerSilence`.
 */
export interface OutboundFrame {
  /** Base64-encoded μ-law payload (160 bytes per 20 ms in the steady state). */
  payload: string;
  /** Receive timestamp from the emulator, monotonic ms (`performance.now()`). */
  ts: number;
}

/**
 * Concatenate the agent's outbound base64 μ-law frames into one
 * PCM16 LE 8 kHz buffer suitable for grading (e.g. running it back
 * through Whisper to compare what the caller "heard" vs. what the
 * agent meant to say). Also reports the timestamp of the first
 * frame, which is the TTFA stop-time. Empty input → empty buffer
 * + null ts.
 */
export function decodeAgentOutbound(
  frames: ReadonlyArray<OutboundFrame>,
): { pcm16: Buffer; firstFrameTs: number | null } {
  if (frames.length === 0) {
    return { pcm16: Buffer.alloc(0), firstFrameTs: null };
  }
  const pcmParts: Buffer[] = [];
  for (const frame of frames) {
    const mulaw = Buffer.from(frame.payload, 'base64');
    pcmParts.push(mulawToPcm16(mulaw));
  }
  return {
    pcm16: Buffer.concat(pcmParts),
    firstFrameTs: frames[0]!.ts,
  };
}

// ─── Internal: ffmpeg shell-out ──────────────────────────────────────────────

/**
 * Spawn ffmpeg with the given args, piping `input` to stdin and
 * collecting stdout into a Buffer. Captures stderr so a non-zero exit
 * surfaces ffmpeg's diagnostic message rather than a bare exit code.
 *
 * The dynamic `import('child_process')` matches the rest of the
 * voice-quality module's lazy-loading pattern (so the codec module
 * imports cheaply at module-init time and only pays for child_process
 * when we actually decode MP3).
 */
async function spawnFfmpegConvert(
  input: Buffer,
  args: string[],
): Promise<Buffer> {
  const { spawn } = await import('child_process');
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    proc.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(
          'ffmpeg not found on PATH. Install ffmpeg ' +
          '(apt-get install ffmpeg, or brew install ffmpeg).'
        ));
      } else {
        reject(err);
      }
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(
          `ffmpeg exited ${code}: ${Buffer.concat(stderrChunks).toString('utf-8')}`
        ));
      }
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}
