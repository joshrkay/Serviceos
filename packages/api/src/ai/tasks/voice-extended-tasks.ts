/**
 * Task handlers for the Stage-2 voice intents (reschedule, cancel,
 * reassign, add_note, send_invoice, record_payment).
 *
 * Design choice: these handlers are simple passthroughs from the
 * classifier's `ExtractedEntities` to the proposal payload. No second
 * LLM round-trip is required because the classifier already extracts
 * everything the downstream execution handler needs — except concrete
 * entity IDs (the classifier never touches the DB, so it returns free-
 * text references like "the Miller job" or "INV-0042"). The review UI
 * resolves those at approval time and the entity-resolver stage will
 * eventually do so automatically.
 *
 * When required fields are missing, the handler lists them on the
 * proposal as `missingFields`. `decideInitialStatus` forces 'draft'
 * whenever `missingFields` is non-empty, so a partial payload can
 * never auto-execute.
 */

import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import {
  createProposal,
  CreateProposalInput,
  ProposalType,
} from '../../proposals/proposal';
import { ExtractedEntities } from '../orchestration/intent-classifier';
import type { AppointmentRepository } from '../../appointments/appointment';
import type { JobRepository } from '../../jobs/job';
import type { LLMGateway } from '../gateway/gateway';
import { isIsoDatetime } from './create-appointment-task';

function entitiesFrom(context: TaskContext): ExtractedEntities {
  return (context.existingEntities ?? {}) as ExtractedEntities;
}

/** Tolerate both spellings ('canceled' canonical, 'cancelled' from fixtures). */
function isCancelled(status: unknown): boolean {
  return status === 'canceled' || status === 'cancelled';
}

/** Coerce a Date | ISO-string | unknown scheduledStart into a Date. */
function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(v as string);
}

/** Options for scoping appointment resolution to the verified caller. */
interface ResolveActiveOpts {
  /** Verified caller identity (caller-ID match). When present, resolution is scoped to this customer. */
  customerId?: string;
  /** Job repo used to map appointment → job → customerId for caller scoping. */
  jobRepo?: JobRepository;
  /** Test seam for "now"; defaults to the wall clock. */
  now?: Date;
}

/**
 * Resolve the caller's active (non-cancelled) appointment id.
 *
 * The classifier only ever returns a natural-language reference
 * ("my Tuesday appointment"), never a UUID. We resolve it against the
 * caller's own upcoming appointments and return the single match.
 * Returns undefined when zero or more than one candidate exists
 * (ambiguous → leave for the review UI / escalation, never guess).
 *
 * Caller scoping (robustness fix): when a verified `customerId` AND a
 * `jobRepo` are supplied, candidates are filtered to appointments whose
 * job belongs to that customer (appointment → job → customerId, the same
 * join the slot-conflict-checker uses). This prevents a live caller's
 * "reschedule/cancel my appointment" from ever resolving to a *different*
 * customer's appointment in a small tenant. When the caller identity or
 * jobRepo is absent we cannot verify ownership, so we preserve the legacy
 * tenant-wide single-active behavior (the operator in-app path, and tests
 * that omit the wiring).
 *
 * Upcoming scoping: past appointments are preferred-out, but only when
 * doing so still leaves at least one candidate — so fixtures with
 * past-but-active appointments (and repos that don't store scheduledStart)
 * keep resolving.
 */
async function resolveActiveAppointmentId(
  repo: AppointmentRepository | undefined,
  tenantId: string,
  opts?: ResolveActiveOpts,
): Promise<string | undefined> {
  if (!repo) return undefined;
  // Use listWithMeta (tenant-scoped, no date filter) rather than
  // findByDateRange: corpus fixtures store scheduledStart as ISO
  // strings, which breaks the repo's Date-based range comparison.
  let all: Array<{ id: string; status: unknown; jobId?: string; scheduledStart?: unknown }> = [];
  if (repo.listWithMeta) {
    const r = await repo.listWithMeta(tenantId);
    all = r.data;
  } else {
    all = await repo.findByDateRange(tenantId, new Date(0), new Date('9999-12-31T00:00:00.000Z'));
  }
  let active = all.filter((a) => !isCancelled(a.status));

  // Scope to the verified caller's own appointments FIRST (when we can
  // verify ownership), THEN prefer upcoming within that owned set. Order
  // matters: scoping before the upcoming filter ensures a caller whose
  // only appointment is in the past still resolves even if a *different*
  // customer has an upcoming one, and never widens resolution on the
  // unscoped operator path (which keeps the legacy single-active-tenant
  // behavior untouched — no auto-pick when >1 active exists).
  if (opts?.customerId && opts?.jobRepo) {
    const jobRepo = opts.jobRepo;
    const owned: typeof active = [];
    for (const a of active) {
      if (!a.jobId) continue;
      try {
        const job = await jobRepo.findById(tenantId, a.jobId);
        if (job && job.customerId === opts.customerId) owned.push(a);
      } catch {
        // Ignore per-candidate lookup failures — a flaky job read should
        // exclude that candidate, not crash the whole resolution.
      }
    }
    active = owned;

    // Prefer the caller's upcoming appointments, but only when that leaves
    // candidates (keeps past-but-active appointments + repos without
    // scheduledStart resolvable).
    const now = opts.now ?? new Date();
    const upcoming = active.filter((a) => {
      const t = toDate(a.scheduledStart).getTime();
      return !Number.isNaN(t) && t >= now.getTime();
    });
    if (upcoming.length > 0) active = upcoming;
  }

  return active.length === 1 ? active[0].id : undefined;
}

const RESCHEDULE_SYSTEM_PROMPT = `You are an appointment scheduling assistant for a field service operating system.
Given a voice transcript where a caller asks to reschedule an existing appointment, extract the NEW appointment time.

Return valid JSON with this shape (no prose, no markdown fences):
{
  "newScheduledStart": "<ISO 8601 UTC datetime, e.g. 2026-04-22T21:00:00.000Z>",
  "newScheduledEnd": "<ISO 8601 UTC datetime>",
  "confidence_score": <number between 0 and 1>
}

Rules:
- Always return ISO 8601 UTC datetimes.
- Assume the tenant's local timezone is America/Los_Angeles unless told otherwise, then convert to UTC.
- Preserve the original appointment's duration unless the caller states a new one.
- If the new date/time is ambiguous, set confidence_score below 0.7.`;

function tryParseJson(content: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(content);
    return typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function baseSourceContext(context: TaskContext): Record<string, unknown> | undefined {
  if (!context.conversationId) return undefined;
  return { conversationId: context.conversationId };
}

function inputFor(
  context: TaskContext,
  proposalType: ProposalType,
  payload: Record<string, unknown>,
  missingFields: string[],
  opts?: { trust?: 'autonomous' | undefined }
): CreateProposalInput {
  return {
    tenantId: context.tenantId,
    proposalType,
    payload,
    summary: context.message,
    sourceContext: baseSourceContext(context),
    createdBy: context.userId,
    missingFields: missingFields.length > 0 ? missingFields : undefined,
    sourceTrustTier: opts?.trust,
    // PR B — pass through the tenant threshold override the router
    // resolved at request entry. All 8 voice-extended task call sites
    // route through this helper, so this is a single touch point.
    ...(context.tenantThresholdOverride
      ? { tenantThresholdOverride: context.tenantThresholdOverride }
      : {}),
  };
}

// ───────────── reschedule_appointment ─────────────
//
// Reschedule needs ISO datetimes. The classifier returns a natural-
// language `newDateTimeDescription` ("next Tuesday at 2pm"). We keep
// the description on the payload and list the ISO fields as missing —
// the review UI (or a follow-up enrichment step) resolves them before
// approval is allowed.
export class RescheduleAppointmentTaskHandler implements TaskHandler {
  readonly taskType = 'reschedule_appointment' as const;

  constructor(
    private readonly gateway?: LLMGateway,
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly jobRepo?: JobRepository,
  ) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    // Resolve the concrete appointment id from the caller's active
    // appointment (the classifier only gives a natural-language ref).
    const resolvedId = await resolveActiveAppointmentId(
      this.appointmentRepo,
      context.tenantId,
      { customerId: context.customerId, jobRepo: this.jobRepo },
    );
    if (resolvedId) {
      payload.appointmentId = resolvedId;
    } else if (ee.appointmentReference) {
      payload.appointmentReference = ee.appointmentReference;
      missing.push('appointmentId');
    } else {
      missing.push('appointmentId');
    }

    if (ee.newDateTimeDescription) {
      payload.newDateTimeDescription = ee.newDateTimeDescription;
    }

    // Parse the natural-language new time into ISO datetimes via the
    // LLM — mirrors CreateAppointmentAITaskHandler. When no gateway is
    // wired (or parsing fails) the ISO fields stay missing so the
    // review UI fills them from the description.
    let parsedStart: string | undefined;
    let parsedEnd: string | undefined;
    if (this.gateway) {
      try {
        const res = await this.gateway.complete({
          taskType: 'reschedule_appointment',
          messages: [
            { role: 'system', content: RESCHEDULE_SYSTEM_PROMPT },
            { role: 'user', content: this.buildUserMessage(context) },
          ],
          responseFormat: 'json',
        });
        const parsed = tryParseJson(res.content);
        if (parsed) {
          if (isIsoDatetime(parsed.newScheduledStart)) parsedStart = parsed.newScheduledStart;
          if (isIsoDatetime(parsed.newScheduledEnd)) parsedEnd = parsed.newScheduledEnd;
        }
      } catch {
        // Degrade to missing-fields — never fail the call on a parse hiccup.
      }
    }

    if (parsedStart) payload.newScheduledStart = parsedStart;
    else missing.push('newScheduledStart');
    if (parsedEnd) payload.newScheduledEnd = parsedEnd;
    else missing.push('newScheduledEnd');

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }

  private buildUserMessage(context: TaskContext): string {
    const parts: string[] = [`Transcript: ${context.message}`];
    if (context.existingEntities && Object.keys(context.existingEntities).length > 0) {
      parts.push(`Known entities: ${JSON.stringify(context.existingEntities)}`);
    }
    return parts.join('\n');
  }
}

// ───────────── cancel_appointment ─────────────
//
// Cancellation is irreversible (action class = 'irreversible'). Even
// if every field is filled, the D3 rules keep it in 'draft' — the
// operator always screen-taps.
export class CancelAppointmentTaskHandler implements TaskHandler {
  readonly taskType = 'cancel_appointment' as const;

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly jobRepo?: JobRepository,
  ) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {
      cancellationType: ee.cancellationType ?? 'other',
    };
    const missing: string[] = [];

    // Resolve the concrete appointment id from the caller's active
    // appointment; fall back to the natural-language reference.
    const resolvedId = await resolveActiveAppointmentId(
      this.appointmentRepo,
      context.tenantId,
      { customerId: context.customerId, jobRepo: this.jobRepo },
    );
    if (resolvedId) {
      payload.appointmentId = resolvedId;
    } else if (ee.appointmentReference) {
      payload.appointmentReference = ee.appointmentReference;
      missing.push('appointmentId');
    } else {
      missing.push('appointmentId');
    }

    if (ee.cancellationReason && ee.cancellationReason.length > 0) {
      payload.reason = ee.cancellationReason;
    } else {
      payload.reason = context.message;
    }

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── reassign_appointment ─────────────
//
// The classifier returns a TECHNICIAN NAME, never a UUID. The
// execution handler needs a concrete `toTechnicianId`. We always
// list `toTechnicianId` as missing so the review UI resolves the
// name to an ID before approval is allowed.
export class ReassignAppointmentTaskHandler implements TaskHandler {
  readonly taskType = 'reassign_appointment' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    if (ee.appointmentReference) payload.appointmentReference = ee.appointmentReference;
    else missing.push('appointmentId');

    if (ee.targetTechnicianName) payload.targetTechnicianName = ee.targetTechnicianName;
    // Always list toTechnicianId as missing — even when a name was
    // given, we need a resolved UUID before the mutation can run.
    missing.push('toTechnicianId');

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── add_note ─────────────
export class AddNoteTaskHandler implements TaskHandler {
  readonly taskType = 'add_note' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {
      targetKind: ee.noteTargetKind ?? 'job',
      body: ee.noteBody ?? context.message,
    };
    const missing: string[] = [];

    if (ee.customerName || ee.jobReference) {
      payload.targetReference = ee.jobReference ?? ee.customerName;
    } else {
      missing.push('targetId');
    }

    if (!ee.noteTargetKind) missing.push('targetKind');

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── send_invoice ─────────────
//
// Comms class — never auto-approves. We don't pass sourceTrustTier so
// D3 lands it in 'draft' regardless of confidence.
export class SendInvoiceTaskHandler implements TaskHandler {
  readonly taskType = 'send_invoice' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {
      channel: ee.sendChannel ?? 'email',
    };
    const missing: string[] = [];

    if (ee.jobReference) payload.invoiceReference = ee.jobReference;
    else if (ee.customerName) payload.invoiceReference = ee.customerName;
    else missing.push('invoiceId');

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── send_estimate ─────────────
//
// Comms class — never auto-approves. Mirrors SendInvoiceTaskHandler:
// the classifier only has a free-text reference at this point, so the
// proposal carries estimateReference and flags estimateId as missing;
// the operator resolves it in the review card before approval.
export class SendEstimateTaskHandler implements TaskHandler {
  readonly taskType = 'send_estimate' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {
      channel: ee.sendChannel ?? 'email',
    };
    const missing: string[] = [];

    if (ee.jobReference) payload.estimateReference = ee.jobReference;
    else if (ee.customerName) payload.estimateReference = ee.customerName;
    else missing.push('estimateId');

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── record_payment ─────────────
//
// Money class — never auto-approves under any confidence.
export class RecordPaymentTaskHandler implements TaskHandler {
  readonly taskType = 'record_payment' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {
      paymentMethod: ee.paymentMethod ?? 'other',
    };
    const missing: string[] = [];

    if (ee.jobReference) payload.invoiceReference = ee.jobReference;
    else if (ee.customerName) payload.invoiceReference = ee.customerName;
    else missing.push('invoiceId');

    if (typeof ee.amount === 'number' && ee.amount > 0) {
      payload.amountCents = ee.amount;
    } else {
      missing.push('amountCents');
    }

    if (ee.paymentReference) payload.paymentReference = ee.paymentReference;

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── emergency_dispatch ─────────────
//
// Fast-path — irreversible action class. Proposal creation is the only
// step; the state machine skips entity_resolution and intent_confirm.
export class EmergencyDispatchTaskHandler implements TaskHandler {
  readonly taskType = 'emergency_dispatch' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const payload: Record<string, unknown> = {
      emergencyDescription: context.message,
      detectedKeywords: [],
    };

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, [])),
      taskType: this.taskType,
    };
  }
}

// ───────────── update_customer ─────────────
//
// Edits contact details on an EXISTING customer. The concrete
// customerId comes from the identified caller (inbound) when present;
// the operator path has no caller identity, so customerId is flagged
// missing and the review UI resolves the customerName reference. The
// classifier's updated* fields map onto the proposal payload's
// name/email/phone/address. Capture-class — reuses the existing
// UpdateCustomerExecutionHandler.
export class UpdateCustomerTaskHandler implements TaskHandler {
  readonly taskType = 'update_customer' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    if (context.customerId) {
      payload.customerId = context.customerId;
    } else {
      if (ee.customerName) payload.customerReference = ee.customerName;
      missing.push('customerId');
    }

    if (ee.updatedName) payload.name = ee.updatedName;
    if (ee.updatedEmail) payload.email = ee.updatedEmail;
    if (ee.updatedPhone) payload.phone = ee.updatedPhone;
    if (ee.updatedAddress) payload.address = ee.updatedAddress;

    // At least one field must change for the update to be meaningful.
    if (!ee.updatedName && !ee.updatedEmail && !ee.updatedPhone && !ee.updatedAddress) {
      missing.push('updatedField');
    }

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── log_expense ─────────────
//
// Owner/technician logs a business expense. Capture-class, moves no
// money. Reuses the existing LogExpenseExecutionHandler. spentAt
// defaults to today (the operator can edit before approval). jobId is
// optional on the contract, so a missing job reference does not block.
export class LogExpenseTaskHandler implements TaskHandler {
  readonly taskType = 'log_expense' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {
      category: ee.expenseCategory ?? 'other',
      description: ee.expenseDescription ?? context.message,
      spentAt: new Date().toISOString().slice(0, 10),
    };
    const missing: string[] = [];

    if (typeof ee.amount === 'number' && ee.amount > 0) {
      payload.amountCents = ee.amount;
    } else {
      missing.push('amountCents');
    }

    if (ee.vendor) payload.vendor = ee.vendor;
    if (ee.jobReference) payload.jobReference = ee.jobReference;

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── convert_lead ─────────────
//
// Promotes an existing lead to a customer. The classifier only has a
// free-text reference, so the payload carries leadReference and flags
// leadId missing — the review UI / execution handler resolves the lead.
export class ConvertLeadTaskHandler implements TaskHandler {
  readonly taskType = 'convert_lead' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    const reference = ee.leadReference ?? ee.customerName;
    if (reference) payload.leadReference = reference;
    missing.push('leadId');

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── confirm_appointment ─────────────
//
// Marks an existing appointment confirmed. Resolves the caller's single
// active appointment when an appointmentRepo is wired; otherwise carries
// the free-text reference and flags appointmentId missing.
export class ConfirmAppointmentTaskHandler implements TaskHandler {
  readonly taskType = 'confirm_appointment' as const;

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly jobRepo?: JobRepository,
  ) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    const resolvedId = await resolveActiveAppointmentId(this.appointmentRepo, context.tenantId, {
      customerId: context.customerId,
      jobRepo: this.jobRepo,
    });
    if (resolvedId) {
      payload.appointmentId = resolvedId;
    } else if (ee.appointmentReference) {
      payload.appointmentReference = ee.appointmentReference;
      missing.push('appointmentId');
    } else {
      missing.push('appointmentId');
    }

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── mark_lead_lost ─────────────
//
// Closes out a lead. The classifier returns a free-text lead reference;
// leadId is resolved by the review UI / execution handler. A reason is
// always carried (defaults to the transcript) since loseLead requires one.
export class MarkLeadLostTaskHandler implements TaskHandler {
  readonly taskType = 'mark_lead_lost' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {
      reason: ee.lostReason && ee.lostReason.length > 0 ? ee.lostReason : context.message,
    };
    const missing: string[] = ['leadId'];

    const reference = ee.leadReference ?? ee.customerName;
    if (reference) payload.leadReference = reference;

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── add_service_location ─────────────
//
// Attaches a new service address to a customer. The classifier only has
// a freeform address string; the structured street/city/state/zip are
// resolved by the review UI, so they're flagged missing.
export class AddServiceLocationTaskHandler implements TaskHandler {
  readonly taskType = 'add_service_location' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    if (context.customerId) {
      payload.customerId = context.customerId;
    } else if (ee.customerName) {
      payload.customerReference = ee.customerName;
      missing.push('customerId');
    } else {
      missing.push('customerId');
    }

    if (ee.serviceAddress) payload.addressText = ee.serviceAddress;
    // The executor needs structured fields — always require resolution.
    missing.push('street1', 'city', 'state', 'postalCode');

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── log_time_entry ─────────────
//
// Clocks the speaking technician in on a job/task. entryType defaults to
// 'job'. jobReference is carried for the executor to resolve to a jobId.
export class LogTimeEntryTaskHandler implements TaskHandler {
  readonly taskType = 'log_time_entry' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {
      entryType: ee.timeEntryType ?? 'job',
    };
    if (ee.jobReference) payload.jobReference = ee.jobReference;

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, [])),
      taskType: this.taskType,
    };
  }
}

// ───────────── notify_delay ─────────────
//
// Outbound delay notice to a customer. Comms-class — never auto-approves.
export class NotifyDelayTaskHandler implements TaskHandler {
  readonly taskType = 'notify_delay' as const;

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly jobRepo?: JobRepository,
  ) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    // Scope to the caller's own appointment — notify_delay emits a comms
    // proposal that texts the customer, so resolving to a *different*
    // customer's appointment would message the wrong person.
    const resolvedId = await resolveActiveAppointmentId(this.appointmentRepo, context.tenantId, {
      customerId: context.customerId,
      jobRepo: this.jobRepo,
    });
    if (resolvedId) {
      payload.appointmentId = resolvedId;
    } else if (ee.appointmentReference) {
      payload.appointmentReference = ee.appointmentReference;
      missing.push('appointmentId');
    } else {
      missing.push('appointmentId');
    }

    if (typeof ee.delayMinutes === 'number' && ee.delayMinutes > 0) {
      payload.delayMinutes = ee.delayMinutes;
    }

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── request_feedback ─────────────
//
// Sends a post-job feedback/review request. Comms-class.
export class RequestFeedbackTaskHandler implements TaskHandler {
  readonly taskType = 'request_feedback' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    if (ee.jobReference) payload.jobReference = ee.jobReference;
    else if (ee.customerName) payload.customerReference = ee.customerName;
    else missing.push('jobId');

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── create_job (LLM-free variant for voice) ─────────────
//
// The task-handlers.ts CreateJobTaskHandler is a plain passthrough
// that expects a pre-built payload. This voice variant maps the
// classifier's extracted fields to the required schema shape. Like
// ReassignAppointmentTaskHandler, customerId is always listed as
// missing because the classifier returns a customer NAME, never a
// UUID — the review UI resolves the reference before approval.
export class CreateJobVoiceTaskHandler implements TaskHandler {
  readonly taskType = 'create_job' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    if (ee.customerName) payload.customerReference = ee.customerName;
    // Always require customerId — the reference alone isn't enough
    // to execute.
    missing.push('customerId');

    if (ee.jobTitle) payload.title = ee.jobTitle;
    else if (ee.jobReference) payload.title = ee.jobReference;
    else missing.push('title');

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}
