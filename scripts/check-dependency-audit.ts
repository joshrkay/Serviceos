#!/usr/bin/env tsx
/**
 * check-dependency-audit — gate on `npm audit` for the PRODUCTION tree.
 *
 * Policy (see docs/quality/dependency-audit-policy.md):
 *   - critical: always fails. Not exceptable.
 *   - high:     fails unless a matching, unexpired entry exists in
 *               .github/dependency-exceptions.json.
 *   - moderate/low/info: reported, never fails.
 *
 * An expired exception fails the build, so exceptions cannot rot quietly.
 * An exception that no longer matches any finding also fails, so the file
 * does not accumulate entries for vulnerabilities that are already gone.
 *
 * Dev-only vulnerabilities are deliberately out of scope here: they do not
 * ship. `--include-dev` reports them without affecting the exit code.
 *
 * Usage:
 *   npx tsx scripts/check-dependency-audit.ts
 *   npx tsx scripts/check-dependency-audit.ts --include-dev
 *   npx tsx scripts/check-dependency-audit.ts --audit-json <path>   # tests
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const EXCEPTIONS_PATH = path.join(REPO_ROOT, '.github', 'dependency-exceptions.json');

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

/** Severities that fail the build unless excepted. */
export const BLOCKING: readonly Severity[] = ['high', 'critical'];
/** Severities that cannot be excepted at all. */
export const NON_EXCEPTABLE: readonly Severity[] = ['critical'];

export interface Finding {
  package: string;
  severity: Severity;
  /** Advisory IDs (e.g. GHSA-xxxx-xxxx-xxxx) reported for this package. */
  advisories: string[];
  title: string;
  url: string;
  range: string;
}

export interface Exception {
  package: string;
  advisory: string;
  owner: string;
  rationale: string;
  mitigation: string;
  /** ISO date (YYYY-MM-DD). Past this date the build fails. */
  expires: string;
}

export interface GateResult {
  ok: boolean;
  blocking: Finding[];
  excepted: Array<{ finding: Finding; exception: Exception }>;
  informational: Finding[];
  expired: Exception[];
  unmatched: Exception[];
  errors: string[];
}

/** Narrows an arbitrary npm-audit severity string to our Severity union. */
function toSeverity(value: unknown): Severity {
  const s = String(value);
  if (
    s === 'info' ||
    s === 'low' ||
    s === 'moderate' ||
    s === 'high' ||
    s === 'critical'
  ) {
    return s;
  }
  return 'info';
}

/**
 * Flattens `npm audit --json` into a finding per vulnerable package. npm nests
 * the advisory detail under `via`, mixing advisory objects with plain strings
 * (transitive parents), so only the objects carry an ID/title/url.
 */
export function parseAuditJson(raw: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('npm audit did not return valid JSON');
  }
  const vulns =
    (parsed as { vulnerabilities?: Record<string, unknown> }).vulnerabilities ?? {};

  const findings: Finding[] = [];
  for (const [name, value] of Object.entries(vulns)) {
    const v = value as {
      severity?: unknown;
      range?: unknown;
      via?: unknown[];
    };
    const via = Array.isArray(v.via) ? v.via : [];
    const advisoryObjects = via.filter(
      (entry): entry is { source?: unknown; title?: unknown; url?: unknown } =>
        typeof entry === 'object' && entry !== null,
    );
    // GHSA IDs live at the tail of the advisory URL; `source` is a numeric
    // npm-internal id that is not stable enough to reference in a doc.
    const advisories = advisoryObjects
      .map((a) => String(a.url ?? '').split('/').filter(Boolean).pop() ?? '')
      .filter((id) => id.length > 0);

    findings.push({
      package: name,
      severity: toSeverity(v.severity),
      advisories,
      title: String(advisoryObjects[0]?.title ?? '(no title)'),
      url: String(advisoryObjects[0]?.url ?? ''),
      range: String(v.range ?? ''),
    });
  }
  return findings.sort((a, b) => a.package.localeCompare(b.package));
}

export function loadExceptions(filePath: string = EXCEPTIONS_PATH): Exception[] {
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
    exceptions?: Exception[];
  };
  return parsed.exceptions ?? [];
}

/** Every field is mandatory: an exception without an owner or expiry is a TODO. */
export function validateException(e: Exception, index: number): string[] {
  const errors: string[] = [];
  const required: Array<keyof Exception> = [
    'package',
    'advisory',
    'owner',
    'rationale',
    'mitigation',
    'expires',
  ];
  for (const field of required) {
    if (!e[field] || String(e[field]).trim().length === 0) {
      errors.push(`exceptions[${index}] is missing "${field}"`);
    }
  }
  if (e.expires && !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) {
    errors.push(
      `exceptions[${index}] has expires="${e.expires}" — must be YYYY-MM-DD`,
    );
  }
  return errors;
}

function matches(finding: Finding, e: Exception): boolean {
  return e.package === finding.package && finding.advisories.includes(e.advisory);
}

/**
 * Whether every advisory on a finding is individually excepted.
 *
 * npm reports one entry per vulnerable package, and that entry can carry
 * several advisory IDs. Matching on "some exception matches this finding"
 * would let a single documented advisory exempt every other advisory on the
 * same package — so a package with GHSA-A (reviewed, unreachable) and GHSA-B
 * (never looked at) would pass the gate silently. Requiring full coverage
 * means a new advisory against an already-excepted package blocks until
 * someone judges it on its own.
 *
 * A finding with no advisory IDs at all cannot be excepted: there is nothing
 * to attest to.
 */
export function exceptionsCovering(
  finding: Finding,
  usable: Exception[],
): Exception[] | null {
  if (finding.advisories.length === 0) return null;
  const covering: Exception[] = [];
  for (const advisory of finding.advisories) {
    const hit = usable.find(
      (e) => e.package === finding.package && e.advisory === advisory,
    );
    if (!hit) return null;
    covering.push(hit);
  }
  return covering;
}

/**
 * Applies the policy. `today` is injected so the expiry behaviour is testable
 * without freezing clocks.
 */
export function evaluate(
  findings: Finding[],
  exceptions: Exception[],
  today: string,
): GateResult {
  const errors = exceptions.flatMap((e, i) => validateException(e, i));

  const expired = exceptions.filter((e) => e.expires && e.expires < today);
  const usable = exceptions.filter((e) => !expired.includes(e));

  const blocking: Finding[] = [];
  const excepted: Array<{ finding: Finding; exception: Exception }> = [];
  const informational: Finding[] = [];

  for (const finding of findings) {
    if (!BLOCKING.includes(finding.severity)) {
      informational.push(finding);
      continue;
    }
    if (NON_EXCEPTABLE.includes(finding.severity)) {
      blocking.push(finding);
      continue;
    }
    // Every advisory on the finding must be excepted, not just one of them.
    const covering = exceptionsCovering(finding, usable);
    if (covering) {
      // Report against the soonest expiry, so the nearest deadline is visible.
      const soonest = covering.reduce((a, b) => (a.expires <= b.expires ? a : b));
      excepted.push({ finding, exception: soonest });
    } else {
      blocking.push(finding);
    }
  }

  const unmatched = exceptions.filter(
    (e) => !findings.some((f) => matches(f, e)),
  );

  return {
    ok:
      blocking.length === 0 &&
      expired.length === 0 &&
      unmatched.length === 0 &&
      errors.length === 0,
    blocking,
    excepted,
    informational,
    expired,
    unmatched,
    errors,
  };
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function runAudit(includeDev: boolean): string {
  const args = ['audit', '--json'];
  if (!includeDev) args.push('--omit=dev');
  try {
    return execFileSync('npm', args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180_000,
    }).toString();
  } catch (err) {
    // `npm audit` exits non-zero whenever it finds anything, so stdout on a
    // thrown error is the normal path, not an anomaly.
    const stdout = (err as { stdout?: Buffer }).stdout?.toString();
    if (stdout && stdout.trim().length > 0) return stdout;
    throw new Error(
      `npm audit failed with no output: ${err instanceof Error ? err.message : err}`,
    );
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const includeDev = argv.includes('--include-dev');
  const jsonFlag = argv.indexOf('--audit-json');
  const raw =
    jsonFlag !== -1 && argv[jsonFlag + 1]
      ? readFileSync(argv[jsonFlag + 1], 'utf8')
      : runAudit(includeDev);

  const findings = parseAuditJson(raw);
  const result = evaluate(findings, loadExceptions(), todayIso());

  console.log(
    `dependency audit — ${includeDev ? 'all dependencies' : 'production dependencies'}\n`,
  );

  if (result.blocking.length > 0) {
    const exceptions = loadExceptions();
    console.log('BLOCKING:');
    for (const f of result.blocking) {
      let why: string;
      if (NON_EXCEPTABLE.includes(f.severity)) {
        why = 'critical severity is never exceptable';
      } else {
        const uncovered = f.advisories.filter(
          (a) => !exceptions.some((e) => e.package === f.package && e.advisory === a),
        );
        why =
          uncovered.length === f.advisories.length
            ? 'no matching exception'
            : `partially excepted — no exception for ${uncovered.join(', ')}`;
      }
      console.log(`  ✗ ${f.package} [${f.severity}] — ${why}`);
      console.log(`      ${f.title}`);
      console.log(`      ${f.url}  (vulnerable: ${f.range})`);
      if (f.advisories.length > 1) {
        console.log(`      advisories: ${f.advisories.join(', ')}`);
      }
    }
    console.log('');
  }

  if (result.excepted.length > 0) {
    console.log('Excepted (expires):');
    for (const { finding, exception } of result.excepted) {
      console.log(
        `  ~ ${finding.package} [${finding.severity}] until ${exception.expires} — ${exception.owner}`,
      );
    }
    console.log('');
  }

  if (result.expired.length > 0) {
    console.log('EXPIRED exceptions (re-review or remediate):');
    for (const e of result.expired) {
      console.log(`  ✗ ${e.package} / ${e.advisory} expired ${e.expires}`);
    }
    console.log('');
  }

  if (result.unmatched.length > 0) {
    console.log('STALE exceptions (no longer match any finding — delete them):');
    for (const e of result.unmatched) {
      console.log(`  ✗ ${e.package} / ${e.advisory}`);
    }
    console.log('');
  }

  if (result.errors.length > 0) {
    console.log('Malformed exception entries:');
    for (const e of result.errors) console.log(`  ✗ ${e}`);
    console.log('');
  }

  if (result.informational.length > 0) {
    console.log('Informational (moderate and below, non-blocking):');
    for (const f of result.informational) {
      console.log(`  · ${f.package} [${f.severity}] ${f.url}`);
    }
    console.log('');
  }

  const counts = `${result.blocking.length} blocking, ${result.excepted.length} excepted, ${result.informational.length} informational`;
  if (!result.ok) {
    console.log(`FAIL — ${counts}`);
    console.log('See docs/quality/dependency-audit-policy.md');
    process.exit(1);
  }
  console.log(`PASS — ${counts}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(
      'check-dependency-audit crashed:',
      err instanceof Error ? err.message : err,
    );
    process.exit(2);
  }
}
