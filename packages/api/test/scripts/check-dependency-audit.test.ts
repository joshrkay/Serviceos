import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BLOCKING,
  NON_EXCEPTABLE,
  type Exception,
  type Finding,
  evaluate,
  loadExceptions,
  parseAuditJson,
  todayIso,
  validateException,
} from '../../../../scripts/check-dependency-audit';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dep-audit-test-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  writeFileSync(file, contents);
  return file;
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    package: 'pkg',
    severity: 'high',
    advisories: ['GHSA-aaaa-bbbb-cccc'],
    title: 'Some flaw',
    url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    range: '<1.2.3',
    ...over,
  };
}

function exception(over: Partial<Exception> = {}): Exception {
  return {
    package: 'pkg',
    advisory: 'GHSA-aaaa-bbbb-cccc',
    owner: 'web',
    rationale: 'not reachable in this build',
    mitigation: 'none needed',
    expires: '2099-01-01',
    ...over,
  };
}

describe('parseAuditJson', () => {
  it('flattens npm audit output into one finding per package', () => {
    const raw = JSON.stringify({
      vulnerabilities: {
        'react-router': {
          severity: 'high',
          range: '7.12.0 - 8.2.0',
          via: [
            {
              source: 1234,
              title: 'RSC Mode CSRF Bypass',
              url: 'https://github.com/advisories/GHSA-qwww-vcr4-c8h2',
            },
          ],
        },
      },
    });
    const findings = parseAuditJson(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].package).toBe('react-router');
    expect(findings[0].severity).toBe('high');
    expect(findings[0].advisories).toEqual(['GHSA-qwww-vcr4-c8h2']);
    expect(findings[0].range).toBe('7.12.0 - 8.2.0');
  });

  // npm mixes advisory objects with plain package-name strings in `via`.
  it('ignores string entries in via (transitive parents)', () => {
    const raw = JSON.stringify({
      vulnerabilities: {
        child: {
          severity: 'moderate',
          range: '*',
          via: ['parent-package'],
        },
      },
    });
    const findings = parseAuditJson(raw);
    expect(findings[0].advisories).toEqual([]);
    expect(findings[0].title).toBe('(no title)');
  });

  it('returns an empty list for a clean audit', () => {
    expect(parseAuditJson(JSON.stringify({ vulnerabilities: {} }))).toEqual([]);
  });

  it('throws on non-JSON input rather than silently passing', () => {
    expect(() => parseAuditJson('npm ERR! network')).toThrow(/valid JSON/);
  });

  it('treats an unrecognised severity as info rather than crashing', () => {
    const raw = JSON.stringify({
      vulnerabilities: { p: { severity: 'bananas', range: '*', via: [] } },
    });
    expect(parseAuditJson(raw)[0].severity).toBe('info');
  });
});

describe('policy constants', () => {
  it('blocks high and critical', () => {
    expect(BLOCKING).toEqual(['high', 'critical']);
  });

  it('never allows a critical to be excepted', () => {
    expect(NON_EXCEPTABLE).toEqual(['critical']);
  });
});

describe('evaluate', () => {
  it('passes a clean audit', () => {
    expect(evaluate([], [], '2026-07-25').ok).toBe(true);
  });

  it('blocks an unexcepted high', () => {
    const r = evaluate([finding()], [], '2026-07-25');
    expect(r.ok).toBe(false);
    expect(r.blocking).toHaveLength(1);
  });

  it('allows a high with a matching unexpired exception', () => {
    const r = evaluate([finding()], [exception()], '2026-07-25');
    expect(r.ok).toBe(true);
    expect(r.excepted).toHaveLength(1);
    expect(r.blocking).toHaveLength(0);
  });

  // The property that stops exceptions from becoming permanent.
  it('fails once an exception has expired', () => {
    const r = evaluate(
      [finding()],
      [exception({ expires: '2026-07-24' })],
      '2026-07-25',
    );
    expect(r.ok).toBe(false);
    expect(r.expired).toHaveLength(1);
    // The finding is no longer covered, so it blocks too.
    expect(r.blocking).toHaveLength(1);
  });

  it('treats the expiry date itself as still valid', () => {
    const r = evaluate(
      [finding()],
      [exception({ expires: '2026-07-25' })],
      '2026-07-25',
    );
    expect(r.ok).toBe(true);
    expect(r.expired).toHaveLength(0);
  });

  it('never lets a critical be excepted', () => {
    const r = evaluate(
      [finding({ severity: 'critical' })],
      [exception()],
      '2026-07-25',
    );
    expect(r.ok).toBe(false);
    expect(r.blocking).toHaveLength(1);
  });

  it('does not apply an exception to a different advisory on the same package', () => {
    const r = evaluate(
      [finding({ advisories: ['GHSA-zzzz-zzzz-zzzz'] })],
      [exception()],
      '2026-07-25',
    );
    expect(r.ok).toBe(false);
    expect(r.blocking).toHaveLength(1);
  });

  it('does not apply an exception to a different package', () => {
    const r = evaluate([finding()], [exception({ package: 'other' })], '2026-07-25');
    expect(r.ok).toBe(false);
  });

  // Keeps the file from accumulating entries for already-fixed advisories.
  it('fails on a stale exception that matches nothing', () => {
    const r = evaluate([], [exception()], '2026-07-25');
    expect(r.ok).toBe(false);
    expect(r.unmatched).toHaveLength(1);
  });

  it('reports moderate and below as informational without failing', () => {
    const r = evaluate(
      [finding({ severity: 'moderate' }), finding({ severity: 'low' })],
      [],
      '2026-07-25',
    );
    expect(r.ok).toBe(true);
    expect(r.informational).toHaveLength(2);
  });

  it('fails when an exception is malformed', () => {
    const r = evaluate([finding()], [exception({ owner: '' })], '2026-07-25');
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('owner');
  });
});

describe('validateException', () => {
  it('accepts a complete entry', () => {
    expect(validateException(exception(), 0)).toEqual([]);
  });

  it.each(['package', 'advisory', 'owner', 'rationale', 'mitigation', 'expires'])(
    'requires %s',
    (field) => {
      const errors = validateException(
        exception({ [field]: '' } as Partial<Exception>),
        0,
      );
      expect(errors.join(' ')).toContain(field);
    },
  );

  it('rejects a non-ISO expiry', () => {
    const errors = validateException(exception({ expires: '23/10/2026' }), 0);
    expect(errors.join(' ')).toContain('YYYY-MM-DD');
  });
});

describe('loadExceptions', () => {
  it('returns [] when the file is absent', () => {
    expect(loadExceptions(path.join(tmpdir(), 'definitely-not-here.json'))).toEqual(
      [],
    );
  });

  it('reads the exceptions array', () => {
    const file = tempFile(
      'e.json',
      JSON.stringify({ exceptions: [exception({ package: 'left-pad' })] }),
    );
    expect(loadExceptions(file)[0].package).toBe('left-pad');
  });

  it('tolerates a file with no exceptions key', () => {
    expect(loadExceptions(tempFile('e.json', '{}'))).toEqual([]);
  });
});

describe('todayIso', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(todayIso(new Date('2026-07-25T18:30:00Z'))).toBe('2026-07-25');
  });
});

describe('the committed exceptions file', () => {
  it('is well-formed', () => {
    const committed = loadExceptions();
    for (const [i, e] of committed.entries()) {
      expect(validateException(e, i)).toEqual([]);
    }
  });

  // A committed exception that has already expired would break CI for
  // everyone; catch it here where the message is clear.
  it('has no already-expired entries', () => {
    const today = todayIso();
    const expired = loadExceptions().filter((e) => e.expires < today);
    expect(expired.map((e) => `${e.package}/${e.advisory}@${e.expires}`)).toEqual([]);
  });
});
