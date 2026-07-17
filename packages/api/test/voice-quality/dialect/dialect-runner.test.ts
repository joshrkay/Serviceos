import { describe, it, expect, vi } from 'vitest';
import {
  runDialectEval,
  runMultiSurfaceDialectEval,
  makeWhisperDialectTranscriber,
  makeDeepgramDialectTranscriber,
  resolveDeepgramApiKey,
  type DialectTranscriber,
  type DialectAgentEvaluator,
  type DialectRunDeps,
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

// A4 — Deepgram (streaming) transcriber path + the SURFACE dimension.

describe('makeDeepgramDialectTranscriber', () => {
  it('loads the fixture and transcribes the buffer, keyed by case id (mocked engine, no network)', async () => {
    const transcribeBuffer = vi.fn(async (_audio: Buffer, _caseId: string) => 'hello world');
    const loadAudio = vi.fn(async (key: string) => Buffer.from(`audio:${key}`));
    const transcriber = makeDeepgramDialectTranscriber({ transcribeBuffer }, loadAudio);

    const text = await transcriber(caseOf('c1', 'southern-us', 'hello world', { audioFixture: 'x.wav' }));

    expect(text).toBe('hello world');
    expect(loadAudio).toHaveBeenCalledWith('x.wav');
    expect(transcribeBuffer).toHaveBeenCalledWith(Buffer.from('audio:x.wav'), 'c1');
  });

  it('throws when a case has no audioFixture', async () => {
    const transcriber = makeDeepgramDialectTranscriber(
      { transcribeBuffer: async () => 'x' },
      async () => Buffer.alloc(0),
    );
    await expect(transcriber(caseOf('c2', 'southern-us', 'ref'))).rejects.toThrow(
      /no audioFixture/,
    );
  });
});

describe('resolveDeepgramApiKey', () => {
  it('returns null when unset or blank (offline-safe default — no credential required to run the harness)', () => {
    expect(resolveDeepgramApiKey({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveDeepgramApiKey({ DEEPGRAM_API_KEY: '   ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns the trimmed key when present', () => {
    expect(resolveDeepgramApiKey({ DEEPGRAM_API_KEY: '  sk-dg-abc  ' } as NodeJS.ProcessEnv)).toBe(
      'sk-dg-abc',
    );
  });
});

describe('runDialectEval — surface stamping (options.surface)', () => {
  it('stamps every result with the given surface label', async () => {
    const transcribe: DialectTranscriber = async (c) => HYP[c.id];
    const { results } = await runDialectEval(CASES, { transcribe }, { surface: 'deepgram' });
    expect(results.every((r) => r.surface === 'deepgram')).toBe(true);
  });

  it('leaves surface undefined when omitted (existing Whisper-only callers unaffected)', async () => {
    const transcribe: DialectTranscriber = async (c) => HYP[c.id];
    const { results } = await runDialectEval(CASES, { transcribe });
    expect(results.every((r) => r.surface === undefined)).toBe(true);
  });
});

describe('runMultiSurfaceDialectEval', () => {
  // Deepgram hypotheses: 'a' perfect, 'b' one substitution, 'c' perfect —
  // deliberately different error pattern than Whisper's HYP so the two
  // surfaces produce distinguishable per-surface WER.
  const DEEPGRAM_HYP: Record<string, string> = {
    a: 'i would like to schedule an appointment',
    b: 'what is my balence',
    c: 'i need to reschedule',
  };

  function surfaceDeps(hyp: Record<string, string>): DialectRunDeps {
    return { transcribe: async (c) => hyp[c.id] };
  }

  it('grades each engine and attributes results to the right surface (mocked engines, no live spend)', async () => {
    const outcome = await runMultiSurfaceDialectEval(CASES, {
      whisper: surfaceDeps(HYP),
      deepgram: surfaceDeps(DEEPGRAM_HYP),
    });

    expect(Object.keys(outcome.bySurface).sort()).toEqual(['deepgram', 'whisper']);
    expect(outcome.combinedResults).toHaveLength(6); // 3 cases x 2 surfaces
    expect(outcome.combinedResults.filter((r) => r.surface === 'whisper')).toHaveLength(3);
    expect(outcome.combinedResults.filter((r) => r.surface === 'deepgram')).toHaveLength(3);

    // Whisper's case 'a' has a substitution (scedool), Deepgram's is perfect —
    // pin the exact WER math per surface, not just presence.
    const whisperA = outcome.combinedResults.find((r) => r.surface === 'whisper' && r.caseId === 'a')!;
    const deepgramA = outcome.combinedResults.find((r) => r.surface === 'deepgram' && r.caseId === 'a')!;
    expect(whisperA.wer.wer).toBeCloseTo(1 / 7);
    expect(deepgramA.wer.wer).toBe(0);

    // Deepgram's case 'b' has a substitution (balence), Whisper's is perfect.
    const whisperB = outcome.combinedResults.find((r) => r.surface === 'whisper' && r.caseId === 'b')!;
    const deepgramB = outcome.combinedResults.find((r) => r.surface === 'deepgram' && r.caseId === 'b')!;
    expect(whisperB.wer.wer).toBe(0);
    expect(deepgramB.wer.wer).toBeCloseTo(1 / 4); // ref 'what is my balance' — 4 words, 1 substitution
  });

  it('rolls the combined results up per surface (buildSurfaceRollup via the runner)', async () => {
    const outcome = await runMultiSurfaceDialectEval(CASES, {
      whisper: surfaceDeps(HYP),
      deepgram: surfaceDeps(DEEPGRAM_HYP),
    });

    expect(outcome.surfaceRollup.map((s) => s.surface)).toEqual(['deepgram', 'whisper']); // sorted
    const whisperStat = outcome.surfaceRollup.find((s) => s.surface === 'whisper')!;
    const deepgramStat = outcome.surfaceRollup.find((s) => s.surface === 'deepgram')!;
    expect(whisperStat.cases).toBe(3);
    expect(deepgramStat.cases).toBe(3);
    // Whisper: WERs [1/7, 0, 0] over 3 cases; Deepgram: [0, 1/4, 0].
    expect(whisperStat.meanWer).toBeCloseTo((1 / 7 + 0 + 0) / 3);
    expect(deepgramStat.meanWer).toBeCloseTo((0 + 1 / 4 + 0) / 3);
  });

  it('keeps each surface\'s own per-dialect gate intact in bySurface (no cross-surface averaging of pass/fail)', async () => {
    const outcome = await runMultiSurfaceDialectEval(CASES, {
      whisper: surfaceDeps(HYP),
      deepgram: surfaceDeps(DEEPGRAM_HYP),
    });
    expect(outcome.bySurface.whisper!.report.pass).toBe(true);
    expect(outcome.bySurface.deepgram!.report.pass).toBe(true);
    expect(outcome.bySurface.whisper!.errors).toEqual([]);
    expect(outcome.bySurface.deepgram!.errors).toEqual([]);
  });

  it('empty-reference / perfect-match boundaries hold per surface', async () => {
    const boundaryCases: DialectEvalCase[] = [
      caseOf('empty', 'southern-us', ''), // empty reference
      caseOf('perfect', 'southern-us', 'hello there'),
    ];
    const outcome = await runMultiSurfaceDialectEval(boundaryCases, {
      whisper: { transcribe: async (c) => (c.id === 'empty' ? '' : 'hello there') },
      deepgram: { transcribe: async (c) => (c.id === 'empty' ? 'spurious words' : 'hello there') },
    });

    const whisperEmpty = outcome.combinedResults.find((r) => r.surface === 'whisper' && r.caseId === 'empty')!;
    const deepgramEmpty = outcome.combinedResults.find((r) => r.surface === 'deepgram' && r.caseId === 'empty')!;
    // ref empty + hyp empty → WER 0 (nothing to get wrong).
    expect(whisperEmpty.wer.wer).toBe(0);
    // ref empty + hyp non-empty → WER clamped to 1 (every hyp word is a spurious insertion).
    expect(deepgramEmpty.wer.wer).toBe(1);

    const whisperPerfect = outcome.combinedResults.find((r) => r.surface === 'whisper' && r.caseId === 'perfect')!;
    const deepgramPerfect = outcome.combinedResults.find((r) => r.surface === 'deepgram' && r.caseId === 'perfect')!;
    expect(whisperPerfect.wer.wer).toBe(0);
    expect(deepgramPerfect.wer.wer).toBe(0);
  });
});
