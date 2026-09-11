#!/usr/bin/env node
/**
 * "Degradation causes" daily triage report for the in-app 50-case suite
 * (docs/plans/2026-09-09-inapp-50-cases-plan.md, "Dashboard, triage, gate").
 *
 * Writes docs/verification-runs/inapp-50/triage-<YYYY-MM-DD>.md, where the
 * date comes from the run's `startedAt` (so re-running triage against an
 * older run artifact reproduces that day's file, not today's).
 *
 * Usage:
 *   node scripts/inapp-50/triage-report.mjs
 *   node scripts/inapp-50/triage-report.mjs --results path/to/run.json
 *   node scripts/inapp-50/triage-report.mjs --out path/to/triage.md
 *   node scripts/inapp-50/triage-report.mjs --register path/to/cases.json
 *
 * Root package.json: `npm run inapp-50:triage`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATED_CLUSTERS,
  ROOT_CAUSE_CATEGORIES,
  SEVERITY_ORDER,
  diffRuns,
  gateVerdict,
  loadLatest,
  loadRuns,
  summarize,
} from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const RESULTS_DIR = path.join(ROOT, 'docs/verification-runs/inapp-50');
const DEFAULT_REGISTER = path.join(ROOT, 'fixtures/voice/inapp-50-cases.json');

// Mirrors scripts/inapp-50/build-register-doc.mjs's CLUSTER_LABEL so the
// register doc, the dashboard, and this report name clusters identically.
const CLUSTER_LABEL = {
  scheduling: 'Scheduling (booking / reschedule / cancel / confirm / delay)',
  search: 'Search & status lookup',
  confirmations: 'Confirmations & recovery (duplicate / noisy turns)',
  estimates: 'Estimates & quote acceptance',
  invoices: 'Invoice actions',
  customers: 'Customers & leads',
  jobs: 'Jobs',
  dispatch: 'Dispatch handoff & emergency',
};

// "top-3 failing clusters ... each with the owning fix from the plan" —
// only scheduling/search/confirmations (and dispatch, folded into Agent D's
// "Scheduling & dispatch" section) have a named owner in the plan.
const CLUSTER_OWNER = {
  scheduling:
    'Agent D — Scheduling & dispatch fixes (technicianId resolution on create_appointment, appointment lookup by customer for notify_delay/confirm_appointment, honest not-found for operator lookups)',
  dispatch:
    'Agent D — Scheduling & dispatch fixes (en_route handoff via the shared dispatch/en-route-voice.ts core)',
  search:
    'Agent B — Search/lookup routing (inapp-lookup-surface.ts calling the shared dispatchAssistantLookup for every lookup_* intent)',
  confirmations:
    'Agent C — Confirmations & recovery (HandleInputResult.trace, duplicate-turn dedup, noise/filler detection, affirmation/negation parsing)',
};

const ROOT_CAUSE_LABEL = {
  intent: 'Intent classification',
  slot_capture: 'Slot capture',
  proposal_generation: 'Proposal generation',
  fallback: 'Fallback (reprompt / escalation / guard / refusal)',
  infra: 'Infra (live-mode only)',
};

const SEVERITY_RANK = Object.fromEntries(SEVERITY_ORDER.map((s, i) => [s, i]));

function parseArgs(argv) {
  const args = { results: null, out: null, register: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--results') args.results = argv[(i += 1)];
    else if (arg === '--out') args.out = argv[(i += 1)];
    else if (arg === '--register') args.register = argv[(i += 1)];
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function dateFromStartedAt(startedAt) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(startedAt ?? '');
  return m ? m[1] : new Date().toISOString().slice(0, 10);
}

function md(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Find the closest earlier FULL (non-batch) run in `dir` relative to
 * `currentRun`, by `startedAt`. Excludes any run-*.json that IS
 * `currentRun` (same runId), so gating on `latest.json` still finds the
 * run before it even though `latest.json` is a copy of a `run-*.json`
 * entry that also appears in `loadRuns`.
 */
function findPreviousRun(dir, currentRun) {
  const currentStarted = currentRun?.startedAt ?? '';
  const candidates = loadRuns(dir).filter(
    (entry) => !entry.isBatch && entry.run?.runId !== currentRun?.runId,
  );
  let previous = null;
  for (const entry of candidates) {
    const started = entry.run?.startedAt ?? '';
    if (started < currentStarted && (!previous || started > (previous.run?.startedAt ?? ''))) {
      previous = entry;
    }
  }
  return previous ? previous.run : null;
}

function caseMeta(key, run, register) {
  const runCase = (run?.cases ?? []).find((c) => c.key === key);
  const regCase = (register?.cases ?? []).find((c) => c.key === key);
  return {
    cluster: regCase?.cluster ?? runCase?.cluster ?? 'unknown',
    severity: regCase?.severity ?? runCase?.severity ?? 'unknown',
    stage: runCase?.stage ?? 'unknown',
  };
}

function renderNonPassByRootCause(run, register) {
  const cases = run.cases ?? [];
  const nonPass = cases.filter((c) => c.verdict !== 'PASS');
  const clusterOrder = register?.clusters ?? [...new Set(cases.map((c) => c.cluster))];

  const lines = ['## Non-PASS cases by root cause', ''];
  if (nonPass.length === 0) {
    lines.push('None — all 50 cases PASSed.', '');
    return lines.join('\n');
  }

  const categories = [...ROOT_CAUSE_CATEGORIES, null]; // null = uncategorized bucket
  for (const category of categories) {
    const inCategory = nonPass.filter((c) => (c.rootCause?.category ?? null) === category);
    if (inCategory.length === 0) continue;

    lines.push(`### ${category ? ROOT_CAUSE_LABEL[category] ?? category : 'Uncategorized'} (${inCategory.length})`, '');

    for (const cluster of clusterOrder) {
      const rows = inCategory
        .filter((c) => c.cluster === cluster)
        .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99) || a.key.localeCompare(b.key));
      if (rows.length === 0) continue;

      lines.push(`**${CLUSTER_LABEL[cluster] ?? cluster}** (${rows.length})`, '');
      lines.push('| Key | Severity | Verdict | Stage | Detail |', '|---|---|---|---|---|');
      for (const c of rows) {
        lines.push(`| \`${c.key}\` | ${c.severity} | ${c.verdict} | ${c.stage ?? '—'} | ${md(c.rootCause?.detail) || '—'} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function renderTopFailingClusters(run, register) {
  const summary = summarize(run);
  const clusterOrder = register?.clusters ?? Object.keys(summary.byCluster);

  const ranked = clusterOrder
    .map((cluster) => {
      const counts = summary.byCluster[cluster] ?? { PASS: 0, PARTIAL: 0, DEGRADED: 0, FAIL: 0 };
      const totalNonPass = counts.PARTIAL + counts.DEGRADED + counts.FAIL;
      const criticalNonPass = (run.cases ?? []).filter(
        (c) => c.cluster === cluster && c.severity === 'critical' && c.verdict !== 'PASS',
      ).length;
      const nonPassKeys = (run.cases ?? [])
        .filter((c) => c.cluster === cluster && c.verdict !== 'PASS')
        .map((c) => c.key);
      return { cluster, totalNonPass, criticalNonPass, nonPassKeys };
    })
    .filter((row) => row.totalNonPass > 0)
    .sort((a, b) => b.criticalNonPass - a.criticalNonPass || b.totalNonPass - a.totalNonPass);

  const lines = ['## Top 3 failing clusters', ''];
  if (ranked.length === 0) {
    lines.push('No cluster has a non-PASS case in this run.', '');
    return lines.join('\n');
  }

  ranked.slice(0, 3).forEach((row, i) => {
    lines.push(
      `${i + 1}. **${CLUSTER_LABEL[row.cluster] ?? row.cluster}** — ${row.criticalNonPass} critical non-PASS, ${row.totalNonPass} total non-PASS.`,
      `   Owning fix: ${CLUSTER_OWNER[row.cluster] ?? 'No owning fix named in the plan — file as core/growth backlog.'}`,
      `   Cases: ${row.nonPassKeys.map((k) => `\`${k}\``).join(', ')}`,
      '',
    );
  });
  return lines.join('\n');
}

function renderSincePreviousRun(run, previousRun) {
  const lines = ['## Since previous run', ''];
  if (!previousRun) {
    lines.push('No earlier full run found in `docs/verification-runs/inapp-50/` — this is the first recorded run.', '');
    return lines.join('\n');
  }

  const diff = diffRuns(previousRun, run);
  lines.push(`Compared against \`${previousRun.runId ?? '(unknown)'}\` (${previousRun.startedAt ?? '?'}).`, '');

  lines.push(`**Fixed (${diff.fixed.length})**`, '');
  lines.push(
    diff.fixed.length
      ? diff.fixed.map((e) => `- \`${e.key}\`: ${e.prevVerdict} → PASS`).join('\n')
      : '- none',
    '',
  );

  lines.push(`**Regressed (${diff.regressed.length})**`, '');
  lines.push(
    diff.regressed.length
      ? diff.regressed.map((e) => `- \`${e.key}\`: PASS → ${e.nextVerdict}${e.nextRootCause?.category ? ` (${e.nextRootCause.category}: ${md(e.nextRootCause.detail)})` : ''}`).join('\n')
      : '- none',
    '',
  );

  lines.push(`**New cases (${diff.newCases.length})**`, '');
  lines.push(diff.newCases.length ? diff.newCases.map((k) => `- \`${k}\``).join('\n') : '- none', '');

  if (diff.changed.length > 0) {
    lines.push(`**Root cause changed, still non-PASS (${diff.changed.length})**`, '');
    lines.push(
      diff.changed
        .map((e) => `- \`${e.key}\`: ${e.prevVerdict} → ${e.nextVerdict}`)
        .join('\n'),
      '',
    );
  }

  return lines.join('\n');
}

function renderIntentCaptureOnlyCallout(run, register) {
  const summary = summarize(run);
  const gated = summary.intentCaptureOnlyCritical.filter((key) => {
    const cluster = caseMeta(key, run, register).cluster;
    return GATED_CLUSTERS.includes(cluster);
  });

  const lines = ['## Intent-capture-only on critical booking/search', ''];
  lines.push(
    '_Gate rule 2: zero critical scheduling/search/confirmations cases may end with intent captured and nothing proposed or answered._',
    '',
  );
  if (gated.length === 0) {
    lines.push('None — gate rule 2 is currently satisfied.', '');
    return lines.join('\n');
  }
  for (const key of gated) {
    const meta = caseMeta(key, run, register);
    lines.push(`- \`${key}\` — ${CLUSTER_LABEL[meta.cluster] ?? meta.cluster}, stage \`${meta.stage}\``);
  }
  lines.push('');
  return lines.join('\n');
}

function renderSummaryParagraph(run, register, previousRun, gate) {
  const summary = gate.summary;
  const ranked = (register?.clusters ?? Object.keys(summary.byCluster))
    .map((cluster) => {
      const counts = summary.byCluster[cluster] ?? { PARTIAL: 0, DEGRADED: 0, FAIL: 0 };
      return { cluster, nonPass: counts.PARTIAL + counts.DEGRADED + counts.FAIL };
    })
    .filter((r) => r.nonPass > 0)
    .sort((a, b) => b.nonPass - a.nonPass);
  const topCluster = ranked[0];

  const diff = previousRun ? diffRuns(previousRun, run) : null;

  const bits = [
    `This run scored ${summary.PASS}/${summary.total} (PARTIAL ${summary.PARTIAL}, DEGRADED ${summary.DEGRADED}, FAIL ${summary.FAIL}), and the release gate is ${gate.pass ? 'PASSING' : 'FAILING'}${gate.pass ? '' : ` (${gate.reasons.join('; ')})`}.`,
  ];
  if (topCluster) {
    bits.push(
      `The worst cluster is ${CLUSTER_LABEL[topCluster.cluster] ?? topCluster.cluster} with ${topCluster.nonPass} non-PASS case(s).`,
    );
  } else {
    bits.push('No cluster has a non-PASS case.');
  }
  if (summary.intentCaptureOnlyCritical.length > 0) {
    bits.push(
      `${summary.intentCaptureOnlyCritical.length} critical case(s) ended intent-capture-only (${summary.intentCaptureOnlyCritical.join(', ')}).`,
    );
  }
  if (diff) {
    bits.push(
      `Since the previous run: ${diff.fixed.length} case(s) fixed, ${diff.regressed.length} regressed, ${diff.newCases.length} new.`,
    );
  } else {
    bits.push('No previous run to compare against.');
  }
  return ['## Summary', '', bits.join(' '), ''].join('\n');
}

export function renderTriageReport({ run, previousRun, register }) {
  const gate = gateVerdict(run, register);
  const date = dateFromStartedAt(run.startedAt);

  const header = [
    `# In-app 50-case triage — ${date}`,
    '',
    `**Run:** \`${run.runId ?? '(unknown)'}\` · **Mode:** \`${run.mode ?? '?'}\` · **Git SHA:** \`${run.gitSha ?? '?'}\``,
    `**Result:** PASS ${gate.summary.PASS}/${gate.summary.total} · **Gate:** ${gate.pass ? 'PASS' : 'FAIL'}`,
    '',
  ];
  if (!gate.pass) {
    header.push('Gate failure reasons:', '');
    for (const reason of gate.reasons) header.push(`- ${reason}`);
    header.push('');
  }

  return [
    header.join('\n'),
    renderNonPassByRootCause(run, register),
    '',
    renderTopFailingClusters(run, register),
    '',
    renderSincePreviousRun(run, previousRun),
    '',
    renderIntentCaptureOnlyCallout(run, register),
    '',
    renderSummaryParagraph(run, register, previousRun, gate),
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      [
        'Usage: node scripts/inapp-50/triage-report.mjs [--results <run.json>] [--out <triage.md>] [--register <cases.json>]',
        '',
        `  --results   run artifact to triage (default: ${path.relative(ROOT, RESULTS_DIR)}/latest.json)`,
        '  --out       output path (default: derived from --results\' startedAt date)',
        `  --register  case register (default: ${path.relative(ROOT, DEFAULT_REGISTER)})`,
      ].join('\n'),
    );
    process.exit(0);
  }

  let run;
  let resultsDir = RESULTS_DIR;
  if (args.results) {
    const resultsPath = path.resolve(process.cwd(), args.results);
    if (!fs.existsSync(resultsPath)) {
      console.error(`inapp-50 triage report: no results file at ${resultsPath}`);
      process.exit(1);
    }
    run = readJson(resultsPath);
    // Previous-run history lives alongside whichever results file was
    // given (matters for pointing --results at a non-default location,
    // e.g. a demo/test fixture directory) rather than always the
    // checked-in docs/verification-runs/inapp-50/ location.
    resultsDir = path.dirname(resultsPath);
  } else {
    run = loadLatest(RESULTS_DIR);
    if (!run) {
      console.error(`inapp-50 triage report: no results file at ${path.join(RESULTS_DIR, 'latest.json')}`);
      console.error('Run the harness first (e.g. npm run inapp-50:run) or pass --results <path>.');
      process.exit(1);
    }
  }

  const registerPath = args.register ? path.resolve(process.cwd(), args.register) : DEFAULT_REGISTER;
  const register = fs.existsSync(registerPath) ? readJson(registerPath) : null;
  if (!register) {
    console.warn(`inapp-50 triage report: register not found at ${registerPath}; cluster/severity fall back to the run's own fields.`);
  }

  const previousRun = findPreviousRun(resultsDir, run);
  const report = renderTriageReport({ run, previousRun, register });

  const outPath = args.out
    ? path.resolve(process.cwd(), args.out)
    : path.join(RESULTS_DIR, `triage-${dateFromStartedAt(run.startedAt)}.md`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, report);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
