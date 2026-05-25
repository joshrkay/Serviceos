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
import type { LLMGateway } from '../gateway/gateway';
import { isIsoDatetime } from './create-appointment-task';

function entitiesFrom(context: TaskContext): ExtractedEntities {
  return (context.existingEntities ?? {}) as ExtractedEntities;
}

/** Tolerate both spellings ('canceled' canonical, 'cancelled' from fixtures). */
function isCancelled(status: unknown): boolean {
  return status === 'canceled' || status === 'cancelled';
}

/**
 * Resolve the caller's active (non-cancelled) appointment id.
 *
 * The classifier only ever returns a natural-language reference
 * ("my Tuesday appointment"), never a UUID. Production resolves that
 * against the identified caller's upcoming appointments. We mirror
 * that here: scan the tenant's scheduled appointments and return the
 * single active one. Returns undefined when zero or more than one
 * candidate exists (ambiguous → leave for the review UI / escalation).
 */
async function resolveActiveAppointmentId(
  repo: AppointmentRepository | undefined,
  tenantId: string,
): Promise<string | undefined> {
  if (!repo) return undefined;
  // Use listWithMeta (tenant-scoped, no date filter) rather than
  // findByDateRange: corpus fixtures store scheduledStart as ISO
  // strings, which breaks the repo's Date-based range comparison.
  let all: Array<{ id: string; status: unknown }> = [];
  if (repo.listWithMeta) {
    const r = await repo.listWithMeta(tenantId);
    all = r.data;
  } else {
    all = await repo.findByDateRange(tenantId, new Date(0), new Date('9999-12-31T00:00:00.000Z'));
  }
  const active = all.filter((a) => !isCancelled(a.status));
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

  constructor(private readonly appointmentRepo?: AppointmentRepository) {}

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
