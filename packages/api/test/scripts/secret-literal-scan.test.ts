/**
 * #1589 — qa/scripts/deep_qa.py:21 hardcoded a real-shaped Clerk dev secret
 * (`sk_test_y3Pg3Qrtv3lezUiItnRsCHePDxOYD4o6f1zWCGmrdB`) as an
 * `os.environ.get(..., default)` fallback, committed to git since
 * 2026-08-29. This is a repo-wide guard against that recurring: it scans
 * every git-tracked file (outside test/e2e code, docs, and `.env*.example`,
 * which legitimately use fake-looking placeholders) for a
 * `sk_test_`/`sk_live_`/`whsec_` literal, and fails unless that exact
 * `path:value` pair is on the reviewed ALLOWLIST below.
 *
 * NEVER print a real secret value here — on failure this reports the
 * offending file path and the literal found in CI logs, so a real hit
 * would itself leak the secret into the test report. Review and rotate out
 * of band instead of debugging via a wider match in this file.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const SECRET_LITERAL_RE = /(sk_test_|sk_live_|whsec_)[A-Za-z0-9+/=_.-]{6,}/g;
// Non-global twin for a one-shot boolean `.test()` — reusing the stateful
// global `SECRET_LITERAL_RE` with `.test()` would mutate its `lastIndex`
// and could skip matches on a later call against the same object.
const SECRET_LITERAL_PROBE_RE = /(sk_test_|sk_live_|whsec_)[A-Za-z0-9+/=_.-]{6,}/;

const EXCLUDED_PATH_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)(test|tests|__tests__|e2e)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.md$/,
  /\.env.*\.example$/,
];

const BINARY_EXTENSIONS = new Set([
  '.mp4', '.mp3', '.wav', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf',
  '.woff', '.woff2', '.ttf', '.eot', '.zip', '.lock',
]);

// Reviewed 2026-10-04 — every remaining hit outside test/e2e/docs code is a
// deliberately fake, readable-words-or-base64 placeholder, not a real
// secret. Exact "path:value" so a NEW literal appended to one of these
// files (including a real secret dropped next to an allowlisted fake)
// still fails the scan.
const ALLOWLIST = new Set<string>([
  '.github/workflows/onboarding-database.yml:sk_test_hermetic_release',
  '.github/workflows/onboarding-database.yml:whsec_hermetic_release',
  'docs/audit/tooling/gate-example-regate-1093.sh:whsec_e2e_public_pay_link_test_secret',
  'playwright.config.ts:whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==',
  'scripts/release/verification-policy.test.mjs:sk_test_fixture',
]);

function isExcludedPath(relPath: string): boolean {
  if (EXCLUDED_PATH_PATTERNS.some((re) => re.test(relPath))) return true;
  const ext = path.extname(relPath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// Describes a hit WITHOUT the secret value itself — only the file, the
// matched prefix, and the literal's length. A failing assertion's diff is
// printed verbatim into the test runner's (and CI's) output, so this is
// the only safe thing to put in that diff; the literal itself must never
// appear in a returned string, an assertion message, or a thrown error.
function describeHit(relPath: string, literal: string): string {
  const prefix = literal.match(/^(sk_test_|sk_live_|whsec_)/)?.[0] ?? '';
  return `${relPath}: ${prefix}<redacted, len=${literal.length}>`;
}

function findOffenders(): string[] {
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  const offenders: string[] = [];
  for (const relPath of tracked) {
    if (isExcludedPath(relPath)) continue;

    let text: string;
    try {
      text = readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
    } catch {
      continue; // unreadable / removed-but-still-tracked race
    }

    const matches = text.match(SECRET_LITERAL_RE);
    if (!matches) continue;

    for (const literal of matches) {
      if (!ALLOWLIST.has(`${relPath}:${literal}`)) {
        offenders.push(describeHit(relPath, literal));
      }
    }
  }
  return offenders;
}

describe('#1589 — no real secret literals committed outside reviewed fixtures', () => {
  it('qa/scripts/deep_qa.py does not hardcode a Clerk secret default', () => {
    const content = readFileSync(path.join(REPO_ROOT, 'qa/scripts/deep_qa.py'), 'utf8');
    // Boolean, not .not.toMatch(content) — a toMatch failure prints the
    // FULL subject string in its diff, which would print the secret.
    expect(SECRET_LITERAL_PROBE_RE.test(content)).toBe(false);
  });

  it('no sk_test_/sk_live_/whsec_ literal exists outside the reviewed allowlist', () => {
    expect(findOffenders()).toEqual([]);
  });
});
