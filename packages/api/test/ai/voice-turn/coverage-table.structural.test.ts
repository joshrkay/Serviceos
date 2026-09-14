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

/**
 * The completeness check, as a PURE function of the table and its axes.
 *
 * #1021: extracted so the same code that audits the real table can be pointed
 * at a table with a PLANTED hole. §8.0 grants STRUCTURAL only with a negative
 * control, and a check that has never been shown failing has proved nothing —
 * the G1 audit marked this file PROVEN-UNIT for exactly that reason ("neither
 * file plants a violation").
 */
export function undeclaredCells(
  table: Readonly<Record<string, Readonly<Record<string, CoverageCell>> | undefined>>,
  families: readonly string[],
  surfaces: readonly string[],
): string[] {
  const undeclared: string[] = [];
  for (const family of families) {
    const row = table[family];
    for (const surface of surfaces) {
      if (!row || row[surface] === undefined) {
        undeclared.push(`${family} × ${surface}`);
      }
    }
  }
  return undeclared;
}

describe('coverage table — structural completeness (#962)', () => {
  it('declares a cell for EVERY intent family on EVERY live surface — silence is impossible', () => {
    const undeclared = undeclaredCells(
      COVERAGE_TABLE as Readonly<Record<string, Readonly<Record<string, CoverageCell>> | undefined>>,
      INTENT_FAMILIES,
      LIVE_SURFACES,
    );
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

  // ─── NEGATIVE CONTROL (#1021) ──────────────────────────────────────────────
  //
  // G1 2026-09-12 marked I16 PROVEN-UNIT rather than STRUCTURAL because this
  // file plants no violation: it asserts the table is complete, and nothing
  // showed the assertion would fail if it were not. These do.

  it('NEGATIVE CONTROL — a planted hole in the table is reported', () => {
    const family = INTENT_FAMILIES[0];
    const surface = LIVE_SURFACES[0];
    const holed = {
      ...(COVERAGE_TABLE as Readonly<Record<string, Readonly<Record<string, CoverageCell>>>>),
      [family]: Object.fromEntries(
        Object.entries(COVERAGE_TABLE[family] ?? {}).filter(([s]) => s !== surface),
      ) as Readonly<Record<string, CoverageCell>>,
    };
    expect(undeclaredCells(holed, INTENT_FAMILIES, LIVE_SURFACES)).toEqual([
      `${family} × ${surface}`,
    ]);
  });

  it('NEGATIVE CONTROL — a whole family dropped from the table is reported on every surface', () => {
    const family = INTENT_FAMILIES[1];
    const dropped = Object.fromEntries(
      Object.entries(COVERAGE_TABLE).filter(([f]) => f !== family),
    ) as Readonly<Record<string, Readonly<Record<string, CoverageCell>> | undefined>>;
    const reported = undeclaredCells(dropped, INTENT_FAMILIES, LIVE_SURFACES);
    expect(reported).toEqual(LIVE_SURFACES.map((s) => `${family} × ${s}`));
  });

  it('NEGATIVE CONTROL — a NEW live surface with no cells anywhere is reported for every family', () => {
    // The drift this catches: adding a surface to LIVE_SURFACES without
    // declaring what each family does on it.
    const withNewSurface = [...LIVE_SURFACES, 'sms_keyword'];
    const reported = undeclaredCells(
      COVERAGE_TABLE as Readonly<Record<string, Readonly<Record<string, CoverageCell>> | undefined>>,
      INTENT_FAMILIES,
      withNewSurface,
    );
    expect(reported).toEqual(INTENT_FAMILIES.map((f) => `${f} × sms_keyword`));
  });

  it('NEGATIVE CONTROL (inverse) — the real table reports nothing, so the controls above are the only reds', () => {
    expect(
      undeclaredCells(
        COVERAGE_TABLE as Readonly<
          Record<string, Readonly<Record<string, CoverageCell>> | undefined>
        >,
        INTENT_FAMILIES,
        LIVE_SURFACES,
      ),
    ).toEqual([]);
  });
});
