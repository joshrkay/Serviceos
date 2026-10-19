/**
 * Wire contract for the onboarding draft API ("pick, don't build" setup).
 *
 *   POST /api/onboarding/draft                       -> { draft, created }
 *   GET  /api/onboarding/draft                       -> { draft }
 *   PUT  /api/onboarding/draft/choices/:settingKey   -> { draft }
 *   PUT  /api/onboarding/draft/metro                 -> { draft }
 *   POST /api/onboarding/draft/approve               -> { draft, proposalIds, approvedNow }
 *   POST /api/onboarding/draft/retry                 -> { draft, retriedProposalIds }
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
    /**
     * The owner's cell in E.164, once the API stores one. Optional on the wire:
     * an API that predates the field omits it, and the schema is strict, so a
     * required key would reject every draft from it.
     */
    ownerPhone: z.string().nullable().optional(),
  })
  .strict();
export type OnboardingDraft = z.infer<typeof OnboardingDraftSchema>;

/** Where an approved draft's proposals are on their way to execution (the status draft fact; derived, never stored). */
export const ONBOARDING_DRAFT_EXECUTION_STATES = ['pending', 'executing', 'executed', 'failed', 'stopped'] as const;
export const OnboardingDraftExecutionSchema = z.enum(ONBOARDING_DRAFT_EXECUTION_STATES);
export type OnboardingDraftExecution = z.infer<typeof OnboardingDraftExecutionSchema>;

/**
 * The way out the shell may offer for a `failed` or `stopped` set (derived,
 * never stored): `reset` while the whole-draft reset (Start over) can run,
 * `settings` once only Settings can finish the setup. Pinned equal to the API
 * list by wire-contract.test.ts.
 */
export const ONBOARDING_DRAFT_RECOVERY = ['reset', 'settings'] as const;
export const OnboardingDraftRecoverySchema = z.enum(ONBOARDING_DRAFT_RECOVERY);
export type OnboardingDraftRecovery = z.infer<typeof OnboardingDraftRecoverySchema>;

/**
 * The `draft` block of GET /api/onboarding/status: the pre-approval draft's
 * progress and, once approved, what is derived from its proposals. Every
 * derived field is optional so a payload from an API that predates it parses.
 * Not strict, like the API's own status schema.
 */
export const OnboardingStatusDraftSchema = z.object({
  status: OnboardingDraftStatusSchema,
  choicesAnswered: z.number().int().min(0),
  version: z.number().int().positive(),
  /** null while the draft is still being edited (or has nothing to track). */
  execution: OnboardingDraftExecutionSchema.nullable().optional(),
  /** Whether the whole-draft undo can still take back every listed proposal; a hint, never a guard. Absent while editing. */
  undoable: z.boolean().optional(),
  /** Present only while `execution` is `failed` or `stopped`. */
  recovery: OnboardingDraftRecoverySchema.optional(),
});
export type OnboardingStatusDraft = z.infer<typeof OnboardingStatusDraftSchema>;

/** Body of POST /api/onboarding/draft. */
export const CreateOnboardingDraftBodySchema = z
  .object({
    packId: z.string().min(1).max(40),
    businessName: z.string().min(1).max(120),
    ownerFirstName: z.string().min(1).max(60).optional(),
    /** Owner cell: places the metro (the API also keeps the normalised number on the draft as `ownerPhone`). */
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

/**
 * The curated metros a shop can be priced for: the API's NPA_METROS table
 * (packages/api/src/compliance/us-geography.ts), code and name, in its order.
 * "Not Cleveland?" offers this list; PUT /draft/metro accepts only these codes.
 * Pinned equal to the API table by wire-contract.test.ts.
 */
export const ONBOARDING_METROS = [
  { code: 'NYC', name: 'New York' },
  { code: 'LAX', name: 'Los Angeles' },
  { code: 'CHI', name: 'Chicago' },
  { code: 'DFW', name: 'Dallas-Fort Worth' },
  { code: 'HOU', name: 'Houston' },
  { code: 'DC', name: 'Washington' },
  { code: 'MIA', name: 'Miami' },
  { code: 'PHL', name: 'Philadelphia' },
  { code: 'ATL', name: 'Atlanta' },
  { code: 'PHX', name: 'Phoenix' },
  { code: 'BOS', name: 'Boston' },
  { code: 'SFO', name: 'San Francisco Bay Area' },
  { code: 'RIV', name: 'Inland Empire' },
  { code: 'DET', name: 'Detroit' },
  { code: 'SEA', name: 'Seattle' },
  { code: 'MSP', name: 'Minneapolis-St. Paul' },
  { code: 'SAN', name: 'San Diego' },
  { code: 'TPA', name: 'Tampa Bay' },
  { code: 'DEN', name: 'Denver' },
  { code: 'BAL', name: 'Baltimore' },
  { code: 'STL', name: 'St. Louis' },
  { code: 'ORL', name: 'Orlando' },
  { code: 'CLT', name: 'Charlotte' },
  { code: 'SAT', name: 'San Antonio' },
  { code: 'PDX', name: 'Portland' },
  { code: 'SAC', name: 'Sacramento' },
  { code: 'PIT', name: 'Pittsburgh' },
  { code: 'LAS', name: 'Las Vegas' },
  { code: 'AUS', name: 'Austin' },
  { code: 'CIN', name: 'Cincinnati' },
  { code: 'KC', name: 'Kansas City' },
  { code: 'CMH', name: 'Columbus' },
  { code: 'IND', name: 'Indianapolis' },
  { code: 'CLE', name: 'Cleveland' },
  { code: 'BNA', name: 'Nashville' },
  { code: 'SLC', name: 'Salt Lake City' },
  { code: 'MKE', name: 'Milwaukee' },
  { code: 'JAX', name: 'Jacksonville' },
  { code: 'OKC', name: 'Oklahoma City' },
  { code: 'RDU', name: 'Raleigh-Durham' },
  { code: 'MEM', name: 'Memphis' },
  { code: 'RIC', name: 'Richmond' },
  { code: 'SDF', name: 'Louisville' },
  { code: 'MSY', name: 'New Orleans' },
  { code: 'BUF', name: 'Buffalo' },
] as const;
export type OnboardingMetro = (typeof ONBOARDING_METROS)[number];
export type OnboardingMetroCode = OnboardingMetro['code'];

const ONBOARDING_METRO_CODES = ONBOARDING_METROS.map((m) => m.code) as [OnboardingMetroCode, ...OnboardingMetroCode[]];

/**
 * Body of PUT /api/onboarding/draft/metro: re-price a draft with nothing staged
 * for another curated metro. `version` is the draft version the Ready screen
 * rendered. The API answers 409 DRAFT_METRO_LOCKED once any choice is staged.
 */
export const SetOnboardingMetroBodySchema = z
  .object({
    metro: z.enum(ONBOARDING_METRO_CODES),
    version: z.number().int().positive(),
  })
  .strict();
export type SetOnboardingMetroBody = z.infer<typeof SetOnboardingMetroBodySchema>;

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

/**
 * Body of POST /api/onboarding/draft/approve. `expectedVersion` is the draft
 * version the read-back on screen was rendered from; the API answers 409
 * VERSION_CONFLICT when the draft has moved on. Optional, so `{}` still works.
 */
export const ApproveOnboardingDraftBodySchema = z
  .object({ expectedVersion: z.number().int().positive().optional() })
  .strict();
export type ApproveOnboardingDraftBody = z.infer<typeof ApproveOnboardingDraftBodySchema>;

/**
 * Response of POST /api/onboarding/draft/retry: the draft at its new version and
 * the proposals that were re-queued. `undoable` says whether Undo can take back
 * the set as the retry left it (false after a partial retry); optional so a
 * response from an API that predates it parses.
 */
export const RetryOnboardingDraftResponseSchema = z
  .object({
    draft: OnboardingDraftSchema,
    retriedProposalIds: z.array(z.string()),
    undoable: z.boolean().optional(),
  })
  .strict();
export type RetryOnboardingDraftResponse = z.infer<typeof RetryOnboardingDraftResponseSchema>;

/**
 * Body of POST /api/onboarding/draft/retry. `expectedVersion` is the approved
 * draft's version as the failed screen rendered it (the API answers 409
 * VERSION_CONFLICT when the draft has moved on). Optional for now.
 */
export const RetryOnboardingDraftBodySchema = z
  .object({ expectedVersion: z.number().int().positive().optional() })
  .strict();
export type RetryOnboardingDraftBody = z.infer<typeof RetryOnboardingDraftBodySchema>;

/**
 * Body of POST /api/onboarding/draft/undo. `expectedVersion` is required: the
 * approved draft's version as the saving screen rendered it (the approve or
 * retry response's `draft.version`, or the status draft block's after a reload).
 */
export const UndoOnboardingDraftBodySchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();
export type UndoOnboardingDraftBody = z.infer<typeof UndoOnboardingDraftBodySchema>;

/** Response of POST /api/onboarding/draft/undo: the draft, editable again. */
export const UndoOnboardingDraftResponseSchema = z.object({ draft: OnboardingDraftSchema }).strict();
export type UndoOnboardingDraftResponse = z.infer<typeof UndoOnboardingDraftResponseSchema>;

/**
 * Body of POST /api/onboarding/draft/reset ("Start over"). `expectedVersion` is
 * required: the approved draft's version the stopped or failed screen was
 * rendered from (the status draft block's `version`).
 */
export const ResetOnboardingDraftBodySchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();
export type ResetOnboardingDraftBody = z.infer<typeof ResetOnboardingDraftBodySchema>;

/** Response of POST /api/onboarding/draft/reset: the draft, editable again, choices intact. */
export const ResetOnboardingDraftResponseSchema = z.object({ draft: OnboardingDraftSchema }).strict();
export type ResetOnboardingDraftResponse = z.infer<typeof ResetOnboardingDraftResponseSchema>;

/**
 * `details.reason` of a 409 DRAFT_RESET_REFUSED: `applied` (part of the setup is
 * already saved; Settings finishes it) or `executing` (part of it is landing
 * now; the next status read settles it). Pinned equal to the API list.
 */
export const ONBOARDING_DRAFT_RESET_REASONS = ['applied', 'executing'] as const;
export type OnboardingDraftResetReason = (typeof ONBOARDING_DRAFT_RESET_REASONS)[number];

/**
 * Every 409 code the draft routes answer with. The API's message is
 * `CODE: plain sentence`, so a client reads the code from the prefix. Pinned
 * equal to the API list by wire-contract.test.ts.
 */
export const ONBOARDING_DRAFT_REFUSALS = [
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
export type OnboardingDraftRefusal = (typeof ONBOARDING_DRAFT_REFUSALS)[number];
