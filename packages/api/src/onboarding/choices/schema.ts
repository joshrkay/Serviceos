/**
 * Onboarding choice registry — Zod shapes.
 *
 * "Pick, don't build" onboarding (docs/plans/2026-10-18-001): Rivet assembles a
 * typical shop for the owner's trade and metro, then asks seven this-or-this
 * choices. Each choice is content, not code: a question Rivet speaks, two
 * options, the line Rivet would say to a caller if that option is picked, and
 * the typed setting values the option writes once the owner approves the
 * read-back. Content lives in per-trade TypeScript files under ./registry and
 * is validated against these schemas at module load so a bad entry fails the
 * build, not a customer.
 *
 * Templates may use these tokens, substituted by assembleTypicalShop():
 *   {businessName} {tripFee} {hourlyRate} {city} {ownerFirstName}
 */
import { z } from 'zod';

/** The seven core choices every owner answers, in the order Rivet asks them. */
export const CHOICE_KEYS = [
  'greeting',
  'trip_fee_and_rate',
  'booking_posture',
  'payment_collection_mode',
  'booking_hours',
  'emergency_target',
  'after_hours_mode',
] as const;
export type ChoiceKey = (typeof CHOICE_KEYS)[number];

/** Asked only of established shops (branch on "do you already have a business number?"). */
export const OPTIONAL_CHOICE_KEYS = ['existing_number'] as const;
export type OptionalChoiceKey = (typeof OPTIONAL_CHOICE_KEYS)[number];

export const ALL_CHOICE_KEYS = [...CHOICE_KEYS, ...OPTIONAL_CHOICE_KEYS] as const;
export type AnyChoiceKey = (typeof ALL_CHOICE_KEYS)[number];

export const ChoiceKeySchema = z.enum(ALL_CHOICE_KEYS);
export const OptionKeySchema = z.enum(['a', 'b']);
export type OptionKey = z.infer<typeof OptionKeySchema>;

/** Which regional price tier an option's prices come from (price choice only). */
export const PriceTierNameSchema = z.enum(['standard', 'premium']);
export type PriceTierName = z.infer<typeof PriceTierNameSchema>;

/**
 * Values an option writes when approved. Finite and typed: these are the only
 * things the read-back approval can land in tenant settings from a choice.
 * Prices are deliberately NOT here — tier-driven options carry `priceTier`
 * and assembly fills `tripFeeCents` / `hourlyRateCents` from the tier.
 */
export const ChoiceWritesSchema = z
  .object({
    voiceGreeting: z.string().min(1).max(240).optional(),
    autonomousBookingEnabled: z.boolean().optional(),
    paymentCollectionMode: z.enum(['pay_link', 'collect_on_site']).optional(),
    bookingHoursPreset: z.enum(['weekdays_7_5', 'mon_sat_7_5', 'any_time']).optional(),
    /** "Someone else first" is the free-speech override, not an option. */
    emergencyTarget: z.enum(['owner_cell', 'owner_cell_then_text']).optional(),
    afterHoursVoiceMode: z.enum(['ai_answering', 'voicemail']).optional(),
    hasExistingBusinessNumber: z.boolean().optional(),
  })
  .strict();
export type ChoiceWrites = z.infer<typeof ChoiceWritesSchema>;

export const ChoiceOptionSchema = z
  .object({
    key: OptionKeySchema,
    /** Short label on the card, as the owner would say it. */
    label: z.string().min(1).max(80),
    /** One supporting sentence under the label. */
    detail: z.string().max(220).optional(),
    /** What Rivet says to a caller if this option is picked. Template. */
    rivetLine: z.string().min(1).max(260),
    /** Present only on the price choice; assembly resolves cents from the tier. */
    priceTier: PriceTierNameSchema.optional(),
    writes: ChoiceWritesSchema,
  })
  .strict();
export type ChoiceOption = z.infer<typeof ChoiceOptionSchema>;

export const ChoiceEntrySchema = z
  .object({
    settingKey: ChoiceKeySchema,
    /** What Rivet asks. Template. Under ~20 words (one-breath rule). */
    question: z.string().min(1).max(140),
    /** One sentence of why, or what Rivet does regardless. Template. */
    supportLine: z.string().max(220).optional(),
    options: z.tuple([ChoiceOptionSchema, ChoiceOptionSchema]),
    /** The option most shops pick; marked on the card and used when the owner skips. */
    mostShops: OptionKeySchema,
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.options[0].key !== 'a' || entry.options[1].key !== 'b') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'options must be [a, b] in order', path: ['options'] });
    }
    const isPrice = entry.settingKey === 'trip_fee_and_rate';
    for (const [i, o] of entry.options.entries()) {
      if (isPrice && !o.priceTier) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'price options must name a priceTier', path: ['options', i, 'priceTier'] });
      }
      if (!isPrice && o.priceTier) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only the price choice may name a priceTier', path: ['options', i, 'priceTier'] });
      }
      if (!isPrice && Object.keys(o.writes).length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'option must write at least one value', path: ['options', i, 'writes'] });
      }
    }
  });
export type ChoiceEntry = z.infer<typeof ChoiceEntrySchema>;

/** A trade's full registry: every core key exactly once, optional keys at most once. */
export const TradeChoiceRegistrySchema = z.array(ChoiceEntrySchema).superRefine((entries, ctx) => {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.settingKey, (counts.get(e.settingKey) ?? 0) + 1);
  for (const k of CHOICE_KEYS) {
    const n = counts.get(k) ?? 0;
    if (n !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `core choice "${k}" must appear exactly once (found ${n})` });
    }
  }
  for (const k of OPTIONAL_CHOICE_KEYS) {
    if ((counts.get(k) ?? 0) > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `optional choice "${k}" must appear at most once` });
    }
  }
});
export type TradeChoiceRegistry = z.infer<typeof TradeChoiceRegistrySchema>;
