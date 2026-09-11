#!/usr/bin/env node
/**
 * In-app 50-case release gate (docs/plans/2026-09-09-inapp-50-cases-plan.md,
 * "Gates (R3)").
 *
 * Reads a run artifact (default: docs/verification-runs/inapp-50/latest.json)
 * and the case register (default: fixtures/voice/inapp-50-cases.json),
 * recomputes the verdict summary from `cases[]` (never trusts the file's own
 * `summary` block — see lib.mjs summarize()), and evaluates the three gate
 * rules:
 *
 *   1. summary.PASS === 50
 *   2. zero critical scheduling/search/confirmations case ends
 *      intent_capture_only
 *   3. zero FAIL verdicts
 *
 * Exit code 0 on PASS, 1 on FAIL (including "no results file found").
 *
 * Usage:
 *   node scripts/inapp-50/release-gate.mjs
 *   node scripts/inapp-50/release-gate.mjs --results path/to/run.json
 *   node scripts/inapp-50/release-gate.mjs --register path/to/cases.json
 *
 * Root package.json: `npm run check:inapp-50`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateVerdict, loadLatest } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_RESULTS_DIR = path.join(ROOT, 'docs/verification-runs/inapp-50');
const DEFAULT_REGISTER = path.join(ROOT, 'fixtures/voice/inapp-50-cases.json');

function parseArgs(argv) {
  const args = { results: null, register: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--results') args.results = argv[(i += 1)];
    else if (arg === '--register') args.register = argv[(i += 1)];
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      [
        'Usage: node scripts/inapp-50/release-gate.mjs [--results <run.json>] [--register <cases.json>]',
        '',
        `  --results   run artifact to gate (default: ${path.relative(ROOT, DEFAULT_RESULTS_DIR)}/latest.json)`,
        `  --register  case register for cross-checking cluster/severity/coverage (default: ${path.relative(ROOT, DEFAULT_REGISTER)})`,
      ].join('\n'),
    );
    process.exit(0);
  }

  let run;
  let resultsLabel;
  if (args.results) {
    const resultsPath = path.resolve(process.cwd(), args.results);
    if (!fs.existsSync(resultsPath)) {
      console.error(`inapp-50 release gate: no results file at ${resultsPath}`);
      process.exit(1);
    }
    run = readJson(resultsPath);
    resultsLabel = resultsPath;
  } else {
    run = loadLatest(DEFAULT_RESULTS_DIR);
    resultsLabel = path.join(DEFAULT_RESULTS_DIR, 'latest.json');
    if (!run) {
      console.error(`inapp-50 release gate: no results file at ${resultsLabel}`);
      console.error('Run the harness first (e.g. npm run inapp-50:run) or pass --results <path>.');
      process.exit(1);
    }
  }

  const registerPath = args.register ? path.resolve(process.cwd(), args.register) : DEFAULT_REGISTER;
  let register = null;
  if (fs.existsSync(registerPath)) {
    register = readJson(registerPath);
  } else {
    console.warn(`inapp-50 release gate: register not found at ${registerPath}; falling back to a hardcoded 50-case total.`);
  }

  const verdict = gateVerdict(run, register);

  console.log(`in-app 50-case release gate — ${resultsLabel}`);
  console.log(`run: ${run.runId ?? '(unknown)'} · mode: ${run.mode ?? '?'} · gitSha: ${run.gitSha ?? '?'}`);
  console.log(
    `PASS ${verdict.summary.PASS}/${verdict.summary.total}  PARTIAL ${verdict.summary.PARTIAL}  DEGRADED ${verdict.summary.DEGRADED}  FAIL ${verdict.summary.FAIL}`,
  );
  console.log(`gate: ${verdict.pass ? 'PASS' : 'FAIL'}`);
  if (!verdict.pass) {
    for (const reason of verdict.reasons) console.log(`  - ${reason}`);
  }

  process.exit(verdict.pass ? 0 : 1);
}

main();
