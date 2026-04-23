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

function entitiesFrom(context: TaskContext): ExtractedEntities {
  return (context.existingEntities ?? {}) as ExtractedEntities;
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

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    if (ee.appointmentReference) payload.appointmentReference = ee.appointmentReference;
    else missing.push('appointmentId');

    if (ee.newDateTimeDescription) {
      payload.newDateTimeDescription = ee.newDateTimeDescription;
    }
    // ISO fields are not derived here — flagged as missing so the
    // review UI fills them from the natural-language description.
    missing.push('newScheduledStart', 'newScheduledEnd');

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── cancel_appointment ─────────────
//
// Cancellation is irreversible (action class = 'irreversible'). Even
// if every field is filled, the D3 rules keep it in 'draft' — the
// operator always screen-taps.
export class CancelAppointmentTaskHandler implements TaskHandler {
  readonly taskType = 'cancel_appointment' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {
      cancellationType: ee.cancellationType ?? 'other',
    };
    const missing: string[] = [];

    if (ee.appointmentReference) payload.appointmentReference = ee.appointmentReference;
    else missing.push('appointmentId');

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
