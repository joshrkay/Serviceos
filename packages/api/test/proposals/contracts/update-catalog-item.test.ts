import { describe, it, expect } from 'vitest';
import { updateCatalogItemPayloadSchema } from '../../../src/proposals/contracts/update-catalog-item';

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
