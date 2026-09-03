/**
 * #962 (PR-A) — structural completeness of the coverage table.
 *
 * THE invariant this PR exists for: every (intent family × live surface)
 * pair has a DECLARED cell — reachable, refuse (with the honest copy), or
 * n/a (with the structural reason). An undeclared cell is exactly the
 * silent-degradation failure mode the table forbids, so this test fails
 * loudly on any missing pair, listing all of them at once.
 *
 * Written RED-FIRST against a partially-populated table (strict TDD): the
 * first run failed with nine families' cells undeclared; completing the
 * table is what turned it green.
 */
import { describe, it, expect } from 'vitest';

import {
  COVERAGE_TABLE,
  INTENT_FAMILIES,
  LIVE_SURFACES,
  type CoverageCell,
} from '../../../src/ai/voice-turn/coverage-table';

describe('coverage table — structural completeness (#962)', () => {
  it('declares a cell for EVERY intent family on EVERY live surface — silence is impossible', () => {
    const undeclared: string[] = [];
    for (const family of INTENT_FAMILIES) {
      const row = COVERAGE_TABLE[family] as
        | Readonly<Record<string, CoverageCell>>
        | undefined;
      for (const surface of LIVE_SURFACES) {
        if (!row || row[surface] === undefined) {
          undeclared.push(`${family} × ${surface}`);
        }
      }
    }
    expect(
      undeclared,
      `undeclared coverage cells (declare each as reachable, refuse, or n/a in coverage-table.ts):\n  ${undeclared.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no rows for unknown families and no cells for unknown surfaces (the table cannot outgrow its axes silently)', () => {
    const familySet = new Set<string>(INTENT_FAMILIES);
    const surfaceSet = new Set<string>(LIVE_SURFACES);
    for (const [family, row] of Object.entries(COVERAGE_TABLE)) {
      expect(familySet.has(family), `unknown family row: ${family}`).toBe(true);
      for (const surface of Object.keys(row ?? {})) {
        expect(surfaceSet.has(surface), `unknown surface cell: ${family} × ${surface}`).toBe(true);
      }
    }
  });

  it('every declared cell is well-formed: refuse carries honest non-empty copy, n/a carries a reason, reachable names its module', () => {
    for (const family of INTENT_FAMILIES) {
      const row = COVERAGE_TABLE[family];
      if (!row) continue; // completeness is the first test's failure, not this one's
      for (const surface of LIVE_SURFACES) {
        const cell = row[surface];
        if (!cell) continue;
        const where = `${family} × ${surface}`;
        if (cell.status === 'reachable') {
          expect(cell.module.trim().length, `${where}: reachable cell must name its module`).toBeGreaterThan(0);
        } else if (cell.status === 'refuse') {
          expect(cell.copy.trim().length, `${where}: refuse cell must carry the honest copy`).toBeGreaterThan(0);
          expect(cell.module.trim().length, `${where}: refuse cell must name where the refusal happens`).toBeGreaterThan(0);
        } else {
          expect(cell.status).toBe('n/a');
          expect(cell.reason.trim().length, `${where}: n/a cell must say why the family cannot occur`).toBeGreaterThan(0);
        }
      }
    }
  });
});
