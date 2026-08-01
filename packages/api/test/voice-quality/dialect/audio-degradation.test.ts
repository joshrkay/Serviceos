import { describe, it, expect } from 'vitest';
import {
  degradeAudio,
  buildMuffledFixture,
  defaultAudioKey,
  TELEPHONY_MUFFLED,
  noisyTelephony,
  reverbTelephony,
  type AudioOps,
  type DegradationSpec,
} from '../../../src/ai/voice-quality/dialect/audio-degradation';

/**
 * Recording AudioOps: tags the buffer per step so we can assert (a) order and
 * (b) that each step's output is threaded into the next.
 */
function recordingOps(): { ops: AudioOps; calls: string[] } {
  const calls: string[] = [];
  const tag = (a: Buffer, s: string) => Buffer.concat([a, Buffer.from(`|${s}`)]);
  const ops: AudioOps = {
    async toTelephony(a, sr) {
      calls.push(`telephony:${sr}`);
      return tag(a, `t${sr}`);
    },
    async lowPass(a, c) {
      calls.push(`lowpass:${c}`);
      return tag(a, `lp${c}`);
    },
    async mixNoise(a, n, snr) {
      calls.push(`noise:${n}:${snr}`);
      return tag(a, `n${n}${snr}`);
    },
    async reverb(a, r) {
      calls.push(`reverb:${r}`);
      return tag(a, `rv${r}`);
    },
  };
  return { ops, calls };
}

describe('degradeAudio', () => {
  it('applies steps in order and threads each output into the next', async () => {
    const { ops, calls } = recordingOps();
    const out = await degradeAudio(Buffer.from('AUDIO'), TELEPHONY_MUFFLED, ops);

    expect(calls).toEqual(['telephony:8000', 'lowpass:1800']);
    expect(out.toString()).toBe('AUDIO|t8000|lp1800'); // proves threading + order
  });

  it('handles noise + reverb steps', async () => {
    const { ops, calls } = recordingOps();
    const spec: DegradationSpec = {
      label: 'combo',
      steps: [
        { kind: 'telephony' }, // default 8 kHz
        { kind: 'noise', noiseId: 'musan', snrDb: 5 },
        { kind: 'reverb', rirId: 'room2' },
      ],
    };
    await degradeAudio(Buffer.from('X'), spec, ops);
    expect(calls).toEqual(['telephony:8000', 'noise:musan:5', 'reverb:room2']);
  });

  it('empty step list returns the input unchanged', async () => {
    const { ops } = recordingOps();
    const out = await degradeAudio(Buffer.from('CLEAN'), { label: 'noop', steps: [] }, ops);
    expect(out.toString()).toBe('CLEAN');
  });
});

describe('buildMuffledFixture', () => {
  it('preserves the transcript, labels by condition, and returns degraded audio', async () => {
    const { ops } = recordingOps();
    const { fixture, audio } = await buildMuffledFixture(
      {
        id: 'src1',
        audio: Buffer.from('AUDIO'),
        transcript: 'i would like to schedule an appointment',
        expectedIntent: 'create_appointment',
      },
      TELEPHONY_MUFFLED,
      ops,
    );

    expect(fixture.id).toBe('src1__telephony-muffled');
    expect(fixture.dialect).toBe('telephony-muffled'); // condition is the grouping axis
    expect(fixture.referenceTranscript).toBe('i would like to schedule an appointment'); // unchanged
    expect(fixture.expectedIntent).toBe('create_appointment');
    expect(fixture.audioFixture).toBe('dialect-fixtures/telephony-muffled/src1.ulaw');
    expect(audio.toString()).toBe('AUDIO|t8000|lp1800');
  });

  it('omits expectedIntent when the source has none, and honors a custom audio key', async () => {
    const { ops } = recordingOps();
    const { fixture } = await buildMuffledFixture(
      { id: 'src2', audio: Buffer.from('A'), transcript: 'what is my balance' },
      noisyTelephony(10),
      ops,
      (id, label) => `s3://fixtures/${label}/${id}.wav`,
    );
    expect('expectedIntent' in fixture).toBe(false);
    expect(fixture.dialect).toBe('telephony-noisy-snr10');
    expect(fixture.audioFixture).toBe('s3://fixtures/telephony-noisy-snr10/src2.wav');
  });
});

describe('preset specs', () => {
  it('noisyTelephony / reverbTelephony build labeled telephony chains', () => {
    expect(noisyTelephony(8).steps).toEqual([
      { kind: 'telephony', sampleRateHz: 8000 },
      { kind: 'noise', noiseId: 'musan', snrDb: 8 },
    ]);
    expect(reverbTelephony('hallway').label).toBe('telephony-reverb-hallway');
  });

  it('defaultAudioKey shape', () => {
    expect(defaultAudioKey('abc', 'telephony-muffled')).toBe(
      'dialect-fixtures/telephony-muffled/abc.ulaw',
    );
  });
});
