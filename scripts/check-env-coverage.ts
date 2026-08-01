#!/usr/bin/env tsx
/**
 * check-env-coverage — fail when the API reads an environment variable that
 * is neither part of the production env contract nor explicitly allowlisted.
 *
 * WHY THIS EXISTS
 *
 * Six times in one day the July 2026 audit found code that was written and
 * never wired up. A sweep of the running services found **85 environment
 * variables read by the API and set in NEITHER Railway environment**, among
 * them:
 *
 *   - GOOGLE_MAPS_API_KEY  — travel time silently falls back to straight-line
 *                            distance (scheduling/travel-time/factory.ts)
 *   - SENTRY_DSN           — no crash reporting anywhere
 *   - SUPERVISOR_DEFAULT_* — three spend / auto-approval caps, unset
 *
 * Every one of those is read with `?? someDefault`, so nothing ever failed
 * loudly. This guard makes "a var the code reads that nobody declared" a build
 * error instead of a silent behaviour change.
 *
 * WHAT COUNTS AS DECLARED
 *
 * CI cannot query Railway, so the checked-in production template
 * `.env.production.example` is the contract: a var appears there either as an
 * active `KEY=` line (must be set at deploy) or as a commented
 * `# KEY=default` line (a documented optional knob). Either way a human wrote
 * it down deliberately.
 *
 * Anything else must be listed in `scripts/env-allowlist.json`:
 *   - `optional`   — reviewed and genuinely fine unset (dev/test-only knobs,
 *                    platform-injected vars, escape hatches with a safe
 *                    default). Silent pass.
 *   - `unreviewed` — seeded from the state of the repo when this guard landed
 *                    so it does not fail on day one. These pass, but the
 *                    script prints them LOUDLY every run and `--strict` makes
 *                    them fail. Seeding is a backlog, not an endorsement.
 *
 * An allowlist entry for a var nothing reads any more also fails, so the file
 * cannot quietly rot (same posture as .github/dependency-exceptions.json).
 *
 * CHECKING A REAL ENVIRONMENT
 *
 * Pass `--env-file <path>` (repeatable) with a dotenv-style dump of an actual
 * environment (e.g. `railway variables --kv > prod.env`) to reproduce the
 * original sweep: vars are then "declared" only if they are in the template OR
 * actually set there. Not used in CI — CI has no access to Railway.
 *
 * Usage:
 *   npx tsx scripts/check-env-coverage.ts
 *   npx tsx scripts/check-env-coverage.ts --strict
 *   npx tsx scripts/check-env-coverage.ts --env-file prod.env
 *   npx tsx scripts/check-env-coverage.ts --json
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Source roots scanned for env reads. Scoped to the API's runtime source —
 * that is what "read by the API" means and what the Railway sweep covered.
 * Tests and scripts are excluded: they set their own env.
 */
export const SOURCE_ROOTS = ['packages/api/src'];

/** The checked-in production env contract. */
export const ENV_TEMPLATE = '.env.production.example';

/** Zod config schema — its keys are env vars read via `config.X`. */
export const CONFIG_SCHEMA_FILE = 'packages/api/src/shared/config.ts';

export const ALLOWLIST_PATH = path.join(REPO_ROOT, 'scripts', 'env-allowlist.json');

const SKIP_DIRS = new Set(['node_modules', '__tests__', '__mocks__', 'dist', 'build']);

export interface AllowlistEntry {
  name: string;
  reason: string;
}

export interface Allowlist {
  optional: AllowlistEntry[];
  unreviewed: AllowlistEntry[];
}

export interface EnvRead {
  name: string;
  /** Repo-relative `file:line` of the first occurrence. */
  where: string;
}

export interface CoverageResult {
  ok: boolean;
  /** Read, not declared, not allowlisted — these fail the build. */
  undeclared: EnvRead[];
  /** Read and on the `unreviewed` backlog — loud, fails only under --strict. */
  unreviewed: EnvRead[];
  /** Allowlisted but nothing reads them any more — these fail the build. */
  staleAllowlist: string[];
  /** Total env vars discovered. */
  totalRead: number;
  /** Total declared in the template (+ any --env-file snapshots). */
  totalDeclared: number;
}

// ── extraction ───────────────────────────────────────────────────────────────

/**
 * Patterns that constitute "the code reads this env var".
 *
 * The `env.NAME` form is NOT optional sugar: `GOOGLE_MAPS_API_KEY` — one of
 * the vars the sweep found missing — is read as `env.GOOGLE_MAPS_API_KEY` off
 * a `NodeJS.ProcessEnv` parameter, and a `process.env`-only scan misses it
 * entirely. The identifier is restricted to env-ish receiver names so an
 * unrelated `foo.SOME_CONSTANT` is not swept in; a false positive is cheap to
 * resolve (one allowlist line) and a false negative is the whole bug class.
 */
const READ_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  /\b(?:env|processEnv|rawEnv|envVars)\.([A-Z][A-Z0-9_]{2,})/g,
  /\b(?:env|processEnv|rawEnv|envVars)\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g,
];

/** Top-level zod schema keys in config.ts: `  SOME_VAR: z.…`. */
const CONFIG_KEY_PATTERN = /^ {2}([A-Z][A-Z0-9_]*)\s*:\s*z\./gm;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry) && !/\.(test|spec)\.[a-z]+$/.test(entry)) {
      out.push(full);
    }
  }
}

/** Collect every env var the API source reads, with a first-sighting location. */
export function collectEnvReads(repoRoot = REPO_ROOT): EnvRead[] {
  const found = new Map<string, string>();

  const record = (name: string, file: string, index: number, text: string) => {
    if (found.has(name)) return;
    const line = text.slice(0, index).split('\n').length;
    found.set(name, `${path.relative(repoRoot, file)}:${line}`);
  };

  const files: string[] = [];
  for (const root of SOURCE_ROOTS) {
    const abs = path.join(repoRoot, root);
    try {
      walk(abs, files);
    } catch {
      // A missing root is a repo-layout change, not a policy violation.
    }
  }

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of READ_PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of text.matchAll(pattern)) {
        record(m[1]!, file, m.index ?? 0, text);
      }
    }
  }

  // Keys declared in the zod config schema are read through `config.X` rather
  // than `process.env`, so they need their own pass.
  const configPath = path.join(repoRoot, CONFIG_SCHEMA_FILE);
  try {
    const text = readFileSync(configPath, 'utf8');
    for (const m of text.matchAll(CONFIG_KEY_PATTERN)) {
      record(m[1]!, configPath, m.index ?? 0, text);
    }
  } catch {
    // config.ts missing — the SOURCE_ROOTS scan still applies.
  }

  return [...found.entries()]
    .map(([name, where]) => ({ name, where }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Keys declared in a dotenv-style file. Commented `# KEY=value` lines COUNT:
 * in the production template a commented default is a deliberately documented
 * optional knob, which is exactly the state this guard wants to see.
 */
export function collectDeclaredKeys(contents: string): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim().replace(/^#\s*/, '');
    const m = /^([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

// ── gate ─────────────────────────────────────────────────────────────────────

export function evaluateCoverage(
  reads: EnvRead[],
  declared: Set<string>,
  allowlist: Allowlist,
  opts: { strict?: boolean } = {},
): CoverageResult {
  const optional = new Set(allowlist.optional.map((e) => e.name));
  const unreviewedSet = new Set(allowlist.unreviewed.map((e) => e.name));

  const undeclared: EnvRead[] = [];
  const unreviewed: EnvRead[] = [];

  for (const read of reads) {
    if (declared.has(read.name)) continue;
    if (optional.has(read.name)) continue;
    if (unreviewedSet.has(read.name)) {
      unreviewed.push(read);
      continue;
    }
    undeclared.push(read);
  }

  const readNames = new Set(reads.map((r) => r.name));
  const staleAllowlist = [...optional, ...unreviewedSet]
    .filter((name) => !readNames.has(name))
    .sort();

  const ok =
    undeclared.length === 0 &&
    staleAllowlist.length === 0 &&
    (!opts.strict || unreviewed.length === 0);

  return {
    ok,
    undeclared,
    unreviewed,
    staleAllowlist,
    totalRead: reads.length,
    totalDeclared: declared.size,
  };
}

export function loadAllowlist(file = ALLOWLIST_PATH): Allowlist {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Allowlist>;
  return {
    optional: parsed.optional ?? [],
    unreviewed: parsed.unreviewed ?? [],
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const asJson = argv.includes('--json');
  const envFiles: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env-file' && argv[i + 1]) envFiles.push(argv[++i]!);
  }

  const reads = collectEnvReads();
  const declared = collectDeclaredKeys(
    readFileSync(path.join(REPO_ROOT, ENV_TEMPLATE), 'utf8'),
  );
  for (const f of envFiles) {
    for (const k of collectDeclaredKeys(readFileSync(path.resolve(f), 'utf8'))) {
      declared.add(k);
    }
  }

  const result = evaluateCoverage(reads, declared, loadAllowlist(), { strict });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  console.log(
    `[env-coverage] ${result.totalRead} env vars read by ${SOURCE_ROOTS.join(', ')}; ` +
      `${result.totalDeclared} declared in ${ENV_TEMPLATE}` +
      (envFiles.length ? ` + ${envFiles.length} snapshot(s)` : ''),
  );

  if (result.unreviewed.length > 0) {
    console.log('');
    console.log(
      `[env-coverage] ${result.unreviewed.length} var(s) on the UNREVIEWED backlog — ` +
        'read by the API, absent from the production contract, not yet confirmed safe:',
    );
    for (const r of result.unreviewed) console.log(`  · ${r.name}  (${r.where})`);
    console.log(
      '  Move each to "optional" with a reason once verified, or add it to ' +
        `${ENV_TEMPLATE}. Run with --strict to make these fail.`,
    );
  }

  if (result.staleAllowlist.length > 0) {
    console.error('');
    console.error(
      '[env-coverage] FAIL: allowlist entries for vars nothing reads any more ' +
        '(delete them):',
    );
    for (const name of result.staleAllowlist) console.error(`  - ${name}`);
  }

  if (result.undeclared.length > 0) {
    console.error('');
    console.error(
      `[env-coverage] FAIL: ${result.undeclared.length} env var(s) read by the API but ` +
        'neither declared nor allowlisted:',
    );
    for (const r of result.undeclared) console.error(`  - ${r.name}  (${r.where})`);
    console.error('');
    console.error('Pick one:');
    console.error(
      `  1. It must be set in production → add it to ${ENV_TEMPLATE} (and set it ` +
        'in Railway — the template is a contract, not a deployment).',
    );
    console.error(
      '  2. It is genuinely optional with a safe default → add it to ' +
        'scripts/env-allowlist.json under "optional" WITH A REASON.',
    );
    console.error('  3. The code should not be reading it → delete the read.');
  }

  if (!result.ok) process.exit(1);
  console.log('[env-coverage] OK');
}

// Only run when invoked directly, so the unit test can import the helpers.
if (require.main === module) main();
