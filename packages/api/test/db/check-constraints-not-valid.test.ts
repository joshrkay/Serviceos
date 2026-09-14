import { describe, it, expect } from 'vitest';
import { getMigrationSQL, MIGRATIONS } from '../../src/db/schema';

/**
 * Schema-wide deploy-blocker guard (#923, plan U9 / R9).
 *
 * The migration runner has no applied-migrations ledger: `applyMigrations()`
 * (migrate.ts) replays `getMigrationSQL()` — the ENTIRE corpus — as one
 * statement on every boot, under a single `statement_timeout = '25s'`.
 * `getMigrationSQL()` also rewrites every `ALTER TABLE … ADD CONSTRAINT`
 * into `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`, so every CHECK
 * constraint in the corpus is dropped and re-added on every deploy.
 *
 * A bare `ADD CONSTRAINT … CHECK (…)` makes Postgres validate the WHOLE
 * table at that point in the corpus, against THAT migration's (possibly
 * stale, pre-later-widening) vocabulary. That is exactly how
 * message_dispatches_entity_type_check bricked every deploy of main three
 * times (see dispatch-entity-type-vocabulary.test.ts and commit 0c9bd4c):
 * a row legal under the FINAL constraint was rejected by an earlier,
 * narrower copy replayed first in the same batch (SQLSTATE 23514 /
 * ATRewriteTable). Even a constraint that was never widened still pays a
 * full validating scan per deploy inside the shared 25s budget.
 *
 * `NOT VALID` skips the existing-row scan while still enforcing the CHECK
 * on every future INSERT/UPDATE — the correct semantics for a replayed
 * corpus. This test pins it on EVERY CHECK constraint in the corpus.
 *
 * Shape mirrors schema.test.ts "Blocker 3": regex-scan getMigrationSQL(),
 * set-difference, fail with a named list.
 */

/**
 * Matches the ADD CONSTRAINT keyword pair for a CHECK constraint in BOTH
 * layouts present in the corpus:
 *   - one-line `ALTER TABLE t ADD CONSTRAINT n\n  CHECK (…)`
 *   - multi-clause `ALTER TABLE t\n  DROP CONSTRAINT IF EXISTS n,\n  ADD CONSTRAINT n\n  CHECK (…)`
 * Whitespace between the name and CHECK is `\s+` (any run, newlines
 * included) — ENTITY_TYPE_CHECK_RE in the dispatch vocabulary test
 * requires a literal newline and would silently miss one-line sites.
 * Inline column checks (`ADD COLUMN … CHECK (…)`) are excluded on purpose:
 * they are not named constraints and are not replayed via DROP/ADD.
 */
const ADD_CHECK_RE = /ADD CONSTRAINT\s+([a-z_][a-z0-9_]*)\s+CHECK\b/g;

/**
 * Pinned total. If a future migration adds a CHECK constraint this must be
 * bumped — deliberately, alongside the new site carrying NOT VALID. If the
 * regex ever stops matching a layout, the count drops and the test fails
 * loudly instead of passing vacuously.
 */
const EXPECTED_CHECK_CONSTRAINT_SITES = 33;

interface CheckSite {
  name: string;
  hasNotValid: boolean;
}

/** Every ADD CONSTRAINT … CHECK site in `sql`, in source order. */
function findCheckSites(sql: string): CheckSite[] {
  const sites: CheckSite[] = [];
  for (const m of sql.matchAll(ADD_CHECK_RE)) {
    const start = m.index ?? 0;
    const end = sql.indexOf(';', start);
    // A CHECK with no terminating `;` would be a corpus syntax error; treat
    // it as a bare site so it shows up in the failure list rather than
    // being skipped.
    const statement = end === -1 ? sql.slice(start) : sql.slice(start, end);
    sites.push({ name: m[1], hasNotValid: /\bNOT VALID\s*$/.test(statement) });
  }
  return sites;
}

describe('every replayed CHECK constraint is NOT VALID (#923)', () => {
  it('the parser sees every CHECK constraint site in the corpus', () => {
    const sites = findCheckSites(getMigrationSQL());
    expect(
      sites.length,
      'ADD CONSTRAINT … CHECK site count drifted. If you ADDED a CHECK ' +
        'constraint, bump EXPECTED_CHECK_CONSTRAINT_SITES (and give the new ' +
        'site NOT VALID). If you did not, ADD_CHECK_RE has stopped matching ' +
        'a layout and this guard would otherwise pass vacuously.',
    ).toBe(EXPECTED_CHECK_CONSTRAINT_SITES);
  });

  it('no ADD CONSTRAINT … CHECK site lacks NOT VALID', () => {
    // Attribute each bare site to its migration key so the failure names
    // where to edit. MIGRATIONS values are the pre-rewrite text, but the
    // DROP-CONSTRAINT rewriter never touches the ADD CONSTRAINT … CHECK …
    // NOT VALID span itself, so the same regex applies to both.
    const bare: string[] = [];
    for (const [key, migration] of Object.entries(MIGRATIONS)) {
      for (const site of findCheckSites(migration)) {
        if (!site.hasNotValid) bare.push(`${key}: ${site.name}`);
      }
    }
    // Cross-check the per-migration scan against the replayed corpus so a
    // rewriter change that dropped or duplicated sites is caught too.
    const replayedBare = findCheckSites(getMigrationSQL()).filter((s) => !s.hasNotValid);
    expect(replayedBare.length).toBe(bare.length);

    expect(
      bare,
      'ADD CONSTRAINT … CHECK without NOT VALID. The corpus is replayed on ' +
        'every boot with each constraint dropped and re-added, so a bare ' +
        'CHECK re-validates the WHOLE table on every deploy against THIS ' +
        "migration's vocabulary — any row legal under a later widening " +
        'bricks every subsequent deploy (SQLSTATE 23514 / ATRewriteTable). ' +
        'Append NOT VALID before the terminating `;` and regenerate the ' +
        'affected SNAPSHOT hash in migration-immutability.test.ts.\n' +
        'Bare sites:\n  ' +
        bare.join('\n  '),
    ).toEqual([]);
  });
});
