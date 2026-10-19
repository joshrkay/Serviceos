/**
 * Zod contracts for the onboarding draft: the pre-approval state of "pick,
 * don't build" setup. A draft holds the assembled typical shop and the owner's
 * staged choices. Nothing in it reaches tenant settings until the read-back is
 * approved, when the draft is turned into onboarding_* proposals.
 */
import { z } from 'zod';
import { ChoiceKeySchema, ChoiceWritesSchema, OptionKeySchema } from '../choices/schema';
import { PriceTierSchema } from '../choices/price-tiers';
import { NPA_METROS } from '../../compliance/us-geography';

/** A picked option, or a free-speech override that supplies the writes directly. */
export const StagedChoiceSchema = z.union([
  z.object({ option: OptionKeySchema }).strict(),
  z
    .object({
      override: z
        .object({
          /** How the owner said it, shown on the read-back row. */
          label: z.string().min(1).max(120),
          writes: ChoiceWritesSchema,
          /** Only for the price choice. */
          prices: PriceTierSchema.optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type StagedChoice = z.infer<typeof StagedChoiceSchema>;

/** Body of PUT /api/onboarding/draft/choices/:settingKey. */
export const StageChoiceBodySchema = z
  .object({
    choice: StagedChoiceSchema,
    /** Optimistic concurrency: the draft version the client last saw. */
    version: z.number().int().positive(),
  })
  .strict();

/**
 * Body of PUT /api/onboarding/draft/owner-phone. `ownerPhone` is whatever the
 * owner typed; the route normalises it to E.164 (a value that does not
 * normalise is a 400 naming `ownerPhone`). `version` is the same optimistic
 * concurrency token as StageChoiceBodySchema.
 */
export const SetOwnerPhoneBodySchema = z
  .object({
    ownerPhone: z.string().min(1).max(40),
    version: z.number().int().positive(),
  })
  .strict();

/** The curated metro codes (the keys of NPA_METROS, the same keys regional_price_tiers uses). */
const METRO_CODES = Object.keys(NPA_METROS) as [string, ...string[]];

/**
 * Body of PUT /api/onboarding/draft/metro: the owner says the city the shop
 * was priced for is not theirs. `metro` is one of the curated codes; the name
 * always comes from the table, never from the client. `version` is the draft
 * version the Ready screen rendered, required like the other draft PUTs.
 */
export const SetMetroBodySchema = z
  .object({
    metro: z.enum(METRO_CODES),
    version: z.number().int().positive(),
  })
  .strict();

/**
 * Body of POST /api/onboarding/draft/approve. `expectedVersion` is an optional
 * optimistic-concurrency token: the draft `version` the read-back the owner is
 * looking at was rendered from. When omitted the row lock alone serialises
 * approve against PUT /choices and against another approve. Additive and
 * optional, so a client that posts `{}` keeps working. On an already-approved
 * draft it is compared with the version the current approval attempt started
 * from (the approval itself, or the latest retry, each of which moves the
 * version by one): equal or omitted is the idempotent 200, anything else is
 * 409 VERSION_CONFLICT, so a tab that has not seen a retry is refused after it.
 */
export const ApproveDraftBodySchema = z
  .object({
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Body of POST /api/onboarding/draft/undo. `expectedVersion` is REQUIRED: the
 * approved draft's `version` as the saving screen rendered it (the approve
 * response's `draft.version`, the retry response's after a Retry, or the status
 * draft block's after a reload). It binds the tap to the approval attempt that
 * screen showed, so a stale tab cannot undo a newer approval (409 VERSION_CONFLICT).
 */
export const UndoDraftBodySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
  })
  .strict();

/**
 * Body of POST /api/onboarding/draft/reset ("Start over"). `expectedVersion` is
 * REQUIRED: the approved draft's `version` the stopped or failed screen was
 * rendered from (the status draft block carries it). A tab that rendered an
 * earlier approval, since replaced by a reset and a new approval, is refused
 * (409 VERSION_CONFLICT), so a reset never reverts an approval its caller never saw.
 */
export const ResetDraftBodySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
  })
  .strict();

/**
 * The machine `details.reason` of a 409 DRAFT_RESET_REFUSED: `applied` (a member
 * is executed; Settings finishes it) or `executing` (a member is landing now).
 * Pinned equal to the shared list by wire-contract.test.ts.
 */
export const DRAFT_RESET_REFUSAL_REASONS = ['applied', 'executing'] as const;

/**
 * Body of POST /api/onboarding/draft/retry. `expectedVersion` is the approved
 * draft's `version` as the failed screen rendered it; a different value is 409
 * VERSION_CONFLICT under the draft lock, before the set is read. Optional until
 * every client sends it (S4-10); no body keeps the bodyless behaviour.
 */
export const RetryDraftBodySchema = z
  .object({
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Every 409 code the draft routes answer with. Each refusal's message is
 * `CODE: plain sentence` (the web reads the code from the prefix; raw statuses
 * ride in `details` only). Pinned equal to the shared list and to the codes the
 * draft sources actually throw by wire-contract.test.ts.
 */
export const DRAFT_REFUSAL_CODES = [
  'VERSION_CONFLICT',
  'DRAFT_APPROVED',
  'DRAFT_NOT_APPROVED',
  'DRAFT_METRO_LOCKED',
  'DRAFT_APPROVAL_FAILED',
  'DRAFT_RETRY_UNSAFE',
  'DRAFT_RETRY_NOTHING_FAILED',
  'DRAFT_RETRY_FAILED',
  'DRAFT_UNDO_REFUSED',
  'UNDO_WINDOW_CLOSED',
  'DRAFT_RESET_REFUSED',
] as const;

/** Partial on purpose: an owner mid-way through has staged some keys, not all. */
export const ChoicesRecordSchema = z.partialRecord(ChoiceKeySchema, StagedChoiceSchema);
export type ChoicesRecord = z.infer<typeof ChoicesRecordSchema>;

export const DraftStatusSchema = z.enum(['draft', 'approved']);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

/** Query/body shape when a draft is first created (from signup or the demo-call lead). */
export const CreateDraftInputSchema = z
  .object({
    packId: z.string().min(1).max(40),
    businessName: z.string().min(1).max(120),
    ownerFirstName: z.string().min(1).max(60).optional(),
    /** Owner cell. Normalised to E.164 and stored on the draft as the owner's cell; it also places the metro. */
    phone: z.string().min(7).max(20).optional(),
    clientTimezone: z.string().min(1).max(64).optional(),
  })
  .strict();
