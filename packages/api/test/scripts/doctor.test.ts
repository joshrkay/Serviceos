import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkDocker,
  checkEnvVars,
  checkInstallLocations,
  checkNodeVersion,
  checkNpmVersion,
  parseEnvExampleKeys,
  parseIntegrationFlag,
  parseWarnOnlyFlag,
  readNvmrc,
} from '../../../../scripts/doctor';

const tempRoots: string[] = [];

function makeRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'doctor-test-'));
  tempRoots.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('parseIntegrationFlag', () => {
  it('detects --integration', () => {
    expect(parseIntegrationFlag(['node', 'doctor', '--integration'])).toBe(true);
  });

  it('defaults to false', () => {
    expect(parseIntegrationFlag(['node', 'doctor'])).toBe(false);
  });
});

/**
 * `npm run verify` passes --warn-only so that an environment mismatch reports
 * without blocking typecheck/lint/test. Without it, a container whose Node
 * differs from .nvmrc cannot run the correctness gate at all.
 */
describe('parseWarnOnlyFlag', () => {
  it('detects --warn-only', () => {
    expect(parseWarnOnlyFlag(['node', 'doctor', '--warn-only'])).toBe(true);
  });

  it('defaults to false, so a direct `npm run doctor` still fails hard', () => {
    expect(parseWarnOnlyFlag(['node', 'doctor'])).toBe(false);
  });

  it('is independent of --integration', () => {
    const argv = ['node', 'doctor', '--integration'];
    expect(parseWarnOnlyFlag(argv)).toBe(false);
    expect(parseIntegrationFlag(argv)).toBe(true);
  });
});

describe('readNvmrc', () => {
  it('reads an exact pin', () => {
    const root = makeRoot({ '.nvmrc': '20.20.2\n' });
    expect(readNvmrc(root)).toBe('20.20.2');
  });

  it('strips a leading v and surrounding whitespace', () => {
    const root = makeRoot({ '.nvmrc': '  v20.20.2  \n' });
    expect(readNvmrc(root)).toBe('20.20.2');
  });

  it('returns null when absent', () => {
    expect(readNvmrc(makeRoot())).toBeNull();
  });

  it('returns null when empty', () => {
    const root = makeRoot({ '.nvmrc': '\n' });
    expect(readNvmrc(root)).toBeNull();
  });
});

describe('checkNodeVersion', () => {
  it('passes on an exact match', () => {
    const r = checkNodeVersion('v20.20.2', '20.20.2');
    expect(r.status).toBe('OK');
  });

  it('fails on a patch mismatch and says so explicitly', () => {
    const r = checkNodeVersion('v20.19.0', '20.20.2');
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('same major, different patch');
    expect(r.remedy).toContain('20.20.2');
  });

  // The condition this whole sprint exists to catch: local on a different
  // major than CI and the Dockerfile.
  it('fails loudly on a major mismatch', () => {
    const r = checkNodeVersion('v22.22.2', '20.20.2');
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('DIFFERENT MAJOR');
  });

  it('fails when there is no pin to compare against', () => {
    const r = checkNodeVersion('v20.20.2', null);
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('.nvmrc missing');
  });
});

describe('checkNpmVersion', () => {
  // Regression: an earlier hand-rolled range parser read ">=10.0.0 <11.0.0"
  // as major>=10 && major<0 and failed a perfectly valid npm 10.9.7.
  it('passes when the major matches the declared spec', () => {
    expect(checkNpmVersion('10.9.7', '10.x').status).toBe('OK');
  });

  it('passes regardless of minor and patch within the major', () => {
    expect(checkNpmVersion('10.0.0', '10.x').status).toBe('OK');
    expect(checkNpmVersion('10.99.99', '10.x').status).toBe('OK');
  });

  it('fails below the declared major', () => {
    const r = checkNpmVersion('9.8.1', '10.x');
    expect(r.status).toBe('FAIL');
    expect(r.remedy).toContain('npm@10');
  });

  it('fails above the declared major', () => {
    expect(checkNpmVersion('11.0.0', '10.x').status).toBe('FAIL');
  });

  it('skips when engines.npm is not declared', () => {
    expect(checkNpmVersion('10.9.7', undefined).status).toBe('skip');
  });

  it('fails clearly when engines.npm has no readable major', () => {
    const r = checkNpmVersion('10.9.7', 'latest');
    expect(r.status).toBe('FAIL');
    expect(r.remedy).toContain('<major>.x');
  });
});

describe('checkInstallLocations', () => {
  it('fails when root node_modules is missing', () => {
    const results = checkInstallLocations(makeRoot());
    const rootCheck = results.find((r) => r.name === 'root node_modules');
    expect(rootCheck?.status).toBe('FAIL');
    expect(rootCheck?.remedy).toBe('npm ci');
  });

  it('passes when root node_modules is present', () => {
    const root = makeRoot({ 'node_modules/.keep': '' });
    const rootCheck = checkInstallLocations(root).find(
      (r) => r.name === 'root node_modules',
    );
    expect(rootCheck?.status).toBe('OK');
  });

  // Mobile is not a root workspace, so a root-only `npm ci` leaves it empty.
  // That is a warning, not a failure — the CI mobile lane runs on the
  // root-hoisted vitest without installing it.
  it('warns (does not fail) when mobile deps are missing', () => {
    const root = makeRoot({
      'node_modules/.keep': '',
      'packages/mobile/package.json': '{"name":"mobile"}',
    });
    const mobileCheck = checkInstallLocations(root).find(
      (r) => r.name === 'mobile node_modules',
    );
    expect(mobileCheck?.status).toBe('warn');
    expect(mobileCheck?.required).toBe(false);
    expect(mobileCheck?.remedy).toContain('--prefix packages/mobile');
  });

  it('skips the mobile check when packages/mobile is absent', () => {
    const root = makeRoot({ 'node_modules/.keep': '' });
    const mobileCheck = checkInstallLocations(root).find(
      (r) => r.name === 'mobile node_modules',
    );
    expect(mobileCheck?.status).toBe('skip');
  });
});

describe('checkDocker', () => {
  it('skips unless --integration is passed', () => {
    const r = checkDocker(false);
    expect(r.status).toBe('skip');
    expect(r.required).toBe(false);
  });
});

describe('parseEnvExampleKeys', () => {
  it('extracts variable names and ignores comments and blanks', () => {
    const keys = parseEnvExampleKeys(
      ['# a comment', '', 'DATABASE_URL=postgres://x', 'PORT=3000', '  ', '# X=1'].join(
        '\n',
      ),
    );
    expect(keys).toEqual(['DATABASE_URL', 'PORT']);
  });

  it('ignores lower-case and malformed keys', () => {
    expect(parseEnvExampleKeys('lowercase=1\n1BAD=2\nGOOD_ONE=3')).toEqual([
      'GOOD_ONE',
    ]);
  });
});

describe('checkEnvVars', () => {
  it('passes when every declared var is set', () => {
    const root = makeRoot({ '.env.example': 'FOO=\nBAR=\n' });
    const r = checkEnvVars(root, { FOO: '1', BAR: '2' });
    expect(r.status).toBe('OK');
  });

  it('warns (never fails) when vars are unset', () => {
    const root = makeRoot({ '.env.example': 'FOO=\nBAR=\n' });
    const r = checkEnvVars(root, { FOO: '1' });
    expect(r.status).toBe('warn');
    expect(r.required).toBe(false);
    expect(r.detail).toContain('BAR');
  });

  it('skips when .env.example is absent', () => {
    expect(checkEnvVars(makeRoot(), {}).status).toBe('skip');
  });
});
