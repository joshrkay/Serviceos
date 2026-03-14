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
  REJECTED = 'rejected',
  EXPIRED = 'expired',
  EXECUTED = 'executed',
  EXECUTION_FAILED = 'execution_failed',
}

export enum ProposalType {
  CREATE_CUSTOMER = 'create_customer',
  UPDATE_CUSTOMER = 'update_customer',
  CREATE_JOB = 'create_job',
  CREATE_APPOINTMENT = 'create_appointment',
  UPDATE_APPOINTMENT = 'update_appointment',
  DRAFT_ESTIMATE = 'draft_estimate',
  UPDATE_ESTIMATE = 'update_estimate',
  // Phase 5
  DRAFT_INVOICE = 'draft_invoice',
  // Phase 6
  REASSIGN_APPOINTMENT = 'reassign_appointment',
  RESCHEDULE_APPOINTMENT = 'reschedule_appointment',
  CANCEL_APPOINTMENT = 'cancel_appointment',
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
  REJECTED = 'rejected',
  EXECUTED = 'executed',
  ASSIGNED = 'assigned',
  UNASSIGNED = 'unassigned',
  PAYMENT_RECORDED = 'payment_recorded',
  PAYMENT_VOIDED = 'payment_voided',
}
