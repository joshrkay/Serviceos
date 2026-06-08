/**
 * metrics.ts — classification + slot metrics for the voice-eval harness.
 */

export interface ClassReport {
  accuracy: number;
  total: number;
  correct: number;
  perClass: Record<string, { precision: number; recall: number; f1: number; support: number }>;
  macroF1: number;
  topConfusions: { gold: string; pred: string; count: number }[];
}

/** Compute accuracy, per-class P/R/F1, macro-F1, and the worst confusions. */
export function classificationReport(pairs: { gold: string; pred: string }[]): ClassReport {
  const labels = new Set<string>();
  for (const p of pairs) { labels.add(p.gold); labels.add(p.pred); }
  const tp: Record<string, number> = {};
  const fp: Record<string, number> = {};
  const fn: Record<string, number> = {};
  const support: Record<string, number> = {};
  for (const l of labels) { tp[l] = 0; fp[l] = 0; fn[l] = 0; support[l] = 0; }

  const confusion = new Map<string, number>();
  let correct = 0;
  for (const { gold, pred } of pairs) {
    support[gold]++;
    if (gold === pred) { tp[gold]++; correct++; }
    else { fp[pred]++; fn[gold]++; const k = `${gold}=>${pred}`; confusion.set(k, (confusion.get(k) ?? 0) + 1); }
  }

  const perClass: ClassReport['perClass'] = {};
  let macroF1Sum = 0;
  let classesWithSupport = 0;
  for (const l of labels) {
    const precision = tp[l] + fp[l] ? tp[l] / (tp[l] + fp[l]) : 0;
    const recall = tp[l] + fn[l] ? tp[l] / (tp[l] + fn[l]) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    perClass[l] = { precision, recall, f1, support: support[l] };
    if (support[l] > 0) { macroF1Sum += f1; classesWithSupport++; }
  }

  const topConfusions = [...confusion.entries()]
    .map(([k, count]) => { const [gold, pred] = k.split('=>'); return { gold, pred, count }; })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    accuracy: pairs.length ? correct / pairs.length : 0,
    total: pairs.length,
    correct,
    perClass,
    macroF1: classesWithSupport ? macroF1Sum / classesWithSupport : 0,
    topConfusions,
  };
}

export interface SlotReport {
  perSlot: Record<string, { precision: number; recall: number; f1: number; tp: number; fp: number; fn: number }>;
  microF1: number;
}

/**
 * Slot metrics. For each example we compare predicted slots to gold slots.
 *   - tp: gold has slot AND prediction matches (per matchFn)
 *   - fp: prediction has a slot value that doesn't match gold
 *   - fn: gold has a slot the prediction missed/got wrong
 */
export function slotReport(
  examples: { gold: Record<string, string>; pred: Record<string, string> }[],
  slots: string[],
  matchFn: (slot: string, gold: string, pred: string) => boolean,
): SlotReport {
  const acc: Record<string, { tp: number; fp: number; fn: number }> = {};
  for (const s of slots) acc[s] = { tp: 0, fp: 0, fn: 0 };

  for (const { gold, pred } of examples) {
    for (const s of slots) {
      const g = (gold[s] ?? '').trim();
      const p = (pred[s] ?? '').trim();
      if (g && p) { if (matchFn(s, g, p)) acc[s].tp++; else { acc[s].fp++; acc[s].fn++; } }
      else if (!g && p) acc[s].fp++;
      else if (g && !p) acc[s].fn++;
    }
  }

  const perSlot: SlotReport['perSlot'] = {};
  let TP = 0, FP = 0, FN = 0;
  for (const s of slots) {
    const { tp, fp, fn } = acc[s];
    TP += tp; FP += fp; FN += fn;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    perSlot[s] = { precision, recall, f1, tp, fp, fn };
  }
  const microP = TP + FP ? TP / (TP + FP) : 0;
  const microR = TP + FN ? TP / (TP + FN) : 0;
  const microF1 = microP + microR ? (2 * microP * microR) / (microP + microR) : 0;
  return { perSlot, microF1 };
}

/** Deterministic hash → [0,1) for stable train/test splits. */
export function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
