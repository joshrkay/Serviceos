import { describe, expect, it } from 'vitest';
import { evaluateBinaryJudge } from '../../../../src/ai/spikes/typesafe/eval-harness';

describe('evaluateBinaryJudge', () => {
  it('reports the confusion matrix, precision and recall for a judge over labeled samples', async () => {
    const samples = [
      { text: 'a', label: true },
      { text: 'b', label: true },
      { text: 'c', label: false },
      { text: 'd', label: false },
    ];
    // judge says yes to a (TP), no to b (FN), yes to c (FP), no to d (TN)
    const judge = async (text: string) => ({ positive: text === 'a' || text === 'c' });

    const report = await evaluateBinaryJudge(judge, samples);

    expect(report.confusion).toEqual({ tp: 1, fn: 1, fp: 1, tn: 1 });
    expect(report.precision).toBe(0.5);
    expect(report.recall).toBe(0.5);
    expect(report.misses.map((m) => m.text)).toEqual(['b']);
    expect(report.falseAlarms.map((m) => m.text)).toEqual(['c']);
  });
});
