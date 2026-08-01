import { describe, it, expect } from 'vitest';
import {
  scoreDialectCase,
  buildDialectReport,
  buildSurfaceRollup,
  DEFAULT_DIALECT_THRESHOLDS,
  type DialectEvalCase,
  type DialectEvalResult,
} from '../../../src/ai/voice-quality/dialect/dialect-report';

function caseOf(partial: Partial<DialectEvalCase> = {}): DialectEvalCase {
  return {
    id: partial.id ?? 'c1',
    dialect: partial.dialect ?? 'southern-us',
    referenceTranscript: partial.referenceTranscript ?? 'i would like to schedule an appointment',
    ...(partial.expectedIntent !== undefined ? { expectedIntent: partial.expectedIntent } : {}),
    ...(partial.audioFixture !== undefined ? { audioFixture: partial.audioFixture } : {}),
  };
}

describe('dialect report — scoreDialectCase', () => {
  it('computes WER + matched intent + clarified passthrough', () => {
    const r = scoreDialectCase(
      caseOf({ expectedIntent: 'create_appointment' }),
      {
        transcript: 'i would like to schedule an appointment',
        actedIntent: 'create_appointment',
        clarified: false,
      },
    );
    expect(r.wer.wer).toBe(0);
    expect(r.intentMatched).toBe(true);
    expect(r.clarified).toBe(false);
  });

  it('flags an intent miss and surfaces a non-zero WER', () => {
    const r = scoreDialectCase(
      caseOf({ expectedIntent: 'create_appointment' }),
      { transcript: 'i would like to scedool an appointment', actedIntent: 'lookup_appointments', clarified: true },
    );
    expect(r.intentMatched).toBe(false);
    expect(r.clarified).toBe(true);
    expect(r.wer.wer).toBeGreaterThan(0);
  });

  it('intentMatched is null when the case declares no expected intent (ASR-only)', () => {
    const r = scoreDialectCase(caseOf(), {
      transcript: 'i would like to schedule an appointment',
      clarified: false,
    });
    expect(r.intentMatched).toBeNull();
  });
});

describe('dialect report — buildDialectReport', () => {
  const result = (
    dialect: string,
    wer: number,
    intentMatched: boolean | null,
    clarified = false,
  ): DialectEvalResult => ({
    caseId: `${dialect}-${wer}`,
    dialect,
    wer: { wer, substitutions: 0, deletions: 0, insertions: 0, hits: 0, referenceWords: 10 },
    intentMatched,
    clarified,
  });

  it('aggregates per dialect: mean/median WER, intent accuracy, clarification rate', () => {
    const report = buildDialectReport([
      result('southern-us', 0.05, true, true),
      result('southern-us', 0.1, false, false),
      result('indian-english', 0.2, true, true),
    ]);

    expect(report.totalCases).toBe(3);
    // Sorted alphabetically: indian-english before southern-us.
    expect(report.perDialect.map((d) => d.dialect)).toEqual(['indian-english', 'southern-us']);

    const southern = report.perDialect.find((d) => d.dialect === 'southern-us')!;
    expect(southern.cases).toBe(2);
    expect(southern.meanWer).toBeCloseTo(0.075);
    expect(southern.medianWer).toBeCloseTo(0.075);
    expect(southern.intentAccuracy).toBeCloseTo(0.5); // 1 of 2 matched
    expect(southern.clarificationRate).toBeCloseTo(0.5);
  });

  it('intentAccuracy is null for a dialect with no intent-bearing cases', () => {
    const report = buildDialectReport([result('aave', 0.05, null), result('aave', 0.08, null)]);
    expect(report.perDialect[0].intentAccuracy).toBeNull();
    expect(report.pass).toBe(true); // no intent gate can fire without intent cases
  });

  it('blocks a dialect whose mean WER exceeds the threshold', () => {
    const report = buildDialectReport([result('heavy-accent', 0.3, true)]);
    expect(report.pass).toBe(false);
    expect(report.blockers.join(' ')).toMatch(/heavy-accent.*WER 30\.0%/);
  });

  it('blocks a dialect whose intent accuracy is below the threshold', () => {
    const report = buildDialectReport([
      result('southern-us', 0.05, true),
      result('southern-us', 0.05, false), // 50% intent accuracy < 90%
    ]);
    expect(report.pass).toBe(false);
    expect(report.blockers.join(' ')).toMatch(/southern-us.*intent accuracy 50\.0%/);
  });

  it('passes cleanly when every dialect is under threshold', () => {
    const report = buildDialectReport([
      result('southern-us', 0.05, true),
      result('indian-english', 0.12, true),
    ]);
    expect(report.pass).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.overallMeanWer).toBeCloseTo((0.05 + 0.12) / 2);
  });

  it('empty input → zeroed report, passes vacuously', () => {
    const report = buildDialectReport([]);
    expect(report).toMatchObject({ totalCases: 0, overallMeanWer: 0, perDialect: [], pass: true });
    expect(report.thresholds).toEqual(DEFAULT_DIALECT_THRESHOLDS);
  });
});

// A4 — per-surface rollup (whisper vs deepgram), independent of the
// per-dialect axis above: the same result set groups differently by
// `surface` than by `dialect`.
describe('dialect report — buildSurfaceRollup', () => {
  const surfaceResult = (
    surface: string | undefined,
    wer: number,
    intentMatched: boolean | null = null,
    clarified = false,
  ): DialectEvalResult => ({
    caseId: `${surface ?? 'none'}-${wer}`,
    dialect: 'southern-us',
    ...(surface !== undefined ? { surface } : {}),
    wer: { wer, substitutions: 0, deletions: 0, insertions: 0, hits: 0, referenceWords: 10 },
    intentMatched,
    clarified,
  });

  it('aggregates per surface: mean/median WER, intent accuracy, clarification rate', () => {
    const rollup = buildSurfaceRollup([
      surfaceResult('whisper', 0.1, true, true),
      surfaceResult('whisper', 0.2, false, false),
      surfaceResult('deepgram', 0.05, true, true),
    ]);

    expect(rollup.map((s) => s.surface)).toEqual(['deepgram', 'whisper']); // sorted

    const whisper = rollup.find((s) => s.surface === 'whisper')!;
    expect(whisper.cases).toBe(2);
    expect(whisper.meanWer).toBeCloseTo(0.15);
    expect(whisper.medianWer).toBeCloseTo(0.15);
    expect(whisper.intentAccuracy).toBeCloseTo(0.5);
    expect(whisper.clarificationRate).toBeCloseTo(0.5);

    const deepgram = rollup.find((s) => s.surface === 'deepgram')!;
    expect(deepgram.cases).toBe(1);
    expect(deepgram.meanWer).toBeCloseTo(0.05);
    expect(deepgram.intentAccuracy).toBe(1);
  });

  it('groups results with no surface under "unknown" (never silently drops rows)', () => {
    const rollup = buildSurfaceRollup([surfaceResult(undefined, 0.1), surfaceResult('whisper', 0.2)]);
    expect(rollup.map((s) => s.surface).sort()).toEqual(['unknown', 'whisper']);
    expect(rollup.find((s) => s.surface === 'unknown')!.cases).toBe(1);
  });

  it('intentAccuracy is null for a surface with no intent-bearing cases', () => {
    const rollup = buildSurfaceRollup([surfaceResult('deepgram', 0.05, null), surfaceResult('deepgram', 0.08, null)]);
    expect(rollup[0].intentAccuracy).toBeNull();
  });

  it('empty input → empty rollup', () => {
    expect(buildSurfaceRollup([])).toEqual([]);
  });
});
