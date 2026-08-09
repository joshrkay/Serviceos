import { z } from 'zod';
import { MAX_QUANTITY } from '../../materials/material-item';

/**
 * add_material proposal payload (Task 9, 2026-08-07 tradesperson plan).
 *
 * Adds a row to the voice-captured shopping list (`material_items`,
 * migration 272, Task 8's substrate — src/materials/material-item.ts).
 * Capture-class: no money moves, and it's reversible (the row can be
 * marked purchased or simply ignored) — same posture as `log_expense`.
 *
 * `description` is the only required field: non-empty AFTER TRIMMING
 * (quality-review I5) — `z.string().min(1)` alone accepts a whitespace-only
 * string like `"   "`, which `material-item.ts`'s own
 * `validateCreateMaterialItemInput` rejects (it trims before checking
 * length). Without `.trim()` here too, a whitespace-only description would
 * pass THIS draft-time gate and then throw a `ValidationError` at
 * execution — precisely the "contract looser than the layer it feeds"
 * class this module's own `quantity` cap comment (below) warns about,
 * just on a different field.
 *
 * `quantity` defaults to 1 and is capped at `MAX_QUANTITY` — imported from
 * `material-item.ts` (quality-review I6), not duplicated as a second
 * `1_000_000` literal. Two independent literals that merely SAY they must
 * agree can silently drift; importing the one real constant makes drift a
 * compile-time impossibility instead of a comment nobody re-reads. This is
 * the SAME domain cap `validateCreateMaterialItemInput` (material-item.ts)
 * enforces at the repo layer — Task 8's repo layer throws a
 * `ValidationError` on a quantity above its cap, and Task 6's change-order
 * contract already showed what happens when a downstream validator's cap
 * silently drifts from the layer above it — a payload that PASSES this
 * contract but then throws inside `buildMaterialItem` would surface as an
 * execution failure instead of a clean draft-time rejection.
 *
 * `jobId`, `vendor`, and `neededBy` are all optional — a shopping-list
 * item can be unlinked to any job, and the vendor/timing are whatever the
 * caller happened to say.
 *
 * `neededBy` is shape-validated as a real calendar date (`YYYY-MM-DD`),
 * reusing the same "genuinely parseable, not just YYYY-MM-DD-shaped"
 * discipline `create-service-agreement.ts`'s `startsOn` uses (Task 8's
 * `Date` column accepts a string blindly; a hand-crafted "2026-02-30"
 * would otherwise round-trip into a rolled-over date). UNLIKE `startsOn`,
 * a past `neededBy` is NOT rejected — see the module doc comment for the
 * decision.
 *
 * ── Why a past `neededBy` is allowed (deliberate divergence from Task 7's
 * `startsOn`) ──
 *
 * `startsOn` (create-service-agreement.ts) rejects a past date because a
 * back-dated value feeds `runDueAgreements` — a 60-second recurring sweep
 * that would immediately treat the plan as overdue and drip a job+invoice
 * pair on every tick until it caught up. `neededBy` has NO such consumer:
 * nothing sweeps, bills, or repeats off it — Task 8's `listPending` doesn't
 * even filter by it (see `add-material-handler.ts` / `voice-lookup-answer.ts`
 * for the read side). It is purely informational context on a review card
 * and, later, a spoken answer. A tradesperson can genuinely say "we needed
 * this yesterday" — an already-overdue part is a real, useful signal on a
 * shopping list, not a malformed one — so rejecting it here would refuse a
 * perfectly legitimate capture for no safety benefit.
 */

/** Shape-validate a real calendar date (not just YYYY-MM-DD-shaped) — mirrors create-service-agreement.ts's startsOnShapeSchema. */
const neededBySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'neededBy must look like YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'neededBy must be a real calendar date');

export const addMaterialPayloadSchema = z.object({
  // .trim() BEFORE .min(1) (quality-review I5) — see module doc comment.
  description: z.string().trim().min(1).max(1000),
  quantity: z.number().int().positive().max(MAX_QUANTITY).default(1),
  jobId: z.string().uuid().optional(),
  vendor: z.string().max(200).optional(),
  neededBy: neededBySchema.optional(),
});

export type AddMaterialPayload = z.infer<typeof addMaterialPayloadSchema>;
