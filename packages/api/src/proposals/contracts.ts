// Re-export proposal contracts from the shared package.
// Canonical definitions live in @ai-service-os/shared/proposal-types.
export {
  createCustomerPayloadSchema,
  updateCustomerPayloadSchema,
  createJobPayloadSchema,
  createAppointmentPayloadSchema,
  draftEstimatePayloadSchema,
  updateEstimatePayloadSchema,
  draftInvoicePayloadSchema,
  lineItemSchema,
  PROPOSAL_TYPE_SCHEMAS,
  validateProposalPayload,
} from '@ai-service-os/shared';
export type { ProposalType } from '@ai-service-os/shared';
