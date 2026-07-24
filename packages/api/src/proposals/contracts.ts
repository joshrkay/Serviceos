import { z } from 'zod';
import { appointmentTypeSchema, jobStatusSchema, jobPrioritySchema } from '@ai-service-os/shared';
import { ProposalType } from './proposal';
import { ValidationError } from '../shared/errors';
import { reassignAppointmentPayloadSchema } from './contracts/reassignment';
import { rescheduleAppointmentPayloadSchema } from './contracts/reschedule';
import { addCrewMemberPayloadSchema, removeCrewMemberPayloadSchema } from './contracts/crew';
import { cancelAppointmentPayloadSchema } from './contracts/cancellation';
import { addNotePayloadSchema } from './contracts/notes';
import { sendInvoicePayloadSchema } from './contracts/send-invoice';
import { sendEstimatePayloadSchema } from './contracts/send-estimate';
import { recordPaymentPayloadSchema } from './contracts/record-payment';
import { logExpensePayloadSchema } from './contracts/log-expense';
import { createInvoiceSchedulePayloadSchema } from './contracts/create-invoice-schedule';
import { batchInvoicePayloadSchema } from './contracts/batch-invoice';
import { sendPaymentReminderPayloadSchema } from './contracts/send-payment-reminder';
import { applyLateFeePayloadSchema } from './contracts/apply-late-fee';
import { createStandingInstructionPayloadSchema } from './contracts/standing-instruction';
import { updateCatalogItemPayloadSchema } from './contracts/update-catalog-item';
import { adoptEntityAliasPayloadSchema } from './contracts/adopt-entity-alias';
import {
  onboardingTenantSettingsPayloadSchema,
  onboardingServiceCategoryPayloadSchema,
  onboardingEstimateTemplatePayloadSchema,
  onboardingTeamMemberPayloadSchema,
  onboardingSchedulePayloadSchema,
} from './contracts/onboarding';
// P7-026 PR c — review_response_proposal schema lives in the shared
// package (per the spec — single source of truth, re-exported via the
// shared barrel). Do NOT redefine it locally.
import { reviewResponseProposalPayloadSchema } from '@ai-service-os/shared';
// RV-007 (F-4) — the confidence vocabulary is owned by the guardrails
// module (score→level mapping lives there too). Re-exported here so
// proposal-layer consumers don't reach into src/ai for the type.
import { CONFIDENCE_LEVELS } from '../ai/guardrails/confidence';
export type { ConfidenceLevel } from '../ai/guardrails/confidence';
// RV-MMS (§6.4-B) — severity markers reuse the canonical urgency-tier
// vocabulary that drives voice triage, so a photo-sourced draft and a voice
// call speak the same severity language. (proposals already depends on ../ai
// for the confidence vocabulary above.)
import { TIER_KEYS } from '../ai/skills/triage-rules.schema';

// ───────────────────────────────────────────────────────────────────────────
// RV-007 (F-4) — Confidence Marker `_meta` on proposal payloads.
//
// A reusable, OPTIONAL fragment carried inside the payload itself:
//
//   _meta: {
//     overallConfidence: 'high' | 'medium' | 'low' | 'very_low',
//     fieldConfidence?:  Record<payload path, ConfidenceLevel>,
//     markers?:          Array<{ path, reason }>,
//   }
//
// Attachment choice: every schema in PROPOSAL_TYPE_SCHEMAS is a Zod
// strip-mode object (several wrapped in `.refine()` → ZodEffects, which
// cannot be `.extend()`ed), so an unknown `_meta` key already passes
// each per-type schema untouched. Rather than rewriting ~40 schemas,
// `_meta` is validated once at the shared choke point —
// `validateProposalPayload` / `assertValidProposalPayload` — via the
// envelope below. Old payloads without `_meta` keep validating; a
// present-but-malformed `_meta` is rejected for every proposal type.
// ───────────────────────────────────────────────────────────────────────────

export const confidenceLevelSchema = z.enum(CONFIDENCE_LEVELS);

export const proposalConfidenceMetaSchema = z.object({
  overallConfidence: confidenceLevelSchema,
  /**
   * N-011 — the tenant brand-voice CONFIG version that produced any AI-drafted
   * text on this proposal (0 = neutral/unconfigured). Stamped by the composer
   * chokepoint so every AI-generated message carries the version used. Optional
   * so pre-N-011 payloads keep validating.
   */
  brandVoiceVersion: z.number().int().nonnegative().optional(),
  /**
   * §6.4-B severity marker — how urgent the visible problem is, on the same
   * urgency-tier scale as voice triage. Optional; today set by the MMS-to-quote
   * vision draft and surfaced to the owner in the review UI / SMS.
   */
  severity: z.enum(TIER_KEYS).optional(),
  /** Per-field certainty keyed by payload path, e.g. "lineItems[0].unitPrice". */
  fieldConfidence: z.record(confidenceLevelSchema).optional(),
  /** Human-readable callouts the review UI / SMS / voice readback render. */
  markers: z
    .array(
      z.object({
        path: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .optional(),
  /**
   * UB-A3 — owner standing instructions the drafting model reported applying,
   * intersected by the handler with what was actually injected (a model-
   * invented id can never land here). Presentation-only: the review UI renders
   * a "Standing instruction applied" chip; `decideInitialStatus` ignores it
   * (guard-tested byte-identical with/without). Omitted entirely when empty.
   */
  appliedStandingInstructions: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
      }),
    )
    .optional(),
});

export type ProposalConfidenceMeta = z.infer<typeof proposalConfidenceMetaSchema>;

/** `_meta` is optional on EVERY payload; other keys pass through untouched. */
const confidenceMetaEnvelopeSchema = z
  .object({ _meta: proposalConfidenceMetaSchema.optional() })
  .passthrough();

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

// B7 (feat: voice-transcript-and-agent-paths) — update_job: a bounded,
// SAFE field edit to an EXISTING job. `jobId` mirrors the update_estimate /
// update_invoice pattern (required uuid; a free-text `jobReference` the
// task handler couldn't resolve to a UUID stays gated via
// sourceContext.missingFields — see ai/tasks/job-edit-task.ts
// resolveJobIdGate — so this schema is deliberately NOT consulted by
// createProposal, only by editProposal / the assistant Edit form, exactly
// like its update_estimate/update_invoice siblings). `status` and
// `priority` reuse the canonical shared enums (jobStatusSchema /
// jobPrioritySchema) so this contract can never drift from the Job domain
// type or the jobs table CHECK constraint. Deliberately excludes money
// (deposit/pricing) and schedule (appointment) fields — those have their
// own proposal paths (draft_estimate/draft_invoice edits,
// reschedule_appointment).
export const updateJobPayloadSchema = z
  .object({
    jobId: z.string().uuid(),
    /** Free-text hint carried for review-card context; never trusted as an id. */
    jobReference: z.string().min(1).optional(),
    status: jobStatusSchema.optional(),
    priority: jobPrioritySchema.optional(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .refine(
    (v) =>
      v.status !== undefined ||
      v.priority !== undefined ||
      v.title !== undefined ||
      v.description !== undefined,
    { message: 'update_job requires at least one field to change: status, priority, title, or description' },
  );

export const createAppointmentPayloadSchema = z
  .object({
    jobId: z.string().uuid(),
    // RV-081 — revisit linkage. When present, this appointment is a REVISIT
    // booked against an EXISTING job (no new job is created): the execution
    // handler validates the job exists in-tenant and attaches the
    // appointment to it, overriding `jobId`. Audit metadata marks the
    // appointment as a revisit.
    linkedJobId: z.string().uuid().optional(),
    scheduledStart: z.string().min(1),
    scheduledEnd: z.string().min(1),
    technicianId: z.string().uuid().optional(),
    notes: z.string().optional(),
    // IANA tenant timezone the times should render in (UTC instants are
    // stored; this is display/context only). Set by the AI booking path.
    timezone: z.string().optional(),
    // Optional customer-facing arrival window (home-services standard).
    arrivalWindowStart: z.string().optional(),
    arrivalWindowEnd: z.string().optional(),
    // Carried from the voice path for the dispatcher review card; not all
    // are persisted directly on the appointment.
    customerId: z.string().optional(),
    customerName: z.string().optional(),
    summary: z.string().optional(),
    // Typed visit kind (estimate/repair/install/maintenance/diagnostic),
    // emitted enum-validated by the appointment task. Optional: inbound-caller
    // DRAFTs built at classify time carry none, and legacy payloads predate it.
    appointmentType: appointmentTypeSchema.optional(),
  })
  .refine(
    (v) => {
      const s = Date.parse(v.scheduledStart);
      const e = Date.parse(v.scheduledEnd);
      return !Number.isNaN(s) && !Number.isNaN(e) && e > s;
    },
    { message: 'scheduledEnd must be a valid datetime after scheduledStart' },
  )
  .refine(
    (v) => {
      // Arrival window is optional, but if both ends are present (e.g. a
      // dispatcher edit) they must be valid and ordered — never "12pm–8am".
      if (v.arrivalWindowStart == null && v.arrivalWindowEnd == null) return true;
      if (v.arrivalWindowStart == null || v.arrivalWindowEnd == null) return false;
      const s = Date.parse(v.arrivalWindowStart);
      const e = Date.parse(v.arrivalWindowEnd);
      return !Number.isNaN(s) && !Number.isNaN(e) && e > s;
    },
    { message: 'arrivalWindowEnd must be a valid datetime after arrivalWindowStart' },
  );

export const createBookingPayloadSchema = z.object({
  appointmentId: z.string().uuid(),
});

// One price field is required, but which one depends on the producer:
// the estimate path emits `unitPrice` (integer cents) while the invoice
// path normalizes to the executor's `unitPriceCents`. P22 adds
// `catalogItemId` + `pricingSource` so the review UI and audit trail
// can show WHERE a price came from (catalog-resolved vs LLM-invented).
const lineItemSchema = z
  .object({
    description: z.string().min(1),
    quantity: z.number(),
    unitPrice: z.number().optional(),
    unitPriceCents: z.number().int().min(0).nullable().optional(),
    category: z.string().optional(),
    catalogItemId: z.string().uuid().optional(),
    pricingSource: z.enum(['catalog', 'ambiguous', 'uncatalogued', 'manual']).optional(),
    needsPricing: z.boolean().optional(),
    // Good-better-best grouping (estimates only; inert on invoices). Items
    // sharing a non-null groupKey are mutually exclusive tiers; isOptional
    // lines without a groupKey are standalone add-ons. Mirrors the persisted
    // shape in packages/shared/src/contracts/money.ts. Declared here so the
    // fields validate explicitly rather than surviving by non-stripping luck.
    groupKey: z.string().optional(),
    groupLabel: z.string().optional(),
    isOptional: z.boolean().optional(),
    isDefaultSelected: z.boolean().optional(),
    // EE-4 — catalog image snapshot stamped by the catalog resolver. Must be
    // declared here or assertValidProposalPayload would strip/reject it and the
    // image would vanish on the AI path only.
    imageFileId: z.string().optional(),
  })
  .refine((li) => li.unitPrice !== undefined || li.unitPriceCents != null, {
    message: 'line item requires unitPrice or unitPriceCents',
  });

/**
 * Structural invariants for good-better-best tier groups on a drafted
 * estimate, returned as human-readable messages (empty = valid). The
 * drafting handlers coerce output to satisfy these via
 * `normalizeTierStructure` (ai/resolution/tier-structure.ts); this is the
 * backstop that keeps a hand-built or future-refactored payload from
 * persisting a malformed group. The two MUST agree — a stricter check here
 * than the normalizer produces would 400 a live draft.
 *
 * Invariants: each non-empty `groupKey` group has >= 2 options and exactly
 * one `isDefaultSelected`; `isDefaultSelected` appears only on a selectable
 * line (a tier option or an `isOptional` add-on), never on an always-billed
 * line where it would be meaningless.
 */
export function tierStructureIssues(
  lineItems: ReadonlyArray<{
    groupKey?: string;
    isOptional?: boolean;
    isDefaultSelected?: boolean;
  }>,
): string[] {
  const issues: string[] = [];
  const groups = new Map<string, number[]>();

  lineItems.forEach((li, i) => {
    const gk = typeof li.groupKey === 'string' && li.groupKey.length > 0 ? li.groupKey : undefined;
    if (gk) {
      const arr = groups.get(gk) ?? [];
      arr.push(i);
      groups.set(gk, arr);
    } else if (li.isDefaultSelected === true && li.isOptional !== true) {
      issues.push(
        `Line ${i} is default-selected but is neither a tier option nor an optional add-on`,
      );
    }
  });

  for (const [gk, indices] of groups) {
    if (indices.length < 2) {
      issues.push(`Tier group "${gk}" has only one option — a tier group needs at least two`);
      continue;
    }
    const defaults = indices.filter((i) => lineItems[i].isDefaultSelected === true);
    if (defaults.length !== 1) {
      issues.push(`Tier group "${gk}" must have exactly one default option (found ${defaults.length})`);
    }
  }

  return issues;
}

export const draftEstimatePayloadSchema = z
  .object({
    customerId: z.string().uuid(),
    jobId: z.string().uuid().optional(),
    lineItems: z.array(lineItemSchema).min(1),
    notes: z.string().optional(),
    validUntil: z.string().optional(),
  })
  // Backstop for good-better-best structure. Attached at the array level on
  // the DRAFT schema only — the edit-action schema (updateEstimatePayloadSchema)
  // validates one line at a time and has no group-level view, so it stays off
  // that path.
  .superRefine((val, ctx) => {
    for (const message of tierStructureIssues(val.lineItems)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['lineItems'] });
    }
  });

// remove_line_item / update_line_item target an existing line item by
// EITHER a numeric index (preferred, e.g. a re-draft carrying a prior
// resolution) OR a free-text description (what the edit-task LLM prompt
// actually emits — see ai/tasks/estimate-edit-task.ts). At least one is
// required; estimates/estimate-editor.ts's resolveActionIndex resolves
// whichever is present to a concrete index (or throws a clear execution
// error — no silent guessing). Note: z.discriminatedUnion requires each
// branch to be a plain ZodObject (not a `.and()`/`.refine()`-wrapped
// schema — that breaks its discriminant introspection), so the
// index-or-description invariant is enforced with a `.refine` on the
// FINISHED union below rather than folded into each branch.
export const estimateEditActionSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('add_line_item'),
      lineItem: lineItemSchema,
    }),
    z.object({
      type: z.literal('remove_line_item'),
      index: z.number().int().min(0).optional(),
      description: z.string().min(1).optional(),
    }),
    z.object({
      type: z.literal('update_line_item'),
      index: z.number().int().min(0).optional(),
      description: z.string().min(1).optional(),
      lineItem: lineItemSchema,
    }),
  ])
  .refine(
    (action) =>
      action.type === 'add_line_item' ||
      action.index !== undefined ||
      action.description !== undefined,
    { message: 'remove_line_item/update_line_item requires index or description' }
  );

export const updateEstimatePayloadSchema = z.object({
  estimateId: z.string().uuid(),
  editActions: z.array(estimateEditActionSchema).min(1),
});

export const draftInvoicePayloadSchema = z.object({
  customerId: z.string().uuid(),
  // B6 — jobId is optional, mirroring draftEstimatePayloadSchema: a
  // resolved customer with no resolvable job reference (e.g. "invoice the
  // Smith account") should still draft for review instead of stalling.
  // CreateInvoiceExecutionHandler auto-opens a job at execution when this
  // is absent, matching DraftEstimateExecutionHandler's job auto-create.
  jobId: z.string().uuid().optional(),
  estimateId: z.string().uuid().optional(),
  invoiceNumber: z.string().min(1).optional(),
  lineItems: z.array(lineItemSchema).min(1),
  discountCents: z.number().int().min(0).optional(),
  taxRateBps: z.number().int().min(0).max(10000).optional(),
  customerMessage: z.string().optional(),
  internalNotes: z.string().optional(),
});

// Edit-action schema for update_invoice proposals. Mirrors the
// estimate-editor pattern but scoped to invoice line items: Phase-2
// voice flows only add, remove, or replace a line item. Notes/wording
// edits are out of scope for this iteration — the draft_invoice path
// still owns those at creation time.
// See estimateEditActionSchema above for why the index-or-description
// invariant is a `.refine` on the finished union rather than folded into
// each discriminatedUnion branch.
export const invoiceEditActionSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('add_line_item'),
      lineItem: lineItemSchema,
    }),
    z.object({
      type: z.literal('remove_line_item'),
      index: z.number().int().min(0).optional(),
      description: z.string().min(1).optional(),
    }),
    z.object({
      type: z.literal('update_line_item'),
      index: z.number().int().min(0).optional(),
      description: z.string().min(1).optional(),
      lineItem: lineItemSchema,
    }),
  ])
  .refine(
    (action) =>
      action.type === 'add_line_item' ||
      action.index !== undefined ||
      action.description !== undefined,
    { message: 'remove_line_item/update_line_item requires index or description' }
  );

export const updateInvoicePayloadSchema = z.object({
  invoiceId: z.string().uuid(),
  editActions: z.array(invoiceEditActionSchema).min(1),
});

export const issueInvoicePayloadSchema = z.object({
  invoiceId: z.string().min(1),
  paymentTermDays: z.number().int().min(1).max(365).optional(),
});

// convert_lead: promote an existing lead to a customer. The classifier
// only has a free-text reference ("the Johnson lead"), so the task
// handler carries `leadReference` and flags `leadId` missing until the
// review UI / execution handler resolves a concrete lead. Either a
// resolved `leadId` (uuid) or a `leadReference` must be present.
// Optional address fields supply a primary service location when the
// lead has none (QA-MANUAL-0730).
export const convertLeadPayloadSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    leadReference: z.string().min(1).optional(),
    street1: z.string().trim().min(1).max(200).optional(),
    street2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(50).optional(),
    postalCode: z.string().trim().min(1).max(20).optional(),
    country: z.string().trim().min(1).max(50).optional(),
    accessNotes: z.string().trim().max(2000).optional(),
    label: z.string().trim().max(100).optional(),
  })
  .refine((v) => Boolean(v.leadId || v.leadReference), {
    message: 'leadId or leadReference is required',
  })
  .refine(
    (v) => {
      const any =
        Boolean(v.street1) || Boolean(v.city) || Boolean(v.state) || Boolean(v.postalCode);
      if (!any) return true;
      return Boolean(v.street1 && v.city && v.state && v.postalCode);
    },
    { message: 'street1, city, state, and postalCode are required together' }
  );

// confirm_appointment: mark an existing appointment confirmed. Resolved
// appointmentId (uuid) by execution time; appointmentReference carries
// the free-text reference until the review UI resolves it.
export const confirmAppointmentPayloadSchema = z
  .object({
    appointmentId: z.string().uuid().optional(),
    appointmentReference: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.appointmentId || v.appointmentReference), {
    message: 'appointmentId or appointmentReference is required',
  });

// mark_lead_lost: close out a lead. lostReason is required by the
// loseLead service, so the contract pins it.
export const markLeadLostPayloadSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    leadReference: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .refine((v) => Boolean(v.leadId || v.leadReference), {
    message: 'leadId or leadReference is required',
  });

// add_service_location: attach a new service address to a customer. The
// classifier only has a free-text address, so the structured fields are
// resolved by the review UI; either a resolved customerId or a
// customerReference must be present.
export const addServiceLocationPayloadSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    customerReference: z.string().min(1).optional(),
    addressText: z.string().min(1).optional(),
    label: z.string().optional(),
    street1: z.string().optional(),
    street2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postalCode: z.string().optional(),
  })
  .refine((v) => Boolean(v.customerId || v.customerReference), {
    message: 'customerId or customerReference is required',
  });

// log_time_entry: clock a technician in on a job/task. userId comes from
// the execution context (the speaking technician). jobReference is
// optional — break/admin time may not attach to a job.
export const logTimeEntryPayloadSchema = z.object({
  entryType: z.enum(['job', 'drive', 'break', 'admin']),
  jobId: z.string().uuid().optional(),
  jobReference: z.string().optional(),
  notes: z.string().optional(),
});

// notify_delay: outbound delay notice to a customer. Comms-class.
export const notifyDelayPayloadSchema = z
  .object({
    appointmentId: z.string().uuid().optional(),
    appointmentReference: z.string().min(1).optional(),
    delayMinutes: z.number().int().positive().optional(),
  })
  .refine((v) => Boolean(v.appointmentId || v.appointmentReference), {
    message: 'appointmentId or appointmentReference is required',
  });

// request_feedback: send a post-job feedback/review request. Comms-class.
export const requestFeedbackPayloadSchema = z
  .object({
    jobId: z.string().uuid().optional(),
    jobReference: z.string().min(1).optional(),
    customerReference: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.jobId || v.jobReference || v.customerReference), {
    message: 'jobId, jobReference, or customerReference is required',
  });

// send_estimate_nudge (RV-086): re-send a sent-but-unanswered estimate to
// the customer ("nudge"). Comms-class — never auto-approves. The classifier
// only has a free-text reference ("the Hendersons' estimate"), so the
// contract accepts either a resolved estimateId (uuid) or an
// estimateReference; the execution handler requires the resolved id.
export const sendEstimateNudgePayloadSchema = z
  .object({
    estimateId: z.string().uuid().optional(),
    estimateReference: z.string().min(1).optional(),
    /** Optional note appended to the outbound message. */
    note: z.string().optional(),
  })
  .refine((v) => Boolean(v.estimateId || v.estimateReference), {
    message: 'estimateId or estimateReference is required',
  });

// voice_clarification: emitted when the voice classifier cannot route
// a transcript (intent='unknown' OR confidence below threshold). It is
// NOT a mutation — it surfaces in the operator's feed as "I heard X
// but wasn't sure what to do." The operator dismisses it or speaks
// again. Stored as a proposal so it reuses the existing tenant
// isolation, audit, and review-card rendering; it has no execution
// handler because there is nothing to execute.
//
// Reasons the router emits one:
//   - 'unknown_intent'         — classifier said 'unknown' at any confidence
//   - 'low_confidence'         — a real intent was picked but below threshold
//   - 'parse_failed'           — classifier output wasn't parseable JSON
//   - 'missing_entities'       — intent was clear but required entities absent
//
// suggestedIntents (optional) lets the UI render "Did you mean: create
// invoice / schedule appointment?" chips. When the classifier picked an
// intent but confidence was low, the low-confidence intent is the first
// suggestion.
export const voiceClarificationPayloadSchema = z.object({
  transcript: z.string().min(1),
  reason: z.enum([
    'unknown_intent',
    'low_confidence',
    'parse_failed',
    'missing_entities',
    // P8 — intent understood, but an entity reference matched several
    // tenant records ("three Bobs"); candidates carry the picker list.
    'ambiguous_entity',
    // P2-036 V2 — a discount ask was understood, but the target price /
    // amount couldn't be parsed ("knock some off"); the discount evaluator
    // emits this instead of silently guessing a discount.
    'ambiguous_discount_target',
    // RIVET P4 — an unauthenticated (S1) caller's intent resolved to an
    // operator-only proposal type ("send me the Henderson invoice"). The
    // request is preserved for the operator as a non-actionable
    // clarification; the S2 op itself is never minted from an S1 session.
    'surface_restricted',
  ]),
  suggestedIntents: z.array(z.string()).optional(),
  classifierReasoning: z.string().optional(),
  classifierConfidence: z.number().min(0).max(1).optional(),
  recordingId: z.string().optional(),
  conversationId: z.string().optional(),
  /** P8 — the free-text reference that was ambiguous ("Bob"). */
  entityReference: z.string().optional(),
  /** P8 — disambiguation candidates for the review UI's one-tap picker. */
  entityCandidates: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        hint: z.string().optional(),
        score: z.number().min(0).max(1),
      }),
    )
    .optional(),
});

export const PROPOSAL_TYPE_SCHEMAS: Record<ProposalType, z.ZodSchema> = {
  create_customer: createCustomerPayloadSchema,
  update_customer: updateCustomerPayloadSchema,
  create_job: createJobPayloadSchema,
  update_job: updateJobPayloadSchema,
  create_appointment: createAppointmentPayloadSchema,
  create_booking: createBookingPayloadSchema,
  // A callback request captured when the agent cannot complete an action
  // live (e.g. an after-hours booking) and needs an operator to call back.
  callback: z
    .object({
      reason: z.string().optional(),
      requestedService: z.string().optional(),
      callerPhone: z.string().optional(),
      transcript: z.string().optional(),
      conversationId: z.string().optional(),
    })
    .passthrough(),
  draft_estimate: draftEstimatePayloadSchema,
  update_estimate: updateEstimatePayloadSchema,
  draft_invoice: draftInvoicePayloadSchema,
  update_invoice: updateInvoicePayloadSchema,
  issue_invoice: issueInvoicePayloadSchema,
  create_invoice_schedule: createInvoiceSchedulePayloadSchema,
  batch_invoice: batchInvoicePayloadSchema,
  reassign_appointment: reassignAppointmentPayloadSchema,
  reschedule_appointment: rescheduleAppointmentPayloadSchema,
  add_crew_member: addCrewMemberPayloadSchema,
  remove_crew_member: removeCrewMemberPayloadSchema,
  cancel_appointment: cancelAppointmentPayloadSchema,
  voice_clarification: voiceClarificationPayloadSchema,
  add_note: addNotePayloadSchema,
  send_invoice: sendInvoicePayloadSchema,
  send_estimate: sendEstimatePayloadSchema,
  send_estimate_nudge: sendEstimateNudgePayloadSchema,
  record_payment: recordPaymentPayloadSchema,
  log_expense: logExpensePayloadSchema,
  convert_lead: convertLeadPayloadSchema,
  confirm_appointment: confirmAppointmentPayloadSchema,
  mark_lead_lost: markLeadLostPayloadSchema,
  add_service_location: addServiceLocationPayloadSchema,
  log_time_entry: logTimeEntryPayloadSchema,
  notify_delay: notifyDelayPayloadSchema,
  request_feedback: requestFeedbackPayloadSchema,
  emergency_dispatch: z.object({
    callerPhone: z.string().optional(),
    emergencyDescription: z.string(),
    detectedKeywords: z.array(z.string()).default([]),
  }),
  onboarding_tenant_settings: onboardingTenantSettingsPayloadSchema,
  onboarding_service_category: onboardingServiceCategoryPayloadSchema,
  onboarding_estimate_template: onboardingEstimateTemplatePayloadSchema,
  onboarding_team_member: onboardingTeamMemberPayloadSchema,
  onboarding_schedule: onboardingSchedulePayloadSchema,
  review_response_proposal: reviewResponseProposalPayloadSchema,
  send_payment_reminder: sendPaymentReminderPayloadSchema,
  apply_late_fee: applyLateFeePayloadSchema,
  create_standing_instruction: createStandingInstructionPayloadSchema,
  update_catalog_item: updateCatalogItemPayloadSchema,
  adopt_entity_alias: adoptEntityAliasPayloadSchema,
};

export function validateProposalPayload(
  proposalType: string,
  payload: unknown
): { valid: boolean; errors?: string[] } {
  const schema = PROPOSAL_TYPE_SCHEMAS[proposalType as ProposalType];
  if (!schema) {
    return { valid: false, errors: [`Unknown proposal type: ${proposalType}`] };
  }

  const errors: string[] = [];

  const result = schema.safeParse(payload);
  if (!result.success) {
    errors.push(
      ...result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    );
  }

  // RV-007 — validate the optional `_meta` confidence-marker fragment for
  // every proposal type. The per-type schemas are strip-mode, so they
  // ignore `_meta`; this envelope is the single gate that rejects a
  // malformed one. Skipped for non-object payloads (the per-type schema
  // already rejects those).
  if (typeof payload === 'object' && payload !== null) {
    const metaResult = confidenceMetaEnvelopeSchema.safeParse(payload);
    if (!metaResult.success) {
      errors.push(
        ...metaResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
      );
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true };
}

/**
 * P2-002 AI-safety gate. Production AI task handlers (and any other
 * code path that translates a model's structured output into a
 * proposal) MUST call this before `createProposal`. Throws a typed
 * `ValidationError` with the offending Zod paths in `details.errors`,
 * which the HTTP layer surfaces as a 400 rather than letting the
 * payload reach storage or execution.
 *
 * Plain `createProposal` is intentionally left as a pure builder so
 * test fixtures can construct proposals with synthetic payloads
 * without dragging in the full schema for unrelated concerns
 * (lifecycle, audit, prioritization). The gate is enforced where AI
 * emits, not where any caller builds.
 */
export function assertValidProposalPayload(
  proposalType: string,
  payload: unknown
): void {
  const validation = validateProposalPayload(proposalType, payload);
  if (!validation.valid) {
    throw new ValidationError(
      `Invalid payload for proposal type '${proposalType}'`,
      { errors: validation.errors }
    );
  }
}
