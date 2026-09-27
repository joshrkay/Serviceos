/**
 * #1408 — an audit row's actor_role must be the acting request's (or the
 * executing proposal's) real role. A hard-coded `actorRole: 'unknown'` threw
 * that away at ~10 write sites. This structural guard fails on any new one.
 *
 * `actorRole: role ?? 'unknown'` (a fallback for a genuinely role-less
 * caller) is allowed; the bare literal is not.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');
const HARD_CODED = /actorRole\s*:\s*['"]unknown['"]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe("#1408 — no audit write hard-codes actorRole: 'unknown'", () => {
  it('finds no hard-coded unknown actor role anywhere in packages/api/src', () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${relative(SRC, file)}:${i + 1}` }))
        .filter(({ line }) => HARD_CODED.test(line))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});
