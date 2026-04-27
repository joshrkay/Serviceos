import { z } from 'zod';
import { ProposalType } from './proposal';
import { reassignAppointmentPayloadSchema } from './contracts/reassignment';
import { rescheduleAppointmentPayloadSchema } from './contracts/reschedule';
import { cancelAppointmentPayloadSchema } from './contracts/cancellation';
import { addNotePayloadSchema } from './contracts/notes';
import { sendInvoicePayloadSchema } from './contracts/send-invoice';
import { recordPaymentPayloadSchema } from './contracts/record-payment';
import {
  onboardingTenantSettingsPayloadSchema,
  onboardingServiceCategoryPayloadSchema,
  onboardingEstimateTemplatePayloadSchema,
  onboardingTeamMemberPayloadSchema,
  onboardingSchedulePayloadSchema,
} from './contracts/onboarding';

export const createCustomerPayloadSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

export const updateCustomerPayloadSchema = z.object({
  customerId: z.string().uuid(),
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

export const createJobPayloadSchema = z.object({
  customerId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  scheduledDate: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
});

export const createAppointmentPayloadSchema = z.object({
  jobId: z.string().uuid(),
  scheduledStart: z.string().min(1),
  scheduledEnd: z.string().min(1),
  technicianId: z.string().uuid().optional(),
  notes: z.string().optional(),
});

const lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number(),
  unitPrice: z.number(),
  category: z.string().optional(),
});

export const draftEstimatePayloadSchema = z.object({
  customerId: z.string().uuid(),
  jobId: z.string().uuid().optional(),
  lineItems: z.array(lineItemSchema).min(1),
  notes: z.string().optional(),
  validUntil: z.string().optional(),
});

// Edit-action schema for update_estimate proposals. Same discriminated
// union shape as invoiceEditActionSchema below. Voice-driven estimate
// edits = add / remove / update a single line item; notes/wording edits
// stay at draft_estimate creation time.
export const estimateEditActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add_line_item'),
    lineItem: lineItemSchema,
  }),
  z.object({
    type: z.literal('remove_line_item'),
    index: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('update_line_item'),
    index: z.number().int().min(0),
    lineItem: lineItemSchema,
  }),
]);

export const updateEstimatePayloadSchema = z.object({
  estimateId: z.string().uuid(),
  editActions: z.array(estimateEditActionSchema).min(1),
});

export const draftInvoicePayloadSchema = z.object({
  customerId: z.string().uuid(),
  jobId: z.string().uuid(),
  estimateId: z.string().uuid().optional(),
  invoiceNumber: z.string().min(1).optional(),
  lineItems: z.array(lineItemSchema).min(1),
  discountCents: z.number().int().min(0).optional(),
  taxRateBps: z.number().int().min(0).max(10000).optional(),
  customerMessage: z.string().optional(),
  internalNotes: z.string().optional(),
});

// Edit-action schema for update_invoice proposals. Mirrors the
// estimate-editor pattern but scoped to invoice line items: Phase-2
// voice flows only add, remove, or replace a line item. Notes/wording
// edits are out of scope for this iteration — the draft_invoice path
// still owns those at creation time.
export const invoiceEditActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add_line_item'),
    lineItem: lineItemSchema,
  }),
  z.object({
    type: z.literal('remove_line_item'),
    index: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('update_line_item'),
    index: z.number().int().min(0),
    lineItem: lineItemSchema,
  }),
]);

export const updateInvoicePayloadSchema = z.object({
  invoiceId: z.string().uuid(),
  editActions: z.array(invoiceEditActionSchema).min(1),
});

export const issueInvoicePayloadSchema = z.object({
  invoiceId: z.string().min(1),
  paymentTermDays: z.number().int().min(1).max(365).optional(),
});

// voice_clarification: emitted when the voice classifier cannot route
// a transcript (intent='unknown' OR confidence below threshold). It is
// NOT a mutation — it surfaces in the operator's feed as "I heard X
// but wasn't sure what to do." The operator dismisses it or speaks
// again. Stored as a proposal so it reuses the existing tenant
// isolation, audit, and review-card rendering; it has no execution
// handler because there is nothing to execute.
//
// Reasons the router emits one:
//   - 'unknown_intent'         — classifier said 'unknown' at any confidence
//   - 'low_confidence'         — a real intent was picked but below threshold
//   - 'parse_failed'           — classifier output wasn't parseable JSON
//   - 'missing_entities'       — intent was clear but required entities absent
//
// suggestedIntents (optional) lets the UI render "Did you mean: create
// invoice / schedule appointment?" chips. When the classifier picked an
// intent but confidence was low, the low-confidence intent is the first
// suggestion.
export const voiceClarificationPayloadSchema = z.object({
  transcript: z.string().min(1),
  reason: z.enum([
    'unknown_intent',
    'low_confidence',
    'parse_failed',
    'missing_entities',
  ]),
  suggestedIntents: z.array(z.string()).optional(),
  classifierReasoning: z.string().optional(),
  classifierConfidence: z.number().min(0).max(1).optional(),
  recordingId: z.string().optional(),
  conversationId: z.string().optional(),
});

export const PROPOSAL_TYPE_SCHEMAS: Record<ProposalType, z.ZodSchema> = {
  create_customer: createCustomerPayloadSchema,
  update_customer: updateCustomerPayloadSchema,
  create_job: createJobPayloadSchema,
  create_appointment: createAppointmentPayloadSchema,
  draft_estimate: draftEstimatePayloadSchema,
  update_estimate: updateEstimatePayloadSchema,
  draft_invoice: draftInvoicePayloadSchema,
  update_invoice: updateInvoicePayloadSchema,
  issue_invoice: issueInvoicePayloadSchema,
  reassign_appointment: reassignAppointmentPayloadSchema,
  reschedule_appointment: rescheduleAppointmentPayloadSchema,
  cancel_appointment: cancelAppointmentPayloadSchema,
  voice_clarification: voiceClarificationPayloadSchema,
  add_note: addNotePayloadSchema,
  send_invoice: sendInvoicePayloadSchema,
  record_payment: recordPaymentPayloadSchema,
  onboarding_tenant_settings: onboardingTenantSettingsPayloadSchema,
  onboarding_service_category: onboardingServiceCategoryPayloadSchema,
  onboarding_estimate_template: onboardingEstimateTemplatePayloadSchema,
  onboarding_team_member: onboardingTeamMemberPayloadSchema,
  onboarding_schedule: onboardingSchedulePayloadSchema,
};

export function validateProposalPayload(
  proposalType: string,
  payload: unknown
): { valid: boolean; errors?: string[] } {
  const schema = PROPOSAL_TYPE_SCHEMAS[proposalType as ProposalType];
  if (!schema) {
    return { valid: false, errors: [`Unknown proposal type: ${proposalType}`] };
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    const errors = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`
    );
    return { valid: false, errors };
  }

  return { valid: true };
}
