import { z } from 'zod';

/**
 * update_catalog_item proposal payload (WS20 — correction-repetition meta-proposal).
 *
 * Raised by the correction loop (learning/corrections/correction-repetition.ts)
 * once the owner has corrected the SAME catalog SKU's price at least
 * CORRECTION_REPETITION_THRESHOLD times: instead of silently re-applying the
 * within-day cascade over and over, the AI PROPOSES making the correction the
 * catalog default itself. On approval the execution handler updates the catalog
 * item's unit price (catalog/catalog-item.ts:updateCatalogItem).
 *
 * Config/capture-class action (actionClassForProposalType): moves no money
 * (only shapes FUTURE drafts, which are themselves reviewed), contacts no
 * customer, and is reversible (edit the price back). The correction loop
 * creates it with NO trust tier, so it always lands for human review — never
 * auto-executed (D-004 proposal-first posture; the meta-proposal goes through
 * the normal inbox, no auto-approve).
 *
 * All money is integer cents (CLAUDE.md core pattern — never floating point).
 * `evidence` carries the repetition provenance so the review UI can show WHY
 * the AI is asking ("you've corrected this 3 times").
 */
export const updateCatalogItemPayloadSchema = z.object({
  /** Catalog item whose unit price the proposal would update. */
  catalogItemId: z.string().uuid(),
  /** SKU label, when the corrected lines carried one (informational). */
  sku: z.string().min(1).optional(),
  /** Catalog item name at proposal time (informational; for the summary/UI). */
  name: z.string().min(1).optional(),
  /**
   * The catalog's price the owner has been repeatedly overriding, in integer
   * cents. Informational — the executor writes `proposedUnitPriceCents`.
   */
  currentUnitPriceCents: z.number().int().nonnegative(),
  /** The corrected price to make the catalog default, in integer cents. */
  proposedUnitPriceCents: z.number().int().nonnegative(),
  /** Repetition provenance that earned this proposal. */
  evidence: z.object({
    /** Correction lesson ids that evidence the repetition (at least the trigger). */
    lessonIds: z.array(z.string().min(1)).min(1),
    /** Total same-SKU price corrections observed (>= the threshold). */
    correctionCount: z.number().int().positive(),
  }),
});

export type UpdateCatalogItemPayload = z.infer<typeof updateCatalogItemPayloadSchema>;
