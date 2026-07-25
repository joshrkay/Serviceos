#!/usr/bin/env tsx
/**
 * collect-quality-metrics — emits the engineering-quality baseline as JSON.
 *
 * The point is that later weeks diff against a recorded artifact instead of
 * against recollection. Every number here is measured, never asserted: if a
 * metric cannot be computed it reports null rather than a stale constant.
 *
 * Reads an ESLint JSON report when one is present (produced by
 * `npm run lint:eslint:report`) but never runs ESLint itself — type-aware
 * linting takes minutes, and this script needs to stay cheap enough to run in
 * any CI job.
 *
 * Usage:
 *   npm run quality:metrics
 *   npm run quality:metrics -- --out quality-metrics.json
 *   npm run quality:metrics -- --eslint-report eslint-report.json
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

interface EslintFileReport {
  filePath: string;
  errorCount: number;
  warningCount: number;
  messages: Array<{ ruleId: string | null; message: string }>;
}

function countLines(relPath: string): number | null {
  const full = path.join(REPO_ROOT, relPath);
  if (!existsSync(full)) return null;
  return readFileSync(full, 'utf8').split('\n').length;
}

/** Counts regex matches in a file, or null when the file is missing. */
function countMatches(relPath: string, pattern: RegExp): number | null {
  const full = path.join(REPO_ROOT, relPath);
  if (!existsSync(full)) return null;
  return (readFileSync(full, 'utf8').match(pattern) ?? []).length;
}

function countFilesIn(relDir: string, ext = '.ts'): number | null {
  const full = path.join(REPO_ROOT, relDir);
  if (!existsSync(full)) return null;
  return readdirSync(full).filter((f) => f.endsWith(ext)).length;
}

/**
 * Repo-wide grep count. Uses git grep so it respects .gitignore and never
 * walks node_modules.
 */
function gitGrepCount(pattern: string, globs: string[]): number | null {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-I', '--no-color', '-o', '-e', pattern, '--', ...globs],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
    ).toString();
    return out.split('\n').filter((l) => l.trim().length > 0).length;
  } catch (err) {
    // git grep exits 1 when there are no matches — that is zero, not failure.
    const status = (err as { status?: number }).status;
    return status === 1 ? 0 : null;
  }
}

/** Counts `node-version:` pins in workflows that are NOT an exact patch. */
function nodePinAudit(): {
  nvmrc: string | null;
  enginesNode: string | null;
  workflowPins: Record<string, number>;
  looseWorkflowPins: number;
  dockerfilePins: string[];
  allExact: boolean;
} {
  const nvmrcPath = path.join(REPO_ROOT, '.nvmrc');
  const nvmrc = existsSync(nvmrcPath)
    ? readFileSync(nvmrcPath, 'utf8').trim()
    : null;

  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { engines?: { node?: string } };

  const wfDir = path.join(REPO_ROOT, '.github', 'workflows');
  const workflowPins: Record<string, number> = {};
  let loose = 0;
  if (existsSync(wfDir)) {
    for (const file of readdirSync(wfDir).filter((f) => f.endsWith('.yml'))) {
      const body = readFileSync(path.join(wfDir, file), 'utf8');
      for (const m of body.matchAll(/node-version:\s*'?([^'\n]+)'?/g)) {
        const version = m[1].trim();
        workflowPins[version] = (workflowPins[version] ?? 0) + 1;
        // node-version-file delegates to .nvmrc, which is exact.
        if (!/^\d+\.\d+\.\d+$/.test(version)) loose += 1;
      }
      for (const _ of body.matchAll(/node-version-file:/g)) {
        workflowPins['(from .nvmrc)'] = (workflowPins['(from .nvmrc)'] ?? 0) + 1;
      }
    }
  }

  const dockerfilePath = path.join(REPO_ROOT, 'Dockerfile');
  const dockerfilePins = existsSync(dockerfilePath)
    ? [...readFileSync(dockerfilePath, 'utf8').matchAll(/^FROM (node:[^\s]+)/gm)].map(
        (m) => m[1],
      )
    : [];

  const exactNvmrc = nvmrc !== null && /^\d+\.\d+\.\d+$/.test(nvmrc);
  const exactDocker = dockerfilePins.every((p) => /^node:\d+\.\d+\.\d+-/.test(p));

  return {
    nvmrc,
    enginesNode: pkg.engines?.node ?? null,
    workflowPins,
    looseWorkflowPins: loose,
    dockerfilePins,
    allExact: exactNvmrc && exactDocker && loose === 0,
  };
}

/**
 * Counts entries in the MIGRATIONS object in db/schema.ts.
 *
 * Scoped by brace matching rather than a whole-file regex: schema.ts contains
 * other 2-space-indented object keys, and counting those inflated the number
 * by 13 (278 instead of 265).
 */
export function countMigrations(
  source: string = readFileSync(
    path.join(REPO_ROOT, 'packages/api/src/db/schema.ts'),
    'utf8',
  ),
): number | null {
  const decl = source.indexOf('export const MIGRATIONS = {');
  if (decl === -1) return null;

  const open = source.indexOf('{', decl);
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;

  const body = source.slice(open + 1, close);
  return (body.match(/^ {2}(?:[a-zA-Z0-9_]+|'[^']+'):/gm) ?? []).length;
}

function eslintSummary(reportPath: string | null): {
  reportPath: string | null;
  filesScanned: number | null;
  errors: number | null;
  warnings: number | null;
  byRule: Record<string, number> | null;
  unusedDisableDirectives: number | null;
  undefinedRuleReferences: number | null;
} {
  const empty = {
    reportPath,
    filesScanned: null,
    errors: null,
    warnings: null,
    byRule: null,
    unusedDisableDirectives: null,
    undefinedRuleReferences: null,
  };
  if (!reportPath || !existsSync(reportPath)) return empty;

  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as EslintFileReport[];
  const byRule: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  let unusedDirectives = 0;
  let undefinedRules = 0;

  for (const file of report) {
    errors += file.errorCount;
    warnings += file.warningCount;
    for (const m of file.messages) {
      const key = m.ruleId ?? '(no-rule)';
      byRule[key] = (byRule[key] ?? 0) + 1;
      if (m.message.startsWith('Unused eslint-disable directive')) unusedDirectives += 1;
      if (/^Definition for rule .* was not found/.test(m.message)) undefinedRules += 1;
    }
  }

  const sorted = Object.fromEntries(
    Object.entries(byRule).sort((a, b) => b[1] - a[1]),
  );

  return {
    reportPath,
    filesScanned: report.length,
    errors,
    warnings,
    byRule: sorted,
    unusedDisableDirectives: unusedDirectives,
    undefinedRuleReferences: undefinedRules,
  };
}

export function collect(eslintReportPath: string | null): Record<string, unknown> {
  const appTs = 'packages/api/src/app.ts';

  return {
    // Stamped by the caller, not here: Date.now() would make the artifact
    // differ on every run and defeat diffing.
    schemaVersion: 1,

    modularity: {
      appTsLines: countLines(appTs),
      // createApp() runs from its declaration to the final closing brace.
      createAppSpan: (() => {
        const full = path.join(REPO_ROOT, appTs);
        if (!existsSync(full)) return null;
        const lines = readFileSync(full, 'utf8').split('\n');
        const start = lines.findIndex((l) => l.startsWith('export function createApp'));
        if (start === -1) return null;
        let end = -1;
        for (let i = lines.length - 1; i > start; i -= 1) {
          if (lines[i] === '}') {
            end = i;
            break;
          }
        }
        return end === -1 ? null : { startLine: start + 1, endLine: end + 1, lines: end - start + 1 };
      })(),
      schemaTsLines: countLines('packages/api/src/db/schema.ts'),
      // The real shape of the app.ts problem: DI wiring, not route handlers.
      repositoryInstantiations: countMatches(appTs, /new [A-Za-z]*Repo[A-Za-z]*\(/g),
      serviceInstantiations: countMatches(appTs, /new [A-Za-z]*Service\(/g),
      routerFactoryCalls: countMatches(appTs, /create[A-Za-z]*Router\(/g),
      appUseMounts: countMatches(appTs, /app\.use\(/g),
      inlineRouteHandlers: countMatches(appTs, /app\.(get|post|put|patch|delete)\(/g),
      imports: countMatches(appTs, /^import /gm),
      extractedRouteModules: countFilesIn('packages/api/src/routes'),
    },

    staticAnalysis: {
      eslintConfigPresent: existsSync(path.join(REPO_ROOT, 'eslint.config.mjs')),
      eslintBlocking: false, // report-only until the counts below come down
      suppressionComments: gitGrepCount('eslint-disable', [
        '*.ts',
        '*.tsx',
        '*.js',
        '*.jsx',
        '*.mjs',
      ]),
      eslint: eslintSummary(eslintReportPath),
    },

    reproducibility: nodePinAudit(),

    migrations: {
      // Every migration is replayed on every boot: applyMigrations() issues
      // getMigrationSQL() as one concatenated query under a 25s
      // statement_timeout. There is no ledger table on the deploy path.
      migrationCount: countMigrations(),
      hasLedgerTable:
        (gitGrepCount('schema_migrations', ['packages/api/src/db/*.ts']) ?? 0) > 0,
      replaysAllOnBoot:
        (countMatches(
          'packages/api/src/db/migrate.ts',
          /client\.query\(getMigrationSQL\(\)\)/g,
        ) ?? 0) > 0,
      hasAdvisoryLock:
        (countMatches(
          'packages/api/src/db/migrate.ts',
          /pg_advisory_lock/g,
        ) ?? 0) > 0,
    },

    dependencyHygiene: {
      auditGatePresent: existsSync(
        path.join(REPO_ROOT, '.github', 'workflows', 'dependency-audit.yml'),
      ),
      dependabotPresent: existsSync(path.join(REPO_ROOT, '.github', 'dependabot.yml')),
      exceptions: (() => {
        const file = path.join(REPO_ROOT, '.github', 'dependency-exceptions.json');
        if (!existsSync(file)) return null;
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
          exceptions?: Array<{ package: string; advisory: string; expires: string }>;
        };
        return (parsed.exceptions ?? []).map((e) => ({
          package: e.package,
          advisory: e.advisory,
          expires: e.expires,
        }));
      })(),
    },

    characterization: {
      routeManifestTestPresent: existsSync(
        path.join(REPO_ROOT, 'packages/api/test/app/route-manifest.test.ts'),
      ),
      routeManifestSnapshotPresent: existsSync(
        path.join(
          REPO_ROOT,
          'packages/api/test/app/__snapshots__/route-manifest.test.ts.snap',
        ),
      ),
    },
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const reportIdx = argv.indexOf('--eslint-report');

  const defaultReport = path.join(REPO_ROOT, 'eslint-report.json');
  const eslintReport =
    reportIdx !== -1 && argv[reportIdx + 1]
      ? argv[reportIdx + 1]
      : existsSync(defaultReport)
        ? defaultReport
        : null;

  const metrics = collect(eslintReport);
  const json = JSON.stringify(metrics, null, 2);

  if (outIdx !== -1 && argv[outIdx + 1]) {
    writeFileSync(argv[outIdx + 1], `${json}\n`);
    console.log(`wrote ${argv[outIdx + 1]}`);
    return;
  }
  console.log(json);
}

if (require.main === module) {
  main();
}
