#!/usr/bin/env npx tsx
/**
 * agent-graph-coverage.ts — offline coverage of the critical agent graph.
 *
 *   npx tsx packages/api/scripts/agent-graph-coverage.ts
 *   npx tsx packages/api/scripts/agent-graph-coverage.ts --gate
 *   npx tsx packages/api/scripts/agent-graph-coverage.ts --json
 *   npx tsx packages/api/scripts/agent-graph-coverage.ts --markdown
 *
 * Maps Layer-1 corpus scripts + path-smoke case ids onto CRITICAL_PATHS and
 * reports which product/safety/structural edges are exercised.
 *
 * Exit codes:
 *   0 — ok (or gate passed)
 *   1 — gate failed (required path uncovered)
 *   2 — corpus failed to load
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCorpus, defaultCorpusRoot } from '../src/ai/voice-quality/corpus/loader';
import {
  computeGraphCoverage,
  coverageGatePasses,
  groupByKind,
} from '../src/ai/voice-quality/graph';
import { allPathSmokePathIds } from '../src/ai/voice-quality/path-smoke';

const argv = process.argv.slice(2);
const gate = argv.includes('--gate');
const asJson = argv.includes('--json');
const asMarkdown = argv.includes('--markdown');
const minRatioArg = argv.find((a) => a.startsWith('--min-ratio='));
const minRatio = minRatioArg
  ? Number(minRatioArg.split('=')[1])
  : gate
    ? 1
    : 0;

async function main(): Promise<void> {
  let scripts;
  try {
    scripts = loadCorpus(defaultCorpusRoot());
  } catch (err) {
    console.error(
      `❌ failed to load corpus: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }

  const report = computeGraphCoverage({
    scripts,
    pathSmokeIds: allPathSmokePathIds(),
  });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ...report,
          // Drop circular-friendly path objects for JSON consumers.
          rows: report.rows.map((r) => ({
            id: r.path.id,
            title: r.path.title,
            kind: r.path.kind,
            required: r.path.required,
            pathSmokeRequired: r.path.pathSmokeRequired,
            covered: r.covered,
            sources: r.sources,
            matchingScriptIds: r.matchingScriptIds,
            gapReason: r.gapReason,
            productionNotes: r.path.productionNotes,
          })),
        },
        null,
        2,
      ),
    );
  } else if (asMarkdown) {
    printMarkdown(report, scripts.length);
  } else {
    console.log(`\n🗺️  Agent graph coverage (${scripts.length} corpus scripts)\n`);
    for (const line of report.summaryLines) console.log(line);
    if (report.uncoveredRequired.length > 0) {
      console.log('\nUncovered required paths:');
      for (const r of report.uncoveredRequired) {
        console.log(
          `  - ${r.path.id}: ${r.gapReason ?? r.path.productionNotes ?? 'no coverage'}`,
        );
      }
    }
    console.log('');
  }

  // Always write a machine-readable artifact next to cwd when requested via env.
  const outPath = process.env.AGENT_GRAPH_COVERAGE_OUT;
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAt: report.generatedAt,
          requiredCoverageRatio: report.requiredCoverageRatio,
          coveredRequired: report.coveredRequired,
          requiredPaths: report.requiredPaths,
          uncovered: report.uncoveredRequired.map((r) => r.path.id),
          rows: report.rows.map((r) => ({
            id: r.path.id,
            covered: r.covered,
            sources: r.sources,
            scripts: r.matchingScriptIds,
          })),
        },
        null,
        2,
      ),
    );
    console.error(`Wrote ${outPath}`);
  }

  if (gate) {
    const ok = coverageGatePasses(report, Number.isFinite(minRatio) ? minRatio : 1);
    if (!ok) {
      console.error(
        `\n❌ graph coverage gate failed: ${(report.requiredCoverageRatio * 100).toFixed(0)}% < ${(minRatio * 100).toFixed(0)}% required paths covered`,
      );
      process.exit(1);
    }
    console.error(
      `✅ graph coverage gate passed (${(report.requiredCoverageRatio * 100).toFixed(0)}%)`,
    );
  }
}

function printMarkdown(
  report: ReturnType<typeof computeGraphCoverage>,
  scriptCount: number,
): void {
  const grouped = groupByKind(report.rows);
  console.log('# Agent graph coverage\n');
  console.log(
    `Generated: ${report.generatedAt} · Corpus scripts: ${scriptCount} · Required: **${report.coveredRequired}/${report.requiredPaths}** (${(report.requiredCoverageRatio * 100).toFixed(0)}%)\n`,
  );
  for (const kind of ['product', 'safety', 'structural'] as const) {
    console.log(`## ${kind}\n`);
    console.log('| Path | Covered | Sources | Scripts | Notes |');
    console.log('|------|---------|---------|---------|-------|');
    for (const r of grouped[kind]) {
      const scripts =
        r.matchingScriptIds.slice(0, 4).join(', ') +
        (r.matchingScriptIds.length > 4 ? ', …' : '');
      const notes = (r.gapReason ?? r.path.productionNotes ?? '').replace(
        /\|/g,
        '\\|',
      );
      console.log(
        `| \`${r.path.id}\` | ${r.covered ? 'yes' : '**NO**'} | ${r.sources.join(', ')} | ${scripts || '—'} | ${notes} |`,
      );
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
