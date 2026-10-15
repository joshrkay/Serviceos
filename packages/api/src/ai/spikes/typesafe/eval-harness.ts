/**
 * TypeSafe spike — judge-agnostic evaluation harness. Offline only; nothing in
 * production imports this directory.
 */
export interface LabeledSample {
  text: string;
  label: boolean;
}

export interface BinaryVerdict {
  positive: boolean;
  /** Probability of yes, when the judge produces one (e.g. TypeSafe Noul). */
  probability?: number;
}

export type BinaryJudge = (text: string) => Promise<BinaryVerdict>;

export interface BinaryEvalReport {
  confusion: { tp: number; fp: number; fn: number; tn: number };
  precision: number;
  recall: number;
  misses: LabeledSample[];
  falseAlarms: LabeledSample[];
}

export async function evaluateBinaryJudge(
  judge: BinaryJudge,
  samples: readonly LabeledSample[]
): Promise<BinaryEvalReport> {
  const confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const misses: LabeledSample[] = [];
  const falseAlarms: LabeledSample[] = [];
  for (const sample of samples) {
    const { positive } = await judge(sample.text);
    if (sample.label && positive) confusion.tp++;
    else if (sample.label) {
      confusion.fn++;
      misses.push(sample);
    } else if (positive) {
      confusion.fp++;
      falseAlarms.push(sample);
    } else confusion.tn++;
  }
  const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);
  return {
    confusion,
    precision: ratio(confusion.tp, confusion.tp + confusion.fp),
    recall: ratio(confusion.tp, confusion.tp + confusion.fn),
    misses,
    falseAlarms,
  };
}
