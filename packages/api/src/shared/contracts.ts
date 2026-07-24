import { z } from 'zod';
import { CUSTOMER_SOURCES } from '../customers/customer';

export const tenantIdHeader = 'x-tenant-id';
export const correlationIdHeader = 'x-correlation-id';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  environment: z.string(),
  timestamp: z.string(),
  checks: z.record(z.object({
    status: z.enum(['ok', 'degraded', 'down']),
    message: z.string().optional(),
  })).optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const createTenantSchema = z.object({
  ownerEmail: z.string().email(),
  name: z.string().min(1).max(255),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'dispatcher', 'technician']),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

export const createConversationSchema = z.object({
  title: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});

export const createMessageSchema = z.object({
  conversationId: z.string().uuid(),
  messageType: z.enum(['text', 'transcript', 'system_event', 'note', 'clarification', 'proposal']),
  content: z.string().optional(),
  fileId: z.string().uuid().optional(),
  source: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const uploadFileSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});

export const createAiRunSchema = z.object({
  taskType: z.string().min(1),
  model: z.string().min(1),
  promptVersionId: z.string().uuid().optional(),
  inputSnapshot: z.record(z.unknown()),
});

export const createPromptVersionSchema = z.object({
  taskType: z.string().min(1),
  template: z.string().min(1),
  model: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

export const createDocumentRevisionSchema = z.object({
  documentType: z.enum(['estimate', 'invoice', 'proposal']),
  documentId: z.string().min(1),
  snapshot: z.record(z.unknown()),
  source: z.enum(['manual', 'ai_generated', 'ai_revised']),
  aiRunId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const createDiffAnalysisSchema = z.object({
  documentType: z.string().min(1),
  documentId: z.string().min(1),
  fromRevisionId: z.string().uuid(),
  toRevisionId: z.string().uuid(),
});

export const triggerEvaluationSchema = z.object({
  workflowType: z.string().min(1),
  hasTranscript: z.boolean(),
  hasExistingProposal: z.boolean(),
  userRole: z.string().min(1),
});

export const estimateLinkInputSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid().optional(),
  proposalRevisionId: z.string().uuid(),
  estimateId: z.string().uuid(),
});


const lineItemSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(['labor', 'material', 'equipment', 'other']).optional(),
  quantity: z.number().nonnegative(),
  unitPriceCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  sortOrder: z.number().int(),
  taxable: z.boolean(),
  // Catalog-grounding signal (estimates). Must be declared here or Zod strips
  // it on update/revise, making a catalog-priced estimate look ungrounded
  // (PgEstimateRepository persists pricingSource; isEstimateCatalogGrounded
  // treats null as NOT grounded).
  pricingSource: z.enum(['catalog', 'ambiguous', 'uncatalogued', 'manual']).optional(),
  // Good-better-best tiers + optional add-ons (estimates only).
  groupKey: z.string().min(1).max(120).optional(),
  groupLabel: z.string().min(1).max(200).optional(),
  isOptional: z.boolean().optional(),
  isDefaultSelected: z.boolean().optional(),
  // EE-4 — frozen catalog photo reference. Must be declared here or Zod strips
  // it on the estimate create/update/revise routes, so a manually-picked
  // catalog line's image would silently vanish at the HTTP boundary (the same
  // trap as pricingSource above). PgEstimateRepository persists image_file_id.
  imageFileId: z.string().optional(),
});

export const createCustomerSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  companyName: z.string().min(1).optional(),
  primaryPhone: z.string().min(1).optional(),
  secondaryPhone: z.string().min(1).optional(),
  email: z.string().email().optional(),
  preferredChannel: z.enum(['phone', 'email', 'sms', 'none']).optional(),
  smsConsent: z.boolean().optional(),
  communicationNotes: z.string().optional(),
  source: z.enum(CUSTOMER_SOURCES).optional(),
});

// U1 (CRM Jobber parity) — request bodies for the nested customer-contacts
// routes. `customerId` is taken from the URL path, not the body. Mirrors the
// service-location create/update shape.
export const createCustomerContactSchema = z.object({
  name: z.string().min(1).max(200),
  role: z.enum(['primary', 'billing', 'site', 'other']).optional(),
  phone: z.string().min(1).optional(),
  email: z.string().email().optional(),
  isPrimary: z.boolean().optional(),
  notes: z.string().optional(),
});

export const updateCustomerContactSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  role: z.enum(['primary', 'billing', 'site', 'other']).optional(),
  phone: z.string().min(1).optional(),
  email: z.string().email().optional(),
  isPrimary: z.boolean().optional(),
  notes: z.string().optional(),
});

// U2 (CRM Jobber parity) — tag + custom-field request bodies.
export const addCustomerTagSchema = z.object({
  tag: z.string().min(1).max(50),
});

export const createCustomFieldDefSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9_]*$/, 'key must be lowercase alphanumeric/underscore, starting with a letter'),
  label: z.string().min(1).max(200),
  fieldType: z.enum(['text', 'number', 'date', 'select']).optional(),
  options: z.array(z.string().min(1)).optional(),
  sortOrder: z.number().int().optional(),
});

export const setCustomFieldValueSchema = z.object({
  value: z.string().nullable(),
});

export const createServiceLocationSchema = z.object({
  customerId: z.string().min(1),
  label: z.string().optional(),
  street1: z.string().min(1),
  street2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().min(1).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  accessNotes: z.string().optional(),
  isPrimary: z.boolean().optional(),
  // U3 (CRM Jobber parity) — service vs billing/mailing address.
  addressType: z.enum(['service', 'billing', 'both']).optional(),
});

export const createJobSchema = z.object({
  customerId: z.string().min(1),
  locationId: z.string().min(1),
  summary: z.string().min(1),
  problemDescription: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  /**
   * Optional override for source attribution. Routes auto-populate this
   * from the customer's `originatingLeadId` when omitted; pass an explicit
   * id only when attaching a job to a lead that the customer wasn't
   * originally created from (e.g., a returning customer who came in via
   * a new ad campaign).
   */
  originatingLeadId: z.string().uuid().optional(),
  /**
   * Optional direct scheduling. When `scheduledStart` is present the job is
   * scheduled in the same request: a linked appointment (+ optional primary
   * technician assignment) is created so it reaches the dispatch board, and
   * the job advances new → scheduled. Absent ⇒ an unscheduled job (legacy
   * behavior). `durationMin` defaults to 60; `timezone` is display context
   * only (times persist UTC).
   */
  scheduledStart: z.string().datetime().optional(),
  technicianId: z.string().uuid().optional(),
  durationMin: z.number().int().positive().optional(),
  timezone: z.string().min(1).optional(),
});

/**
 * Body for `POST /api/jobs/:id/schedule` — initial schedule OR reschedule of
 * an existing job (idempotent upsert of the canonical `job-schedule:` visit).
 */
export const scheduleJobSchema = z
  .object({
    scheduledStart: z.string().datetime(),
    technicianId: z.string().uuid().optional(),
    durationMin: z.number().int().positive().optional(),
    timezone: z.string().min(1).optional(),
  })
  .strict();

/**
 * Body for `POST /api/jobs/:id/reassign` — change or CLEAR (null) the primary
 * technician on the job's appointment, keeping the slot. `null` moves the
 * appointment to the dispatch board's unassigned queue.
 */
export const reassignJobSchema = z
  .object({
    technicianId: z.string().uuid().nullable(),
  })
  .strict();

/**
 * Body for `POST /api/jobs/:id/unschedule` — cancel the job's appointment and
 * revert the job scheduled → new. `reason` is recorded on the audit trail.
 */
export const unscheduleJobSchema = z
  .object({
    reason: z.string().min(1).optional(),
  })
  .strict();

export const createEstimateSchema = z.object({
  jobId: z.string().min(1),
  lineItems: z.array(lineItemSchema).min(1),
  discountCents: z.number().int().nonnegative().optional(),
  taxRateBps: z.number().int().min(0).max(10000).optional(),
  validUntil: z.string().datetime().optional(),
  customerMessage: z.string().optional(),
  internalNotes: z.string().optional(),
});

export const createInvoiceSchema = z.object({
  jobId: z.string().min(1),
  estimateId: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1),
  discountCents: z.number().int().nonnegative().optional(),
  taxRateBps: z.number().int().min(0).max(10000).optional(),
  processingFeeBps: z.number().int().min(0).max(10000).optional(),
  customerMessage: z.string().optional(),
});

// Update/revise payloads — the PUT/PATCH routes previously passed req.body
// straight to updateInvoice/updateEstimate with NO validation (create routes
// validate). That let a caller persist negative discounts, fractional cents,
// or an out-of-range tax rate, corrupting the stored money. These mirror the
// create schemas but make every field optional (partial update) and, being
// plain z.object, strip unknown keys so `status`/`tenantId`/etc. can't be
// injected via the body.
export const updateInvoiceSchema = z.object({
  lineItems: z.array(lineItemSchema).min(1).optional(),
  discountCents: z.number().int().nonnegative().optional(),
  taxRateBps: z.number().int().min(0).max(10000).optional(),
  processingFeeBps: z.number().int().min(0).max(10000).optional(),
  customerMessage: z.string().max(2000).optional(),
});

export const updateEstimateSchema = z.object({
  lineItems: z.array(lineItemSchema).min(1).optional(),
  discountCents: z.number().int().nonnegative().optional(),
  taxRateBps: z.number().int().min(0).max(10000).optional(),
  // Accept an ISO string (JSON has no Date) and coerce to the Date that
  // UpdateEstimateInput expects. Preprocess null → undefined FIRST: a bare
  // z.coerce.date() turns null into Date(0) (1970-01-01), which updateEstimate
  // would persist as valid_until and silently expire the estimate. Treating
  // null as absent preserves the prior `?? existing.validUntil` no-op.
  validUntil: z.preprocess(
    (v) => (v === null ? undefined : v),
    z.coerce.date().optional(),
  ),
  customerMessage: z.string().max(2000).optional(),
  internalNotes: z.string().max(5000).optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export const recordPaymentSchema = z.object({
  invoiceId: z.string().min(1),
  amountCents: z.number().int().positive(),
  method: z.enum(['cash', 'check', 'credit_card', 'bank_transfer', 'other']),
  providerReference: z.string().optional(),
  note: z.string().optional(),
});

export const createAppointmentSchema = z.object({
  jobId: z.string().min(1),
  scheduledStart: z.string().datetime(),
  scheduledEnd: z.string().datetime(),
  arrivalWindowStart: z.string().datetime().optional(),
  arrivalWindowEnd: z.string().datetime().optional(),
  timezone: z.string().min(1),
  notes: z.string().optional(),
});

export const delayMinutesSchema = z.union([
  z.literal(10),
  z.literal(15),
  z.literal(20),
  z.literal(60),
]);

export const delayAcknowledgmentSchema = z.object({
  appointmentId: z.string().min(1),
  isRunningBehind: z.boolean(),
  delayMinutes: delayMinutesSchema.optional(),
  reasonCode: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.isRunningBehind && value.delayMinutes === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['delayMinutes'],
      message: 'delayMinutes is required when isRunningBehind is true',
    });
  }

  if (!value.isRunningBehind && value.delayMinutes !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['delayMinutes'],
      message: 'delayMinutes is not allowed when isRunningBehind is false',
    });
  }
});

export type DelayAcknowledgment = z.infer<typeof delayAcknowledgmentSchema>;

export const createNoteSchema = z.object({
  entityType: z.enum(['customer', 'location', 'job', 'estimate', 'invoice']),
  entityId: z.string().min(1),
  content: z.string().min(1),
  isPinned: z.boolean().optional(),
});

export const createCatalogItemSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional(),
  category: z.enum(['Labor', 'Parts', 'Materials']),
  unit: z.enum(['each', 'hour', 'sq ft', 'per lb', 'per gal']),
  unitPriceCents: z.number().int().nonnegative(),
  // EE-4 — hero photo, a file id from the upload flow. `null` clears it.
  imageFileId: z.string().uuid().nullish(),
});

export const updateCatalogItemSchema = createCatalogItemSchema.partial();

// Public review-link field (Settings → Reviews). Trims the input FIRST so a
// whitespace-only value ('   ') normalizes to null (cleared) instead of
// failing validation; a non-empty value must be a valid URL.
const reviewUrlField = z
  .preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z.union([
      // https only — these values are rendered as clickable hrefs on the
      // public feedback page, so reject javascript:/data:/http: schemes.
      z.string().url().refine((u) => /^https:\/\//i.test(u), {
        message: 'Review URL must be an https:// link',
      }),
      z.literal(''),
      z.null(),
    ]),
  )
  .optional()
  .transform((v) => (v === '' ? null : v));

// Polly voice id (e.g. "Polly.Mia-Neural"). Constrained so a stored value
// can never inject XML metacharacters into the `<Say voice="...">` TwiML.
const ttsVoiceField = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/, 'Invalid voice id')
  .max(64)
  .nullable()
  .optional();

export const updateSettingsSchema = z.object({
  businessName: z.string().min(1).optional(),
  // Codex P2 (PR #316): `.nullable()` so the Business profile sheet
  // can clear a previously-set phone/email/timezone by sending null.
  // JSON.stringify drops undefined keys (no-op on the route's update),
  // so an explicit null is the only path to "clear this field".
  businessPhone: z.string().nullable().optional(),
  businessEmail: z.union([z.string().email(), z.null()]).optional(),
  // P8-016 — owner's personal cell for emergency triage. Accepts any
  // human format; normalized to E.164 server-side. Empty string or
  // explicit null clears the value; omit to leave untouched.
  ownerPhone: z.string().max(40).nullable().optional(),
  timezone: z.string().nullable().optional(),
  // Foundation gate (I12/V17) — per-day booking hours and travel buffer.
  // Previously writable only through the onboarding identity route; without
  // these keys z.object STRIPS them, so a settings-surface write silently
  // no-oped and the scheduler kept the stale values. Each day is
  // { open: 'HH:MM', close: 'HH:MM' } or null (closed); {} / null clears
  // back to "not configured" (scheduler falls back to defaults).
  businessHours: z
    .record(
      z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
      z
        .object({
          open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM'),
          close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM'),
        })
        .nullable(),
    )
    .nullable()
    .optional(),
  jobBufferMinutes: z.number().int().min(0).max(240).nullable().optional(),
  estimatePrefix: z.string().min(1).optional(),
  invoicePrefix: z.string().min(1).optional(),
  defaultPaymentTermDays: z.number().int().nonnegative().optional(),
  terminologyPreferences: z.record(z.string()).optional(),
  // Phase 12 — supervisor backup + unsupervised proposal routing.
  // `backupSupervisorUserId: null` explicitly clears the backup.
  backupSupervisorUserId: z.string().uuid().nullable().optional(),
  unsupervisedProposalRouting: z
    .enum(['queue_and_sms', 'queue_only', 'escalate_to_oncall'])
    .optional(),
  // Tier 4 — Quick-settings toggles persistence.
  autoApplyInternalUpdates: z.boolean().optional(),
  autoSendAppointmentReminders: z.boolean().optional(),
  // P20-001 — opt into auto-drafting an invoice (as a proposal) on job completion.
  autoInvoiceOnCompletion: z.boolean().optional(),
  // Feature (launch) — opt into recomputing auto-invoice labor from actual time entries.
  billLaborFromTimeEntries: z.boolean().optional(),
  // P21-003 — opt into the daily batch-invoice proposal sweep.
  batchInvoiceEnabled: z.boolean().optional(),
  // P21 — opt into minting on_completion milestone invoices. Without this in
  // the schema Zod strips it, so the toggle could never be set via the API.
  milestoneBillingEnabled: z.boolean().optional(),
  // Tier 4 — AI approval rules: per-mode auto-approve threshold override.
  // Each entry is a confidence in [0, 1]. Missing keys fall back to
  // DEFAULT_AUTO_APPROVE_THRESHOLDS in proposals/auto-approve.ts.
  autoApproveThreshold: z
    .object({
      supervisor: z.number().min(0).max(1).optional(),
      tech: z.number().min(0).max(1).optional(),
      both: z.number().min(0).max(1).optional(),
    })
    .strict()
    .optional(),
  // Tier 4 — Deposit rules. Cross-field correlation enforced both at
  // the DB layer (CHECK constraint) and here (z.refine) so a malformed
  // request fails at validation time with a useful message rather than
  // bouncing off a generic CHECK violation.
  depositStrategy: z.enum(['percentage', 'fixed']).nullable().optional(),
  depositPercentageBps: z.number().int().min(0).max(10000).nullable().optional(),
  depositFixedCents: z.number().int().min(0).nullable().optional(),
  depositRequiredAboveCents: z.number().int().min(0).nullable().optional(),
  // P2-036 V2 (Discount policy — U1) — per-tenant policy bounding AI-proposed
  // discounts. Mirrors the deposit fields' shape (bps + cents) and the
  // migration 178 CHECKs. Without these keys in the schema, z.object strips
  // them and the policy can never be set via the API. null clears the column;
  // omit to leave untouched. resolveDiscountPolicy fail-closes any absent value.
  discountMaxBps: z.number().int().min(0).max(10000).nullable().optional(),
  discountFloorCents: z.number().int().min(0).nullable().optional(),
  discountNeverBelowCatalog: z.boolean().nullable().optional(),
  // Tier 4 (Deposit rules — PR 3a-extended). Selects whether the
  // customer pays the deposit BEFORE they can approve the estimate
  // ('before_approval') or AFTER ('after_approval'). Default behavior
  // is 'after_approval'; existing tenants keep current flow.
  depositTimingPolicy: z.enum(['before_approval', 'after_approval']).optional(),
  // §9 — owner's effective hourly rate (integer cents). Populated by
  // §10 onboarding; until set, the Time-Given-Back card shows hours
  // only. null clears the field.
  hourlyRateCents: z.number().int().min(0).nullable().optional(),
  // B1 — Per-tenant voice persona. null clears the field.
  voiceAgentName: z.string().min(1).max(80).nullable().optional(),
  voiceGreeting: z.string().min(1).max(500).nullable().optional(),
  // F8 — Call routing & handoff (CallRoutingSheet). Persisted to the
  // escalation_settings JSONB column (migration 106) and consumed by the
  // telephony stack via resolveEscalationSettings. Partial: missing keys
  // fall back to DEFAULT_ESCALATION_SETTINGS on read.
  escalationSettings: z
    .object({
      channel_sms: z.boolean(),
      channel_in_app: z.boolean(),
      channel_whisper: z.boolean(),
      trigger_low_confidence: z.boolean(),
      trigger_explicit_request: z.boolean(),
      trigger_keyword_frustration: z.boolean(),
      trigger_llm_sentiment: z.boolean(),
      llm_sentiment_threshold: z.number().min(0).max(1),
      after_hours_voice_mode: z.enum(['voicemail', 'ai_answering']),
      // RV-071 — spoken challenge (PIN/passphrase) gating money/
      // irreversible VOICE approvals on the recognized owner line
      // (caller-ID match; see approver-identity.ts).
      // DEPRECATED (WS21a) — plaintext-at-rest. Enroll via
      // `PUT /api/settings/voice-approval-pin` instead, which hashes the PIN
      // (HMAC) and stores only `voice_approval_pin_hash`. This field is kept
      // for back-compat (the verify seam falls back to it) but should not be
      // written by new clients. `voice_approval_pin_hash` is intentionally
      // NOT in this schema, so a raw hash can never be injected via the
      // generic settings PUT (unknown keys are stripped by `.partial()`).
      voice_approval_challenge: z.string().min(4).max(64),
    })
    .partial()
    .optional(),
  // Public review links (Settings → Reviews). Migration 120. Whitespace/empty
  // normalizes to null so a cleared field reads back as "not configured".
  googleReviewUrl: reviewUrlField,
  yelpReviewUrl: reviewUrlField,
  // P11-002 — tenant language stack. Persisted to tenant_settings and
  // consumed by the voice agent + customer-facing comms.
  defaultLanguage: z.enum(['en', 'es']).optional(),
  autoDetectLanguage: z.boolean().optional(),
  ttsVoiceEn: ttsVoiceField,
  ttsVoiceEs: ttsVoiceField,
  spanishDispatcherUserIds: z.array(z.string().uuid()).optional(),
  // Voice-parity (migration 152) — E.164 warm-transfer line. Normalized to
  // E.164 (or null to clear) at the route boundary, mirroring ownerPhone.
  transferNumber: z.string().max(40).nullable().optional(),
  // RV-063 — end-of-day digest delivery. digestTime is tenant-local
  // 'HH:MM' (24h); channel 'none' stores the digest without owner SMS.
  digestEnabled: z.boolean().optional(),
  digestTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "digestTime must be 'HH:MM' (24-hour)")
    .optional(),
  digestChannel: z.enum(['sms', 'none']).optional(),
  // UB-D / D-015 — autonomous booking lane (migration 231). Threshold bounds
  // mirror the DB CHECK (NUMERIC(3,2) in [0.90, 0.99]).
  autonomousBookingEnabled: z.boolean().optional(),
  autonomousBookingThreshold: z.number().min(0.9).max(0.99).optional(),
}).superRefine((val, ctx) => {
  if (val.depositStrategy === 'percentage') {
    if (val.depositPercentageBps == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'depositPercentageBps is required when depositStrategy is "percentage"',
        path: ['depositPercentageBps'],
      });
    }
  } else if (val.depositStrategy === 'fixed') {
    if (val.depositFixedCents == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'depositFixedCents is required when depositStrategy is "fixed"',
        path: ['depositFixedCents'],
      });
    }
  }
});

export const conversationAccessSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['owner', 'dispatcher', 'technician']),
  tenantId: z.string().min(1),
});

// Phase 4 — Vertical Packs + Estimate Intelligence

export const verticalTypeSchema = z.enum(['hvac', 'plumbing', 'electrical', 'painting']);

const lineItemTemplateSchema = z.object({
  description: z.string().min(1),
  category: z.enum(['labor', 'material', 'equipment', 'other']),
  defaultQuantity: z.number().min(0),
  defaultUnitPriceCents: z.number().int().min(0),
  taxable: z.boolean(),
  sortOrder: z.number().int().min(0),
  isOptional: z.boolean(),
});

export const createTemplateSchema = z.object({
  verticalType: verticalTypeSchema,
  categoryId: z.string().min(1),
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  lineItemTemplates: z.array(lineItemTemplateSchema).min(1),
  defaultDiscountCents: z.number().int().min(0).optional(),
  defaultTaxRateBps: z.number().int().min(0).max(10000).optional(),
  defaultCustomerMessage: z.string().max(2000).optional(),
});

// PUT payloads: same field rules as create (money stays integer cents,
// taxRateBps bounded), everything optional. Without these the update routes
// persisted raw req.body — float/negative money straight to the DB.
export const updateTemplateSchema = createTemplateSchema
  .omit({ verticalType: true, categoryId: true })
  .partial()
  .extend({ isActive: z.boolean().optional() });

export const createBundleSchema = z.object({
  verticalType: verticalTypeSchema,
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  categoryIds: z.array(z.string().min(1)).min(1),
  lineItemTemplates: z.array(lineItemTemplateSchema).min(1),
  triggerKeywords: z.array(z.string().min(1)).min(1),
});

export const updateBundleSchema = createBundleSchema
  .omit({ verticalType: true })
  .partial()
  .extend({ isActive: z.boolean().optional() });

export const createWordingPreferenceSchema = z.object({
  verticalType: verticalTypeSchema.optional(),
  scope: z.enum(['line_item_description', 'customer_message', 'internal_note', 'estimate_header', 'estimate_footer']),
  key: z.string().min(1).max(100),
  preferredWording: z.string().min(1).max(500),
  avoidWordings: z.array(z.string().min(1)).optional(),
  context: z.string().max(500).optional(),
});

// J-FORM (Jobber parity) — job forms & checklists. Kept in lockstep with
// JOB_FORM_FIELD_TYPES (packages/api/src/job-forms/job-form.ts).
export const jobFormFieldTypeSchema = z.enum([
  'text',
  'textarea',
  'number',
  'date',
  'checkbox',
  'select',
]);

export const jobFormFieldInputSchema = z.object({
  id: z.string().max(100).optional(),
  label: z.string().min(1).max(200),
  fieldType: jobFormFieldTypeSchema.optional(),
  options: z.array(z.string().min(1).max(200)).optional(),
  required: z.boolean().optional(),
});

export const createJobFormTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  fields: z.array(jobFormFieldInputSchema).min(1),
  sortOrder: z.number().int().optional(),
});

export const updateJobFormTemplateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    fields: z.array(jobFormFieldInputSchema).min(1).optional(),
    sortOrder: z.number().int().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

export const jobFormAnswerSchema = z.object({
  fieldId: z.string().min(1).max(100),
  value: z.string().max(10000).nullable(),
});

export const createJobFormSubmissionSchema = z.object({
  templateId: z.string().min(1),
  answers: z.array(jobFormAnswerSchema).optional(),
  complete: z.boolean().optional(),
});

export const updateJobFormSubmissionSchema = z.object({
  answers: z.array(jobFormAnswerSchema).optional(),
  complete: z.boolean().optional(),
});

// U8 (CRM Jobber parity) — customer groups / segmentation.
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be a hex value like #3b82f6');

export const createCustomerGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).nullable().optional(),
  color: hexColor.nullable().optional(),
});

export const updateCustomerGroupSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(2000).nullable().optional(),
    color: hexColor.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

// MKT (Jobber parity) — customer email campaigns.
export const createCampaignSchema = z
  .object({
    name: z.string().min(1).max(200),
    subject: z.string().min(1).max(300),
    bodyText: z.string().min(1).max(20000),
    bodyHtml: z.string().max(50000).nullable().optional(),
    segmentTag: z.string().min(1).max(50).nullable().optional(),
    segmentGroupId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => !(v.segmentTag && v.segmentGroupId), {
    message: 'target a tag or a group, not both',
  });

// FIN (Jobber parity) — consumer financing on invoices.
export const offerFinancingSchema = z.object({
  // Defaults to the invoice's amount due when omitted.
  amountCents: z.number().int().positive().optional(),
  returnUrl: z.string().url().max(2000).optional(),
});

// R-JOB (Jobber parity) — recurring job series. Kept in lockstep with
// RECURRENCE_FREQUENCIES (packages/api/src/recurring-jobs/recurrence.ts).
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');

export const recurrenceRuleSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
    interval: z.number().int().min(1).max(365).default(1),
    count: z.number().int().min(1).max(1000).optional(),
    until: isoDate.optional(),
  })
  .refine((r) => !(r.count !== undefined && r.until !== undefined), {
    message: 'set either count or until, not both',
  });

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24-hour)');
const appointmentTypeValue = z.enum(['estimate', 'repair', 'install', 'maintenance', 'diagnostic']);

export const createRecurringJobSchema = z.object({
  customerId: z.string().min(1),
  title: z.string().min(1).max(200),
  anchorDate: isoDate,
  anchorTime: timeOfDay.optional(),
  durationMinutes: z.number().int().min(15).max(480).optional(),
  appointmentType: appointmentTypeValue.nullable().optional(),
  rule: recurrenceRuleSchema,
  notes: z.string().max(2000).nullable().optional(),
});

export const updateRecurringJobSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    anchorDate: isoDate.optional(),
    anchorTime: timeOfDay.optional(),
    durationMinutes: z.number().int().min(15).max(480).optional(),
    appointmentType: appointmentTypeValue.nullable().optional(),
    rule: recurrenceRuleSchema.optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });
