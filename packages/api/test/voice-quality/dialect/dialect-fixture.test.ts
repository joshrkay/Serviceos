import { describe, it, expect, vi } from 'vitest';
import {
  buildDialectFixtureFromCall,
  buildDialectFixtures,
  scrubForDialect,
  makeScrubbingTranscriber,
  type LabeledDialectCall,
} from '../../../src/ai/voice-quality/dialect/dialect-fixture';
import type { DialectEvalCase } from '../../../src/ai/voice-quality/dialect/dialect-report';
import type { DialectTranscriber } from '../../../src/ai/voice-quality/dialect/dialect-runner';

function call(partial: Partial<LabeledDialectCall> = {}): LabeledDialectCall {
  return {
    id: partial.id ?? 'rec_1',
    dialect: partial.dialect ?? 'southern-us',
    correctedTranscript: partial.correctedTranscript ?? 'i would like to schedule an appointment',
    audioFixture: partial.audioFixture ?? 'recordings/rec_1.wav',
    ...(partial.expectedIntent !== undefined ? { expectedIntent: partial.expectedIntent } : {}),
    ...(partial.knownEntities !== undefined ? { knownEntities: partial.knownEntities } : {}),
  };
}

describe('buildDialectFixtureFromCall', () => {
  it('scrubs PII out of the reference and emits a DialectEvalCase', () => {
    const { fixture, redactions, hasResidualPii } = buildDialectFixtureFromCall(
      call({
        id: 'rec_42',
        dialect: 'indian-english',
        expectedIntent: 'create_appointment',
        correctedTranscript: 'hi this is Jane Smith call me at 415-555-0123 to book',
        knownEntities: { names: ['Jane Smith'] },
      }),
    );

    expect(fixture.id).toBe('rec_42');
    expect(fixture.dialect).toBe('indian-english');
    expect(fixture.expectedIntent).toBe('create_appointment');
    expect(fixture.audioFixture).toBe('recordings/rec_1.wav');
    // The name (known entity) and the phone (regex) are gone from the reference.
    expect(fixture.referenceTranscript).toContain('[CALLER_NAME]');
    expect(fixture.referenceTranscript).toContain('[PHONE]');
    expect(fixture.referenceTranscript).not.toMatch(/jane smith/i);
    expect(fixture.referenceTranscript).not.toContain('415-555-0123');
    expect(redactions.length).toBeGreaterThanOrEqual(2);
    expect(hasResidualPii).toBe(false);
  });

  it('omits expectedIntent for ASR-only cases', () => {
    const { fixture } = buildDialectFixtureFromCall(call());
    expect('expectedIntent' in fixture).toBe(false);
  });

  it('rejects (throws) when residual PII survives the scrub (default)', () => {
    // A bare long digit run is not phone-shaped, so the regex sweep misses it
    // and the residual gate trips (digit_run_ge_7).
    expect(() =>
      buildDialectFixtureFromCall(call({ id: 'rec_9', correctedTranscript: 'my account is 12345678' })),
    ).toThrow(/rec_9 still has PII.*digit_run_ge_7/);
  });

  it('returns the residual signal instead of throwing when rejectOnResidualPii is false', () => {
    const r = buildDialectFixtureFromCall(
      call({ correctedTranscript: 'my account is 12345678' }),
      { rejectOnResidualPii: false },
    );
    expect(r.hasResidualPii).toBe(true);
    expect(r.residualSignals).toContain('digit_run_ge_7');
  });
});

describe('buildDialectFixtures (batch)', () => {
  it('keeps clean fixtures and quarantines residual-PII calls instead of throwing', () => {
    const { fixtures, skipped } = buildDialectFixtures([
      call({ id: 'clean_1', correctedTranscript: 'what is my balance' }),
      call({ id: 'dirty_1', correctedTranscript: 'card ending 12345678' }),
      call({ id: 'clean_2', correctedTranscript: 'i need to reschedule' }),
    ]);

    expect(fixtures.map((f) => f.id)).toEqual(['clean_1', 'clean_2']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].id).toBe('dirty_1');
    expect(skipped[0].residualSignals).toContain('digit_run_ge_7');
  });
});

describe('scrubForDialect', () => {
  it('returns the scrubbed string with known + regex PII removed', () => {
    const out = scrubForDialect('email me at jane@example.com or call 415-555-0123', {});
    expect(out).toContain('[EMAIL]');
    expect(out).toContain('[PHONE]');
    expect(out).not.toContain('jane@example.com');
  });
});

describe('makeScrubbingTranscriber', () => {
  it('scrubs the inner transcriber output with the per-case entities (symmetric WER)', async () => {
    const inner: DialectTranscriber = vi.fn(async () => 'hi i am Jane Smith call 415-555-0123');
    const entities = new Map<string, { names: string[] }>([['rec_1', { names: ['Jane Smith'] }]]);
    const transcriber = makeScrubbingTranscriber(inner, (c) => entities.get(c.id));

    const evalCase: DialectEvalCase = {
      id: 'rec_1',
      dialect: 'southern-us',
      referenceTranscript: 'hi i am [CALLER_NAME] call [PHONE]',
    };
    const hyp = await transcriber(evalCase);

    expect(hyp).toContain('[CALLER_NAME]');
    expect(hyp).toContain('[PHONE]');
    expect(hyp).not.toMatch(/jane smith/i);
    expect(inner).toHaveBeenCalledWith(evalCase);
  });
});
