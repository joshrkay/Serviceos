/**
 * Tier-1 locked status enums. These values are mirrored by DB CHECK
 * constraints; the API integration suite has a drift test that reads
 * pg_catalog and fails if either side changes unilaterally.
 */

export const ROLES = ['owner', 'tech'] as const;
export type Role = (typeof ROLES)[number];

export const JOB_STATUSES = [
  'unscheduled',
  'scheduled',
  'in_progress',
  'done',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const APPOINTMENT_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const ESTIMATE_STATUSES = ['draft', 'sent', 'approved', 'declined', 'expired'] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = ['card', 'cash', 'check', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PROPOSAL_STATUSES = [
  'ready_for_review',
  'approved',
  'executing',
  'executed',
  'execution_failed',
  'rejected',
  'undone',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_TYPES = [
  'create_customer',
  'schedule_job',
  'draft_invoice',
  'send_invoice',
] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

export const PROPOSAL_SOURCES = ['voice', 'sms', 'web', 'system'] as const;
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];

export const ACTOR_TYPES = ['user', 'ai', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const CONVERSATION_CHANNELS = ['sms', 'voice'] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

/** Terminal proposal statuses — no transitions out of these. */
export const TERMINAL_PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'executed',
  'execution_failed',
  'rejected',
  'undone',
];
