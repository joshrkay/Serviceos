import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput, Proposal } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence, getConfidenceLevel } from '../guardrails/confidence';
import type { ProposalConfidenceMeta } from '../../proposals/contracts';
import { SlotConflictChecker, SlotConflictResult } from './slot-conflict-checker';
import { AvailabilityFinder, OpenSlot } from './availability-finder';
import { AppointmentRepository } from '../../appointments/appointment';
import { JobRepository } from '../../jobs/job';
import { placeAppointmentHold } from '../scheduling/place-hold';
import {
  resolveDateTime,
  formatForReadback,
  formatTimeForReadback,
  DEFAULT_TENANT_TIMEZONE,
  ResolveDateTimeFailureReason,
} from '../scheduling/resolve-datetime';
import { voiceHoldIdempotencyKey } from '../../voice/voice-audit';
import { appointmentTypeSchema, type AppointmentTypeValue } from '@ai-service-os/shared';
import {
  buildStandingInstructionsSection,
  intersectAppliedStandingInstructions,
} from '../standing-instructions-context';
import {
  evaluateAutonomousBookingLane,
  autonomousLaneStamp,
  type AutonomousLaneEvaluation,
} from '../../proposals/autonomous-lane';
import { checkBusinessHours } from '../../compliance/business-hours';
import { parseOnboardingBusinessHours } from '../../telephony/business-hours-loader';

/**
 * LLM-backed CreateAppointmentTaskHandler.
 *
 * Exists alongside the minimal CreateAppointmentTaskHandler in
 * `task-handlers.ts`. That one is for programmatic callers that already
 * have structured date/time fields. This one is for voice transcripts
 * where the caller says "next Tuesday at 2pm".
 *
 * HYBRID date resolution (P0 correctness fix). The LLM ONLY extracts the
 * verbatim date/time phrase plus ancillary fields — it does NO timezone or
 * calendar math. `resolveDateTime` then deterministically translates that
 * phrase into a UTC window using the TENANT's timezone (threaded on the
 * context, no longer hardcoded to America/Los_Angeles) and the current
 * instant. Ambiguous phrases ("sometime Tuesday") and invalid results
 * (past times, inverted ranges) become a `voice_clarification` instead of
 * a silently mis-booked appointment.
 *
 * Produces the same proposal type (`create_appointment`) so the downstream
 * CreateAppointmentExecutionHandler doesn't care which task handler built
 * the payload.
 *
 * P0-035: when a SlotConflictChecker is provided, the task calls it BEFORE
 * producing the proposal. On a conflict, the task swaps the
 * `create_appointment` proposal for a `voice_clarification` so the
 * dispatcher is asked to pick another time / technician.
 */

const APPOINTMENT_SYSTEM_PROMPT = `You extract appointment details from a field service voice transcript.

Return valid JSON with this shape (no prose, no markdown fences):
{
  "dateTimePhrase": "<the date/time phrase EXACTLY as spoken, e.g. 'next Tuesday at 2pm' or 'tomorrow morning'>",
  "customerName": "<string, optional>",
  "customerId": "<uuid, optional — only if explicitly known>",
  "jobId": "<uuid, optional — only if explicitly known>",
  "summary": "<one-line description of the work requested>",
  "appointmentType": "<optional — one of: estimate, repair, install, maintenance, diagnostic>",
  "durationMinutes": <integer, optional — estimated job length if stated or clearly implied by the service>,
  "confidence_score": <number between 0 and 1>
}

Rules:
- Copy the date/time phrase VERBATIM into dateTimePhrase. Do NOT convert it to a
  date, do NOT compute a timezone, do NOT output an ISO timestamp. Downstream
  code resolves the actual time against the tenant's timezone.
- If the transcript mentions no date or time at all, set dateTimePhrase to "".
- appointmentType is the KIND of visit: estimate (a quote/estimate visit), repair,
  install, maintenance, or diagnostic. Choose the closest fit from that set, or
  omit it entirely when the kind isn't clear. Never output a value outside that
  set ("emergency" is urgency, not a type).
- durationMinutes is a hint only (e.g. a quick diagnostic ~60, a furnace install ~240).
- Never invent a customerId or jobId.`;

/** A tentative hold survives 24h before the availability finder treats it as free. */
const HOLD_WINDOW_MS = 24 * 60 * 60 * 1000;

function tryParseJson(content: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(content);
    return typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Extract the non-date fields the LLM returned into a proposal payload. */
function buildPayload(parsed: Record<string, unknown> | null): Record<string, unknown> {
  if (!parsed) return {};
  const payload: Record<string, unknown> = {};
  if (typeof parsed.customerName === 'string') payload.customerName = parsed.customerName;
  if (typeof parsed.customerId === 'string') payload.customerId = parsed.customerId;
  if (typeof parsed.jobId === 'string') payload.jobId = parsed.jobId;
  if (typeof parsed.summary === 'string') payload.summary = parsed.summary;
  if (typeof parsed.technicianId === 'string') payload.technicianId = parsed.technicianId;
  // Typed visit kind — only forward a value the enum allows; never trust a raw
  // LLM string (an out-of-set or hallucinated kind is dropped, not persisted).
  if (
    typeof parsed.appointmentType === 'string' &&
    appointmentTypeSchema.safeParse(parsed.appointmentType).success
  ) {
    payload.appointmentType = parsed.appointmentType;
  }
  return payload;
}

/** Pull the verbatim date/time phrase from the LLM output or the classifier entities. */
function extractDateTimePhrase(
  parsed: Record<string, unknown> | null,
  context: TaskContext,
): string {
  if (parsed && typeof parsed.dateTimePhrase === 'string' && parsed.dateTimePhrase.trim()) {
    return parsed.dateTimePhrase.trim();
  }
  const ee = context.existingEntities;
  if (ee && typeof ee.dateTimeDescription === 'string' && ee.dateTimeDescription.trim()) {
    return ee.dateTimeDescription.trim();
  }
  // Last resort: let the resolver try the whole utterance.
  return context.message ?? '';
}

function durationHint(parsed: Record<string, unknown> | null): number | undefined {
  if (parsed && typeof parsed.durationMinutes === 'number' && parsed.durationMinutes > 0) {
    return parsed.durationMinutes;
  }
  return undefined;
}

/**
 * Build a human-readable appointment summary in the tenant timezone. This
 * is what the dispatcher review card shows AND what the TTS read-back
 * speaks — so the operator/caller hears the RESOLVED time, not the raw
 * transcript (the industry safeguard against mis-bookings).
 */
function buildResolvedSummary(
  work: string | undefined,
  startUtc: string,
  timezone: string,
  arrival?: { startUtc: string; endUtc: string },
): string {
  const when = formatForReadback(startUtc, timezone);
  const window = arrival
    ? ` (arrival window ${formatTimeForReadback(arrival.startUtc, timezone)}–${formatTimeForReadback(arrival.endUtc, timezone)})`
    : '';
  const what = work && work.trim() ? `${work.trim()} — ` : 'Appointment — ';
  return `${what}${when}${window}`;
}

const CLARIFICATION_MESSAGES: Record<ResolveDateTimeFailureReason, string> = {
  empty: "I didn't catch a day or time for the appointment. When would you like to be scheduled?",
  unparseable: "I couldn't make out the day and time. Could you say the date and time again?",
  ambiguous_no_time: 'What time of day works for that date — morning, afternoon, or a specific time?',
  in_past: 'That time has already passed. What upcoming day and time would you like?',
  inverted: 'The end time was before the start time. Could you give the start time and how long it should take?',
  implausible: "I couldn't pin down a valid time. Could you say the date and time again?",
};

/**
 * Emit a clarification when the spoken time can't be resolved. Reuses the
 * Tier-1-LOCKED voice_clarification 'missing_entities' reason (the operator
 * must supply a usable time before anything is booked).
 */
function buildTimeClarificationProposal(
  context: TaskContext,
  reason: ResolveDateTimeFailureReason,
  phrase: string,
): Proposal {
  const explanation = CLARIFICATION_MESSAGES[reason];
  const sourceContext: Record<string, unknown> = {
    source: 'voice',
    transcript: context.message,
    reason: `unresolved_datetime:${reason}`,
    ...(phrase ? { phrase } : {}),
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
  };
  const payload: Record<string, unknown> = {
    transcript: context.message,
    reason: 'missing_entities',
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
  };
  return createProposal({
    tenantId: context.tenantId,
    proposalType: 'voice_clarification',
    payload,
    summary: explanation,
    explanation,
    sourceContext,
    createdBy: context.userId,
    // A clarification is never auto-approved — no sourceTrustTier.
  });
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
  private readonly jobRepo?: JobRepository;

  constructor(
    gateway: LLMGateway,
    slotConflictChecker?: SlotConflictChecker,
    availabilityFinder?: AvailabilityFinder,
    appointmentRepo?: AppointmentRepository,
    jobRepo?: JobRepository
  ) {
    this.gateway = gateway;
    this.slotConflictChecker = slotConflictChecker;
    this.availabilityFinder = availabilityFinder;
    this.appointmentRepo = appointmentRepo;
    this.jobRepo = jobRepo;
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const timezone = context.timezone ?? DEFAULT_TENANT_TIMEZONE;
    const now = context.now ?? new Date();

    // UB-A3 — owner standing instructions ride a SEPARATE, delimited system
    // message (mirroring the classifier's vertical-context injection) so the
    // base prompt stays byte-identical when none apply. Content-only: the
    // section itself forbids approval/confidence/schema/pricing overrides.
    const systemMessages: Array<{ role: 'system'; content: string }> = [
      { role: 'system', content: APPOINTMENT_SYSTEM_PROMPT },
    ];
    const injectedInstructions = context.standingInstructions ?? [];
    if (injectedInstructions.length > 0) {
      systemMessages.push({
        role: 'system',
        content: buildStandingInstructionsSection(injectedInstructions, {
          requestAppliedIds: true,
        }),
      });
    }

    const llmResponse = await this.gateway.complete({
      taskType: 'create_appointment',
      // Top-level tenantId so the gateway keys this tenant's concurrency
      // quota / cache bucket correctly (never the shared SYSTEM_TENANT_ID).
      tenantId: context.tenantId,
      messages: [...systemMessages, { role: 'user', content: this.buildUserMessage(context) }],
      responseFormat: 'json',
    });

    const parsed = tryParseJson(llmResponse.content);
    const payload = buildPayload(parsed);

    // HYBRID resolution: the LLM only extracted the verbatim phrase; we
    // resolve it deterministically against the tenant timezone + now.
    const phrase = extractDateTimePhrase(parsed, context);
    const resolved = resolveDateTime(phrase, {
      timezone,
      now,
      defaultDurationMin: durationHint(parsed),
    });

    if (!resolved.ok) {
      // Couldn't pin down a valid time — ask rather than mis-book.
      return {
        proposal: buildTimeClarificationProposal(context, resolved.reason, phrase),
        taskType: 'voice_clarification',
      };
    }

    payload.scheduledStart = resolved.startUtc;
    payload.scheduledEnd = resolved.endUtc;
    payload.timezone = resolved.timezone;
    if (resolved.arrivalWindowStartUtc && resolved.arrivalWindowEndUtc) {
      payload.arrivalWindowStart = resolved.arrivalWindowStartUtc;
      payload.arrivalWindowEnd = resolved.arrivalWindowEndUtc;
    }

    // The LLM is instructed never to invent a customerId; the caller's
    // identity is resolved upstream (caller-ID match) and threaded on
    // the context. Prefer it over anything the model produced so the
    // booking is attributed to the verified caller.
    if (context.customerId) payload.customerId = context.customerId;

    const confidenceInput = parsed ?? {};
    const confidence = assessConfidence(confidenceInput);

    // RV-007 — Confidence Marker `_meta`: the task confidence score
    // mapped onto the shared level vocabulary. This handler has no
    // per-field certainty signal, so overall-only is correct.
    // UB-A3 — applied-instruction marker: the model's claimed ids are
    // INTERSECTED with what was injected (never trust invented ids) and the
    // field is dropped entirely when empty. The held-slot create_booking
    // path below reuses this same meta object, so the marker rides both.
    const appliedStandingInstructions = intersectAppliedStandingInstructions(
      parsed?.appliedStandingInstructions,
      injectedInstructions,
    );
    const meta: ProposalConfidenceMeta = {
      overallConfidence: getConfidenceLevel(confidence.score),
      ...(appliedStandingInstructions.length > 0 ? { appliedStandingInstructions } : {}),
    };
    payload._meta = meta;

    // The dispatcher card / TTS read-back must show the RESOLVED time, not
    // the raw transcript, so the human approving it can catch a misparse.
    const arrival =
      resolved.arrivalWindowStartUtc && resolved.arrivalWindowEndUtc
        ? { startUtc: resolved.arrivalWindowStartUtc, endUtc: resolved.arrivalWindowEndUtc }
        : undefined;
    const summary = buildResolvedSummary(
      typeof payload.summary === 'string' ? payload.summary : undefined,
      resolved.startUtc,
      resolved.timezone,
      arrival,
    );

    // P0-035: pre-check slot availability if the checker is wired AND
    // we have enough payload to ask the question. We need a customerId
    // and both ISO timestamps.
    const checker = this.slotConflictChecker;
    const customerId = typeof payload.customerId === 'string' ? payload.customerId : undefined;
    const scheduledStart = resolved.startUtc;
    const scheduledEnd = resolved.endUtc;
    const technicianId = typeof payload.technicianId === 'string' ? payload.technicianId : undefined;

    if (checker && customerId) {
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
        // is with a DIFFERENT tech.
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
      summary,
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
      // Phase 12 — forward supervisor presence so an unsupervised tenant's
      // booking lands in review instead of auto-approving (the autonomous
      // trust tier above is only honored when a supervisor is present).
      ...(context.supervisorPresent !== undefined
        ? { supervisorPresent: context.supervisorPresent }
        : {}),
      ...(context.supervisorMode ? { supervisorMode: context.supervisorMode } : {}),
    };

    // Held-slot booking path: when an appointmentRepo is wired AND the
    // LLM produced a complete booking (jobId + both timestamps), place
    // a tentative hold on the calendar up front and emit a
    // `create_booking` proposal that references it.
    const repo = this.appointmentRepo;
    if (repo && typeof payload.jobId === 'string') {
      // The jobId is LLM-extracted from untrusted transcript text. Before
      // writing a real (held) appointment row against it, confirm it belongs to
      // the verified caller — otherwise an injected/guessed id could place a
      // hold on another customer's job and pollute their calendar for the 24h
      // hold window. Mirrors the appointment→job→customer ownership check the
      // reschedule/cancel handlers already perform.
      //
      // When a jobRepo is wired we CAN verify ownership, so we MUST: the held
      // write only proceeds for an identified caller (context.customerId) whose
      // jobId is a well-formed UUID that resolves to a job they own. An
      // unidentified caller, a malformed id, or someone else's job degrades to
      // the approval-gated create_appointment proposal rather than writing a
      // hold against an unverified job. (No jobRepo → cannot check → the legacy
      // held path is unchanged.)
      // Fallback for every case where we cannot positively attribute the
      // LLM-supplied jobId to the verified caller. It MUST NOT auto-execute:
      // `input` carries sourceTrustTier:'autonomous', so for a supervised,
      // high-confidence tenant the create_appointment would auto-approve and
      // CreateAppointmentExecutionHandler (which only checks jobId is a string)
      // would book against the unverified job. Dropping the trust tier lands it
      // in 'draft' so a human reviews the booking first.
      const reviewGatedFallback = (): TaskResult => ({
        proposal: createProposal({ ...input, sourceTrustTier: undefined }),
        taskType: this.taskType,
      });
      // WS18 — the ownership guard + tentative-hold write now live in the shared
      // placeAppointmentHold helper (ai/scheduling/place-hold.ts) so the live
      // call close flow places the identical hold. Behavior-preserving.
      const holdResult = await placeAppointmentHold(
        {
          appointmentRepo: repo,
          ...(this.jobRepo ? { jobRepo: this.jobRepo } : {}),
        },
        {
          tenantId: context.tenantId,
          jobId: payload.jobId,
          ...(context.customerId ? { customerId: context.customerId } : {}),
          scheduledStart: new Date(scheduledStart),
          scheduledEnd: new Date(scheduledEnd),
          // FIX: persist the tenant's real display timezone, not 'UTC'.
          timezone: resolved.timezone,
          ...(arrival ? { arrival } : {}),
          ...(typeof payload.summary === 'string' ? { notes: payload.summary } : {}),
          // buildPayload only sets appointmentType to an enum-valid value.
          ...(payload.appointmentType
            ? { appointmentType: payload.appointmentType as AppointmentTypeValue }
            : {}),
          createdBy: context.userId,
          holdWindowMs: HOLD_WINDOW_MS,
          // Deterministic per-recording key: a redelivered voice message returns
          // the existing hold instead of inserting a second one.
          ...(context.recordingId
            ? { idempotencyKey: voiceHoldIdempotencyKey(context.recordingId) }
            : {}),
        },
      );
      if (!holdResult.ok) {
        // job_not_owned → the review-gated create_appointment (unverified job,
        // reachable only with a jobRepo wired); hold_write_failed → the legacy
        // create_appointment (repo/validation error), rather than failing the call.
        return holdResult.failed === 'job_not_owned'
          ? reviewGatedFallback()
          : { proposal: createProposal(input), taskType: this.taskType };
      }
      const holdExpiryAt = holdResult.holdExpiryAt;
      // Same confidence marker as the create_appointment payload — the booking
      // proposal can auto-approve on the same score.
      const bookingPayload: Record<string, unknown> = {
        appointmentId: holdResult.appointmentId,
        _meta: meta,
      };

      // UB-D / D-015 — autonomous booking lane. When the entry-point threaded
      // lane inputs, evaluate EVERY gate against the real values from the
      // hold just placed. BOTH outcomes are stamped on sourceContext (audit
      // trail: why a booking did or did not take the lane); the evaluation is
      // handed to createProposal ONLY when eligible, where
      // decideInitialStatus consults it solely inside the unsupervised
      // autonomous+capture branch. No lane inputs ⇒ byte-identical behavior.
      let laneEvaluation: AutonomousLaneEvaluation | undefined;
      if (context.autonomousBooking) {
        // No configured hours parses to null and checkBusinessHours fails
        // OPEN ('no_schedule_configured') — absence of configuration is not
        // a lane blocker (D-015).
        const slotWithinBusinessHours = checkBusinessHours(
          parseOnboardingBusinessHours(context.businessHours, resolved.timezone),
          new Date(scheduledStart),
        ).isOpen;
        laneEvaluation = evaluateAutonomousBookingLane({
          platformDisabled: context.autonomousBooking.platformDisabled,
          settings: context.autonomousBooking.settings,
          proposalType: 'create_booking',
          inboundReceptionistSource: context.autonomousBooking.inboundReceptionistSource,
          confidenceScore: confidence.score,
          payload: bookingPayload,
          pendingReferenceCount: context.autonomousBooking.pendingReferenceCount,
          customerId: context.customerId,
          holdPlaced: true,
          holdExpiryAt,
          now: context.now ?? new Date(),
          slotWithinBusinessHours,
          // No vulnerability/emergency/negotiation signal exists on this
          // recorded-transcript path — those flags ride live-call sessions
          // (the FSM call site, a later PR).
          flags: {},
        });
      }
      const laneStamp = laneEvaluation ? autonomousLaneStamp(laneEvaluation) : undefined;
      const bookingSourceContext =
        context.conversationId || laneStamp
          ? {
              ...(context.conversationId ? { conversationId: context.conversationId } : {}),
              ...(laneStamp ?? {}),
            }
          : undefined;

      const bookingInput: CreateProposalInput = {
        tenantId: context.tenantId,
        proposalType: 'create_booking',
        payload: bookingPayload,
        summary,
        confidenceScore: confidence.score,
        confidenceFactors: confidence.factors,
        sourceContext: bookingSourceContext,
        createdBy: context.userId,
        sourceTrustTier: 'autonomous',
        expiresAt: holdExpiryAt,
        ...(context.tenantThresholdOverride
          ? { tenantThresholdOverride: context.tenantThresholdOverride }
          : {}),
        // Phase 12 — same supervisor gate as the create_appointment path.
        ...(context.supervisorPresent !== undefined
          ? { supervisorPresent: context.supervisorPresent }
          : {}),
        ...(context.supervisorMode ? { supervisorMode: context.supervisorMode } : {}),
        // UB-D — the lane result reaches decideInitialStatus ONLY when every
        // gate passed; ineligible evaluations ride the sourceContext stamp
        // alone.
        ...(laneEvaluation?.eligible ? { autonomousLane: laneEvaluation } : {}),
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
   * Failure-open: any error returns `undefined`.
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

export { APPOINTMENT_SYSTEM_PROMPT, buildPayload };
