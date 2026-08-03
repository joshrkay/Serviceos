/**
 * Compute graph coverage: which critical paths are exercised by the
 * Layer-1 corpus (and optionally by the path-smoke case list).
 *
 * Pure + offline — no LLM, no network.
 */
import type { VoiceQualityScript } from '../schema';
import {
  CRITICAL_PATHS,
  type CoverageSource,
  type CriticalPath,
  type CriticalPathKind,
} from './paths';

export interface PathCoverageRow {
  path: CriticalPath;
  covered: boolean;
  sources: CoverageSource[];
  matchingScriptIds: string[];
  /** When uncovered and required, why (for reports). */
  gapReason?: string;
}

export interface GraphCoverageReport {
  generatedAt: string;
  totalPaths: number;
  requiredPaths: number;
  coveredRequired: number;
  uncoveredRequired: PathCoverageRow[];
  rows: PathCoverageRow[];
  /**
   * Fraction of required paths with at least one coverage source.
   * 0..1. Used by --gate.
   */
  requiredCoverageRatio: number;
  summaryLines: string[];
}

export interface ComputeCoverageOptions {
  scripts: VoiceQualityScript[];
  /** Path ids that the real-LLM smoke case list exercises. */
  pathSmokeIds?: readonly string[];
  /**
   * Structural / unit-covered path ids (cost_cap, hangup, etc.) that
   * are proven outside the corpus. Defaults to a fixed known set.
   */
  unitCoveredIds?: readonly string[];
}

/** Paths we treat as unit-proven even without a perfect script map. */
export const DEFAULT_UNIT_COVERED_IDS: readonly string[] = [
  'cost_cap',
  'hangup',
  'confidence_low',
  'post_quote_close',
  // Operator money loop (operator-ops-loop.test.ts) — not Layer-1 CSR scripts.
  'invoice',
  'payment_chase',
];

/**
 * Map a single script onto critical path ids it exercises.
 * Heuristic but deterministic — prefers explicit scriptIdHints, then
 * turn expected intents / proposal types / escalate flags.
 */
export function scriptCoversPathIds(
  script: VoiceQualityScript,
  paths: readonly CriticalPath[] = CRITICAL_PATHS,
): string[] {
  const hits = new Set<string>();

  for (const path of paths) {
    const hints = path.signals.scriptIdHints ?? [];
    if (hints.includes(script.id)) {
      hits.add(path.id);
      continue;
    }

    const bucketHints = path.signals.bucketHints ?? [];
    const bucketMatch =
      bucketHints.length > 0 && bucketHints.includes(script.bucket);

    const turnIntents = new Set(
      script.turns
        .map((t) => t.expected.intent)
        .filter((x): x is string => typeof x === 'string'),
    );
    const turnProposals = new Set(
      script.turns
        .map((t) => t.expected.proposalType)
        .filter((x): x is string => typeof x === 'string'),
    );
    const anyEscalate = script.turns.some((t) => t.expected.escalates === true);

    // When a path declares bucketHints, intent/proposal matches only count
    // inside those buckets (prevents english booking scripts from covering
    // spanish_book, etc.). Paths without bucketHints match globally.
    const bucketOk = bucketHints.length === 0 || bucketMatch;

    let intentHit = false;
    if (bucketOk && path.intents) {
      for (const i of path.intents) {
        if (turnIntents.has(i)) {
          intentHit = true;
          break;
        }
      }
    }

    let proposalHit = false;
    if (bucketOk) {
      const props = path.signals.proposalTypes ?? [];
      for (const p of props) {
        if (turnProposals.has(p)) {
          proposalHit = true;
          break;
        }
      }
    }

    // Escalate-flagged scripts in a safety path's buckets count as weak
    // coverage when the path expects escalates:true.
    const escalateHit =
      path.signals.escalates === true &&
      anyEscalate &&
      (bucketMatch ||
        (bucketOk && (path.intents?.some((i) => turnIntents.has(i)) ?? false)));

    if (intentHit || proposalHit || escalateHit) {
      hits.add(path.id);
    }
  }

  return [...hits].sort();
}

export function computeGraphCoverage(
  opts: ComputeCoverageOptions,
): GraphCoverageReport {
  const pathSmoke = new Set(opts.pathSmokeIds ?? []);
  const unitCovered = new Set(opts.unitCoveredIds ?? DEFAULT_UNIT_COVERED_IDS);

  const scriptIndex = new Map<string, string[]>();
  for (const script of opts.scripts) {
    const ids = scriptCoversPathIds(script);
    for (const id of ids) {
      const list = scriptIndex.get(id) ?? [];
      list.push(script.id);
      scriptIndex.set(id, list);
    }
  }

  const rows: PathCoverageRow[] = CRITICAL_PATHS.map((path) => {
    const matchingScriptIds = [...new Set(scriptIndex.get(path.id) ?? [])].sort();
    const sources: CoverageSource[] = [];

    if (matchingScriptIds.length > 0) sources.push('corpus');
    if (pathSmoke.has(path.id)) sources.push('path-smoke');
    if (unitCovered.has(path.id) && path.kind === 'structural') {
      sources.push('unit');
    }
    // Explicit unitCovered product paths (e.g. invoice/payment_chase via
    // operator-ops-loop) count as unit when listed.
    if (
      unitCovered.has(path.id) &&
      path.kind === 'product' &&
      !sources.includes('unit')
    ) {
      sources.push('unit');
    }
    // confidence_low is safety but proven by unit + scripts; allow unit tag
    // when listed in unitCovered and no corpus yet.
    if (
      unitCovered.has(path.id) &&
      path.kind !== 'structural' &&
      path.kind !== 'product' &&
      matchingScriptIds.length === 0 &&
      !pathSmoke.has(path.id)
    ) {
      // Don't claim unit for product/safety without evidence — only if
      // explicitly listed AND kind is safety with pathSmokeRequired false.
      if (path.kind === 'safety' && !path.pathSmokeRequired) {
        sources.push('unit');
      }
    }

    // Structural with unit list always counts as covered via unit.
    if (path.kind === 'structural' && unitCovered.has(path.id) && !sources.includes('unit')) {
      sources.push('unit');
    }

    let covered = sources.length > 0;
    // Structural paths need unit or corpus.
    if (path.kind === 'structural') {
      covered = sources.includes('unit') || sources.includes('corpus');
    }

    let gapReason: string | undefined;
    if (!covered && path.required) {
      if (path.productionNotes) {
        gapReason = path.productionNotes;
      } else {
        gapReason = 'No corpus script, path-smoke case, or unit mapping found';
      }
      sources.push('gap');
    } else if (!covered) {
      sources.push('gap');
      gapReason = path.productionNotes ?? 'Optional path not covered';
    }

    // If we only have gap, not covered.
    const realSources = sources.filter((s) => s !== 'gap');
    covered = realSources.length > 0;

    return {
      path,
      covered,
      sources: covered ? realSources : (['gap'] as CoverageSource[]),
      matchingScriptIds,
      gapReason: covered ? undefined : gapReason,
    };
  });

  const requiredRows = rows.filter((r) => r.path.required);
  const coveredRequired = requiredRows.filter((r) => r.covered).length;
  const uncoveredRequired = requiredRows.filter((r) => !r.covered);
  const requiredCoverageRatio =
    requiredRows.length === 0 ? 1 : coveredRequired / requiredRows.length;

  const summaryLines = [
    `Agent graph coverage: ${coveredRequired}/${requiredRows.length} required paths covered (${(requiredCoverageRatio * 100).toFixed(0)}%)`,
    ...rows.map((r) => formatRow(r)),
  ];

  return {
    generatedAt: new Date().toISOString(),
    totalPaths: rows.length,
    requiredPaths: requiredRows.length,
    coveredRequired,
    uncoveredRequired,
    rows,
    requiredCoverageRatio,
    summaryLines,
  };
}

function formatRow(r: PathCoverageRow): string {
  const flag = r.covered ? '✓' : r.path.required ? '✗' : '·';
  const kind = r.path.kind.padEnd(10);
  const src = r.sources.join('+') || 'none';
  const scripts =
    r.matchingScriptIds.length > 0
      ? ` scripts=[${r.matchingScriptIds.slice(0, 3).join(', ')}${r.matchingScriptIds.length > 3 ? ',…' : ''}]`
      : '';
  const gap = r.gapReason ? ` — ${r.gapReason}` : '';
  return `  ${flag} [${kind}] ${r.path.id}: ${src}${scripts}${gap}`;
}

export function coverageGatePasses(
  report: GraphCoverageReport,
  minRatio = 1,
): boolean {
  return report.requiredCoverageRatio + 1e-9 >= minRatio;
}

/** Group paths by kind for markdown reports. */
export function groupByKind(
  rows: PathCoverageRow[],
): Record<CriticalPathKind, PathCoverageRow[]> {
  const out: Record<CriticalPathKind, PathCoverageRow[]> = {
    product: [],
    safety: [],
    structural: [],
  };
  for (const r of rows) out[r.path.kind].push(r);
  return out;
}
