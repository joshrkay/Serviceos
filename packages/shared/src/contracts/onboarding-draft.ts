/**
 * Wire contract for the onboarding draft API ("pick, don't build" setup).
 *
 *   POST /api/onboarding/draft                       -> { draft, created }
 *   GET  /api/onboarding/draft                       -> { draft }
 *   PUT  /api/onboarding/draft/choices/:settingKey   -> { draft }
 *   POST /api/onboarding/draft/approve               -> { draft, proposalIds, approvedNow }
 *
 * The API owns the source schemas (packages/api/src/onboarding/choices/schema.ts
 * and onboarding/draft/contracts.ts). These mirror what crosses the wire, with
 * dates as ISO strings, so the web client can parse what it receives. Drift is
 * pinned by packages/api/test/onboarding/draft/wire-contract.test.ts, which
 * parses a real API-built draft with these schemas and fails when a field is
 * added, renamed, or dropped on either side.
 */
import { z } from 'zod';

/** The seven core choices every owner answers, in the order Rivet asks them. */
export const ONBOARDING_CORE_CHOICE_KEYS = [
  'greeting',
  'trip_fee_and_rate',
  'booking_posture',
  'payment_collection_mode',
  'booking_hours',
  'emergency_target',
  'after_hours_mode',
] as const;
export type OnboardingCoreChoiceKey = (typeof ONBOARDING_CORE_CHOICE_KEYS)[number];

/** Core choices plus the one asked only of established shops. */
export const ONBOARDING_CHOICE_KEYS = [...ONBOARDING_CORE_CHOICE_KEYS, 'existing_number'] as const;
export const OnboardingChoiceKeySchema = z.enum(ONBOARDING_CHOICE_KEYS);
export type OnboardingChoiceKey = z.infer<typeof OnboardingChoiceKeySchema>;

export const OnboardingOptionKeySchema = z.enum(['a', 'b']);
export type OnboardingOptionKey = z.infer<typeof OnboardingOptionKeySchema>;

/** Trade wording sets in the API's choice registry. */
export const ONBOARDING_REGISTRY_TRADES = ['plumbing', 'hvac', 'electrical', 'generic'] as const;

/** Integer cents, always. */
export const OnboardingPriceTierSchema = z
  .object({
    tripFeeCents: z.number().int().nonnegative(),
    hourlyRateCents: z.number().int().nonnegative(),
  })
  .strict();
export type OnboardingPriceTier = z.infer<typeof OnboardingPriceTierSchema>;

/** Values an option writes once the read-back is approved. */
export const OnboardingChoiceWritesSchema = z
  .object({
    voiceGreeting: z.string().optional(),
    autonomousBookingEnabled: z.boolean().optional(),
    paymentCollectionMode: z.enum(['pay_link', 'collect_on_site']).optional(),
    bookingHoursPreset: z.enum(['weekdays_7_5', 'mon_sat_7_5', 'any_time']).optional(),
    emergencyTarget: z.enum(['owner_cell', 'owner_cell_then_text']).optional(),
    afterHoursVoiceMode: z.enum(['voicemail', 'ai_answering']).optional(),
    hasExistingBusinessNumber: z.boolean().optional(),
  })
  .strict();
export type OnboardingChoiceWrites = z.infer<typeof OnboardingChoiceWritesSchema>;

export const AssembledOnboardingOptionSchema = z
  .object({
    key: OnboardingOptionKeySchema,
    /** Short label on the card, as the owner would say it. */
    label: z.string(),
    detail: z.string().optional(),
    /** What Rivet says to a caller if this option is picked. */
    rivetLine: z.string(),
    writes: OnboardingChoiceWritesSchema,
    /** Present only on the price choice. */
    prices: OnboardingPriceTierSchema.optional(),
  })
  .strict();
export type AssembledOnboardingOption = z.infer<typeof AssembledOnboardingOptionSchema>;

export const AssembledOnboardingChoiceSchema = z
  .object({
    settingKey: OnboardingChoiceKeySchema,
    /** What Rivet asks. */
    question: z.string(),
    supportLine: z.string().optional(),
    options: z.tuple([AssembledOnboardingOptionSchema, AssembledOnboardingOptionSchema]),
    /** The option most shops pick; also the answer used when the owner skips. */
    mostShops: OnboardingOptionKeySchema,
  })
  .strict();
export type AssembledOnboardingChoice = z.infer<typeof AssembledOnboardingChoiceSchema>;

export const AssembledOnboardingShopSchema = z
  .object({
    trade: z.enum(ONBOARDING_REGISTRY_TRADES),
    packId: z.string(),
    metroCode: z.string().nullable(),
    metroName: z.string().nullable(),
    /** Populated only when the area code spans more than one metro. */
    metroCandidates: z.array(z.object({ metroCode: z.string(), name: z.string() }).strict()),
    priceSource: z.enum(['metro', 'national', 'pack_default']),
    /** True only when the prices really are for the owner's metro. */
    showsCity: z.boolean(),
    choices: z.array(AssembledOnboardingChoiceSchema),
    defaults: z.record(z.string(), OnboardingOptionKeySchema),
  })
  .strict();
export type AssembledOnboardingShop = z.infer<typeof AssembledOnboardingShopSchema>;

/** A picked option, or a free-speech override that supplies the writes directly. */
export const StagedOnboardingChoiceSchema = z.union([
  z.object({ option: OnboardingOptionKeySchema }).strict(),
  z
    .object({
      override: z
        .object({
          /** How the owner said it, shown on the read-back row. */
          label: z.string().min(1).max(120),
          writes: OnboardingChoiceWritesSchema,
          /** Only for the price choice. */
          prices: OnboardingPriceTierSchema.optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type StagedOnboardingChoice = z.infer<typeof StagedOnboardingChoiceSchema>;

/** Partial on purpose: an owner mid-way has staged some keys, not all. */
export const StagedOnboardingChoicesSchema = z.partialRecord(OnboardingChoiceKeySchema, StagedOnboardingChoiceSchema);
export type StagedOnboardingChoices = z.infer<typeof StagedOnboardingChoicesSchema>;

export const OnboardingDraftStatusSchema = z.enum(['draft', 'approved']);
export type OnboardingDraftStatus = z.infer<typeof OnboardingDraftStatusSchema>;

export const OnboardingDraftSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    packId: z.string(),
    trade: z.string(),
    metroCode: z.string().nullable(),
    metroName: z.string().nullable(),
    businessName: z.string(),
    ownerFirstName: z.string().nullable(),
    clientTimezone: z.string().nullable(),
    assembled: AssembledOnboardingShopSchema,
    choices: StagedOnboardingChoicesSchema,
    status: OnboardingDraftStatusSchema,
    /** Optimistic-concurrency token: send it back with every staged choice. */
    version: z.number().int().positive(),
    proposalIds: z.array(z.string()),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    approvedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type OnboardingDraft = z.infer<typeof OnboardingDraftSchema>;

/** Body of POST /api/onboarding/draft. */
export const CreateOnboardingDraftBodySchema = z
  .object({
    packId: z.string().min(1).max(40),
    businessName: z.string().min(1).max(120),
    ownerFirstName: z.string().min(1).max(60).optional(),
    /** Owner cell, used only to place the metro. Not stored on the draft. */
    phone: z.string().min(7).max(20).optional(),
    clientTimezone: z.string().min(1).max(64).optional(),
  })
  .strict();
export type CreateOnboardingDraftBody = z.infer<typeof CreateOnboardingDraftBodySchema>;

/** Body of PUT /api/onboarding/draft/choices/:settingKey. */
export const StageOnboardingChoiceBodySchema = z
  .object({
    choice: StagedOnboardingChoiceSchema,
    version: z.number().int().positive(),
  })
  .strict();
export type StageOnboardingChoiceBody = z.infer<typeof StageOnboardingChoiceBodySchema>;

/** Response of GET and PUT. */
export const OnboardingDraftResponseSchema = z.object({ draft: OnboardingDraftSchema }).strict();
export type OnboardingDraftResponse = z.infer<typeof OnboardingDraftResponseSchema>;

/** Response of POST /api/onboarding/draft: 201 when created, 200 for an existing draft. */
export const CreateOnboardingDraftResponseSchema = z
  .object({ draft: OnboardingDraftSchema, created: z.boolean() })
  .strict();
export type CreateOnboardingDraftResponse = z.infer<typeof CreateOnboardingDraftResponseSchema>;

/** Response of POST /api/onboarding/draft/approve. */
export const ApproveOnboardingDraftResponseSchema = z
  .object({
    draft: OnboardingDraftSchema,
    proposalIds: z.array(z.string()),
    /** False on an idempotent re-tap of "That's right". */
    approvedNow: z.boolean(),
  })
  .strict();
export type ApproveOnboardingDraftResponse = z.infer<typeof ApproveOnboardingDraftResponseSchema>;
