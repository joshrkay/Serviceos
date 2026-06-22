import { describe, it, expect, vi } from 'vitest';
import {
  runDialectEval,
  makeWhisperDialectTranscriber,
  type DialectTranscriber,
  type DialectAgentEvaluator,
} from '../../../src/ai/voice-quality/dialect/dialect-runner';
import type { DialectEvalCase } from '../../../src/ai/voice-quality/dialect/dialect-report';

function caseOf(
  id: string,
  dialect: string,
  referenceTranscript: string,
  extra: { expectedIntent?: string; audioFixture?: string } = {},
): DialectEvalCase {
  return {
    id,
    dialect,
    referenceTranscript,
    ...(extra.expectedIntent !== undefined ? { expectedIntent: extra.expectedIntent } : {}),
    ...(extra.audioFixture !== undefined ? { audioFixture: extra.audioFixture } : {}),
  };
}

const CASES: DialectEvalCase[] = [
  caseOf('a', 'southern-us', 'i would like to schedule an appointment', {
    expectedIntent: 'create_appointment',
  }),
  caseOf('b', 'southern-us', 'what is my balance', { expectedIntent: 'lookup_balance' }),
  caseOf('c', 'indian-english', 'i need to reschedule', {
    expectedIntent: 'reschedule_appointment',
  }),
];

// Canned ASR hypotheses: 'a' has one substitution (scedool), 'b'/'c' perfect.
const HYP: Record<string, string> = {
  a: 'i would like to scedool an appointment',
  b: 'what is my balance',
  c: 'i need to reschedule',
};
const ACTED: Record<string, string> = {
  a: 'create_appointment',
  b: 'lookup_balance',
  c: 'reschedule_appointment',
};

describe('runDialectEval — full mode (ASR + agent)', () => {
  it('transcribes, scores, and aggregates per dialect', async () => {
    const transcribe = vi.fn<Parameters<DialectTranscriber>, ReturnType<DialectTranscriber>>(
      async (c) => HYP[c.id],
    );
    const evaluateAgent: DialectAgentEvaluator = async (c) => ({
      actedIntent: ACTED[c.id],
      clarified: c.id === 'a', // only the accented case clarified
    });

    const { report, results, errors } = await runDialectEval(CASES, { transcribe, evaluateAgent });

    expect(errors).toEqual([]);
    expect(results).toHaveLength(3);
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(report.totalCases).toBe(3);

    const southern = report.perDialect.find((d) => d.dialect === 'southern-us')!;
    expect(southern.cases).toBe(2);
    expect(southern.meanWer).toBeCloseTo((1 / 7 + 0) / 2); // 'a' WER 1/7, 'b' 0
    expect(southern.intentAccuracy).toBe(1); // both matched
    expect(southern.clarificationRate).toBeCloseTo(0.5); // only 'a' clarified

    expect(report.pass).toBe(true);
  });
});

describe('runDialectEval — ASR-only mode (no agent)', () => {
  it('scores WER per dialect and leaves intent unevaluated (null)', async () => {
    const transcribe: DialectTranscriber = async (c) => HYP[c.id];
    const { report, results } = await runDialectEval(CASES, { transcribe });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.intentMatched === null)).toBe(true);
    expect(results.every((r) => r.clarified === false)).toBe(true);

    const southern = report.perDialect.find((d) => d.dialect === 'southern-us')!;
    expect(southern.intentAccuracy).toBeNull(); // no intent grading
    expect(southern.meanWer).toBeCloseTo((1 / 7 + 0) / 2);
    expect(report.pass).toBe(true);
  });
});

describe('runDialectEval — error handling', () => {
  it('captures a per-case transcription failure and keeps going (default)', async () => {
    const transcribe: DialectTranscriber = async (c) => {
      if (c.id === 'b') throw new Error('whisper 503');
      return HYP[c.id];
    };
    const { report, results, errors } = await runDialectEval(CASES, { transcribe });

    expect(results.map((r) => r.caseId).sort()).toEqual(['a', 'c']);
    expect(errors).toEqual([{ caseId: 'b', dialect: 'southern-us', error: 'whisper 503' }]);
    // The gate only reflects cases that actually transcribed.
    expect(report.totalCases).toBe(2);
  });

  it('aborts the run when continueOnError is false', async () => {
    const transcribe: DialectTranscriber = async (c) => {
      if (c.id === 'b') throw new Error('whisper 503');
      return HYP[c.id];
    };
    await expect(
      runDialectEval(CASES, { transcribe }, { continueOnError: false, concurrency: 1 }),
    ).rejects.toThrow(/aborted on case b: whisper 503/);
  });

  it('processes every case even at concurrency 1', async () => {
    const transcribe = vi.fn<Parameters<DialectTranscriber>, ReturnType<DialectTranscriber>>(
      async (c) => HYP[c.id],
    );
    const { results } = await runDialectEval(CASES, { transcribe }, { concurrency: 1 });
    expect(results).toHaveLength(3);
    expect(transcribe).toHaveBeenCalledTimes(3);
  });
});

describe('makeWhisperDialectTranscriber', () => {
  it('loads the fixture and transcribes the buffer, keyed by case id', async () => {
    const transcribeBuffer = vi.fn(async (_audio: Buffer, _scriptId: string) => 'hello world');
    const loadAudio = vi.fn(async (key: string) => Buffer.from(`audio:${key}`));
    const transcriber = makeWhisperDialectTranscriber({ transcribeBuffer }, loadAudio);

    const text = await transcriber(caseOf('c1', 'southern-us', 'hello world', { audioFixture: 'x.wav' }));

    expect(text).toBe('hello world');
    expect(loadAudio).toHaveBeenCalledWith('x.wav');
    expect(transcribeBuffer).toHaveBeenCalledWith(Buffer.from('audio:x.wav'), 'c1');
  });

  it('throws when a case has no audioFixture', async () => {
    const transcriber = makeWhisperDialectTranscriber(
      { transcribeBuffer: async () => 'x' },
      async () => Buffer.alloc(0),
    );
    await expect(transcriber(caseOf('c2', 'southern-us', 'ref'))).rejects.toThrow(
      /no audioFixture/,
    );
  });
});
