#!/usr/bin/env tsx
/**
 * doctor — pre-flight checker for the local development environment.
 *
 * Answers one question: "is this machine set up to produce the same results
 * as CI?" Every check reports a remediation line, so a failure tells you what
 * to run rather than what went wrong.
 *
 * Checks:
 *   - Node version matches .nvmrc EXACTLY (major.minor.patch). CI, the
 *     Dockerfile, and .nvmrc all pin the same patch; a local mismatch is the
 *     single most common source of "works on my machine".
 *   - npm major satisfies the root `engines.npm` range.
 *   - Root node_modules present (covers packages/api, web, shared via
 *     workspaces).
 *   - packages/mobile/node_modules present. Mobile is NOT a root workspace and
 *     carries its own lockfile, so `npm ci` at the root does not install it.
 *     This is the "two install locations" trap.
 *   - Docker reachable — only with `--integration`, since the integration
 *     suite uses Testcontainers.
 *   - Env vars named in .env.example are present (warns, does not fail: most
 *     are only needed for specific suites).
 *
 * Usage:
 *   npx tsx scripts/doctor.ts
 *   npm run doctor
 *   npm run doctor -- --integration
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

type Status = 'OK' | 'FAIL' | 'warn' | 'skip';

export interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  /** Shown only when the check did not pass. */
  remedy?: string;
  required: boolean;
}

const REPO_ROOT = path.resolve(__dirname, '..');

function symbol(status: Status): string {
  if (status === 'OK') return '✓';
  if (status === 'FAIL') return '✗';
  if (status === 'warn') return '!';
  return '-';
}

export function parseIntegrationFlag(argv: string[] = process.argv): boolean {
  return argv.includes('--integration');
}

/**
 * Whether to report problems without failing the process.
 *
 * `npm run verify` uses this. Doctor checks the *environment*; typecheck, lint,
 * and test check the *code*. Chaining them with `&&` meant a machine whose Node
 * differs from `.nvmrc` could not run the correctness gate at all — which is
 * exactly the situation in the provided dev container, so `verify` was unusable
 * there. Advisory mode keeps the drift visible without blocking the checks that
 * do not depend on it. Invoked directly, `npm run doctor` still exits non-zero.
 */
export function parseWarnOnlyFlag(argv: string[] = process.argv): boolean {
  return argv.includes('--warn-only');
}

/** Reads the pinned version from .nvmrc, tolerating a `v` prefix and whitespace. */
export function readNvmrc(root: string = REPO_ROOT): string | null {
  const file = path.join(root, '.nvmrc');
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) return null;
  return raw.replace(/^v/, '');
}

/**
 * Compares a running Node version against the .nvmrc pin. Exact match is
 * required: the whole point of pinning a patch is that a patch drift is
 * visible. Returns null when there is nothing to compare against.
 */
export function checkNodeVersion(
  running: string,
  pinned: string | null,
): CheckResult {
  const actual = running.replace(/^v/, '');
  if (pinned === null) {
    return {
      name: 'node version',
      status: 'FAIL',
      detail: '.nvmrc missing or empty — no pinned version to compare against',
      remedy: 'Restore .nvmrc with an exact version (e.g. 20.20.2).',
      required: true,
    };
  }
  if (actual === pinned) {
    return {
      name: 'node version',
      status: 'OK',
      detail: `v${actual} matches .nvmrc`,
      required: true,
    };
  }
  const sameMajor = actual.split('.')[0] === pinned.split('.')[0];
  return {
    name: 'node version',
    status: 'FAIL',
    detail: `running v${actual}, .nvmrc pins ${pinned}${sameMajor ? ' (same major, different patch)' : ' (DIFFERENT MAJOR)'}`,
    remedy: `nvm install ${pinned} && nvm use ${pinned}   (or: fnm use ${pinned})`,
    required: true,
  };
}

/**
 * Checks the npm major against `engines.npm`, which is declared in the
 * `<major>.x` form. Only the major is compared, deliberately: npm patch drift
 * within a major has never broken reproducibility here, and pinning an exact
 * npm patch would fail on every fresh Node install (each Node release bundles
 * its own npm patch).
 *
 * This does a major comparison rather than full semver-range evaluation so the
 * check has no dependency and no hand-rolled range parser to get wrong.
 */
export function checkNpmVersion(
  running: string,
  enginesSpec: string | undefined,
): CheckResult {
  if (!enginesSpec) {
    return {
      name: 'npm version',
      status: 'skip',
      detail: 'no engines.npm declared',
      required: false,
    };
  }
  const wanted = Number(enginesSpec.match(/^\D*(\d+)/)?.[1]);
  if (!Number.isFinite(wanted)) {
    return {
      name: 'npm version',
      status: 'FAIL',
      detail: `cannot read a major version out of engines.npm "${enginesSpec}"`,
      remedy: 'Declare engines.npm in the "<major>.x" form, e.g. "10.x".',
      required: true,
    };
  }
  const major = Number(running.replace(/^v/, '').split('.')[0]);
  if (major === wanted) {
    return {
      name: 'npm version',
      status: 'OK',
      detail: `v${running} matches engines.npm "${enginesSpec}"`,
      required: true,
    };
  }
  return {
    name: 'npm version',
    status: 'FAIL',
    detail: `running npm v${running}, engines.npm wants major ${wanted} ("${enginesSpec}")`,
    remedy: `npm install -g npm@${wanted}`,
    required: true,
  };
}

/**
 * Verifies both install locations. Mobile is deliberately outside the root
 * workspaces array, so a root-only `npm ci` leaves it empty and its Vitest
 * suite fails in a way that looks like a code bug.
 */
export function checkInstallLocations(root: string = REPO_ROOT): CheckResult[] {
  const results: CheckResult[] = [];

  const rootModules = path.join(root, 'node_modules');
  results.push(
    existsSync(rootModules)
      ? {
          name: 'root node_modules',
          status: 'OK',
          detail: 'present (api, web, shared via workspaces)',
          required: true,
        }
      : {
          name: 'root node_modules',
          status: 'FAIL',
          detail: 'missing',
          remedy: 'npm ci',
          required: true,
        },
  );

  const mobilePkg = path.join(root, 'packages', 'mobile', 'package.json');
  if (!existsSync(mobilePkg)) {
    results.push({
      name: 'mobile node_modules',
      status: 'skip',
      detail: 'packages/mobile absent',
      required: false,
    });
    return results;
  }

  // Mobile tests run with the root-hoisted vitest (see pr-checks.yml), so a
  // missing packages/mobile/node_modules is only fatal for Expo/RN tooling.
  // Warn rather than fail so `npm run doctor` stays green for API-only work.
  const mobileModules = path.join(root, 'packages', 'mobile', 'node_modules');
  results.push(
    existsSync(mobileModules)
      ? {
          name: 'mobile node_modules',
          status: 'OK',
          detail: 'present (separate lockfile — not a root workspace)',
          required: false,
        }
      : {
          name: 'mobile node_modules',
          status: 'warn',
          detail: 'missing — mobile is not a root workspace, so `npm ci` skips it',
          remedy: 'npm ci --prefix packages/mobile   (only needed for Expo/RN tooling)',
          required: false,
        },
  );

  return results;
}

export function checkDocker(integration: boolean): CheckResult {
  if (!integration) {
    return {
      name: 'docker',
      status: 'skip',
      detail: 'pass --integration to check (Testcontainers)',
      required: false,
    };
  }
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 15_000 });
    return {
      name: 'docker',
      status: 'OK',
      detail: 'daemon reachable',
      required: true,
    };
  } catch {
    return {
      name: 'docker',
      status: 'FAIL',
      detail: 'daemon not reachable',
      remedy: 'Start Docker, then: docker pull pgvector/pgvector:pg16',
      required: true,
    };
  }
}

/** Extracts the variable names declared in .env.example. */
export function parseEnvExampleKeys(contents: string): string[] {
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split('=')[0].trim())
    .filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key));
}

/**
 * Reports env vars named in .env.example that are unset. This is a warning,
 * not a failure: most vars only matter for a specific suite, and the API's own
 * validateEnvSchema is the authority at boot.
 */
export function checkEnvVars(
  root: string = REPO_ROOT,
  env: NodeJS.ProcessEnv = process.env,
): CheckResult {
  const file = path.join(root, '.env.example');
  if (!existsSync(file)) {
    return {
      name: 'env vars',
      status: 'skip',
      detail: '.env.example absent',
      required: false,
    };
  }
  const keys = parseEnvExampleKeys(readFileSync(file, 'utf8'));
  const missing = keys.filter((k) => !env[k]);
  if (missing.length === 0) {
    return {
      name: 'env vars',
      status: 'OK',
      detail: `all ${keys.length} vars from .env.example are set`,
      required: false,
    };
  }
  const shown = missing.slice(0, 4).join(', ');
  return {
    name: 'env vars',
    status: 'warn',
    detail: `${missing.length}/${keys.length} unset (${shown}${missing.length > 4 ? ', …' : ''})`,
    remedy: 'cp .env.example .env && fill in the values you need',
    required: false,
  };
}

export async function runDoctor(
  opts: { integration?: boolean; root?: string } = {},
): Promise<CheckResult[]> {
  const root = opts.root ?? REPO_ROOT;
  const pkg = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8'),
  ) as { engines?: { npm?: string } };

  let npmVersion = '';
  try {
    npmVersion = execFileSync('npm', ['--version'], {
      stdio: 'pipe',
      timeout: 15_000,
    })
      .toString()
      .trim();
  } catch {
    npmVersion = '';
  }

  return [
    checkNodeVersion(process.version, readNvmrc(root)),
    npmVersion
      ? checkNpmVersion(npmVersion, pkg.engines?.npm)
      : {
          name: 'npm version',
          status: 'FAIL' as Status,
          detail: 'could not run `npm --version`',
          remedy: 'Reinstall Node/npm.',
          required: true,
        },
    ...checkInstallLocations(root),
    checkDocker(opts.integration === true),
    checkEnvVars(root),
  ];
}

async function main(): Promise<void> {
  const integration = parseIntegrationFlag();
  console.log(
    `doctor — local environment pre-flight${integration ? ' (with integration checks)' : ''}\n`,
  );

  const results = await runDoctor({ integration });
  for (const r of results) {
    console.log(`${symbol(r.status)} ${r.name.padEnd(22)} ${r.detail}`);
  }

  const failures = results.filter((r) => r.status === 'FAIL');
  const warnings = results.filter((r) => r.status === 'warn');
  const passed = results.filter((r) => r.status === 'OK');
  const skipped = results.filter((r) => r.status === 'skip');

  console.log('');
  console.log(
    `Summary: ${passed.length} OK, ${failures.length} FAIL, ${warnings.length} warn, ${skipped.length} skip`,
  );

  const actionable = [...failures, ...warnings].filter((r) => r.remedy);
  if (actionable.length > 0) {
    console.log('');
    console.log('To fix:');
    for (const r of actionable) {
      console.log(`  ${r.name}: ${r.remedy}`);
    }
  }

  if (failures.length > 0) {
    console.log('');
    if (parseWarnOnlyFlag()) {
      console.log(
        'Environment is NOT aligned with CI (advisory: --warn-only, continuing).',
      );
      return;
    }
    console.log('Environment is NOT aligned with CI. Fix the failures above.');
    process.exit(1);
  }

  console.log('');
  console.log('Environment matches CI. Next: npm run verify');
}

// Only run when invoked directly, so the checks stay importable from tests.
if (require.main === module) {
  main().catch((err) => {
    console.error('doctor crashed:', err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
