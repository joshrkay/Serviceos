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
  DISPATCHED = 'dispatched',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  INVOICED = 'invoiced',
  CLOSED = 'closed',
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
  // B7 — safe job field edits (status/priority/title/description) via the
  // propose→approve→execute chain; mirrors the API's update_job proposal type.
  UPDATE_JOB = 'update_job',
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
  SEND_ESTIMATE_NUDGE = 'send_estimate_nudge',
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
  SEND_PAYMENT_REMINDER = 'send_payment_reminder',
  APPLY_LATE_FEE = 'apply_late_fee',
  // UB-A2 (agent wave) — voice-captured persistent directive; on approval the
  // API inserts a standing_instructions row (source 'proposal').
  CREATE_STANDING_INSTRUCTION = 'create_standing_instruction',
  // WS20 — correction-repetition meta-proposal. Emitted by the correction
  // loop (not voice) once the owner has corrected the same catalog SKU's price
  // N times; on approval the execution handler updates the catalog item's
  // unit price. Config/capture-class, reversible, never auto-executed (D-004).
  UPDATE_CATALOG_ITEM = 'update_catalog_item',
  // U4 — owner-approved tenant alias activation after voice entity correction.
  ADOPT_ENTITY_ALIAS = 'adopt_entity_alias',
  // B1.18 — brand voice captured by voice. Manual action class: it never
  // auto-approves at any trust tier, and its payload cannot express the lock
  // (locking stays tap-only, same theory as the D-013 approval exception).
  UPDATE_BRAND_VOICE = 'update_brand_voice',
  // Tradesperson wave 1, Task 3 — records a MANUAL refund (cash/check/
  // external card) given back to a customer. Money-class: never
  // auto-approves at any trust tier. (Backfilled here alongside
  // apply_credit below — this entry was missing from the shared enum since
  // Task 3 shipped, which silently broke the ProposalType ↔
  // VALID_PROPOSAL_TYPES and action-class parity tests in this file.)
  RECORD_REFUND = 'record_refund',
  // Tradesperson wave 1, Task 4 — reduces what a customer owes on an issued
  // invoice (goodwill, warranty labor, price match). Money-class: never
  // auto-approves at any trust tier. Floor-guarded against the invoice's
  // amount due — over-crediting is record_refund's job, not this one's.
  APPLY_CREDIT = 'apply_credit',
  // Tradesperson wave 1, Task 5 — a free-form outbound customer message
  // (status update, part arrival, ETA, thanks). Comms-class: the AI drafts
  // the exact text; the owner ALWAYS approves before a customer sees it —
  // never auto-approves at any trust tier. Highest-frequency gap in the
  // 2026-08-07 tradesperson plan.
  SEND_CUSTOMER_MESSAGE = 'send_customer_message',
  // Tradesperson wave 1, Task 6 — mints a NEW estimate pinned to an EXISTING
  // job, flagged is_change_order (migration 271) so reporting can separate
  // scope-adds from original bids. Capture-class: no money moves at
  // creation, sending the resulting estimate is a later comms-class step.
  CREATE_CHANGE_ORDER = 'create_change_order',
  // Task 7 (2026-08-07 tradesperson plan) — signs a customer up to a
  // recurring maintenance plan/membership, writing a service_agreements
  // row (migration 056, already live). Capture-class: no money moves at
  // creation, the agreement's own recurring sweep invoices later.
  CREATE_SERVICE_AGREEMENT = 'create_service_agreement',
  // Task 9 (2026-08-07 tradesperson plan) — adds a row to the voice-
  // captured shopping list (material_items, migration 272). Capture-class:
  // no money moves, and it's reversible (the row can be marked purchased
  // or simply ignored).
  ADD_MATERIAL = 'add_material',
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
