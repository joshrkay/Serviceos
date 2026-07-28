/**
 * FAIL-VIS CI guard — scripts/check-env-coverage.ts.
 *
 * The recurring pattern this exists to stop: code reads an env var, nobody
 * ever sets it, and the `?? default` makes the omission invisible. The guard's
 * own correctness matters, so the extractor and the gate are tested directly,
 * plus one end-to-end assertion that the CHECKED-IN state passes (otherwise
 * the gate lands red and gets ignored).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectDeclaredKeys,
  collectEnvReads,
  evaluateCoverage,
  loadAllowlist,
  type Allowlist,
  type EnvRead,
} from '../../../../scripts/check-env-coverage';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'env-coverage-test-'));
  tempDirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    require('node:fs').mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }
  return dir;
}

const emptyAllowlist: Allowlist = { optional: [], unreviewed: [] };
const read = (name: string): EnvRead => ({ name, where: 'x.ts:1' });

describe('collectDeclaredKeys', () => {
  it('reads active KEY= lines', () => {
    expect([...collectDeclaredKeys('FOO=1\nBAR=\n')]).toEqual(['FOO', 'BAR']);
  });

  it('counts COMMENTED defaults as declared — a documented optional knob is deliberate', () => {
    expect(collectDeclaredKeys('# SLO_QUEUE_STALE_MIN=15\n').has('SLO_QUEUE_STALE_MIN')).toBe(true);
  });

  it('ignores prose comments and blank lines', () => {
    const keys = collectDeclaredKeys('# this is a note about FOO=BAR style\n\n# ═══ TIER 0 ═══\n');
    expect(keys.has('FOO')).toBe(false);
    expect(keys.size).toBe(0);
  });
});

describe('collectEnvReads', () => {
  it('finds process.env.X, bracket access, and the `env.X` parameter form', () => {
    const dir = fixtureRepo({
      'packages/api/src/a.ts': "const a = process.env.ALPHA;\n",
      'packages/api/src/b.ts': "const b = process.env['BRAVO'];\n",
      // GOOGLE_MAPS_API_KEY is read exactly this way — a process.env-only scan
      // misses it, which is how it stayed invisible.
      'packages/api/src/c.ts':
        'export function f(env: NodeJS.ProcessEnv) { return env.CHARLIE; }\n',
      'packages/api/src/shared/config.ts': '  DELTA: z.string().optional(),\n',
    });
    const names = collectEnvReads(dir).map((r) => r.name);
    expect(names).toEqual(['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA']);
  });

  it('records a repo-relative file:line for the first sighting', () => {
    const dir = fixtureRepo({ 'packages/api/src/a.ts': '\n\nconst a = process.env.ALPHA;\n' });
    expect(collectEnvReads(dir)[0]).toEqual({ name: 'ALPHA', where: 'packages/api/src/a.ts:3' });
  });

  it('skips test files and __tests__ directories — those set their own env', () => {
    const dir = fixtureRepo({
      'packages/api/src/a.test.ts': 'process.env.ONLY_IN_TEST;\n',
      'packages/api/src/__tests__/b.ts': 'process.env.ALSO_ONLY_IN_TEST;\n',
    });
    expect(collectEnvReads(dir)).toEqual([]);
  });
});

describe('evaluateCoverage', () => {
  it('fails on a var that is read but neither declared nor allowlisted', () => {
    const r = evaluateCoverage(
      [read('GOOGLE_MAPS_API_KEY')],
      new Set(['DATABASE_URL']),
      emptyAllowlist,
    );
    expect(r.ok).toBe(false);
    expect(r.undeclared.map((u) => u.name)).toEqual(['GOOGLE_MAPS_API_KEY']);
  });

  it('passes when the var is in the production contract', () => {
    const r = evaluateCoverage([read('SENTRY_DSN')], new Set(['SENTRY_DSN']), emptyAllowlist);
    expect(r.ok).toBe(true);
    expect(r.undeclared).toEqual([]);
  });

  it('passes silently when the var is on the reviewed `optional` list', () => {
    const r = evaluateCoverage([read('LOG_LEVEL')], new Set(), {
      optional: [{ name: 'LOG_LEVEL', reason: 'defaults to info' }],
      unreviewed: [],
    });
    expect(r.ok).toBe(true);
    expect(r.unreviewed).toEqual([]);
  });

  it('passes but reports loudly when the var is on the `unreviewed` backlog', () => {
    const allowlist: Allowlist = {
      optional: [],
      unreviewed: [{ name: 'GOOGLE_MAPS_API_KEY', reason: 'UNSURE - probably should be set' }],
    };
    const r = evaluateCoverage([read('GOOGLE_MAPS_API_KEY')], new Set(), allowlist);
    expect(r.ok).toBe(true);
    expect(r.undeclared).toEqual([]);
    expect(r.unreviewed.map((u) => u.name)).toEqual(['GOOGLE_MAPS_API_KEY']);
  });

  it('--strict turns the unreviewed backlog into a failure', () => {
    const allowlist: Allowlist = {
      optional: [],
      unreviewed: [{ name: 'GOOGLE_MAPS_API_KEY', reason: 'UNSURE' }],
    };
    const r = evaluateCoverage([read('GOOGLE_MAPS_API_KEY')], new Set(), allowlist, {
      strict: true,
    });
    expect(r.ok).toBe(false);
  });

  it('fails on an allowlist entry nothing reads any more, so the file cannot rot', () => {
    const r = evaluateCoverage([read('STILL_READ')], new Set(['STILL_READ']), {
      optional: [{ name: 'DELETED_LONG_AGO', reason: 'stale' }],
      unreviewed: [],
    });
    expect(r.ok).toBe(false);
    expect(r.staleAllowlist).toEqual(['DELETED_LONG_AGO']);
  });
});

describe('the checked-in repo state', () => {
  it('passes the guard today (seeded so it does not land red)', () => {
    const reads = collectEnvReads(REPO_ROOT);
    const declared = collectDeclaredKeys(
      require('node:fs').readFileSync(
        path.join(REPO_ROOT, '.env.production.example'),
        'utf8',
      ) as string,
    );
    const result = evaluateCoverage(reads, declared, loadAllowlist());
    expect(result.undeclared).toEqual([]);
    expect(result.staleAllowlist).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('every allowlist entry carries a reason', () => {
    const allowlist = loadAllowlist();
    for (const entry of [...allowlist.optional, ...allowlist.unreviewed]) {
      expect(entry.reason, `${entry.name} has no reason`).toBeTruthy();
      expect(entry.reason.length, `${entry.name}'s reason is too thin`).toBeGreaterThan(20);
    }
  });

  it('the vars named in the July 2026 Railway sweep are NOT silently marked optional', () => {
    // These are the three the audit called out by name. If someone moves them
    // to `optional` it must be a deliberate, reviewed act — not a way to make
    // this gate quiet.
    const optional = new Set(loadAllowlist().optional.map((e) => e.name));
    for (const name of [
      'GOOGLE_MAPS_API_KEY',
      'SUPERVISOR_DEFAULT_PER_PROPOSAL_CAP_CENTS',
      'SUPERVISOR_DEFAULT_DAILY_SPEND_CAP_CENTS',
      'SUPERVISOR_DEFAULT_MAX_AUTO_APPROVALS_PER_HOUR',
    ]) {
      expect(optional.has(name), `${name} was quietly allowlisted as optional`).toBe(false);
    }
  });
});
