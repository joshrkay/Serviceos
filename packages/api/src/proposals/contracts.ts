import { z } from 'zod';
import { ProposalType } from './proposal';
import { reassignAppointmentPayloadSchema } from './contracts/reassignment';
import { rescheduleAppointmentPayloadSchema } from './contracts/reschedule';
import { cancelAppointmentPayloadSchema } from './contracts/cancellation';

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

export const updateEstimatePayloadSchema = z.object({
  estimateId: z.string().uuid(),
  lineItems: z.array(lineItemSchema).optional(),
  notes: z.string().optional(),
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

export const PROPOSAL_TYPE_SCHEMAS: Record<ProposalType, z.ZodSchema> = {
  create_customer: createCustomerPayloadSchema,
  update_customer: updateCustomerPayloadSchema,
  create_job: createJobPayloadSchema,
  create_appointment: createAppointmentPayloadSchema,
  draft_estimate: draftEstimatePayloadSchema,
  update_estimate: updateEstimatePayloadSchema,
  draft_invoice: draftInvoicePayloadSchema,
  reassign_appointment: reassignAppointmentPayloadSchema,
  reschedule_appointment: rescheduleAppointmentPayloadSchema,
  cancel_appointment: cancelAppointmentPayloadSchema,
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
