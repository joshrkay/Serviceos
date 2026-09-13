import { describe, it, expect } from 'vitest';
import { getMigrationSQL } from '../../src/db/schema';
import type { DispatchEntityType } from '../../src/notifications/dispatch-repository';

/**
 * Deploy-blocker regression guard (2026-08-29).
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
 * These two tests pin the fix and guard against it regressing again:
 *   1. Every ADD CONSTRAINT for this check, anywhere in the migration
 *      corpus, must carry NOT VALID — so re-running the corpus against a
 *      populated table can never fail validation mid-batch again.
 *   2. The FINAL (highest-numbered / last-applied) definition of the check
 *      must exactly match `DispatchEntityType` in dispatch-repository.ts —
 *      so the two can never silently drift (code writing a value the DB
 *      constraint doesn't allow, or vice versa).
 */

// Exhaustive by construction: TypeScript's excess/missing-property check on
// a `Record<DispatchEntityType, true>` object literal fails to compile if
// this list and the `DispatchEntityType` union ever disagree, so this array
// can't silently go stale.
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

const ENTITY_TYPE_CHECK_RE =
  /ADD CONSTRAINT message_dispatches_entity_type_check\s*\n\s*CHECK \(entity_type IN \(\s*([\s\S]*?)\s*\)\)(\s*NOT VALID)?;/g;

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

function findAllEntityTypeChecks(sql: string): ParsedCheck[] {
  const checks: ParsedCheck[] = [];
  let match: RegExpExecArray | null;
  ENTITY_TYPE_CHECK_RE.lastIndex = 0;
  while ((match = ENTITY_TYPE_CHECK_RE.exec(sql))) {
    checks.push({ values: parseValueList(match[1]), hasNotValid: Boolean(match[2]) });
  }
  return checks;
}

describe('message_dispatches entity_type vocabulary (deploy-blocker guard)', () => {
  it('every widening of message_dispatches_entity_type_check uses NOT VALID', () => {
    const sql = getMigrationSQL();
    const checks = findAllEntityTypeChecks(sql);
    expect(checks.length).toBeGreaterThanOrEqual(6);

    const missing = checks
      .map((c, i) => ({ ...c, i }))
      .filter((c) => !c.hasNotValid);

    expect(
      missing,
      'ADD CONSTRAINT message_dispatches_entity_type_check without NOT VALID ' +
        'forces Postgres to validate the WHOLE table at that point in the ' +
        'corpus, on every redeploy (no migration ledger). If a later ' +
        'widening in the same corpus allows a value this one does not, any ' +
        'row already carrying that value bricks every future deploy ' +
        '(SQLSTATE 23514 / ATRewriteTable). Add NOT VALID.',
    ).toEqual([]);
  });

  it('the final effective CHECK matches DispatchEntityType exactly', () => {
    const sql = getMigrationSQL();
    const checks = findAllEntityTypeChecks(sql);
    expect(checks.length).toBeGreaterThan(0);

    // DROP CONSTRAINT + ADD CONSTRAINT is replayed for every occurrence in
    // source order (Object.values() preserves insertion order — see
    // getMigrationSQL()), so the LAST occurrence is what the constraint
    // actually ends up as after the full corpus runs.
    const finalCheck = checks[checks.length - 1];
    const finalValues = new Set(finalCheck.values);
    const codeValues = new Set(Object.keys(ALL_DISPATCH_ENTITY_TYPES));

    const inCodeNotInDb = [...codeValues].filter((v) => !finalValues.has(v));
    const inDbNotInCode = [...finalValues].filter((v) => !codeValues.has(v));

    expect(
      inCodeNotInDb,
      'DispatchEntityType values with no matching entry in the final ' +
        'message_dispatches_entity_type_check CHECK — a dispatch write with ' +
        'this entityType would violate the constraint.',
    ).toEqual([]);
    expect(
      inDbNotInCode,
      'message_dispatches_entity_type_check allows a value DispatchEntityType ' +
        "does not declare — likely a widening whose code never landed, or a " +
        'type that went stale.',
    ).toEqual([]);
  });
});
