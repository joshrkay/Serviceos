/**
 * §11 H4 — migration discipline guard.
 *
 * Permissive: this test never fails. Its purpose is to surface a console.warn
 * in CI output when the newest migration contains destructive patterns
 * (DROP, RENAME, ALTER ... DROP) so PR reviewers see the warning and apply
 * the two-step-deploy checklist documented in docs/runbooks/migration-discipline.md.
 *
 * Scans the value of the lexicographically-last entry in MIGRATIONS
 * (packages/api/src/db/schema.ts) — the most recently added migration.
 */
import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../../src/db/schema';

const DESTRUCTIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bRENAME\s+TO\b/i,
  /\bRENAME\s+COLUMN\b/i,
  /\bALTER\s+TYPE\s+\S+\s+DROP\b/i,
];

describe('migration discipline (§11 H4)', () => {
  it('warns when the newest migration contains destructive patterns', () => {
    const keys = Object.keys(MIGRATIONS).sort();
    const newestKey = keys.at(-1);
    expect(newestKey, 'no migrations found').toBeTruthy();
    const sql = MIGRATIONS[newestKey as keyof typeof MIGRATIONS];
    const hits = DESTRUCTIVE_PATTERNS.filter((p) => p.test(sql));
    if (hits.length > 0) {
      const patternNames = hits.map((p) => p.source).join(', ');
      // eslint-disable-next-line no-console
      console.warn(
        `\n⚠️  Migration ${newestKey} contains destructive patterns: ${patternNames}\n` +
          `   See docs/runbooks/migration-discipline.md — destructive changes require a two-step deploy.\n` +
          `   Step 1: ship the additive change. Step 2 (≥ 1 day later): drop the old shape.\n`,
      );
    }
    // PERMISSIVE: never fail. Reviewers see the warning and apply the checklist.
    expect(true).toBe(true);
  });
});
