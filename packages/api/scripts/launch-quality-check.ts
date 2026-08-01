#!/usr/bin/env tsx
/**
 * §11 Launch Quality Bar tally.
 *
 * Verifies all 12 bar items (5 hardening H* + 3 discipline D* + ack-backed
 * human verifications) and prints PASS/FAIL for each. Exits 0 if all pass,
 * 1 otherwise. Run before opening self-serve onboarding.
 *
 * Reads:
 *   - Filesystem (migration files, test files, runbooks, workflows).
 *   - packages/api/.launch-quality-acks.json (timestamps for human-verified items).
 *   - Source files (greps for compile-checked invariants).
 *
 * Does NOT call external APIs (GitHub Actions, Sentry). Those are tier-2
 * concerns; trust filesystem + acks at tier 1.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

interface Check {
  id: string;
  description: string;
  pass: boolean;
  detail?: string;
}

// Resolve repo root + packages/api regardless of where the script is invoked from.
const HERE = __dirname; // packages/api/scripts
const API = join(HERE, '..');
const ROOT = join(API, '..', '..');

const checks: Check[] = [];

function check(
  id: string,
  description: string,
  predicate: () => boolean | { pass: boolean; detail?: string },
): void {
  try {
    const r = predicate();
    if (typeof r === 'boolean') {
      checks.push({ id, description, pass: r });
    } else {
      checks.push({ id, description, ...r });
    }
  } catch (e) {
    checks.push({
      id,
      description,
      pass: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

// ----- H1: executor idempotency by default + unique index -----

check('H1.1', 'IdempotencyGuard required on ProposalExecutor (compile-checked)', () => {
  const src = readFileSync(join(API, 'src/proposals/execution/executor.ts'), 'utf8');
  const hasRequired = /idempotency:\s*IdempotencyGuard\b/.test(src);
  const hasOptional = /idempotency\?:\s*IdempotencyGuard/.test(src);
  return hasRequired && !hasOptional;
});

check('H1.2', 'proposal_executions partial unique index (migration 099)', () => {
  // The .sql files under src/db/migrations/ were documentation copies only
  // (never executed at runtime — see docs/runbooks/migration-discipline.md)
  // and were removed 2026-07; the MIGRATIONS map in schema.ts is the sole
  // source of truth, so assert directly against it.
  const schema = readFileSync(join(API, 'src/db/schema.ts'), 'utf8');
  return schema.includes("'099_proposal_executions_idempotency_index'") &&
    schema.includes('proposal_executions_tenant_idempotency_uniq');
});

// ----- H2: voice e2e smoke -----

check('H2.A', 'synthetic voice smoke wired in deploy workflow', () => {
  const yml = join(ROOT, '.github/workflows/deploy.yml');
  if (!existsSync(yml)) return { pass: false, detail: 'deploy.yml missing' };
  return readFileSync(yml, 'utf8').includes('voice-smoke.synthetic');
});

check('H2.B', 'voice-smoke-real.yml scheduled cron exists', () => {
  const yml = join(ROOT, '.github/workflows/voice-smoke-real.yml');
  return existsSync(yml);
});

// ----- H3: alerting runbook + instrument() helper wired in 4 paths -----

check('H3', 'alerting runbook + instrument() wraps 4 critical paths', () => {
  const runbook = join(ROOT, 'docs/runbooks/alerting.md');
  if (!existsSync(runbook)) return { pass: false, detail: 'alerting.md missing' };

  const wraps = [
    { path: 'src/payments/stripe-webhook-handler.ts', tag: 'stripe-webhook' },
    { path: 'src/workers/execution-worker.ts', tag: 'execution-worker' },
    { path: 'src/workers/voice-action-router.ts', tag: 'voice-action-router' },
    { path: 'src/telephony/media-streams/twilio-mediastream-server.ts', tag: 'voice' },
  ];
  const missing = wraps.filter(({ path, tag }) => {
    const src = readFileSync(join(API, path), 'utf8');
    return !src.includes("path: '" + tag + "'") && !src.includes('path: "' + tag + '"');
  });
  if (missing.length > 0) {
    return { pass: false, detail: `not wrapped: ${missing.map((m) => m.tag).join(', ')}` };
  }
  return true;
});

// ----- H4: rollback + migration discipline -----

check('H4.1', 'rollback runbook present', () =>
  existsSync(join(ROOT, 'docs/runbooks/rollback.md')),
);

check('H4.2', 'migration-discipline runbook present', () =>
  existsSync(join(ROOT, 'docs/runbooks/migration-discipline.md')),
);

check('H4.3', 'migration-discipline guard test present', () =>
  existsSync(join(API, 'test/db/migration-discipline.test.ts')),
);

// ----- H5: voice load test + capacity runbook (acks-backed) -----

check('H5', 'voice-capacity.md updated within 30 days', () => {
  if (!existsSync(join(ROOT, 'docs/runbooks/voice-capacity.md'))) {
    return { pass: false, detail: 'voice-capacity.md missing' };
  }
  const acksPath = join(API, '.launch-quality-acks.json');
  if (!existsSync(acksPath)) {
    return { pass: false, detail: '.launch-quality-acks.json missing' };
  }
  const acks = JSON.parse(readFileSync(acksPath, 'utf8'));
  if (!acks.voice_capacity_run) {
    return { pass: false, detail: 'no voice_capacity_run timestamp recorded' };
  }
  const age = Date.now() - new Date(acks.voice_capacity_run).getTime();
  if (age >= 30 * 24 * 3600 * 1000) {
    return {
      pass: false,
      detail: `voice_capacity_run is ${Math.floor(age / 86400000)} days old; re-run the load test`,
    };
  }
  return true;
});

// ----- D: discipline (must stay green) -----

function runVitest(testPath: string): boolean {
  try {
    execSync(`npx vitest run ${testPath}`, { cwd: API, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

check('D1', 'decisions.test green', () =>
  runVitest('test/decisions/decisions.test.ts'),
);

check('D2', 'smoke + owner-loop critical path tests present', () =>
  existsSync(join(API, 'scripts/smoke-test.ts')) &&
  existsSync(join(API, 'test/voice/voice-smoke.synthetic.test.ts')) &&
  existsSync(join(API, 'test/owner-loop-critical-path.test.ts')),
);

check('D3', 'migration-immutability green', () =>
  runVitest('test/db/migration-immutability.test.ts'),
);

// ----- Render -----

const padId = Math.max(...checks.map((c) => c.id.length));
const padDesc = Math.max(...checks.map((c) => c.description.length));
const passed = checks.filter((c) => c.pass).length;

console.log('\nLaunch Quality Bar (tier 1 — 10–50 customers)');
for (const c of checks) {
  const tag = c.pass ? '[PASS]' : '[FAIL]';
  const line = `  ${tag} ${c.id.padEnd(padId)}  ${c.description.padEnd(padDesc)}`;
  console.log(c.detail ? `${line} — ${c.detail}` : line);
}
const verdict =
  passed === checks.length
    ? 'PASS — bar is met. Safe to open self-serve.'
    : 'FAIL — bar is NOT met.';
console.log(`\n${passed}/${checks.length} ${verdict}\n`);

// Operator advisories — do not fail the bar; surface incomplete human steps.
const acksPath = join(API, '.launch-quality-acks.json');
if (existsSync(acksPath)) {
  const acks = JSON.parse(readFileSync(acksPath, 'utf8')) as {
    alerting_runbook_verified?: string | null;
    voice_capacity_provenance?: string;
  };
  const advisories: string[] = [];
  if (!acks.alerting_runbook_verified) {
    advisories.push(
      'H3 operator: Sentry→Slack E2E not acked — complete docs/runbooks/alerting.md verification and set alerting_runbook_verified in .launch-quality-acks.json',
    );
  }
  if (
    typeof acks.voice_capacity_provenance === 'string' &&
    acks.voice_capacity_provenance.includes('harness-self-check')
  ) {
    advisories.push(
      'H5 operator: only harness self-check recorded — run voice-load:staging before high-traffic launch (docs/runbooks/voice-capacity.md)',
    );
  }
  if (advisories.length > 0) {
    console.log('Operator advisories (bar still passes):');
    for (const a of advisories) {
      console.log(`  [WARN] ${a}`);
    }
    console.log('');
  }
}

process.exit(passed === checks.length ? 0 : 1);
