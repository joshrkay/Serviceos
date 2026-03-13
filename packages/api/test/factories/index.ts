/**
 * Test Factories — One factory per entity
 *
 * Factories use @faker-js/faker for realistic data with overridable defaults.
 * Never use hardcoded IDs in tests — always generate via factory.
 */
export { buildCustomer, buildCreateCustomerInput } from './customer.factory';
export { buildJob, buildCreateJobInput } from './job.factory';
export { buildLocation, buildCreateLocationInput } from './location.factory';
export { buildEstimate, buildCreateEstimateInput } from './estimate.factory';
export { buildInvoice, buildCreateInvoiceInput } from './invoice.factory';
export { buildPayment, buildRecordPaymentInput } from './payment.factory';
export { buildAppointment, buildCreateAppointmentInput } from './appointment.factory';
export { buildConversation, buildMessage, buildCreateConversationInput, buildCreateMessageInput } from './conversation.factory';
export { buildNote, buildCreateNoteInput } from './note.factory';
export { buildProposal, buildCreateProposalInput } from './proposal.factory';
export { buildAuditEvent } from './audit.factory';
export { buildTenant, buildUser } from './tenant.factory';
export { buildLineItemFactory } from './line-item.factory';
