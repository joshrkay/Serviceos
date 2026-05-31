import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput, Proposal } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence } from '../guardrails/confidence';
import { SlotConflictChecker, SlotConflictResult } from './slot-conflict-checker';
import { AvailabilityFinder, OpenSlot } from './availability-finder';
import { AppointmentRepository, createAppointment } from '../../appointments/appointment';
import { voiceHoldIdempotencyKey } from '../../voice/voice-audit';

/**
 * LLM-backed CreateAppointmentTaskHandler.
 *
 * Exists alongside the minimal CreateAppointmentTaskHandler in
 * `task-handlers.ts`. That one is for programmatic callers that already
 * have structured date/time fields. This one is for voice transcripts
 * where the operator says "next Tuesday at 2pm" and the LLM has to
 * turn that into an ISO datetime.
 *
 * Produces the same proposal type (`create_appointment`) so the
 * downstream CreateAppointmentExecutionHandler doesn't care which
 * task handler built the payload.
 *
 * P0-035: when a SlotConflictChecker is provided, the task calls it
 * BEFORE producing the proposal. On a conflict, the task swaps the
 * `create_appointment` proposal for a `voice_clarification` so the
 * dispatcher is asked to pick another time / technician (with the
 * conflicting appointment id surfaced for context) instead of
 * approving an already-broken appointment.
 */

const APPOINTMENT_SYSTEM_PROMPT = `You are an appointment scheduling assistant for a field service operating system.
Given a voice transcript from a field service operator, extract the appointment details.

Return valid JSON with this shape (no prose, no markdown fences):
{
  "customerName": "<string, optional>",
  "customerId": "<uuid, optional — only if explicitly known>",
  "jobId": "<uuid, optional — only if explicitly known>",
  "scheduledStart": "<ISO 8601 datetime, e.g. 2026-04-21T21:00:00Z>",
  "scheduledEnd": "<ISO 8601 datetime>",
  "summary": "<one-line description of the appointment>",
  "confidence_score": <number between 0 and 1>
}

Rules:
- Always return ISO 8601 UTC datetimes for scheduledStart and scheduledEnd.
- If the transcript says "next Tuesday at 2pm" assume the tenant's local
  timezone is America/Los_Angeles unless told otherwise, then convert to UTC.
- If no explicit end time is given, default the appointment to 1 hour.
- If the date is ambiguous, set confidence_score below 0.7.
- Never invent a customerId or jobId.`;

const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** A tentative hold survives 24h before the availability finder treats it as free. */
const HOLD_WINDOW_MS = 24 * 60 * 60 * 1000;

function isIsoDatetime(v: unknown): v is string {
  return typeof v === 'string' && ISO_DATETIME_REGEX.test(v);
}

function tryParseJson(content: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(content);
    return typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function buildPayload(parsed: Record<string, unknown> | null): Record<string, unknown> {
  if (!parsed) return {};
  const payload: Record<string, unknown> = {};

  if (typeof parsed.customerName === 'string') payload.customerName = parsed.customerName;
  if (typeof parsed.customerId === 'string') payload.customerId = parsed.customerId;
  if (typeof parsed.jobId === 'string') payload.jobId = parsed.jobId;
  if (typeof parsed.summary === 'string') payload.summary = parsed.summary;
  if (typeof parsed.technicianId === 'string') payload.technicianId = parsed.technicianId;

  // Strict ISO validation — refuse garbage dates rather than hand
  // them to the execution handler where they'd blow up at execute time.
  if (isIsoDatetime(parsed.scheduledStart)) payload.scheduledStart = parsed.scheduledStart;
  if (isIsoDatetime(parsed.scheduledEnd)) payload.scheduledEnd = parsed.scheduledEnd;

  return payload;
}

function buildClarificationProposal(
  context: TaskContext,
  conflict: Exclude<SlotConflictResult, { ok: true }>,
  proposedPayload: Record<string, unknown>,
  alternatives?: OpenSlot[]
): Proposal {
  const explanation = explanationForConflict(conflict, alternatives);
  const sourceContext: Record<string, unknown> = {
    source: 'voice',
    transcript: context.message,
    proposedAppointment: proposedPayload,
    conflict: serializeConflict(conflict),
    ...(alternatives && alternatives.length > 0
      ? {
          alternatives: alternatives.map((s) => ({
            start: s.start.toISOString(),
            end: s.end.toISOString(),
          })),
        }
      : {}),
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
  };

  // The voice_clarification payload schema is Tier 1 LOCKED — reuse
  // the existing reasons rather than invent a new one. 'missing_entities'
  // is the closest semantic match: the operator needs to provide a
  // different time or technician for the proposal to be valid.
  const payload: Record<string, unknown> = {
    transcript: context.message,
    reason: 'missing_entities',
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
  };

  const input: CreateProposalInput = {
    tenantId: context.tenantId,
    proposalType: 'voice_clarification',
    payload,
    summary: summaryForConflict(conflict),
    explanation,
    sourceContext,
    createdBy: context.userId,
    // Deliberately NO sourceTrustTier. A clarification is never
    // auto-approved — the operator must answer it explicitly.
  };

  return createProposal(input);
}

function summaryForConflict(
  conflict: Exclude<SlotConflictResult, { ok: true }>
): string {
  switch (conflict.conflict) {
    case 'technician_busy':
      return `Technician is already booked at that time (conflicts with appointment ${conflict.appointmentId})`;
    case 'customer_busy':
      return `Customer is already booked at that time (conflicts with appointment ${conflict.appointmentId})`;
    case 'could_not_verify':
      return `Could not verify availability — please confirm manually`;
  }
}

function explanationForConflict(
  conflict: Exclude<SlotConflictResult, { ok: true }>,
  alternatives?: OpenSlot[]
): string {
  const base = (() => {
    switch (conflict.conflict) {
      case 'technician_busy':
        return 'I drafted this appointment, but the proposed technician is already booked during that window. Please pick a different technician or another time.';
      case 'customer_busy':
        return 'I drafted this appointment, but the customer already has an appointment that overlaps that window. Please pick another time.';
      case 'could_not_verify':
        return "I couldn't verify availability for that slot — please confirm there's no conflict before approving.";
    }
  })();

  if (!alternatives || alternatives.length === 0) return base;

  const altList = alternatives
    .map((s) => `${s.start.toISOString()} – ${s.end.toISOString()}`)
    .join('; ');
  return `${base} Suggested alternative slot${alternatives.length === 1 ? '' : 's'}: ${altList}.`;
}

function serializeConflict(
  conflict: Exclude<SlotConflictResult, { ok: true }>
): Record<string, unknown> {
  if (conflict.conflict === 'could_not_verify') {
    return { type: 'could_not_verify', reason: conflict.reason };
  }
  return {
    type: conflict.conflict,
    appointmentId: conflict.appointmentId,
    conflictWindow: {
      start: conflict.conflictWindow.start.toISOString(),
      end: conflict.conflictWindow.end.toISOString(),
    },
  };
}

export class CreateAppointmentAITaskHandler implements TaskHandler {
  readonly taskType = 'create_appointment' as const;
  private readonly gateway: LLMGateway;
  private readonly slotConflictChecker?: SlotConflictChecker;
  private readonly availabilityFinder?: AvailabilityFinder;
  private readonly appointmentRepo?: AppointmentRepository;

  constructor(
    gateway: LLMGateway,
    slotConflictChecker?: SlotConflictChecker,
    availabilityFinder?: AvailabilityFinder,
    appointmentRepo?: AppointmentRepository
  ) {
    this.gateway = gateway;
    this.slotConflictChecker = slotConflictChecker;
    this.availabilityFinder = availabilityFinder;
    this.appointmentRepo = appointmentRepo;
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const llmResponse = await this.gateway.complete({
      taskType: 'create_appointment',
      messages: [
        { role: 'system', content: APPOINTMENT_SYSTEM_PROMPT },
        { role: 'user', content: this.buildUserMessage(context) },
      ],
      responseFormat: 'json',
    });

    const parsed = tryParseJson(llmResponse.content);
    const payload = buildPayload(parsed);

    // The LLM is instructed never to invent a customerId; the caller's
    // identity is resolved upstream (caller-ID match) and threaded on
    // the context. Prefer it over anything the model produced so the
    // booking is attributed to the verified caller.
    if (context.customerId) payload.customerId = context.customerId;

    const confidenceInput = parsed ?? {};
    const confidence = assessConfidence(confidenceInput);

    // P0-035: pre-check slot availability if the checker is wired AND
    // we have enough payload to ask the question. We need a customerId
    // and both ISO timestamps. If any of those are missing, fall back
    // to the original create_appointment behavior — the proposal will
    // still go to dispatcher review, who will catch the issue.
    const checker = this.slotConflictChecker;
    const customerId = typeof payload.customerId === 'string' ? payload.customerId : undefined;
    const scheduledStart = typeof payload.scheduledStart === 'string' ? payload.scheduledStart : undefined;
    const scheduledEnd = typeof payload.scheduledEnd === 'string' ? payload.scheduledEnd : undefined;
    const technicianId = typeof payload.technicianId === 'string' ? payload.technicianId : undefined;

    if (checker && customerId && scheduledStart && scheduledEnd) {
      const result = await checker.check({
        tenantId: context.tenantId,
        windowStart: new Date(scheduledStart),
        windowEnd: new Date(scheduledEnd),
        technicianId,
        customerId,
      });

      if (!result.ok) {
        // Per-tech filter is only safe when the conflict is the tech
        // being busy. For `customer_busy`, the conflicting appointment
        // is with a DIFFERENT tech — passing `technicianId` would let
        // the finder filter that appointment out and re-suggest the
        // very slot the customer is double-booked on. For
        // `could_not_verify`, drop the tech filter defensively (we
        // don't know what the underlying problem was).
        const altTechId =
          result.conflict === 'technician_busy' ? technicianId : undefined;
        const alternatives = await this.findAlternatives(
          context.tenantId,
          new Date(scheduledStart),
          new Date(scheduledEnd),
          altTechId
        );
        const proposal = buildClarificationProposal(context, result, payload, alternatives);
        return { proposal, taskType: 'voice_clarification' };
      }
    }

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload,
      summary: context.message,
      confidenceScore: confidence.score,
      confidenceFactors: confidence.factors,
      sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
      createdBy: context.userId,
      // Appointments are capture-class — schedule changes are reversible
      // and the undo window provides the human-in-the-loop check. See D3.
      sourceTrustTier: 'autonomous',
      // PR B — propagate tenant override from context.
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
    };

    // Held-slot booking path: when an appointmentRepo is wired AND the
    // LLM produced a complete booking (jobId + both timestamps), place
    // a tentative hold on the calendar up front and emit a
    // `create_booking` proposal that references it. The slot is
    // reserved immediately; approving the proposal confirms it,
    // rejecting it releases it. Without a repo, or with an incomplete
    // booking, fall through to the legacy create_appointment proposal.
    const repo = this.appointmentRepo;
    if (repo && typeof payload.jobId === 'string' && scheduledStart && scheduledEnd) {
      // Compute the hold expiry ONCE so the appointment's holdExpiryAt and
      // the proposal's expiresAt agree exactly (previously each used its own
      // Date.now(), drifting by however long createAppointment took).
      const holdExpiryAt = new Date(Date.now() + HOLD_WINDOW_MS);
      let held;
      try {
        held = await createAppointment(
          {
            tenantId: context.tenantId,
            jobId: payload.jobId,
            scheduledStart: new Date(scheduledStart),
            scheduledEnd: new Date(scheduledEnd),
            timezone: 'UTC',
            notes: typeof payload.summary === 'string' ? payload.summary : undefined,
            createdBy: context.userId,
            holdPendingApproval: true,
            holdExpiryAt,
            // Deterministic per-recording key: a redelivered voice message
            // returns the existing hold instead of inserting a second one
            // (closes the concurrent-redelivery double-booking window).
            ...(context.recordingId
              ? { idempotencyKey: voiceHoldIdempotencyKey(context.recordingId) }
              : {}),
          },
          repo,
        );
      } catch {
        // Repo error or validation failure — degrade to the legacy
        // create_appointment proposal rather than failing the call.
        return { proposal: createProposal(input), taskType: this.taskType };
      }
      const bookingInput: CreateProposalInput = {
        tenantId: context.tenantId,
        proposalType: 'create_booking',
        payload: { appointmentId: held.id },
        summary: context.message,
        confidenceScore: confidence.score,
        confidenceFactors: confidence.factors,
        sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
        createdBy: context.userId,
        sourceTrustTier: 'autonomous',
        expiresAt: holdExpiryAt,
        ...(context.tenantThresholdOverride
          ? { tenantThresholdOverride: context.tenantThresholdOverride }
          : {}),
      };
      return { proposal: createProposal(bookingInput), taskType: 'create_booking' };
    }

    return { proposal: createProposal(input), taskType: this.taskType };
  }

  private buildUserMessage(context: TaskContext): string {
    const parts: string[] = [];
    parts.push(`Transcript: ${context.message}`);
    if (context.existingEntities && Object.keys(context.existingEntities).length > 0) {
      parts.push(`Known entities: ${JSON.stringify(context.existingEntities)}`);
    }
    return parts.join('\n');
  }

  /**
   * Look up alternative open slots when the proposed time conflicts.
   * Failure-open: any error returns `undefined`, and the clarification
   * proposal falls back to the no-alternatives wording. Search window
   * spans from the conflicted slot's start through the end of the next
   * day, which covers same-day reschedules and "first thing tomorrow"
   * without scanning the full calendar.
   */
  private async findAlternatives(
    tenantId: string,
    proposedStart: Date,
    proposedEnd: Date,
    technicianId: string | undefined
  ): Promise<OpenSlot[] | undefined> {
    const finder = this.availabilityFinder;
    if (!finder) return undefined;

    const durationMs = proposedEnd.getTime() - proposedStart.getTime();
    if (durationMs <= 0) return undefined;

    // 36h is enough to catch "later today" + "first thing tomorrow"
    // without an unreasonably large repo scan.
    const SEARCH_WINDOW_MS = 36 * 60 * 60 * 1000;
    const searchTo = new Date(proposedStart.getTime() + SEARCH_WINDOW_MS);

    try {
      const result = await finder.find({
        tenantId,
        searchFrom: proposedStart,
        searchTo,
        durationMs,
        technicianId,
        count: 3,
      });
      if (!result.ok) return undefined;
      return result.slots.length > 0 ? result.slots : undefined;
    } catch {
      return undefined;
    }
  }
}

export { APPOINTMENT_SYSTEM_PROMPT, isIsoDatetime, buildPayload };
