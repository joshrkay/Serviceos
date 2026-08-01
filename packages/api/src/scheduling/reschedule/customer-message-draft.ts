import {
  composeBrandVoiceMessage,
  type ComposeBrandVoiceDeps,
  type BrandVoiceDeviation,
} from '../../ai/brand-voice/composer';

/**
 * P6-028 — draft a customer-facing reschedule SMS in the tenant's brand voice
 * (P4-015). One draft is composed per affected appointment and attached to its
 * `reschedule_appointment` proposal under `sourceContext.draftSms`, so when the
 * owner approves, the customer notification is the message they reviewed.
 *
 * The draft is a SUGGESTION at proposal-creation time. It rides in
 * `sourceContext` (Tier-2-safe — no schema change). Whether the execution
 * handler sends this exact text on approval is verified separately (see the
 * final report): the existing reschedule handler sends via
 * `TransactionalCommsService.notifyRescheduled`, not from `sourceContext`.
 */

export interface CustomerMessageDraftInput {
  tenantId: string;
  /** Customer display name, if known — referenced in the message. */
  customerName?: string;
  /** Human-readable appointment time, if known — referenced in the message. */
  appointmentTime?: string;
  /** Hard SMS character cap; a single segment is 160 chars. */
  maxChars?: number;
}

export interface CustomerMessageDraft {
  text: string;
  promptVersionId: string;
  /** N-011 — the brand-voice config version stamped onto the proposal. */
  brandVoiceVersion: number;
  /** N-011 — present when the draft departed from the locked profile. */
  deviation?: BrandVoiceDeviation;
}

export const DEFAULT_RESCHEDULE_SMS_MAX_CHARS = 160;

/**
 * Compose the per-appointment customer reschedule SMS. PII opt-in: only the
 * caller-supplied `customerName` / `appointmentTime` reach the prompt — the
 * composer never pulls anything implicitly.
 */
export async function draftCustomerRescheduleMessage(
  input: CustomerMessageDraftInput,
  deps: ComposeBrandVoiceDeps,
): Promise<CustomerMessageDraft> {
  const context: Record<string, unknown> = {};
  if (input.customerName) context.customerName = input.customerName;
  if (input.appointmentTime) context.appointmentTime = input.appointmentTime;

  const result = await composeBrandVoiceMessage(
    {
      tenantId: input.tenantId,
      intent: 'tech_reschedule_customer_sms',
      context,
      maxChars: input.maxChars ?? DEFAULT_RESCHEDULE_SMS_MAX_CHARS,
    },
    deps,
  );

  return {
    text: result.text,
    promptVersionId: result.promptVersionId,
    brandVoiceVersion: result.brandVoiceVersion,
    ...(result.deviation ? { deviation: result.deviation } : {}),
  };
}
