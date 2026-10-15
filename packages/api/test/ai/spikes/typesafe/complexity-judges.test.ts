import { describe, expect, it } from 'vitest';
import {
  baselineComplexityJudge,
  typesafeComplexityJudge,
  COMPLEXITY_QUESTION_ID,
} from '../../../../src/ai/spikes/typesafe/complexity-judges';
import type { SystemOneClient } from '../../../../src/ai/spikes/typesafe/system-one-client';

describe('baselineComplexityJudge', () => {
  it('treats a long message as complex and a short one as simple (word-count rule)', async () => {
    const long = Array.from({ length: 81 }, () => 'word').join(' ');
    expect((await baselineComplexityJudge(long)).positive).toBe(true);
    expect((await baselineComplexityJudge('what is on my schedule today')).positive).toBe(false);
  });

  it('misses a short but hard request — the gap the spike measures', async () => {
    const hard = 'refund the Hendersons but only the labor, not the part, and cancel the follow-up';
    expect((await baselineComplexityJudge(hard)).positive).toBe(false);
  });
});

describe('typesafeComplexityJudge', () => {
  const clientScoring = (score: number, confidence = 0.8) => {
    const calls: Array<{ state: unknown; questions: Record<string, { type: string; levels?: string[] }> }> = [];
    const client: SystemOneClient = {
      async systemOne(req) {
        calls.push(req as never);
        return { answers: { [COMPLEXITY_QUESTION_ID]: { score, confidence } } };
      },
    };
    return { client, calls };
  };

  it('asks a 3-level score question and is positive at or above the threshold', async () => {
    const { client, calls } = clientScoring(1.8);
    const verdict = await typesafeComplexityJudge(client, { threshold: 1.5 })('split the invoice across two cards');

    expect(verdict.positive).toBe(true);
    expect(verdict.probability).toBeUndefined();
    expect(verdict.score).toBe(1.8);
    expect(verdict.confidence).toBe(0.8);
    const q = calls[0].questions[COMPLEXITY_QUESTION_ID];
    expect(q.type).toBe('score');
    expect(q.levels).toHaveLength(3);
    expect(calls[0].state).toEqual({ message: 'split the invoice across two cards' });
  });

  it('is negative below the threshold', async () => {
    const { client } = clientScoring(0.3);
    expect((await typesafeComplexityJudge(client, { threshold: 1.5 })('what time is it')).positive).toBe(false);
  });
});
