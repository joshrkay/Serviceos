/**
 * Zod contracts for the onboarding draft: the pre-approval state of "pick,
 * don't build" setup. A draft holds the assembled typical shop and the owner's
 * staged choices. Nothing in it reaches tenant settings until the read-back is
 * approved, when the draft is turned into onboarding_* proposals.
 */
import { z } from 'zod';
import { ChoiceKeySchema, ChoiceWritesSchema, OptionKeySchema } from '../choices/schema';
import { PriceTierSchema } from '../choices/price-tiers';

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
export type StageChoiceBody = z.infer<typeof StageChoiceBodySchema>;

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
    /** Owner cell, used only to place the metro. Not stored on the draft. */
    phone: z.string().min(7).max(20).optional(),
    clientTimezone: z.string().min(1).max(64).optional(),
  })
  .strict();
export type CreateDraftInput = z.infer<typeof CreateDraftInputSchema>;
