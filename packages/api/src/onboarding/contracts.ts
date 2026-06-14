import { z } from 'zod';

const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const DayHours = z.object({ open: TimeOfDay, close: TimeOfDay }).nullable();

export const BusinessHoursSchema = z
  .object({
    mon: DayHours.optional(),
    tue: DayHours.optional(),
    wed: DayHours.optional(),
    thu: DayHours.optional(),
    fri: DayHours.optional(),
    sat: DayHours.optional(),
    sun: DayHours.optional(),
  })
  .default({});

export const BusinessIdentityInputSchema = z.object({
  businessName: z.string().min(1).max(120),
  serviceAreaText: z.string().max(200).optional(),
  serviceAreaRadius: z.number().int().min(1).max(500).optional(),
  businessHours: BusinessHoursSchema,
  jobBufferMinutes: z.number().int().min(0).max(240),
  hourlyRateCents: z.number().int().min(100).max(100_000),
  // IANA timezone name (e.g. "America/Phoenix"). Optional — the client
  // sends browser-detected tz so the AI books at the operator's local
  // time. Omit to keep whatever's already stored; first-write defaults to ET.
  timezone: z.string().min(1).max(64).optional(),
  // P8-016 — owner's personal cell phone for emergency patch-through.
  // Accepts raw user input ("(512) 555-1234", "+15125551234", "512.555.1234")
  // and is normalized to E.164 server-side via normalizeMobileE164. Empty
  // string clears the value; omit to leave whatever is already stored.
  ownerPhone: z.string().max(40).optional(),
  // Feature 2 extras — a street/service address, the ZIP codes served, and
  // the multi-select of services offered (free-form catalog keys). All
  // optional + additive; omit to leave unchanged.
  serviceAddress: z.string().max(200).optional(),
  serviceAreaZips: z.array(z.string().regex(/^\d{5}$/, 'expected a 5-digit ZIP')).max(100).optional(),
  servicesOffered: z.array(z.string().min(1).max(60)).max(50).optional(),
});
export type BusinessIdentityInput = z.infer<typeof BusinessIdentityInputSchema>;

export const PackPickInputSchema = z.object({
  packId: z.enum(['hvac', 'plumbing']),
});
export type PackPickInput = z.infer<typeof PackPickInputSchema>;

// Feature 4 — voice agent configuration. voiceId is a preset key (e.g.
// 'rachel'); greeting is an optional override (empty/absent → auto-generated
// from business name + services).
export const VoiceConfigInputSchema = z.object({
  voiceId: z.string().min(1).max(40),
  greeting: z.string().max(500).optional(),
});
export type VoiceConfigInput = z.infer<typeof VoiceConfigInputSchema>;

// Feature 5 — calendar connection. 'google' kicks off OAuth; 'builtin' uses
// ServiceOS scheduling (the skip path).
export const CalendarChoiceInputSchema = z.object({
  provider: z.enum(['google', 'builtin']),
});
export type CalendarChoiceInput = z.infer<typeof CalendarChoiceInputSchema>;

// Number picker — area-code search for purchasable numbers. A NANP area code
// is exactly 3 digits; `limit` caps how many candidates to show.
export const PhoneAvailableInputSchema = z.object({
  areaCode: z.string().regex(/^\d{3}$/, 'expected a 3-digit area code'),
  limit: z.number().int().min(1).max(20).optional(),
});
export type PhoneAvailableInput = z.infer<typeof PhoneAvailableInputSchema>;

// Number picker — claim a specific number the tradesperson chose from the
// search results. E.164 (+1 + 10 digits for US/Canada).
export const PhoneClaimInputSchema = z.object({
  phoneNumber: z.string().regex(/^\+1\d{10}$/, 'expected an E.164 US/Canada number'),
});
export type PhoneClaimInput = z.infer<typeof PhoneClaimInputSchema>;

export const OnboardingStepIdSchema = z.enum(['signup', 'identity', 'pack', 'phone', 'billing', 'ai_check', 'test_call']);
export type OnboardingStepId = z.infer<typeof OnboardingStepIdSchema>;

export const OnboardingStepStatusSchema = z.enum(['done', 'current', 'pending', 'error', 'skipped']);
export type OnboardingStepStatus = z.infer<typeof OnboardingStepStatusSchema>;

export const OnboardingStepSchema = z.object({
  id: OnboardingStepIdSchema,
  status: OnboardingStepStatusSchema,
  blockers: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const SubscriptionStatusSchema = z
  .enum(['trialing', 'active', 'past_due', 'canceled', 'incomplete'])
  .nullable();
export type SubscriptionStatusValue = z.infer<typeof SubscriptionStatusSchema>;

export const OnboardingStatusResponseSchema = z.object({
  steps: z.array(OnboardingStepSchema).length(7),
  currentStep: OnboardingStepIdSchema.nullable(),
  isComplete: z.boolean(),
  voiceAgentLive: z.boolean(),
  /** The tenant id — lets the web client stamp tenant_id onto funnel events. */
  tenantId: z.string(),
  /** Mirror of tenants.subscription_status. Drives the past-due payment banner. */
  subscriptionStatus: SubscriptionStatusSchema,
  /** ISO-8601 timestamp of the 30-minute upgrade nudge fire-event. Drives the in-app banner. */
  upgradePromptShownAt: z.string().datetime().optional(),
  /** ISO-8601 timestamp of the activation milestone (first real inbound call).
   * Drives the one-time celebration banner. Absent until activation fires. */
  activatedAt: z.string().datetime().optional(),
});
export type OnboardingStatusResponse = z.infer<typeof OnboardingStatusResponseSchema>;
