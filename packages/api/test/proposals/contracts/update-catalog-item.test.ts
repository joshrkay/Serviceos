import { describe, it, expect } from 'vitest';
import { updateCatalogItemPayloadSchema } from '../../../src/proposals/contracts/update-catalog-item';
import { MAX_UNIT_PRICE_CENTS } from '../../../src/proposals/contracts/add-catalog-item';

const CATALOG_ITEM_ID = '550e8400-e29b-41d4-a716-446655440000';

// Follow-up fix (2026-08-09) — `evidence` (lessonIds + correctionCount) is
// now OPTIONAL on this contract. It exists purely to carry the
// correction-repetition loop's provenance ("you've corrected this N
// times") for the review UI; a voice-drafted proposal
// (UpdateCatalogItemTaskHandler, ai/tasks/voice-extended-tasks.ts) has no
// lesson to point to and deliberately omits the key rather than fabricate
// one. Before this fix `evidence` was REQUIRED, so a voice-drafted payload
// failed `validateProposalPayload` at ANY price — which meant
// `editProposal` (proposals/actions.ts) rejected the merged payload with
// "Invalid payload after edit" for EVERY voice-drafted update_catalog_item
// proposal, not just an edge case. Nothing reads `payload.evidence` at
// execution (UpdateCatalogItemExecutionHandler only reads catalogItemId +
// proposedUnitPriceCents) or in the review UI, so making it optional loses
// no real behavior.
describe('update_catalog_item payload contract — evidence is optional (voice drafts have none)', () => {
  const basePayload = {
    catalogItemId: CATALOG_ITEM_ID,
    name: 'AC diagnostic fee',
    currentUnitPriceCents: 7900,
    proposedUnitPriceCents: 8900,
  };

  it('validates a voice-drafted payload with NO evidence key at all', () => {
    const result = updateCatalogItemPayloadSchema.safeParse(basePayload);
    expect(result.success).toBe(true);
  });

  it("still validates the correction loop's payload WITH evidence present (the one honest producer)", () => {
    const result = updateCatalogItemPayloadSchema.safeParse({
      ...basePayload,
      evidence: { lessonIds: ['lesson-1'], correctionCount: 3 },
    });
    expect(result.success).toBe(true);
  });

  // Optional does not mean "anything goes" — when the correction loop DOES
  // supply evidence, it must still be well-formed. This pins that we did
  // not accidentally widen `evidence`'s own shape while relaxing its
  // presence requirement.
  it('rejects a present-but-malformed evidence object (empty lessonIds)', () => {
    const result = updateCatalogItemPayloadSchema.safeParse({
      ...basePayload,
      evidence: { lessonIds: [], correctionCount: 3 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a present-but-malformed evidence object (non-positive correctionCount)', () => {
    const result = updateCatalogItemPayloadSchema.safeParse({
      ...basePayload,
      evidence: { lessonIds: ['lesson-1'], correctionCount: 0 },
    });
    expect(result.success).toBe(false);
  });
});

// Follow-up fix (2026-08-09) — the MAX_UNIT_PRICE_CENTS ceiling on
// `proposedUnitPriceCents` was REMOVED from this contract (it briefly
// mirrored add_catalog_item's ceiling, "I4"). It was always meant as a
// backstop against a MISHEARD SPOKEN figure, but proposedUnitPriceCents
// carries never-spoken values on two producer paths: a voice name/
// description-only edit inherits the item's own untouched price
// (`requestedPriceCents ?? resolvedItem.unitPriceCents` in
// UpdateCatalogItemTaskHandler, ai/tasks/voice-extended-tasks.ts), and the
// correction-repetition loop carries `afterCents` straight from persisted
// lesson data. Both are legitimate, human-verified prices the
// misheard-figure backstop was never meant to police — a real catalog item
// priced above $100k must not be rejected on EDIT just for existing. The
// ceiling now lives ONLY in the voice drafting handler's own gate (the one
// path that ever writes a genuinely SPOKEN value into this field) — see
// `test/ai/tasks/update-catalog-item-task.test.ts`, which is now that
// gate's SOLE enforcement proof and must not be deleted as a "redundant
// mirror" of add_catalog_item's contract-level test.
//
// Producer-topology contrast with add_catalog_item (whose ceiling is
// UNCHANGED and correct, kept exactly as-is): add_catalog_item has exactly
// ONE producer (voice), so its contract-level ceiling and its drafting-time
// gate can never disagree by construction. update_catalog_item has TWO
// producers — voice AND the correction loop — and the non-voice one
// legitimately carries a human-entered/persisted price the backstop was
// never meant to police, so a SHARED contract-level ceiling was the wrong
// place to enforce it.
describe('update_catalog_item payload contract — no price ceiling (producer-topology fix)', () => {
  const priceBasePayload = {
    catalogItemId: CATALOG_ITEM_ID,
    currentUnitPriceCents: 10000,
    evidence: { lessonIds: ['l1'], correctionCount: 3 },
  };

  // The exactly-ceiling case is folded into this same test rather than
  // kept standalone: with the old ceiling restored, exactly-ceiling still
  // validates (it's <= the bound), so on its own it can't tell a correct
  // fix from a reverted one — it was an orphaned assertion that proved
  // nothing about this fix. Only the one-cent-above case discriminates;
  // pinning both together keeps the old boundary value documented without
  // a test that passes either way.
  it('accepts a proposedUnitPriceCents at AND one cent above the OLD sanity ceiling (100_000_00) — the contract no longer bounds this field', () => {
    for (const proposedUnitPriceCents of [MAX_UNIT_PRICE_CENTS, MAX_UNIT_PRICE_CENTS + 1]) {
      const result = updateCatalogItemPayloadSchema.safeParse({
        ...priceBasePayload,
        proposedUnitPriceCents,
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts a legitimately priced catalog item far above $100k (the correction-loop path)', () => {
    const result = updateCatalogItemPayloadSchema.safeParse({
      ...priceBasePayload,
      currentUnitPriceCents: 250_000_00,
      proposedUnitPriceCents: 250_000_00,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a proposedUnitPriceCents of exactly 0 — the nonnegative floor is inclusive', () => {
    const result = updateCatalogItemPayloadSchema.safeParse({
      ...priceBasePayload,
      proposedUnitPriceCents: 0,
    });
    expect(result.success).toBe(true);
  });

  it('still rejects a negative proposedUnitPriceCents — the >= 0 floor is untouched by this fix', () => {
    const result = updateCatalogItemPayloadSchema.safeParse({
      ...priceBasePayload,
      proposedUnitPriceCents: -1,
    });
    expect(result.success).toBe(false);
  });

  // currentUnitPriceCents is informational (the RESOLVED item's real,
  // already-persisted price, never spoken) and the domain/HTTP layer
  // places no upper bound on a catalog item's price — a legitimately
  // priced pre-existing item over $100k must not be rejected just for
  // being echoed back on this payload. (Unaffected by this fix — already
  // true before it — kept here for parity with proposedUnitPriceCents now
  // sharing the same "no ceiling" posture.)
  it('does NOT ceiling currentUnitPriceCents either — a pre-existing item priced above $100k still validates', () => {
    const result = updateCatalogItemPayloadSchema.safeParse({
      ...priceBasePayload,
      currentUnitPriceCents: MAX_UNIT_PRICE_CENTS + 1,
      proposedUnitPriceCents: MAX_UNIT_PRICE_CENTS + 1,
    });
    expect(result.success).toBe(true);
  });
});
