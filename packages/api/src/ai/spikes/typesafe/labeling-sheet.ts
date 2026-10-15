/**
 * Disagreement sampler: turns judged utterances into a short human-labeling
 * sheet — every baseline/TypeSafe disagreement, plus a seeded sample of
 * agreements so precision on the "both agree" mass can still be estimated.
 */
export interface JudgedRow {
  text: string;
  baseline: boolean;
  typesafe: boolean;
  /** TypeSafe probability of yes, when available. */
  probability?: number;
}

export type SheetKind = 'typesafe_only' | 'baseline_only' | 'agree_positive' | 'agree_negative';

export interface SheetRow extends JudgedRow {
  kind: SheetKind;
  /** Left blank for the human labeler: true / false. */
  label: '';
}

const normalize = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

/** mulberry32 — small deterministic PRNG so a sheet is reproducible from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample<T>(items: T[], n: number, rand: () => number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

export function buildLabelingSheet(
  rows: readonly JudgedRow[],
  opts: { agreementSample: number; seed: number }
): SheetRow[] {
  const seen = new Set<string>();
  const unique: JudgedRow[] = [];
  for (const r of rows) {
    const key = normalize(r.text);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  const withKind = (r: JudgedRow, kind: SheetKind): SheetRow => ({ ...r, kind, label: '' });
  const p = (r: JudgedRow) => r.probability ?? 0.5;

  // Most confident TypeSafe "yes" first; most confident TypeSafe "no" first for baseline-only.
  const tsOnly = unique
    .filter((r) => r.typesafe && !r.baseline)
    .sort((a, b) => p(b) - p(a))
    .map((r) => withKind(r, 'typesafe_only'));
  const baseOnly = unique
    .filter((r) => r.baseline && !r.typesafe)
    .sort((a, b) => p(a) - p(b))
    .map((r) => withKind(r, 'baseline_only'));

  const agreePos = unique.filter((r) => r.baseline && r.typesafe);
  const agreeNeg = unique.filter((r) => !r.baseline && !r.typesafe);
  const rand = prng(opts.seed);
  const total = agreePos.length + agreeNeg.length;
  const nPos = total === 0 ? 0 : Math.round((opts.agreementSample * agreePos.length) / total);
  const nNeg = Math.max(0, opts.agreementSample - nPos);
  const agreements = [
    ...sample(agreePos, nPos, rand).map((r) => withKind(r, 'agree_positive')),
    ...sample(agreeNeg, nNeg, rand).map((r) => withKind(r, 'agree_negative')),
  ];

  return [...tsOnly, ...baseOnly, ...agreements];
}

const csvCell = (v: string | number | boolean | undefined): string => {
  const s = v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: readonly SheetRow[]): string {
  const header = 'text,kind,baseline,typesafe,probability,label';
  const body = rows.map((r) =>
    [r.text, r.kind, r.baseline, r.typesafe, r.probability, r.label].map(csvCell).join(',')
  );
  return [header, ...body].join('\n') + '\n';
}
