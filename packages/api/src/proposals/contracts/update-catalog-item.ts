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
 * `evidence` was added so the review UI could show WHY the AI is asking
 * ("you've corrected this 3 times") — though no UI consumes it yet (see
 * below). It is OPTIONAL (follow-up fix, 2026-08-09): the correction loop
 * is the only producer that can honestly populate it, but this type now
 * also has a voice on-ramp
 * (`UpdateCatalogItemTaskHandler`, ai/tasks/voice-extended-tasks.ts) that
 * has no lesson to point to and correctly omits the key rather than
 * fabricate one. Nothing reads `payload.evidence` — not
 * `UpdateCatalogItemExecutionHandler.execute()` (only reads
 * `catalogItemId` + `proposedUnitPriceCents`), not any review-card UI in
 * `packages/web`/`packages/mobile` — so "required" was pure ceremony that
 * bought nothing except breaking `editProposal` (proposals/actions.ts),
 * which revalidates the FULL merged payload against this schema: a
 * voice-drafted proposal failed with "Invalid payload after edit" at ANY
 * price, always, not just at an edge case. `approveProposal` was never
 * affected (it only blocks on the tracked `missingFields` list, not full
 * Zod re-validation), so approve/execute worked fine — only the review
 * card's EDIT action was broken. When `evidence` IS present (the
 * correction loop's honest case), its own shape (non-empty `lessonIds`,
 * positive `correctionCount`) is still enforced — optional presence, not a
 * loosened shape.
 *
 * `proposedUnitPriceCents` carries NO price ceiling (follow-up fix,
 * 2026-08-09 — it briefly mirrored `add-catalog-item.ts`'s
 * `MAX_UNIT_PRICE_CENTS` sanity ceiling, "I4", removed here). That ceiling
 * is a backstop against a MISHEARD SPOKEN figure, and it correctly still
 * lives on `add_catalog_item`'s contract — but `add_catalog_item` has
 * exactly ONE producer (voice), so a contract-level ceiling and a
 * drafting-time gate can never disagree there. `update_catalog_item` has
 * TWO producers, and `proposedUnitPriceCents` carries a never-spoken value
 * on both of the non-"fresh voice price" paths:
 *   (a) a voice name/description-only edit inherits the item's own
 *       UNTOUCHED price (`requestedPriceCents ?? resolvedItem.unitPriceCents`
 *       in `UpdateCatalogItemTaskHandler`, ai/tasks/voice-extended-tasks.ts)
 *       — never a spoken figure that could be misheard;
 *   (b) the correction-repetition loop carries `afterCents` straight from
 *       already-persisted lesson data (learning/corrections/
 *       correction-repetition.ts) — also never spoken.
 * A legitimately priced catalog item over $100k is reachable on both paths
 * (no bound in `createCatalogItem`, none on `POST /api/catalog-items`, and
 * the DB CHECK is `unit_price_cents >= 0` with no ceiling), so a
 * contract-level ceiling here rejected real prices the operator never
 * touched. The ONE path that ever writes a genuinely spoken value into
 * this field — `UpdateCatalogItemTaskHandler`'s own drafting gate — keeps
 * its `MAX_UNIT_PRICE_CENTS` check exactly where a misheard-figure
 * backstop belongs: at the point a spoken number is first trusted, not on
 * a shared contract two other, non-spoken producers must also satisfy.
 * `currentUnitPriceCents` was never ceilinged for the same reason (see the
 * field's own doc comment) — `proposedUnitPriceCents` now matches that
 * posture instead of contradicting it.
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
   * Not ceilinged — see module doc comment.
   */
  currentUnitPriceCents: z.number().int().nonnegative(),
  /**
   * The corrected price to make the catalog default, in integer cents.
   * Deliberately NOT ceilinged — see module doc comment (producer
   * topology: this field carries never-spoken values from both real
   * producers; the misheard-spoken-figure ceiling lives in
   * UpdateCatalogItemTaskHandler's own drafting gate instead).
   */
  proposedUnitPriceCents: z.number().int().nonnegative(),
  /**
   * Repetition provenance that earned this proposal. OPTIONAL — only the
   * correction-repetition loop can honestly populate this; the voice
   * on-ramp (UpdateCatalogItemTaskHandler) omits it. See the module doc
   * comment for why "required" was pure ceremony that only broke
   * `editProposal`.
   */
  evidence: z
    .object({
      /** Correction lesson ids that evidence the repetition (at least the trigger). */
      lessonIds: z.array(z.string().min(1)).min(1),
      /** Total same-SKU price corrections observed (>= the threshold). */
      correctionCount: z.number().int().positive(),
    })
    .optional(),
});

export type UpdateCatalogItemPayload = z.infer<typeof updateCatalogItemPayloadSchema>;
