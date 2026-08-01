/**
 * Dialect eval — audio degradation (telephony-muffled fixture prep).
 *
 * Bridges public/clean dialogue audio (People's Speech, AMI, your own TTS
 * scripts) into telephony-muffled `DialectEvalCase`s. The recipe is the
 * standard ASR-robustness chain — resample to 8 kHz + μ-law (telephony),
 * low-pass ("muffle"), mix MUSAN-style noise at an SNR, convolve a room
 * impulse response (reverb) — which lets you match YOUR channel exactly while
 * keeping ground-truth transcripts (the thing naturally-muffled internet audio
 * usually lacks).
 *
 * Degradation changes the AUDIO, never the words — so the clean transcript is
 * preserved verbatim as the reference, and the spec's `label` becomes the
 * per-condition grouping key (the report's `dialect` axis doubles as the
 * acoustic-condition axis: per-accent OR per-condition WER).
 *
 * The heavy DSP lives behind the injected `AudioOps` seam (same pattern the
 * runner uses for `transcribe`), so this orchestration is pure + unit-testable
 * without audio libs. A production `AudioOps` (ffmpeg / sox / torchaudio) is
 * the follow-up.
 */
import type { DialectEvalCase } from './dialect-report';

/** A single acoustic degradation step. */
export type DegradationStep =
  | { kind: 'telephony'; sampleRateHz?: number } // resample + μ-law (default 8 kHz)
  | { kind: 'lowpass'; cutoffHz: number } // "muffle"
  | { kind: 'noise'; noiseId: string; snrDb: number } // additive noise (MUSAN) at SNR
  | { kind: 'reverb'; rirId: string }; // convolve a room impulse response

export interface DegradationSpec {
  /** Stable condition label, e.g. 'telephony-muffled-snr8'. Becomes the case grouping key. */
  label: string;
  steps: DegradationStep[];
}

/**
 * Injected DSP primitives — the heavy audio work lives behind this seam.
 * Each takes the working buffer and returns the transformed buffer.
 */
export interface AudioOps {
  /** Resample to `sampleRateHz` and μ-law encode (G.711 telephony). */
  toTelephony(audio: Buffer, sampleRateHz: number): Promise<Buffer>;
  /** Low-pass filter at `cutoffHz` to "muffle". */
  lowPass(audio: Buffer, cutoffHz: number): Promise<Buffer>;
  /** Additively mix the named noise sample at the target SNR (dB). */
  mixNoise(audio: Buffer, noiseId: string, snrDb: number): Promise<Buffer>;
  /** Convolve with the named room impulse response (reverb). */
  reverb(audio: Buffer, rirId: string): Promise<Buffer>;
}

/** Apply a degradation spec to a clean audio buffer, step by step in order. */
export async function degradeAudio(
  audio: Buffer,
  spec: DegradationSpec,
  ops: AudioOps,
): Promise<Buffer> {
  let current = audio;
  for (const step of spec.steps) {
    switch (step.kind) {
      case 'telephony':
        current = await ops.toTelephony(current, step.sampleRateHz ?? 8000);
        break;
      case 'lowpass':
        current = await ops.lowPass(current, step.cutoffHz);
        break;
      case 'noise':
        current = await ops.mixNoise(current, step.noiseId, step.snrDb);
        break;
      case 'reverb':
        current = await ops.reverb(current, step.rirId);
        break;
    }
  }
  return current;
}

export interface CleanAudioSource {
  /** Stable id for the source utterance. */
  id: string;
  /** Clean audio buffer (the source dataset / TTS render). */
  audio: Buffer;
  /** Ground-truth transcript — preserved verbatim (degradation can't change the words). */
  transcript: string;
  /** Optional true intent. */
  expectedIntent?: string;
}

export interface MuffledFixtureResult {
  fixture: DialectEvalCase;
  /** The degraded audio to persist at `fixture.audioFixture`. */
  audio: Buffer;
}

/** Default fixture audio key: `dialect-fixtures/<label>/<sourceId>.ulaw`. */
export function defaultAudioKey(sourceId: string, label: string): string {
  return `dialect-fixtures/${label}/${sourceId}.ulaw`;
}

/**
 * Produce a degraded `DialectEvalCase` (+ the degraded audio buffer to persist)
 * from a clean source + a degradation spec. The transcript is the unchanged
 * reference; `spec.label` is the per-condition grouping key; the case id is
 * `<sourceId>__<label>` so the same utterance under multiple conditions stays
 * distinct.
 */
export async function buildMuffledFixture(
  source: CleanAudioSource,
  spec: DegradationSpec,
  ops: AudioOps,
  audioKey: (sourceId: string, label: string) => string = defaultAudioKey,
): Promise<MuffledFixtureResult> {
  const audio = await degradeAudio(source.audio, spec, ops);
  const fixture: DialectEvalCase = {
    id: `${source.id}__${spec.label}`,
    dialect: spec.label,
    referenceTranscript: source.transcript,
    audioFixture: audioKey(source.id, spec.label),
    ...(source.expectedIntent !== undefined ? { expectedIntent: source.expectedIntent } : {}),
  };
  return { fixture, audio };
}

// ─── Preset conditions ─────────────────────────────────────────────────────────

/** Plain telephony band + a muffle low-pass (1.8 kHz ≈ a hand over the phone). */
export const TELEPHONY_MUFFLED: DegradationSpec = {
  label: 'telephony-muffled',
  steps: [
    { kind: 'telephony', sampleRateHz: 8000 },
    { kind: 'lowpass', cutoffHz: 1800 },
  ],
};

/** Telephony band + additive noise at the given SNR (default MUSAN). */
export function noisyTelephony(snrDb: number, noiseId = 'musan'): DegradationSpec {
  return {
    label: `telephony-noisy-snr${snrDb}`,
    steps: [
      { kind: 'telephony', sampleRateHz: 8000 },
      { kind: 'noise', noiseId, snrDb },
    ],
  };
}

/** Telephony band + room reverb (convolve a named RIR). */
export function reverbTelephony(rirId: string): DegradationSpec {
  return {
    label: `telephony-reverb-${rirId}`,
    steps: [
      { kind: 'telephony', sampleRateHz: 8000 },
      { kind: 'reverb', rirId },
    ],
  };
}
