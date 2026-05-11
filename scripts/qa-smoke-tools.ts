#!/usr/bin/env tsx
/**
 * qa-smoke-tools — validate the QA matrix harness itself before running it.
 *
 * Confirms the local toolchain has everything the matrix needs:
 *   - tsx works (because this script is running, it does — we still print it)
 *   - Playwright is installed (`npx playwright --version`)
 *   - Stripe CLI is installable / available (for INV-05 webhook forwarding)
 *
 * Prints [OK] / [WARN] / [TODO] per check. Exits 0 on success even if Stripe
 * CLI is missing — only Playwright is hard-required for the matrix run. Stripe
 * CLI is only needed for INV-05 webhook rows; we treat its absence as a TODO
 * so the user can decide to skip those rows or install the CLI.
 *
 * Usage:
 *   npx tsx scripts/qa-smoke-tools.ts
 *   npm run qa:smoke-tools
 */

import { spawnSync } from 'node:child_process';

type Status = 'OK' | 'WARN' | 'TODO' | 'FAIL';

interface ToolCheck {
  name: string;
  status: Status;
  detail: string;
}

function symbol(status: Status): string {
  if (status === 'OK') return '[OK]  ';
  if (status === 'WARN') return '[WARN]';
  if (status === 'TODO') return '[TODO]';
  return '[FAIL]';
}

function runQuiet(cmd: string, args: string[]): { ok: boolean; out: string; err: string } {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = (r.stdout ?? '').toString().trim();
    const err = (r.stderr ?? '').toString().trim();
    return { ok: r.status === 0, out, err };
  } catch (e) {
    return { ok: false, out: '', err: e instanceof Error ? e.message : String(e) };
  }
}

function checkTsx(): ToolCheck {
  // We are running under tsx; reaching this line confirms it works.
  const v = process.versions?.node ?? 'unknown';
  return {
    name: 'tsx',
    status: 'OK',
    detail: `running under Node ${v}; tsx loaded this script successfully`,
  };
}

function checkPlaywright(): ToolCheck {
  const r = runQuiet('npx', ['--no-install', 'playwright', '--version']);
  if (r.ok && r.out) {
    return { name: 'Playwright', status: 'OK', detail: r.out };
  }
  // Fall back to `npx playwright --version` which can auto-install.
  const r2 = runQuiet('npx', ['playwright', '--version']);
  if (r2.ok && r2.out) {
    return { name: 'Playwright', status: 'OK', detail: r2.out };
  }
  return {
    name: 'Playwright',
    status: 'FAIL',
    detail: `not installed. Run: npm install. (${r.err || r2.err || 'no output'})`,
  };
}

function checkStripeCli(): ToolCheck {
  const r = runQuiet('stripe', ['--version']);
  if (r.ok && r.out) {
    return {
      name: 'Stripe CLI',
      status: 'OK',
      detail: `${r.out} — for INV-05, run: stripe listen --forward-to $E2E_API_URL/webhooks/stripe`,
    };
  }
  return {
    name: 'Stripe CLI',
    status: 'TODO',
    detail:
      'not on PATH. Required ONLY for INV-05 webhook rows. Install: `brew install stripe/stripe-cli/stripe` (mac) or see https://stripe.com/docs/stripe-cli',
  };
}

function checkPgClient(): ToolCheck {
  // We don't shell out to psql — the helpers use the `pg` npm package. Just
  // verify it's resolvable.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require.resolve('pg');
    return { name: 'pg (npm)', status: 'OK', detail: 'resolved from node_modules' };
  } catch {
    return {
      name: 'pg (npm)',
      status: 'FAIL',
      detail: 'package `pg` not installed. Run: npm install',
    };
  }
}

function checkNodeVersion(): ToolCheck {
  const major = parseInt(process.versions.node.split('.')[0]!, 10);
  if (major >= 20) {
    return { name: 'Node.js', status: 'OK', detail: `v${process.versions.node} (>=20 OK)` };
  }
  return {
    name: 'Node.js',
    status: 'WARN',
    detail: `v${process.versions.node} is below 20. The matrix uses fetch() and AbortController; upgrade is recommended.`,
  };
}

function main(): void {
  console.log('qa-smoke-tools — harness toolchain checks\n');

  const checks: ToolCheck[] = [
    checkNodeVersion(),
    checkTsx(),
    checkPlaywright(),
    checkPgClient(),
    checkStripeCli(),
  ];

  for (const c of checks) {
    console.log(`${symbol(c.status)} ${c.name.padEnd(14)} ${c.detail}`);
  }

  const fails = checks.filter((c) => c.status === 'FAIL');
  const warns = checks.filter((c) => c.status === 'WARN');
  const todos = checks.filter((c) => c.status === 'TODO');

  console.log('');
  console.log(
    `Summary: ${checks.length - fails.length - warns.length - todos.length} OK, ` +
      `${warns.length} WARN, ${todos.length} TODO, ${fails.length} FAIL`,
  );

  if (fails.length > 0) {
    console.log('');
    console.log('Hard failures (matrix cannot run):');
    for (const f of fails) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }

  if (todos.length > 0) {
    console.log('');
    console.log('TODOs (matrix can run, but some rows may be skipped):');
    for (const t of todos) console.log(`  - ${t.name}: ${t.detail}`);
  }
}

main();
