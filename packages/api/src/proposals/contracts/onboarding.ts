import { z } from 'zod';
import { isRuntimeTimezone } from '../../shared/timezone';

// Electrical and painting are accepted as basic second-class verticals; rich defaults are added separately.
const verticalTypeSchema = z.enum(['hvac', 'plumbing', 'electrical', 'painting']);

const lineItemCategorySchema = z.enum(['labor', 'material', 'equipment', 'other']);

export const onboardingTenantSettingsPayloadSchema = z.object({
  businessName: z.string().min(1),
  city: z.string().optional(),
  state: z.string().optional(),
  verticalPacks: z.array(verticalTypeSchema).min(1),
  // B1.20 — the owner's hourly rate, when the pricing capture state
  // extracted one (price_type: 'hourly_rate'). Integer cents, per the
  // repo's money invariant. Optional/absent when no hourly rate was
  // spoken — never fabricated (see tenant-settings-proposer.ts).
  hourlyRateCents: z.number().int().min(0).optional(),
  /**
   * The tenant's IANA zone. Optional HERE (a voice capture cannot produce
   * one, so the proposal is emitted GATED on this key and the operator
   * supplies it from the review card) but REQUIRED by
   * `OnboardingTenantSettingsExecutionHandler` — gate and handler stay in
   * step, per tenant-settings-proposer.ts.
   *
   * Validated with `isRuntimeTimezone`, the SAME predicate
   * `CreateAppointmentTaskHandler` gates spoken bookings on
   * (ai/tasks/create-appointment-task.ts). That identity is the point: a
   * value that clears this gate cannot then fail the booking gate, which is
   * precisely the "approvable card that cannot succeed" shape. `.trim()`
   * and `.max(64)` match PUT /identity's BusinessIdentityInputSchema
   * (onboarding/contracts.ts) so the two write paths cannot drift.
   *
   * NEVER defaulted anywhere: a wrong zone silently misbooks appointments
   * (Phoenix mis-booking postmortem, migration 263 dropped the column's
   * `DEFAULT 'America/New_York'`). Absence must stay absence.
   */
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isRuntimeTimezone, {
      message: 'must be a recognized IANA timezone (e.g. "America/Phoenix")',
    })
    .optional(),
});

export const onboardingServiceCategoryPayloadSchema = z.object({
  verticalType: verticalTypeSchema,
  categoryId: z.string().min(1),
  displayName: z.string().min(1),
});

const templateLineItemSchema = z.object({
  description: z.string().min(1),
  category: lineItemCategorySchema.optional(),
  defaultQuantity: z.number().min(0),
  defaultUnitPriceCents: z.number().int().min(0),
  taxable: z.boolean(),
  sortOrder: z.number().int().min(0),
});

export const onboardingEstimateTemplatePayloadSchema = z.object({
  verticalType: verticalTypeSchema,
  categoryId: z.string().min(1),
  templateName: z.string().min(1),
  lineItems: z.array(templateLineItemSchema).min(1),
  defaultNotes: z.string().optional(),
});

export const onboardingTeamMemberPayloadSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['technician', 'dispatcher', 'owner']),
  /**
   * The invitee's address. Optional HERE — voice cannot produce one from
   * "me and my cousin Carlos", so the proposal is emitted GATED on this key
   * (orchestration/onboarding-conversation.ts) — but REQUIRED by
   * `OnboardingTeamMemberExecutionHandler`.
   *
   * Declared with EXACTLY `inviteUserSchema`'s rule from routes/users.ts
   * (`z.string().trim().email().max(320)`) so the review-card path and
   * POST /api/users/invitations cannot drift on what an address is. Without
   * this field the schema was strip-mode-silent about `email`: `editProposal`
   * accepted `carlos` or a whitespace-padded address, `clearSatisfiedMissingFields`
   * lifted the gate for any non-empty string, and the invitation repository
   * (users/pending-invitation.ts `EMAIL_RE`) then rejected it at execution —
   * `execution_failed` after the UI said the gate was satisfied.
   */
  email: z.string().trim().email().max(320).optional(),
});

const workingHoursEntrySchema = z.object({
  days: z.array(z.string()).min(1),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  seasonal: z.string().optional(),
});

export const onboardingSchedulePayloadSchema = z.object({
  workingHours: z.array(workingHoursEntrySchema).min(1),
  emergencySLA: z
    .object({
      hoursTarget: z.number().min(0),
      isGuarantee: z.boolean(),
    })
    .optional(),
});
