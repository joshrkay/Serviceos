/**
 * §5 I9′ (STRUCTURAL) — *"…from one engine as the only source of totals math"*
 * (#1021, map #995).
 *
 * **The rule in one sentence:** no module outside `src/shared/billing-engine.ts`
 * may compute document totals — no second line-item subtotal, no second
 * `quantity × unitPrice`, no second percent-of-money.
 *
 * ## What this guard does NOT say
 *
 * G1 counted "20+ modules outside `billing-engine` assign `totalCents`" and
 * marked the row CODE-ONLY. Assignment is not the invariant: a module that
 * takes `calculateDocumentTotals(...)` and writes the result is using the
 * engine correctly, and a guard that banned the assignment would ban the
 * architecture. What I9′ forbids is a SECOND IMPLEMENTATION of the math.
 *
 * Nor does it forbid ADDING UP documents. `sentEstimates.reduce((s, e) => s +
 * e.totals.totalCents, 0)` sums engine-produced totals across many estimates
 * for a digest line; that is a report, not a totals engine. A guard that
 * confused the two would fire on every dashboard in the repo and be turned off
 * within a week.
 *
 * So the guard sweeps for the four arithmetic SHAPES the engine owns, and
 * requires every hit to be classified in the frozen inventory below —
 * `engine`, `harness`, `cross-document-aggregate` (with why) or `violation`
 * (with why). An unclassified hit fails the build, whichever it turns out to
 * be. That is what keeps the exception list honest: nobody can widen it
 * without writing down which one it is.
 *
 * ## Finding: the universal does NOT hold today
 *
 * Three second implementations exist, listed in `KNOWN_VIOLATIONS`. One of
 * them is demonstrably divergent rather than merely duplicative, and the test
 * below proves it with numbers: `proposals/estimate-editor.ts:31`'s
 * `calculateEstimateTotal` sums `quantity × unitPrice` with **no per-line
 * rounding**, so on a fractional quantity it returns a NON-INTEGER — which
 * CLAUDE.md's first core pattern ("all money: integer cents") forbids outright
 * and which the engine's own `normalizeLineItemTotals` doc comment describes
 * as the P0-2 bug it was written to close.
 *
 * The engine's math is NOT touched here (§5 lane rule: never touch
 * discount/tax math). The violations are recorded and reported.
 *
 * Evidence class: STRUCTURAL (negative controls plant each shape).
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  listSourceFiles,
  plantTree,
  removeTree,
  formatViolations,
} from '../support/structural-scan';
import {
  calculateLineItemTotal,
  calculateDocumentTotals,
  type LineItem,
} from '../../src/shared/billing-engine';
import { calculateEstimateTotal } from '../../src/proposals/estimate-editor';

const SRC = path.resolve(__dirname, '../../src');

/** The single home of totals math. */
const ENGINE_REL = 'src/shared/billing-engine.ts';

// ─── The four shapes the engine owns ────────────────────────────────────────

const TOTALS_MATH_SHAPES: ReadonlyArray<{ rule: string; why: string; pattern: RegExp }> = [
  {
    rule: 'line-item-subtotal',
    why: "Summing a LineItem's `totalCents`/`unitPriceCents` is `calculateDocumentTotals`'s own subtotal reduce. A second copy drifts the moment the engine's subtotal changes (optional/tier lines are already selectable — see `resolveSelectedLineItems`).",
    pattern: /\.reduce\s*\(.*\+\s*[\w.?[\]]*\.(totalCents|unitPriceCents)\b/,
  },
  {
    rule: 'line-item-total-math',
    why: '`quantity × unitPrice` is `calculateLineItemTotal`, which rounds per line. A copy that forgets the rounding produces non-integer cents — the P0-2 client/server divergence.',
    pattern: /\b(quantity|qty)[\w.?]*\s*\*\s*[\w.?]*\b(unitPriceCents|unitPrice)\b/,
  },
  {
    rule: 'percent-of-money',
    why: "`applyBps` is documented as \"the single home for percentage-of-money math (tax lines, deposit rules, discounts) so the rounding convention can never drift between call sites\".",
    pattern: /(\/\s*10000\b|\*\s*[\w.]*(?<!K)[Bb]ps\b)/,
  },
  {
    rule: 'document-total-expression',
    why: '`subtotal − discount + tax (+ fee)` is the engine\'s total expression. A second copy is a second definition of what a document costs.',
    pattern: /\bsubtotal\w*\s*[-+]\s*\w*(discount|tax|processingFee)\w*Cents\b/,
  },
];

export interface TotalsMathHit {
  readonly at: string;
  readonly file: string;
  readonly rule: string;
  readonly snippet: string;
}

/**
 * Every line under `roots` matching a shape the engine owns, excluding the
 * engine itself. Pure in its roots — the negative controls point it at
 * planted trees.
 */
export function totalsMathOutsideEngine(roots: readonly string[]): TotalsMathHit[] {
  const hits: TotalsMathHit[] = [];
  for (const file of listSourceFiles(roots)) {
    if (file.rel === ENGINE_REL || file.rel.endsWith('shared/billing-engine.ts')) continue;
    const code = file.code.split('\n');
    const raw = file.text.split('\n');
    for (let i = 0; i < code.length; i += 1) {
      for (const shape of TOTALS_MATH_SHAPES) {
        // `percent-of-money` only counts in a money context; `/ 10000` is also
        // a perfectly ordinary audio/bitrate divisor.
        if (shape.rule === 'percent-of-money' && !code[i].includes('Cents')) continue;
        if (!shape.pattern.test(code[i])) continue;
        hits.push({
          at: `${file.rel}:${i + 1}`,
          file: file.rel,
          rule: shape.rule,
          snippet: (raw[i] ?? '').trim(),
        });
      }
    }
  }
  return hits;
}

// ─── The frozen inventory ───────────────────────────────────────────────────

type Classification = 'harness' | 'cross-document-aggregate' | 'violation';

const CLASSIFIED: ReadonlyArray<{ at: string; as: Classification; why: string }> = [
  {
    at: 'src/ai/voice-quality/inapp-50/world.ts:554',
    as: 'harness',
    why: 'inapp-50 eval world seeding a fixture line item; not a caller-facing path (same exemption as I1′).',
  },
  {
    at: 'src/ai/skills/lookup-estimates.ts:173',
    as: 'cross-document-aggregate',
    why: 'Sums the engine-produced total of N estimates for a spoken "you have 3 estimates totaling $X". A report over documents, not a document\'s total.',
  },
  {
    at: 'src/jobs/job-profit.ts:145',
    as: 'cross-document-aggregate',
    why: 'Sums `inv.totals.totalCents` across a job\'s invoices — reads DocumentTotals the engine produced.',
  },
  {
    at: 'src/verticals/context-assembly.ts:296',
    as: 'cross-document-aggregate',
    why: 'Averages `e.totals.totalCents` across similar estimates for AI context.',
  },
  {
    at: 'src/digest/digest-service.ts:961',
    as: 'cross-document-aggregate',
    why: 'Pipeline value for the daily digest — sums `e.totals.totalCents` across sent estimates.',
  },
  {
    at: 'src/proposals/estimate-editor.ts:33',
    as: 'violation',
    why: "`calculateEstimateTotal` is a SECOND totals engine: `sum + item.quantity * item.unitPrice` with NO per-line rounding, so a fractional quantity yields non-integer cents — CLAUDE.md's \"all money: integer cents\" broken outright, and exactly the P0-2 divergence `normalizeLineItemTotals` exists to close. It also has ZERO callers in src (only its own unit test), so the cheapest fix is deletion — which CLAUDE.md's hygiene rule already requires of an unused export.",
  },
  {
    at: 'src/proposals/execution/handlers.ts:838',
    as: 'violation',
    why: "`Math.round(quantity * unitPriceCents)` in the execution line-item normalizer duplicates `calculateLineItemTotal` byte for byte. Numerically identical today; a second definition tomorrow. The file already imports `buildLineItem` from the engine, so the fix is a one-line swap.",
  },
  {
    at: 'src/routes/invoices.ts:178',
    as: 'violation',
    why: "Recomputes an invoice subtotal by hand (`parsed.lineItems.reduce(... + li.totalCents)`) to feed the member-discount `applyBps`. It reaches for the engine's `applyBps` and then defines `subtotal` itself — so if the engine's subtotal ever stops meaning \"every line\" (optional and tier lines are already selectable), the member discount silently uses a different base than the invoice does.",
  },
];

function classificationOf(at: string): Classification | null {
  return CLASSIFIED.find((c) => c.at === at)?.as ?? null;
}

// ─── The guard ──────────────────────────────────────────────────────────────

describe('§5 I9′ (STRUCTURAL) — the billing engine is the only source of totals math', () => {
  it('the sweep is not vacuous: the shapes it looks for are real and present', () => {
    const hits = totalsMathOutsideEngine([SRC]);
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((h) => h.rule)).size).toBeGreaterThan(1);
  });

  it('every hit is classified: harness, cross-document aggregate, or a recorded violation', () => {
    const unclassified = totalsMathOutsideEngine([SRC]).filter(
      (h) => classificationOf(h.at) === null,
    );
    expect(
      formatViolations(unclassified.map((h) => ({ ...h, line: 0 }))),
      [
        'Totals math appeared outside the billing engine and is not classified.',
        '',
        'I9′: one engine as the only source of totals math (D-003, CLAUDE.md',
        '"Use the shared billing engine for all financial calculations").',
        '',
        'If it computes a document total, route it through',
        'calculateDocumentTotals / calculateLineItemTotal / applyBps. If it adds',
        'UP documents the engine already totalled, classify it as a',
        'cross-document-aggregate with the reason.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('the recorded violations are still exactly where the report says they are', () => {
    const found = totalsMathOutsideEngine([SRC]).map((h) => h.at);
    for (const entry of CLASSIFIED.filter((c) => c.as === 'violation')) {
      expect(found, `${entry.at} — ${entry.why}`).toContain(entry.at);
    }
  });

  /**
   * I9′ AS WRITTEN — the honest state. Three second implementations exist.
   * When they are routed through the engine this starts PASSING, `it.fails`
   * fails, and the row is forced back for re-grading.
   */
  it.fails(
    'I9′ as written — no module outside the engine computes document totals (KNOWN GAP: 3 sites)',
    () => {
      const violations = totalsMathOutsideEngine([SRC]).filter(
        (h) => classificationOf(h.at) === 'violation',
      );
      expect(violations.map((v) => v.at)).toEqual([]);
    },
  );

  /**
   * The finding made concrete rather than stylistic. This is not a guard on
   * the engine's math (untouchable on this lane) — it is a measurement of the
   * SECOND implementation, run against the first.
   */
  it('PROOF the duplication is not harmless: calculateEstimateTotal disagrees with the engine and returns non-integer cents', () => {
    // 0.5 × 29¢ — the engine's own P0-2 example.
    const engineLineTotal = calculateLineItemTotal(0.5, 29);
    expect(engineLineTotal).toBe(15);
    expect(Number.isInteger(engineLineTotal)).toBe(true);

    const secondEngineTotal = calculateEstimateTotal({
      lineItems: [{ description: 'Fitting', quantity: 0.5, unitPrice: 29 }],
    });
    expect(secondEngineTotal).toBe(14.5);
    expect(Number.isInteger(secondEngineTotal)).toBe(false);
    expect(secondEngineTotal).not.toBe(engineLineTotal);

    // And the engine's document total for the same line is the integer.
    const lineItems: LineItem[] = [
      {
        id: 'li-1',
        description: 'Fitting',
        quantity: 0.5,
        unitPriceCents: 29,
        totalCents: engineLineTotal,
        taxable: true,
        sortOrder: 0,
      } as LineItem,
    ];
    expect(calculateDocumentTotals(lineItems, 0, 0).totalCents).toBe(15);
  });

  // ─── Negative controls ────────────────────────────────────────────────────

  it('NEGATIVE CONTROL — a planted line-item subtotal is reported', () => {
    const dir = plantTree('i9-subtotal', {
      'planted-subtotal.ts': [
        'export function subtotal(lineItems: Array<{ totalCents: number }>) {',
        '  return lineItems.reduce((sum, li) => sum + li.totalCents, 0);',
        '}',
        '',
      ].join('\n'),
    });
    try {
      const hits = totalsMathOutsideEngine([dir]);
      expect(hits.map((h) => h.rule)).toEqual(['line-item-subtotal']);
      expect(hits[0].snippet).toContain('reduce');
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL — a planted `quantity * unitPriceCents` is reported', () => {
    const dir = plantTree('i9-line-total', {
      'planted-line-total.ts': [
        'export function lineTotal(quantity: number, unitPriceCents: number) {',
        '  return quantity * unitPriceCents;',
        '}',
        '',
      ].join('\n'),
    });
    try {
      expect(totalsMathOutsideEngine([dir]).map((h) => h.rule)).toEqual(['line-item-total-math']);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL — a planted percent-of-money is reported, and a bitrate divisor is not', () => {
    const dir = plantTree('i9-bps', {
      'planted-bps.ts': [
        'export function tax(amountCents: number, bps: number) {',
        '  return Math.round((amountCents * bps) / 10000);',
        '}',
        '',
      ].join('\n'),
      'audio.ts': [
        'export function frameSize(bitrateKbps: number, sampleRate: number) {',
        '  return Math.floor((144 * bitrateKbps * 1000) / sampleRate);',
        '}',
        '',
      ].join('\n'),
    });
    try {
      const hits = totalsMathOutsideEngine([dir]);
      expect(hits.map((h) => h.rule)).toContain('percent-of-money');
      expect(hits.every((h) => !h.file.endsWith('audio.ts'))).toBe(true);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL — a planted document-total expression is reported', () => {
    const dir = plantTree('i9-doc-total', {
      'planted-doc-total.ts': [
        'export function total(subtotalCents: number, discountCents: number, taxCents: number) {',
        '  return subtotalCents - discountCents + taxCents;',
        '}',
        '',
      ].join('\n'),
    });
    try {
      expect(totalsMathOutsideEngine([dir]).map((h) => h.rule)).toContain(
        'document-total-expression',
      );
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL (inverse) — totals math quoted in a doc comment is NOT reported', () => {
    const dir = plantTree('i9-comment-only', {
      'commented.ts': [
        '/**',
        ' * This used to do `lineItems.reduce((sum, li) => sum + li.totalCents, 0)`',
        ' * and `quantity * unitPriceCents`; it now calls the engine.',
        ' */',
        "export { calculateDocumentTotals } from '../shared/billing-engine';",
        '',
      ].join('\n'),
    });
    try {
      expect(totalsMathOutsideEngine([dir])).toEqual([]);
    } finally {
      removeTree(dir);
    }
  });

  it('every shape and every classification carries its reason', () => {
    for (const shape of TOTALS_MATH_SHAPES) {
      expect(shape.why.length, shape.rule).toBeGreaterThan(60);
    }
    for (const entry of CLASSIFIED) {
      expect(entry.why.length, entry.at).toBeGreaterThan(40);
      expect(entry.at, entry.at).toMatch(/^src\/.+\.ts:\d+$/);
    }
  });
});
