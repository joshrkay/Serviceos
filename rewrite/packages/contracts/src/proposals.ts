import { z } from 'zod';
import { PROPOSAL_SOURCES, PROPOSAL_STATUSES, PROPOSAL_TYPES } from './enums';
import { lineItemInputSchema, taxRateBpsSchema } from './money';

/**
 * Typed proposal payloads. AI output is validated against these schemas
 * before a proposal row is ever created — malformed extractions are
 * rejected at the boundary, not at execution time.
 */

export const createCustomerPayloadSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(7).max(20),
  email: z.string().email().optional(),
  address: z.string().max(500).optional(),
});

export const scheduleJobPayloadSchema = z.object({
  customerId: z.string().uuid().optional(),
  customerName: z.string().min(1).max(200),
  customerPhone: z.string().min(7).max(20).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  startsAt: z.string().datetime(),
  durationMinutes: z.number().int().min(15).max(720).default(60),
});

export const draftInvoicePayloadSchema = z.object({
  customerId: z.string().uuid().optional(),
  customerName: z.string().min(1).max(200),
  jobId: z.string().uuid().optional(),
  lineItems: z.array(lineItemInputSchema).min(1).max(50),
  taxRateBps: taxRateBpsSchema.optional(),
});

export const sendInvoicePayloadSchema = z.object({
  invoiceId: z.string().uuid(),
});

export const proposalPayloadSchemas = {
  create_customer: createCustomerPayloadSchema,
  schedule_job: scheduleJobPayloadSchema,
  draft_invoice: draftInvoicePayloadSchema,
  send_invoice: sendInvoicePayloadSchema,
} as const satisfies Record<(typeof PROPOSAL_TYPES)[number], z.ZodTypeAny>;

export type ProposalPayloads = {
  [K in keyof typeof proposalPayloadSchemas]: z.infer<(typeof proposalPayloadSchemas)[K]>;
};

export const proposalResponseSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(PROPOSAL_TYPES),
  status: z.enum(PROPOSAL_STATUSES),
  source: z.enum(PROPOSAL_SOURCES),
  shortCode: z.number().int(),
  summary: z.string(),
  payload: z.record(z.unknown()),
  confidenceBps: z.number().int().min(0).max(10_000).nullable(),
  undoDeadlineAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
  result: z.record(z.unknown()).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProposalResponse = z.infer<typeof proposalResponseSchema>;
