import { describe, it, expect } from 'vitest';
import { getMigrationSQL } from '../../src/db/schema';
import type { DispatchEntityType } from '../../src/notifications/dispatch-repository';
import type { JobStatus } from '../../src/jobs/job';
import { LEAD_SOURCES } from '../../src/leads/enums';

/**
 * Deploy-blocker regression guard (2026-08-29), generalised schema-wide
 * for #923 (plan U9).
 *
 * Root cause: `message_dispatches_entity_type_check` has been widened six
 * times (092, 125, 164, 190, 269, 270 in db/schema.ts). The runner has no
 * migration ledger — `getMigrationSQL()` replays every migration on every
 * boot — so an `ADD CONSTRAINT ... CHECK (...)` WITHOUT `NOT VALID`
 * re-validates the ENTIRE table on every single redeploy, against THAT
 * migration's (possibly stale, pre-later-widening) vocabulary. 190, 269 and
 * 270 shipped without `NOT VALID` (092/125/164 got it right); once the app
 * started writing 'portal_session'/'custom_message' rows under the final,
 * fully-widened constraint, the next redeploy replayed 190 first and
 * rejected those rows — SQLSTATE 23514 / ATRewriteTable, bricking every
 * subsequent deploy of main. See the fix on 190/269/270 and the matching
 * hash updates in migration-immutability.test.ts.
 *
 * The same shape existed on `leads_source_check` (069 lacked 'sms', which
 * 191 added) and `proposals_status_check` (039 lacked 'executing', which
 * 072 added) — one SMS-originated lead or one executing proposal at deploy
 * time would have bricked the deploy. check-constraints-not-valid.test.ts
 * now pins NOT VALID on every CHECK site in the corpus; this file pins the
 * OTHER half of the invariant for every constraint with a single exported
 * TS union:
 *   1. Every ADD CONSTRAINT for this check, anywhere in the migration
 *      corpus, must carry NOT VALID — so re-running the corpus against a
 *      populated table can never fail validation mid-batch again.
 *   2. The FINAL (highest-numbered / last-applied) definition of the check
 *      must exactly match the TS vocabulary — so the two can never
 *      silently drift (code writing a value the DB constraint doesn't
 *      allow, or vice versa).
 *
 * NOT pinned here: `proposals_status_check`. The plan (U9, Open Questions)
 * records that there is no single agreed source for it — the API declares
 * `ProposalStatus` in proposals/proposal.ts while packages/shared exports a
 * separate `proposalStatusSchema` — so which one is authoritative is an
 * open question rather than a test to write blind.
 */

// Exhaustive by construction: TypeScript's excess/missing-property check on
// a `Record<Union, true>` object literal fails to compile if the list and the
// union ever disagree, so these objects can't silently go stale.
const ALL_DISPATCH_ENTITY_TYPES: Record<DispatchEntityType, true> = {
  estimate: true,
  invoice: true,
  appointment_confirmation: true,
  appointment_reschedule: true,
  appointment_cancel: true,
  appointment_reminder: true,
  payment_receipt: true,
  invoice_overdue: true,
  delay_notice: true,
  appointment_en_route: true,
  daily_digest: true,
  conversation_reply: true,
  portal_session: true,
  custom_message: true,
};

const ALL_JOB_STATUSES: Record<JobStatus, true> = {
  new: true,
  scheduled: true,
  dispatched: true,
  in_progress: true,
  completed: true,
  invoiced: true,
  closed: true,
  canceled: true,
};

interface VocabularyPin {
  /** Constraint name as it appears in `ADD CONSTRAINT <name>`. */
  constraint: string;
  /** Column the CHECK constrains via `<column> IN (...)`. */
  column: string;
  /** Where the TS side lives — for the failure message. */
  codeSource: string;
  /** The TS vocabulary the LAST definition must equal exactly. */
  codeValues: readonly string[];
  /** Lower bound on ADD CONSTRAINT sites, so a regex miss fails loudly. */
  minOccurrences: number;
}

const PINS: VocabularyPin[] = [
  {
    constraint: 'message_dispatches_entity_type_check',
    column: 'entity_type',
    codeSource: 'DispatchEntityType (notifications/dispatch-repository.ts)',
    codeValues: Object.keys(ALL_DISPATCH_ENTITY_TYPES),
    minOccurrences: 6,
  },
  {
    constraint: 'jobs_status_check',
    column: 'status',
    codeSource: 'JobStatus (jobs/job.ts)',
    codeValues: Object.keys(ALL_JOB_STATUSES),
    minOccurrences: 1,
  },
  {
    constraint: 'leads_source_check',
    column: 'source',
    codeSource: 'LEAD_SOURCES (leads/enums.ts)',
    codeValues: LEAD_SOURCES,
    minOccurrences: 2,
  },
];

/**
 * Matches `ADD CONSTRAINT <name> CHECK (<column> IN (...))` with any
 * whitespace between tokens — both the one-line `ALTER TABLE t ADD
 * CONSTRAINT n\n CHECK` layout and the multi-clause `DROP CONSTRAINT …,
 * ADD CONSTRAINT …` layout — and captures whether the statement ends in
 * NOT VALID. `[^)]*` inside IN (...) is safe because value lists are plain
 * quoted literals; a CHECK with nested parens is not a vocabulary pin.
 */
function checkRe(pin: VocabularyPin): RegExp {
  return new RegExp(
    `ADD CONSTRAINT ${pin.constraint}\\s+CHECK \\(${pin.column} IN \\(\\s*([^)]*?)\\s*\\)\\)(\\s*NOT VALID)?\\s*;`,
    'g',
  );
}

function parseValueList(capture: string): string[] {
  return capture
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^'(.*)'$/, '$1'));
}

interface ParsedCheck {
  values: string[];
  hasNotValid: boolean;
}

function findAllChecks(sql: string, pin: VocabularyPin): ParsedCheck[] {
  const checks: ParsedCheck[] = [];
  for (const match of sql.matchAll(checkRe(pin))) {
    checks.push({ values: parseValueList(match[1]), hasNotValid: Boolean(match[2]) });
  }
  return checks;
}

describe.each(PINS)('$constraint vocabulary (deploy-blocker guard)', (pin) => {
  it(`every definition of ${pin.constraint} uses NOT VALID`, () => {
    const sql = getMigrationSQL();
    const checks = findAllChecks(sql, pin);
    expect(
      checks.length,
      `fewer ${pin.constraint} sites than expected — the regex missed a layout`,
    ).toBeGreaterThanOrEqual(pin.minOccurrences);

    const missing = checks
      .map((c, i) => ({ ...c, i }))
      .filter((c) => !c.hasNotValid);

    expect(
      missing,
      `ADD CONSTRAINT ${pin.constraint} without NOT VALID ` +
        'forces Postgres to validate the WHOLE table at that point in the ' +
        'corpus, on every redeploy (no migration ledger). If a later ' +
        'widening in the same corpus allows a value this one does not, any ' +
        'row already carrying that value bricks every future deploy ' +
        '(SQLSTATE 23514 / ATRewriteTable). Add NOT VALID.',
    ).toEqual([]);
  });

  it(`the final effective CHECK matches ${pin.codeSource} exactly`, () => {
    const sql = getMigrationSQL();
    const checks = findAllChecks(sql, pin);
    expect(checks.length).toBeGreaterThan(0);

    // DROP CONSTRAINT + ADD CONSTRAINT is replayed for every occurrence in
    // source order (Object.values() preserves insertion order — see
    // getMigrationSQL()), so the LAST occurrence is what the constraint
    // actually ends up as after the full corpus runs.
    const finalCheck = checks[checks.length - 1];
    const finalValues = new Set(finalCheck.values);
    const codeValues = new Set(pin.codeValues);

    const inCodeNotInDb = [...codeValues].filter((v) => !finalValues.has(v));
    const inDbNotInCode = [...finalValues].filter((v) => !codeValues.has(v));

    expect(
      inCodeNotInDb,
      `${pin.codeSource} values with no matching entry in the final ` +
        `${pin.constraint} CHECK — a write with this value would violate ` +
        'the constraint.',
    ).toEqual([]);
    expect(
      inDbNotInCode,
      `${pin.constraint} allows a value ${pin.codeSource} does not declare ` +
        '— likely a widening whose code never landed, or a type that went stale.',
    ).toEqual([]);
  });
});
