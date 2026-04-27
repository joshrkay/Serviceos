import fs from 'node:fs/promises';
import path from 'node:path';
import {
  runApiCheck,
  runUiCheck,
  runDbCheck,
  writeJson,
  missingEnvVars,
} from './tools.mjs';

const root = path.resolve('qa-runner');
const planPath = path.join(root, 'config', 'test-plan.json');
const reportPath = path.join(root, 'reports', 'test_results.json');

function parseArgs(argv) {
  const args = { mode: argv[2] || 'run', stage: null, test: null };
  for (let i = 3; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--stage') args.stage = argv[i + 1];
    if (token === '--test') args.test = argv[i + 1];
  }
  return args;
}

async function loadPlan() {
  const raw = await fs.readFile(planPath, 'utf8');
  return JSON.parse(raw);
}

function stagePassed(rows, stageName) {
  const stageRows = rows.filter((r) => r.stage === stageName);
  return stageRows.length > 0 && stageRows.every((r) => r.final_status === 'pass');
}

function assemble({ stage, test, api, ui, db, skippedReason = null }) {
  const statuses = [api.status, ui.status, db.status];
  let final = 'blocked';
  if (statuses.every((s) => s === 'pass')) final = 'pass';
  else if (statuses.includes('fail')) final = 'fail';

  if (skippedReason) final = 'blocked';

  return {
    stage,
    test_id: test.id,
    module: test.module,
    api_status: api.status,
    ui_status: ui.status,
    db_status: db.status,
    final_status: final,
    summary: skippedReason
      ? `${test.id} skipped: ${skippedReason}`
      : `${test.id}: api=${api.status}, ui=${ui.status}, db=${db.status}`,
    evidence: {
      api: api.evidence_path ? [api.evidence_path] : [],
      ui: ui.evidence_path ? [ui.evidence_path] : [],
      db: db.evidence_path ? [db.evidence_path] : [],
    },
    defects: final === 'fail' ? [{ id: `DEF-${test.id}`, note: 'See evidence files' }] : [],
    skipped_reason: skippedReason,
  };
}

function defaultBlocked(note) {
  return { status: 'blocked', evidence_path: null, notes: note };
}

async function run() {
  const args = parseArgs(process.argv);
  const plan = await loadPlan();
  const baseUrl = process.env.BASE_URL || 'https://serviceosweb-development.up.railway.app';
  const apiUrl = process.env.API_URL || 'https://serviceosapi-development.up.railway.app';

  const rows = [];

  for (const stage of plan.stages) {
    if (args.stage && stage.name !== args.stage) continue;

    if (stage.depends_on?.length) {
      const canRun = stage.depends_on.every((name) => stagePassed(rows, name));
      if (!canRun) {
        console.log(`Skipping stage ${stage.name}: dependencies not fully passed.`);
        continue;
      }
    }

    console.log(`\n=== Stage: ${stage.name} ===`);

    for (const test of stage.tests) {
      if (args.test && test.id !== args.test) continue;
      console.log(`Running ${test.id}...`);

      const missing = missingEnvVars(test.requires_env || []);
      let api;
      let ui;
      let db;
      let skippedReason = null;

      if (missing.length > 0) {
        skippedReason = `missing required env vars: ${missing.join(', ')}`;
        api = defaultBlocked(skippedReason);
        ui = defaultBlocked(skippedReason);
        db = defaultBlocked(skippedReason);
      } else {
        api = await runApiCheck({
          apiUrl,
          testId: test.id,
          check: test.api_check,
          artifactDir: path.join(root, 'artifacts', 'api'),
        });
        ui = await runUiCheck({
          baseUrl,
          testId: test.id,
          check: test.ui_check,
          artifactDir: path.join(root, 'artifacts', 'ui'),
        });
        db = await runDbCheck({
          testId: test.id,
          check: test.db_check,
          artifactDir: path.join(root, 'artifacts', 'db'),
        });
      }

      const row = assemble({ stage: stage.name, test, api, ui, db, skippedReason });
      rows.push(row);
      console.log(`${test.id} => ${row.final_status}`);
    }
  }

  await writeJson(reportPath, rows);
  console.log(`\nReport written: ${reportPath}`);
}

async function smoke() {
  const baseUrl = process.env.BASE_URL || 'https://serviceosweb-development.up.railway.app';
  const apiUrl = process.env.API_URL || 'https://serviceosapi-development.up.railway.app';

  const health = await runApiCheck({
    apiUrl,
    testId: 'SMOKE-API',
    check: { method: 'GET', endpoint: '/health', expect_statuses: [200] },
    artifactDir: path.join(root, 'artifacts', 'api'),
  });

  const ui = await runUiCheck({
    baseUrl,
    testId: 'SMOKE-UI',
    check: { path: '/login', expect_text: 'Fieldly' },
    artifactDir: path.join(root, 'artifacts', 'ui'),
  });

  const db = await runDbCheck({
    testId: 'SMOKE-DB',
    check: { query: 'SELECT 1 AS ok;', required: false },
    artifactDir: path.join(root, 'artifacts', 'db'),
  });

  console.log({ health: health.status, ui: ui.status, db: db.status });
}

async function doctor() {
  const checks = [
    ['BASE_URL', process.env.BASE_URL || 'https://serviceosweb-development.up.railway.app (default)'],
    ['API_URL', process.env.API_URL || 'https://serviceosapi-development.up.railway.app (default)'],
    ['AUTH_BEARER_TOKEN', process.env.AUTH_BEARER_TOKEN ? 'set' : 'missing'],
    ['DB_CHECK_COMMAND', process.env.DB_CHECK_COMMAND ? 'set' : 'missing'],
  ];

  console.log('\nQA Doctor\n---------');
  for (const [name, value] of checks) {
    console.log(`${name}: ${value}`);
  }

  console.log('\nTip: run `npm run qa:smoke-tools` then `npm run qa:run` once API/Web are reachable.');
}

async function summary() {
  const raw = await fs.readFile(reportPath, 'utf8');
  const rows = JSON.parse(raw);
  const totals = rows.reduce((acc, r) => {
    acc[r.final_status] = (acc[r.final_status] || 0) + 1;
    return acc;
  }, {});

  const byStage = {};
  for (const r of rows) {
    byStage[r.stage] ||= { pass: 0, fail: 0, blocked: 0, total: 0 };
    byStage[r.stage][r.final_status] += 1;
    byStage[r.stage].total += 1;
  }

  const lines = ['# QA Summary', '', `Totals: ${JSON.stringify(totals)}`, ''];
  for (const [stage, stats] of Object.entries(byStage)) {
    lines.push(`- ${stage}: ${stats.pass} pass / ${stats.fail} fail / ${stats.blocked} blocked (total ${stats.total})`);
  }

  const mdPath = path.join(root, 'reports', 'summary.md');
  await fs.writeFile(mdPath, `${lines.join('\n')}\n`);
  console.log(`Summary written: ${mdPath}`);
}

const args = parseArgs(process.argv);
if (args.mode === 'smoke') await smoke();
else if (args.mode === 'doctor') await doctor();
else if (args.mode === 'summary') await summary();
else await run();
