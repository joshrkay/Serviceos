/**
 * §5 I6 (STRUCTURAL) — **a gate on an entity id must have something behind it
 * that can lift it** (D-029, #909, #1021, map #995).
 *
 * ## The "contradiction", and the decision
 *
 * The PRD calls I6 *"the weakest invariant in the table"* because two
 * statements look incompatible:
 *
 *   - **the text** — *"A gate nothing can lift is a capability that can never
 *     be approved (#909)"*; and
 *   - **the test** — `gated-reference-resolution.test.ts`, the case titled
 *     *"leaves gates it does not know how to resolve strictly alone"*, which
 *     the PRD reads as pinning *"an unresolvable gate is a legal state"*.
 *
 * **Decision: the TEXT is right, and the test is right too — the PRD's claim
 * that they contradict is what is wrong.** They quantify over different sets,
 * and D-029 itself writes both of them:
 *
 *   1. D-029 rule 1 (`docs/decisions.md:785`): *"A `missingFields` gate **on an
 *      entity id** is only legitimate if a resolver can lift it."* The
 *      invariant is scoped to entity-id gates from the first sentence.
 *   2. D-029 Constraints (`docs/decisions.md:820`): *"A gate absent from
 *      `GATED_REFERENCE_SOURCES` (**a parsed time, a path-shaped catalog
 *      gate**) is left strictly alone."* The same decision that states the
 *      invariant also states the post-draft loop's SCOPE — and the pinning
 *      test asserts exactly that scope, over exactly those examples
 *      (`newScheduledStart`, `recurrenceRule`, `lineItems[0].catalogItemId`).
 *      It is a statement about which gates this MODULE touches, under D-026's
 *      "one core, thin adapters". It never says the operator is left stuck.
 *   3. #909's own pure case settles the intent: *"`convert_lead` /
 *      `mark_lead_lost` … gate on `leadId` while no `lead` EntityKind existed
 *      at all, so that gate had NO resolver behind it on ANY surface and those
 *      two capabilities were unreachable by construction."* The remedy D-029
 *      chose was to ADD `leadId` to `GATED_REFERENCE_SOURCES` — give the gate
 *      a lifter — never to accept the stall as legal.
 *
 * So nothing is deleted and nothing is reversed; no new D-NNN is needed. What
 * needs correcting is the PRD's I6 Confirm cell, which asserts a
 * contradiction that the citations do not support. That correction is proposed
 * in the lane report, not made here.
 *
 * ## The guard for the winner
 *
 * **The rule in one sentence:** every entity-id gate key a proposal contract
 * can emit is a key of `GATED_REFERENCE_SOURCES`, or is in an explicit
 * exception list that NAMES the mechanism which lifts it — a gate with
 * nothing behind it fails the build.
 *
 * The key set is DERIVED, not grepped: `contractGapFields`
 * (`ai/tasks/task-input.ts:104`) builds `missingFields` from the leading path
 * segment of each Zod issue, so the gate keys a contract can emit are exactly
 * the heads of its issue paths. Parsing an empty payload against every schema
 * in `PROPOSAL_TYPE_SCHEMAS` enumerates them mechanically — the same
 * computation the production path performs, rather than a regex over prose.
 * The literal `missingFields: ['…']` emitters in `src` are swept as a second
 * source so a hand-written gate cannot slip past the derivation.
 *
 * Evidence class: STRUCTURAL (negative controls plant an unliftable gate on
 * both sources).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import path from 'path';
import { PROPOSAL_TYPE_SCHEMAS } from '../../src/proposals/contracts';
import { GATED_REFERENCE_SOURCES } from '../../src/ai/resolution/gated-reference-resolution';
import { listSourceFiles, plantTree, removeTree } from '../support/structural-scan';

const API_SRC = path.resolve(__dirname, '../../src');

// ─── Source 1: derive the emittable gate keys from the contracts ────────────

/**
 * Every gate key a proposal contract can emit, per type.
 *
 * Mirrors `contractGapFields`: an empty payload makes every required field
 * report an issue, and the gate key is `path.split(/[.[]/)[0]` — the leading
 * segment. A schema wrapped in `.refine()` can also emit a root-level issue
 * with an empty path; those carry no field name and are represented as
 * `''` (the caller's `fallback` supplies the name at runtime), so they are
 * dropped here rather than guessed at.
 */
export function gateKeysEmittableByContracts(
  schemas: Record<string, z.ZodSchema>,
): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const [proposalType, schema] of Object.entries(schemas)) {
    const result = schema.safeParse({});
    if (result.success) continue;
    for (const issue of result.error.issues) {
      const head = String(issue.path[0] ?? '');
      if (head.length === 0) continue;
      const seen = byKey.get(head) ?? [];
      if (!seen.includes(proposalType)) seen.push(proposalType);
      byKey.set(head, seen);
    }
  }
  return byKey;
}

// ─── Source 2: sweep the hand-written literal emitters ──────────────────────

/**
 * Every string literal that appears inside an array literal on a line
 * mentioning `missingFields`, anywhere under `roots` — comment-stripped.
 *
 * This is the belt to the derivation's braces: a handler that writes
 * `missingFields: ['somethingId']` by hand, for a field its contract does not
 * even declare, is still a gate the operator will hit.
 */
export function literalGateKeyEmitters(
  roots: readonly string[],
): Array<{ key: string; at: string }> {
  const out: Array<{ key: string; at: string }> = [];
  for (const file of listSourceFiles(roots)) {
    const lines = file.code.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.includes('issingFields')) continue;
      for (const arr of line.matchAll(/\[([^[\]]*)\]/g)) {
        for (const lit of arr[1].matchAll(/['"`]([^'"`]+)['"`]/g)) {
          out.push({ key: lit[1], at: `${file.rel}:${i + 1}` });
        }
      }
      for (const push of line.matchAll(/\.push\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        out.push({ key: push[1], at: `${file.rel}:${i + 1}` });
      }
      for (const push of line.matchAll(/\.push\(\s*`([^`]*)`\s*\)/g)) {
        out.push({ key: push[1].replace(/\$\{[^}]*\}/g, ''), at: `${file.rel}:${i + 1}` });
      }
    }
  }
  return out;
}

// ─── Classification ─────────────────────────────────────────────────────────

/**
 * Is this gate key an ENTITY-ID gate — the scope D-029 rule 1 quantifies over?
 *
 * Two conditions, both mechanical:
 *
 *   1. a flat payload key ending in `Id` (a parsed time `newScheduledStart`, a
 *      cadence `recurrenceRule`, a settings value `timezone` and a line-item
 *      block `lineItems` are value gates the operator types on the card —
 *      outside I6 by construction, and the very examples D-029's Constraints
 *      paragraph lists as left strictly alone); and
 *   2. **the contract types it as a UUID.** This is the line between a
 *      reference to a persisted ROW — which an operator cannot type and which
 *      therefore must be resolved or prefilled for them, the whole of #909 —
 *      and a key-shaped VALUE they can simply supply. `categoryId:
 *      z.string().min(1)` on the onboarding contracts is a vertical-pack
 *      category slug (`hvac_repair`), not an entity id; `entityId:
 *      z.string().uuid()` is a row.
 *
 * Condition 2 is derived from the schema, not asserted about it: the key is
 * probed with an invalid and a valid uuid and the schema is asked which it
 * rejects. No hand-maintained list of "which ids are real ids" — that would be
 * the loosened regex this file exists to avoid.
 */
const NOT_A_UUID = 'not-a-uuid';
const A_UUID = '11111111-1111-4111-8111-111111111111';

function issuesAtKey(schema: z.ZodSchema, key: string, value: string): number {
  const result = schema.safeParse({ [key]: value });
  if (result.success) return 0;
  return result.error.issues.filter((i) => i.path[0] === key).length;
}

export function isUuidTypedByAnyContract(
  schemas: Record<string, z.ZodSchema>,
  key: string,
): boolean {
  for (const schema of Object.values(schemas)) {
    if (issuesAtKey(schema, key, NOT_A_UUID) > 0 && issuesAtKey(schema, key, A_UUID) === 0) {
      return true;
    }
  }
  return false;
}

export function isEntityIdGate(schemas: Record<string, z.ZodSchema>, key: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*Id$/.test(key) && isUuidTypedByAnyContract(schemas, key);
}

/** A path-shaped gate (`lineItems[0].catalogItemId`) — flat-key rules do not apply. */
export function isPathShapedGate(key: string): boolean {
  return /[.[]/.test(key) && /Id$/.test(key);
}

/**
 * Entity-id gates that are liftable by something OTHER than the post-draft
 * resolver, with the mechanism named. This is the "or the documented
 * exception" half of I6's acceptance criterion — and every entry has to say
 * what the operator actually does to clear it, because a gate whose exception
 * reads "n/a" is the unreachable capability #909 is about.
 */
const LIFTED_BY_OTHER_MECHANISM: ReadonlyArray<{
  key: string;
  mechanism: string;
}> = [
  {
    key: 'locationId',
    mechanism:
      'Lifted by the OPERATOR on the review card, not by a resolver: the drafting handler attaches `sourceContext.serviceLocationGap` carrying the recovered address, where it was recovered from, and a structured prefill for the address inputs (create-appointment-task.ts:745 raises the gate; routes/assistant.ts:275 declares the companion context and :711 lifts it onto the card). Without that companion the gate would be the dead end this invariant forbids — which is exactly why the assistant route rebuilds it from a whitelist and comments that anything not lifted there is silently dropped.',
  },
  {
    key: 'lineItems[].catalogItemId',
    mechanism:
      'Path-shaped catalog gate, named by D-029 Constraints as left strictly alone by the post-draft loop. Its lifter runs BEFORE drafting: the deterministic catalog resolver (ai/resolution/catalog-resolver.ts) grounds every AI-drafted line price in the tenant catalog per CLAUDE.md; an uncatalogued line keeps the gate and forces human review by design (I4), which is a REVIEWED state, not an unliftable one — the operator picks or prices the line on the card.',
  },
  {
    key: 'editActions[].lineItem.catalogItemId',
    mechanism:
      'The same catalog grounding on the edit path (ai/resolution/edit-action-grounding.ts:307,379). Same lifter, same human affordance.',
  },
];

function classify(key: string): 'resolver' | 'documented-exception' | 'unliftable' {
  if (Object.hasOwn(GATED_REFERENCE_SOURCES, key)) return 'resolver';
  if (LIFTED_BY_OTHER_MECHANISM.some((e) => e.key === key)) return 'documented-exception';
  return 'unliftable';
}

/**
 * Every entity-id gate key from both sources that nothing is known to lift.
 *
 * The two sources use different shape tests, deliberately. A contract-derived
 * key is probed against its own schema (the uuid test above) because the
 * schema is right there and is the authority on what the field is. A
 * hand-written `missingFields: ['xId']` literal has no schema behind it — the
 * author has simply declared "this id is missing", so the flat `*Id` shape is
 * taken at face value. Being stricter on the derived side and literal on the
 * hand-written side is the conservative pairing: it cannot mistake a slug for
 * a row reference, and it cannot miss a gate someone wrote by hand.
 */
export function unliftableEntityIdGates(
  schemas: Record<string, z.ZodSchema>,
  roots: readonly string[],
): Array<{ key: string; where: string }> {
  const out: Array<{ key: string; where: string }> = [];

  for (const [key, types] of gateKeysEmittableByContracts(schemas)) {
    if (!isEntityIdGate(schemas, key)) continue;
    if (classify(key) !== 'unliftable') continue;
    out.push({ key, where: `contract(s): ${types.join(', ')}` });
  }

  for (const emitter of literalGateKeyEmitters(roots)) {
    const key = emitter.key;
    if (!/^[A-Za-z][A-Za-z0-9]*Id$/.test(key) && !isPathShapedGate(key)) continue;
    if (classify(key) !== 'unliftable') continue;
    if (out.some((o) => o.key === key)) continue;
    out.push({ key, where: emitter.at });
  }

  return out;
}

/**
 * The genuine I6 gaps found on `origin/main` at 2026-09-12: entity-id gates a
 * contract can emit with nothing on record to lift them.
 *
 * All three are SYSTEM-SUPPLIED ids — the row is chosen by the code, not named
 * by the operator — which makes them a milder shape than #909's `convert_lead`
 * (where the operator DID name a lead and had no way to be understood). They
 * are still recorded rather than excused, because I6 is a universal and
 * because the consequence when one is emitted is identical: a card the
 * operator is shown and cannot clear.
 *
 * Reported on #1021 for Fable and the product owner; not fixed here.
 */
const KNOWN_UNLIFTABLE: ReadonlyArray<{ key: string; where: string; note: string }> = [
  {
    key: 'reviewId',
    where: 'packages/shared/src/contracts/review-response-proposal.ts:73 (review_response_proposal)',
    note: 'The review being answered is picked from the reputation queue by the drafting task (ai/tasks/review-response-task.ts:182), never named by the operator. Emitted as a gate on the voice leg by proposals/voice-payload.ts:504 if it is ever absent, and no resolver or card affordance can supply it.',
  },
  {
    key: 'entityId',
    where: 'packages/api/src/proposals/contracts/adopt-entity-alias.ts:11 (adopt_entity_alias)',
    note: 'The entity the alias is being adopted for — already resolved by the time the alias proposal is drafted. Owner-only to approve (proposals/actions.ts:227).',
  },
  {
    key: 'groundedProposalId',
    where: 'packages/api/src/proposals/contracts/adopt-entity-alias.ts:13 (adopt_entity_alias)',
    note: 'The proposal whose resolution grounded the alias — a system id by construction.',
  },
];

// ─── The guard ──────────────────────────────────────────────────────────────

describe('§5 I6 (STRUCTURAL) — every entity-id gate a proposal contract can emit has a lifter', () => {
  it('the derivation is not vacuous: the contracts really do emit entity-id gates', () => {
    const keys = [...gateKeysEmittableByContracts(PROPOSAL_TYPE_SCHEMAS).keys()];
    const entityIdKeys = keys.filter((k) => isEntityIdGate(PROPOSAL_TYPE_SCHEMAS, k));
    // If this ever hits zero the guard has stopped measuring anything —
    // §12.4d, "directory is not proof".
    expect(entityIdKeys.length).toBeGreaterThan(0);
    expect(entityIdKeys).toContain('customerId');
  });

  it('the uuid test separates row references from key-shaped values, mechanically', () => {
    // A row reference the operator cannot type.
    expect(isUuidTypedByAnyContract(PROPOSAL_TYPE_SCHEMAS, 'customerId')).toBe(true);
    expect(isUuidTypedByAnyContract(PROPOSAL_TYPE_SCHEMAS, 'appointmentId')).toBe(true);
    // A vertical-pack category slug ("hvac_repair"), `z.string().min(1)` —
    // shaped like an id, is not one, and is outside I6's scope.
    expect(isUuidTypedByAnyContract(PROPOSAL_TYPE_SCHEMAS, 'categoryId')).toBe(false);
    expect(isEntityIdGate(PROPOSAL_TYPE_SCHEMAS, 'categoryId')).toBe(false);
  });

  it('the literal sweep is not vacuous: hand-written missingFields emitters are found', () => {
    const emitted = literalGateKeyEmitters([API_SRC]).map((e) => e.key);
    expect(emitted).toContain('customerId');
    expect(emitted).toContain('locationId');
  });

  it('no NEW entity-id gate appears without a lifter (the three recorded gaps are frozen)', () => {
    const unliftable = unliftableEntityIdGates(PROPOSAL_TYPE_SCHEMAS, [API_SRC]);
    const unrecorded = unliftable.filter(
      (u) => !KNOWN_UNLIFTABLE.some((k) => k.key === u.key),
    );
    expect(
      unrecorded.map((u) => `${u.key}  (${u.where})`),
      [
        'A proposal can be gated on an entity id that nothing lifts.',
        '',
        'D-029: "A missingFields gate on an entity id is only legitimate if a',
        'resolver can lift it." A gate with no lifter is #909\'s convert_lead —',
        'a capability that can never be approved.',
        '',
        'Fix: add the id field to GATED_REFERENCE_SOURCES with the free text it',
        'pairs with, or add it to LIFTED_BY_OTHER_MECHANISM naming what the',
        'operator actually does to clear it.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('the recorded gaps are still exactly where the report says they are', () => {
    const found = unliftableEntityIdGates(PROPOSAL_TYPE_SCHEMAS, [API_SRC]).map((u) => u.key);
    for (const known of KNOWN_UNLIFTABLE) {
      expect(found, `${known.key} — ${known.note}`).toContain(known.key);
    }
  });

  /**
   * I6 AS WRITTEN — the honest state of the invariant. It does not hold for
   * three system-supplied ids. Recorded rather than defined away: when they
   * are given a lifter (or shown unreachable and removed from the gate path),
   * this case starts PASSING, `it.fails` itself fails, and the row is forced
   * back for re-grading.
   */
  it.fails(
    'I6 as written — every entity-id gate has a lifter (KNOWN GAP: reviewId, entityId, groundedProposalId)',
    () => {
      expect(unliftableEntityIdGates(PROPOSAL_TYPE_SCHEMAS, [API_SRC])).toEqual([]);
    },
  );

  it('every documented exception NAMES its lifting mechanism (an exception without one is the gap)', () => {
    for (const entry of LIFTED_BY_OTHER_MECHANISM) {
      expect(entry.mechanism.length, entry.key).toBeGreaterThan(80);
      expect(entry.mechanism, entry.key).toMatch(/\.ts/);
    }
  });

  /**
   * The other half of the decision, asserted rather than argued: the pinning
   * test's subject matter is disjoint from I6's. Everything the post-draft
   * loop leaves alone is a value gate or a path-shaped gate — never a flat
   * entity-id gate with no lifter. If that ever stops holding, the two really
   * WOULD contradict and the row must be re-opened.
   */
  it('the "leaves gates it does not know how to resolve strictly alone" set is disjoint from the entity-id gate set', () => {
    const leftAlone = ['newScheduledStart', 'recurrenceRule', 'lineItems[0].catalogItemId'];
    for (const key of leftAlone) {
      const isFlatEntityId = isEntityIdGate(PROPOSAL_TYPE_SCHEMAS, key);
      expect(
        isFlatEntityId && classify(key) === 'unliftable',
        `${key}: the pinning test leaves it alone AND nothing lifts it — that WOULD be the contradiction`,
      ).toBe(false);
    }
    // And the loop's own table does not claim them.
    for (const key of leftAlone) {
      expect(Object.hasOwn(GATED_REFERENCE_SOURCES, key), key).toBe(false);
    }
  });

  it('#909\'s pure case is closed: leadId has a resolver behind it', () => {
    // "convert_lead / mark_lead_lost … gate on leadId while no lead
    // EntityKind existed at all" — the gate with NO resolver on ANY surface.
    expect(Object.hasOwn(GATED_REFERENCE_SOURCES, 'leadId')).toBe(true);
    expect(GATED_REFERENCE_SOURCES.leadId.kind).toBe('lead');
    expect(GATED_REFERENCE_SOURCES.leadId.payloadFields.length).toBeGreaterThan(0);
  });

  // ─── Negative controls ────────────────────────────────────────────────────

  it('NEGATIVE CONTROL — a contract that gates on an unliftable entity id fails the guard', () => {
    const planted = {
      ...PROPOSAL_TYPE_SCHEMAS,
      // A new capability gated on an id with no resolver and no exception —
      // #909's convert_lead, re-created.
      plant_dispatch_route: z.object({
        routeId: z.string().uuid(),
        routeReference: z.string().optional(),
      }),
    };
    const unliftable = unliftableEntityIdGates(planted, [API_SRC]);
    expect(unliftable.map((u) => u.key)).toContain('routeId');
    expect(unliftable.find((u) => u.key === 'routeId')?.where).toContain('plant_dispatch_route');
  });

  it('NEGATIVE CONTROL — a hand-written missingFields literal with no lifter fails the guard', () => {
    const dir = plantTree('i6-plant', {
      'planted-task.ts': [
        'export function draft() {',
        '  const missingFields: string[] = [];',
        "  missingFields.push('warrantyClaimId');",
        '  return { missingFields };',
        '}',
        '',
      ].join('\n'),
    });
    try {
      const unliftable = unliftableEntityIdGates({}, [dir]);
      expect(unliftable.map((u) => u.key)).toEqual(['warrantyClaimId']);
      expect(unliftable[0].where).toMatch(/planted-task\.ts:3$/);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL (inverse) — a gate key quoted only in a doc comment is NOT reported', () => {
    const dir = plantTree('i6-comment-only', {
      'commented.ts': [
        '/**',
        " * Historically this drafted with missingFields: ['warrantyClaimId'];",
        ' * it now resolves the reference before drafting.',
        ' */',
        'export const ok = true;',
        '',
      ].join('\n'),
    });
    try {
      expect(unliftableEntityIdGates({}, [dir])).toEqual([]);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL — removing a resolver from the table surfaces its gates as unliftable', () => {
    // Proves the guard reads GATED_REFERENCE_SOURCES rather than restating a
    // hardcoded answer: with `customerId` classified as unliftable, the very
    // gate sixteen chat capabilities stalled on in #909 reappears.
    const withoutCustomer = Object.fromEntries(
      Object.entries(GATED_REFERENCE_SOURCES).filter(([k]) => k !== 'customerId'),
    );
    const classifyWithout = (key: string): boolean =>
      !Object.hasOwn(withoutCustomer, key) &&
      !LIFTED_BY_OTHER_MECHANISM.some((e) => e.key === key);

    expect(classifyWithout('customerId')).toBe(true);
    expect(classify('customerId')).toBe('resolver');
  });
});
