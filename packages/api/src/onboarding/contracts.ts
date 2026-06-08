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
});
export type BusinessIdentityInput = z.infer<typeof BusinessIdentityInputSchema>;

export const PackPickInputSchema = z.object({
  packId: z.enum(['hvac', 'plumbing']),
});
export type PackPickInput = z.infer<typeof PackPickInputSchema>;

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
