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
  SMS = 'sms',
  NONE = 'none',
}

// ── Jobs ──
// Values mirror the jobs `status` CHECK in packages/api/src/db/schema.ts
// (DEFAULT 'new'). Kept in lockstep with jobStatusSchema in
// ./contracts/status.ts; status.test.ts fails CI on drift.
export enum JobStatus {
  NEW = 'new',
  SCHEDULED = 'scheduled',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELED = 'canceled',
}

export enum JobPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

export enum JobSource {
  PHONE = 'phone',
  WALK_IN = 'walk_in',
  CONVERSATION = 'conversation',
  WEB = 'web',
}

// ── Appointments ──
// Values mirror the appointments `status` CHECK in
// packages/api/src/db/schema.ts. The field/UI "en route" concept is a tech
// workflow state (see web TechJobView), not a persisted appointment status.
// Kept in lockstep with appointmentStatusSchema in ./contracts/status.ts.
export enum AppointmentStatus {
  SCHEDULED = 'scheduled',
  CONFIRMED = 'confirmed',
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
// Values mirror the estimate_line_items / invoice_line_items `category` CHECK in
// packages/api/src/db/schema.ts and the billing engine's LineItemCategory.
export enum LineItemCategory {
  LABOR = 'labor',
  MATERIAL = 'material',
  EQUIPMENT = 'equipment',
  OTHER = 'other',
}

export enum DiscountType {
  FLAT = 'flat',
  PERCENT = 'percent',
}

// ── Proposals ──
// Values mirror the proposals `status` CHECK in packages/api/src/db/schema.ts
// (latest migration adds 'undone'). Kept in lockstep with proposalStatusSchema
// in ./contracts/status.ts; status.test.ts fails CI on drift.
export enum ProposalStatus {
  DRAFT = 'draft',
  READY_FOR_REVIEW = 'ready_for_review',
  APPROVED = 'approved',
  EXECUTING = 'executing',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
  EXECUTED = 'executed',
  EXECUTION_FAILED = 'execution_failed',
  UNDONE = 'undone',
}

// Mirrors the ProposalType union (VALID_PROPOSAL_TYPES) in
// `packages/api/src/proposals/proposal.ts`. The API package owns
// runtime validation via PROPOSAL_TYPE_SCHEMAS; this enum is the
// shared identifier set that downstream packages (template specs,
// voice/SMS/email registries, web UI) reference. Kept in exact
// lockstep with the API union by proposal-type.test.ts, which parses
// VALID_PROPOSAL_TYPES and fails CI if the two sets diverge — so a new
// API ProposalType can no longer silently leave this enum (and the
// shared registries) blind to it.
//
// `update_appointment` is intentionally absent: the API never carried it.
// Update-style flows are modeled as `reassign_appointment`,
// `reschedule_appointment`, or `cancel_appointment`.
export enum ProposalType {
  CREATE_CUSTOMER = 'create_customer',
  UPDATE_CUSTOMER = 'update_customer',
  CREATE_JOB = 'create_job',
  CREATE_APPOINTMENT = 'create_appointment',
  CREATE_BOOKING = 'create_booking',
  CALLBACK = 'callback',
  DRAFT_ESTIMATE = 'draft_estimate',
  UPDATE_ESTIMATE = 'update_estimate',
  DRAFT_INVOICE = 'draft_invoice',
  UPDATE_INVOICE = 'update_invoice',
  ISSUE_INVOICE = 'issue_invoice',
  CREATE_INVOICE_SCHEDULE = 'create_invoice_schedule',
  BATCH_INVOICE = 'batch_invoice',
  REASSIGN_APPOINTMENT = 'reassign_appointment',
  RESCHEDULE_APPOINTMENT = 'reschedule_appointment',
  ADD_CREW_MEMBER = 'add_crew_member',
  REMOVE_CREW_MEMBER = 'remove_crew_member',
  CANCEL_APPOINTMENT = 'cancel_appointment',
  VOICE_CLARIFICATION = 'voice_clarification',
  ADD_NOTE = 'add_note',
  SEND_INVOICE = 'send_invoice',
  SEND_ESTIMATE = 'send_estimate',
  RECORD_PAYMENT = 'record_payment',
  LOG_EXPENSE = 'log_expense',
  CONVERT_LEAD = 'convert_lead',
  CONFIRM_APPOINTMENT = 'confirm_appointment',
  MARK_LEAD_LOST = 'mark_lead_lost',
  ADD_SERVICE_LOCATION = 'add_service_location',
  LOG_TIME_ENTRY = 'log_time_entry',
  NOTIFY_DELAY = 'notify_delay',
  REQUEST_FEEDBACK = 'request_feedback',
  EMERGENCY_DISPATCH = 'emergency_dispatch',
  ONBOARDING_TENANT_SETTINGS = 'onboarding_tenant_settings',
  ONBOARDING_SERVICE_CATEGORY = 'onboarding_service_category',
  ONBOARDING_ESTIMATE_TEMPLATE = 'onboarding_estimate_template',
  ONBOARDING_TEAM_MEMBER = 'onboarding_team_member',
  ONBOARDING_SCHEDULE = 'onboarding_schedule',
  REVIEW_RESPONSE_PROPOSAL = 'review_response_proposal',
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
