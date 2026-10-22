import { z } from 'zod';

/**
 * #1735 — outbound multi-step drip campaigns: the sequence model and the pure
 * scheduling rules. No I/O here; the engine (drip-engine.ts) applies them.
 *
 * A sequence is an ordered list of steps. Each step is one SMS, one call or one
 * email, sent `delayMinutes` after the previous step (the first step: after
 * enrollment). A customer walks it as an enrollment and leaves early when they
 * book, reply or opt out (the exit conditions).
 */

export const DRIP_FEATURE_FLAG = 'drip_campaigns';

export const DRIP_CHANNELS = ['sms', 'call', 'email'] as const;
export type DripChannel = (typeof DRIP_CHANNELS)[number];

export const DRIP_TARGET_KINDS = ['lapsed_customers', 'unsold_estimates'] as const;
export type DripTargetKind = (typeof DRIP_TARGET_KINDS)[number];

export const DRIP_MAX_STEPS = 8;
/** A step waits at most 30 days after the previous one. */
export const DRIP_MAX_DELAY_MINUTES = 30 * 24 * 60;
/** A retryable block (kill switch, A2P not approved, provider error) is retried this often. */
export const DRIP_RETRY_MINUTES = 60;
/** After this many retryable blocks on one step the step is recorded failed and skipped. */
export const DRIP_MAX_STEP_ATTEMPTS = 5;
/** A booking this many days after an enrollment finished still credits the campaign. */
export const DRIP_ATTRIBUTION_WINDOW_DAYS = 14;
/** Most targets enrolled by one owner action. */
export const DRIP_MAX_ENROLL_PER_RUN = 200;

const smsStepSchema = z.object({
  channel: z.literal('sms'),
  delayMinutes: z.number().int().min(0).max(DRIP_MAX_DELAY_MINUTES),
  body: z.string().trim().min(1).max(480),
});

const emailStepSchema = z.object({
  channel: z.literal('email'),
  delayMinutes: z.number().int().min(0).max(DRIP_MAX_DELAY_MINUTES),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
});

/**
 * A call step rings `agentPhone` (the owner's or dispatcher's callback number)
 * through the existing outbound call service, which bridges to the customer.
 * There is no autonomous AI dialer in the product yet.
 */
const callStepSchema = z.object({
  channel: z.literal('call'),
  delayMinutes: z.number().int().min(0).max(DRIP_MAX_DELAY_MINUTES),
  agentPhone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'agentPhone must be E.164'),
});

export const dripStepSchema = z.discriminatedUnion('channel', [
  smsStepSchema,
  emailStepSchema,
  callStepSchema,
]);
export type DripStep = z.infer<typeof dripStepSchema>;

export const createDripSequenceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  targetKind: z.enum(DRIP_TARGET_KINDS),
  /** Lapsed: days since the last job. Unsold estimates: days since the estimate was sent. */
  targetDays: z.number().int().min(1).max(3650).optional(),
  steps: z.array(dripStepSchema).min(1).max(DRIP_MAX_STEPS),
});
export type CreateDripSequenceInput = z.infer<typeof createDripSequenceSchema>;

export type DripSequenceStatus = 'active' | 'paused';

export interface DripSequence {
  id: string;
  tenantId: string;
  name: string;
  targetKind: DripTargetKind;
  targetDays: number;
  steps: DripStep[];
  status: DripSequenceStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type DripEnrollmentStatus = 'active' | 'completed' | 'exited';
export type DripExitReason =
  | 'completed'
  | 'booked'
  | 'replied'
  | 'opted_out'
  | 'customer_unavailable'
  | 'cancelled';

export interface DripEnrollment {
  id: string;
  tenantId: string;
  sequenceId: string;
  customerId: string;
  sourceEntityType: 'estimate' | null;
  sourceEntityId: string | null;
  status: DripEnrollmentStatus;
  exitReason: DripExitReason | null;
  currentStep: number;
  stepAttempts: number;
  nextRunAt: Date;
  enrolledAt: Date;
  finishedAt: Date | null;
  bookedAt: Date | null;
  bookedAppointmentId: string | null;
}

export const DEFAULT_TARGET_DAYS: Record<DripTargetKind, number> = {
  lapsed_customers: 180,
  unsold_estimates: 3,
};

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/** When the first step of a fresh enrollment is due. */
export function firstRunAt(steps: readonly DripStep[], now: Date): Date {
  return addMinutes(now, steps[0]?.delayMinutes ?? 0);
}

/** What happens to an enrollment after step `stepIndex` was handled (sent or skipped). */
export type Advance = { done: true } | { done: false; currentStep: number; nextRunAt: Date };

export function advanceAfterStep(steps: readonly DripStep[], stepIndex: number, now: Date): Advance {
  const next = stepIndex + 1;
  if (next >= steps.length) return { done: true };
  return { done: false, currentStep: next, nextRunAt: addMinutes(now, steps[next].delayMinutes) };
}

/**
 * Fills `{{firstName}}` in a step body. Anything else in braces is left alone;
 * a customer with no first name reads "there".
 */
export function renderStepBody(
  body: string,
  customer: { firstName?: string; displayName?: string },
): string {
  const first =
    customer.firstName?.trim() || customer.displayName?.trim().split(/\s+/)[0] || 'there';
  return body.replace(/\{\{\s*firstName\s*\}\}/g, first);
}

/**
 * A permanent consent block that means "this person opted out" ends the
 * enrollment; any other permanent block only skips the one step (the customer
 * may still be reachable on another channel).
 */
export function exitReasonForBlock(reason: string): DripExitReason | null {
  return reason === 'dnc' ||
    reason === 'revoked' ||
    reason === 'cross_channel_revoked' ||
    reason === 'dnc_listed' ||
    reason === 'consent_revoked'
    ? 'opted_out'
    : null;
}
