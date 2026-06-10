/**
 * Feature 2 — Voice → structured slot extraction (launch-readiness pass).
 *
 * A Zod contract for the structured "slots" an inbound service call must
 * collect, plus pure helpers to (a) project the intent classifier's
 * fine-grained `ExtractedEntities` onto that slot shape and (b) decide whether
 * the agent can proceed, must re-ask for a missing slot, or must hand off to a
 * human.
 *
 * Before this, slot data lived only as loosely-typed `ExtractedEntities` with
 * ad-hoc field-by-field guards and no single schema describing the
 * caller-intake shape. This module gives the voice pipeline one validated
 * source of truth for the launch slots and keeps the re-ask cap aligned with
 * the FSM (`MAX_ASK_CALLER_RETRIES` in customer-calling/transitions.ts).
 */
import { z } from 'zod';
import { ExtractedEntities } from '../ai/orchestration/intent-classifier';

export const voiceSlotsSchema = z
  .object({
    caller_name: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    service_type: z.string().min(1).optional(),
    preferred_time_window: z.string().min(1).optional(),
    problem_description: z.string().min(1).optional(),
  })
  .strict();

export type VoiceSlots = z.infer<typeof voiceSlotsSchema>;

/**
 * Slots that must be present before the agent can act autonomously. A
 * `preferred_time_window` is intentionally NOT required: estimate requests
 * don't need one, and the scheduler proposes windows when it is absent.
 */
export const REQUIRED_VOICE_SLOTS = [
  'caller_name',
  'phone',
  'address',
  'service_type',
  'problem_description',
] as const;

/** Matches the FSM's ask_caller retry cap before escalation. */
export const MAX_SLOT_REASKS = 2;

export interface LaunchSlotInput {
  /** Service line, typically resolved from the tenant vertical / transcript. */
  serviceType?: string;
  /** Problem summary when the classifier did not capture one as a note. */
  problemDescription?: string;
  /** Preferred time window when not present on the classifier entities. */
  preferredTimeWindow?: string;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/**
 * Project classifier entities (+ transcript-level context) onto the launch
 * slot shape and validate. Only populated slots are emitted, so the result is
 * always schema-valid; downstream callers use {@link planSlotFollowup} to act
 * on what is missing.
 */
export function extractLaunchSlots(
  entities: ExtractedEntities,
  input: LaunchSlotInput = {},
): VoiceSlots {
  const slots: VoiceSlots = {};

  const callerName = firstNonEmpty(entities.displayName, entities.customerName);
  if (callerName) slots.caller_name = callerName;

  const phone = firstNonEmpty(entities.phone, entities.updatedPhone);
  if (phone) slots.phone = phone;

  const address = firstNonEmpty(entities.serviceAddress, entities.updatedAddress);
  if (address) slots.address = address;

  const serviceType = firstNonEmpty(input.serviceType);
  if (serviceType) slots.service_type = serviceType;

  const timeWindow = firstNonEmpty(
    input.preferredTimeWindow,
    entities.dateTimeDescription,
    entities.newDateTimeDescription,
  );
  if (timeWindow) slots.preferred_time_window = timeWindow;

  const problem = firstNonEmpty(
    input.problemDescription,
    entities.noteBody,
    entities.lineItemDescriptions && entities.lineItemDescriptions.length > 0
      ? entities.lineItemDescriptions.join('; ')
      : undefined,
  );
  if (problem) slots.problem_description = problem;

  // Always schema-valid by construction; parse to fail loudly if the shape
  // ever drifts (e.g. a future field added without updating the schema).
  return voiceSlotsSchema.parse(slots);
}

export type SlotFollowupAction = 'proceed' | 'reask' | 'handoff';

export interface SlotFollowupPlan {
  action: SlotFollowupAction;
  /** Required slots still unfilled (empty when action === 'proceed'). */
  missing: string[];
}

/**
 * Decide the next move given the current slots and how many clarifying turns
 * have already been spent. Returns `proceed` when all required slots are
 * filled, `reask` while under the retry cap, and `handoff` once the cap is
 * reached with slots still missing.
 */
export function planSlotFollowup(slots: VoiceSlots, reaskCount: number): SlotFollowupPlan {
  const missing = REQUIRED_VOICE_SLOTS.filter((key) => {
    const value = slots[key];
    return !value || value.trim().length === 0;
  });

  if (missing.length === 0) return { action: 'proceed', missing: [] };
  if (reaskCount >= MAX_SLOT_REASKS) return { action: 'handoff', missing };
  return { action: 'reask', missing };
}
