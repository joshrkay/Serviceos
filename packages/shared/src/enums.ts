/**
 * AI Service OS — Shared Enums
 * 
 * These enums are the source of truth for status values, roles, and categories
 * used across API, web, and AI modules. Import from @ai-service-os/shared.
 */

// ── Auth ──
export enum Role {
  OWNER = 'owner',
  DISPATCHER = 'dispatcher',
  TECHNICIAN = 'technician',
}

// ── Customers ──
export enum CustomerStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

export enum PreferredChannel {
  PHONE = 'phone',
  EMAIL = 'email',
  TEXT = 'text',
}

// ── Jobs ──
export enum JobStatus {
  CREATED = 'created',
  SCHEDULED = 'scheduled',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELED = 'canceled',
}

export enum JobPriority {
  NORMAL = 'normal',
  URGENT = 'urgent',
  EMERGENCY = 'emergency',
}

export enum JobSource {
  PHONE = 'phone',
  WALK_IN = 'walk_in',
  CONVERSATION = 'conversation',
  WEB = 'web',
}

// ── Appointments ──
export enum AppointmentStatus {
  SCHEDULED = 'scheduled',
  EN_ROUTE = 'en_route',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELED = 'canceled',
  NO_SHOW = 'no_show',
}

// ── Estimates ──
export enum EstimateStatus {
  DRAFT = 'draft',
  READY_FOR_REVIEW = 'ready_for_review',
  SENT = 'sent',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
}

export enum EstimateSourceType {
  MANUAL = 'manual',
  AI_DRAFT = 'ai_draft',
  AI_REVISION = 'ai_revision',
  IMPORTED = 'imported',
}

export enum ApprovalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  EXECUTING = 'executing',
  APPROVED_WITH_EDITS = 'approved_with_edits',
  REJECTED = 'rejected',
}

// ── Invoices ──
export enum InvoiceStatus {
  DRAFT = 'draft',
  OPEN = 'open',
  PARTIALLY_PAID = 'partially_paid',
  PAID = 'paid',
  VOID = 'void',
  CANCELED = 'canceled',
}

// ── Payments ──
export enum PaymentMethod {
  CASH = 'cash',
  CHECK = 'check',
  CREDIT_CARD = 'credit_card',
  BANK_TRANSFER = 'bank_transfer',
  STRIPE = 'stripe',
  OTHER = 'other',
}

export enum PaymentStatus {
  RECORDED = 'recorded',
  CLEARED = 'cleared',
  VOIDED = 'voided',
}

// ── Line Items (shared between estimates and invoices) ──
export enum LineItemCategory {
  LABOR = 'labor',
  MATERIAL = 'material',
  EQUIPMENT = 'equipment',
  SUBCONTRACTOR = 'subcontractor',
  OTHER = 'other',
}

export enum DiscountType {
  FLAT = 'flat',
  PERCENT = 'percent',
}

// ── Proposals ──
export enum ProposalStatus {
  DRAFT = 'draft',
  READY_FOR_REVIEW = 'ready_for_review',
  APPROVED = 'approved',
  EXECUTING = 'executing',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
  EXECUTED = 'executed',
  EXECUTION_FAILED = 'execution_failed',
}

// Mirrors the ProposalType union in
// `packages/api/src/proposals/proposal.ts`. The API package owns
// runtime validation via PROPOSAL_TYPE_SCHEMAS; this enum is the
// shared identifier set that downstream packages (template specs,
// voice/SMS/email registries, web UI) reference. Keep the two
// sources in lockstep — adding a new ProposalType to the API
// without mirroring it here will leave the shared registries
// blind to the new type.
//
// `update_appointment` was removed: the API never carried it.
// Update-style flows are modeled as `reassign_appointment`,
// `reschedule_appointment`, or `cancel_appointment`, which template
// consumers should reference directly.
export enum ProposalType {
  CREATE_CUSTOMER = 'create_customer',
  UPDATE_CUSTOMER = 'update_customer',
  CREATE_JOB = 'create_job',
  CREATE_APPOINTMENT = 'create_appointment',
  CREATE_BOOKING = 'create_booking',
  DRAFT_ESTIMATE = 'draft_estimate',
  UPDATE_ESTIMATE = 'update_estimate',
  DRAFT_INVOICE = 'draft_invoice',
  UPDATE_INVOICE = 'update_invoice',
  ISSUE_INVOICE = 'issue_invoice',
  CREATE_INVOICE_SCHEDULE = 'create_invoice_schedule',
  BATCH_INVOICE = 'batch_invoice',
  REASSIGN_APPOINTMENT = 'reassign_appointment',
  RESCHEDULE_APPOINTMENT = 'reschedule_appointment',
  CANCEL_APPOINTMENT = 'cancel_appointment',
  VOICE_CLARIFICATION = 'voice_clarification',
  ADD_NOTE = 'add_note',
  SEND_INVOICE = 'send_invoice',
  SEND_ESTIMATE = 'send_estimate',
  RECORD_PAYMENT = 'record_payment',
  LOG_EXPENSE = 'log_expense',
  EMERGENCY_DISPATCH = 'emergency_dispatch',
  ONBOARDING_TENANT_SETTINGS = 'onboarding_tenant_settings',
  ONBOARDING_SERVICE_CATEGORY = 'onboarding_service_category',
  ONBOARDING_ESTIMATE_TEMPLATE = 'onboarding_estimate_template',
  ONBOARDING_TEAM_MEMBER = 'onboarding_team_member',
  ONBOARDING_SCHEDULE = 'onboarding_schedule',
}

export enum RejectionCategory {
  WRONG_ENTITY = 'wrong_entity',
  MISSING_INFO = 'missing_info',
  WRONG_PRICING = 'wrong_pricing',
  WRONG_WORDING = 'wrong_wording',
  DUPLICATE_ACTION = 'duplicate_action',
  OTHER = 'other',
}

// ── AI ──
export enum AiRunStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  TIMEOUT = 'timeout',
}

export enum AiTaskType {
  INTENT_CLASSIFICATION = 'intent_classification',
  ENTITY_EXTRACTION = 'entity_extraction',
  TRANSCRIPT_NORMALIZATION = 'transcript_normalization',
  CREATE_CUSTOMER_PROPOSAL = 'create_customer_proposal',
  CREATE_JOB_PROPOSAL = 'create_job_proposal',
  CREATE_APPOINTMENT_PROPOSAL = 'create_appointment_proposal',
  DRAFT_ESTIMATE_PROPOSAL = 'draft_estimate_proposal',
  DRAFT_INVOICE_PROPOSAL = 'draft_invoice_proposal',
  CLARIFICATION_GENERATION = 'clarification_generation',
}

export enum ModelTier {
  LIGHTWEIGHT = 'lightweight',
  STANDARD = 'standard',
  COMPLEX = 'complex',
}

// ── Conversations ──
export enum MessageType {
  TEXT = 'text',
  TRANSCRIPT = 'transcript',
  SYSTEM_EVENT = 'system_event',
  NOTE = 'note',
  /** Matches `createMessageSchema` in packages/api — F-2 contract freeze. */
  CLARIFICATION = 'clarification',
  /** Matches `createMessageSchema` in packages/api — F-2 contract freeze. */
  PROPOSAL = 'proposal',
  PROPOSAL_SUMMARY = 'proposal_summary',
}

export enum SenderType {
  USER = 'user',
  SYSTEM = 'system',
  AI = 'ai',
}

export enum TranscriptStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

// ── Audit ──
export enum AuditEventType {
  CREATED = 'created',
  UPDATED = 'updated',
  ARCHIVED = 'archived',
  STATUS_CHANGED = 'status_changed',
  APPROVED = 'approved',
  EXECUTING = 'executing',
  REJECTED = 'rejected',
  EXECUTED = 'executed',
  ASSIGNED = 'assigned',
  UNASSIGNED = 'unassigned',
  PAYMENT_RECORDED = 'payment_recorded',
  PAYMENT_VOIDED = 'payment_voided',
}
