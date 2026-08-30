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
  ResolveDateTimeFailureReason,
} from '../scheduling/resolve-datetime';
import { voiceHoldIdempotencyKey } from '../../voice/voice-audit';
import { isRuntimeTimezone } from '../../shared/timezone';
import type { LocationRepository } from '../../locations/location';
import type { CustomerRepository } from '../../customers/customer';
import {
  appointmentTypeSchema,
  type AppointmentTypeValue,
  parseSpokenAddressParts,
  formatStructuredAddress,
  REQUIRED_LOCATION_FIELDS,
} from '@ai-service-os/shared';
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
 * NO DEFAULT TIMEZONE (2026-07-28). This handler used to read
 * `context.timezone ?? DEFAULT_TENANT_TIMEZONE`, i.e. it silently booked
 * every tenant whose entry point failed to resolve a zone at
 * `America/New_York`. An operator in `America/Phoenix` had every spoken
 * booking landed three hours early — "Friday morning" became 5:00 AM — and
 * because these proposals arrive at confidence 1 on the autonomous capture
 * lane, they auto-approved and executed with no human ever seeing them.
 *
 * A default zone is unfixable-by-inspection: a US-East timestamp is a
 * perfectly plausible value, so nothing downstream can tell a resolved
 * Eastern tenant from an unresolved one. The zone is therefore REQUIRED
 * input now. When the entry point cannot resolve one from
 * `tenant_settings.timezone`, this handler emits a `voice_clarification`
 * (which carries the transcript verbatim and can never auto-approve)
 * rather than guessing. Nothing spoken is lost; nothing wrong is booked.
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

// Round 4b (sweep row A33) — mirrors job-edit-task.ts's `isUuid` /
// `resolvedJobIdFrom` and LogExpenseTaskHandler's log_mileage jobId handling
// (voice-extended-tasks.ts): a classifier/LLM-extracted reference is free
// text ("the QA Sweep Furnace Inspection job") in the overwhelming case, but
// may already BE the resolved id.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * The job id the ROUTER's entity resolver already resolved for this turn, if
 * any. `schedule_inspection` (the classifier intent this handler drafts
 * `create_appointment` for via `CHAT_INTENT_TO_REGISTRY_KEY`'s alias entry)
 * is a `JOB_REF_INTENTS` member (ai/agents/customer-calling/entity-
 * resolution.ts) BECAUSE naming an existing job ("for the QA Sweep Furnace
 * Inspection job") is exactly what it does — so routes/assistant.ts's
 * pre-draft `resolveVerifiedIdsForDraft` already tried to resolve that
 * reference to a real jobId before this handler ever ran. A hit lands on
 * `existingEntities.jobId`.
 *
 * Shape-checked only (no second repo round-trip): the router's resolver is
 * itself a DB lookup, so a value here is trustworthy by construction —
 * exactly the same seam LogExpenseTaskHandler's log_mileage branch consumes.
 */
function resolvedJobIdFrom(context: TaskContext): string | undefined {
  const id = context.existingEntities?.jobId;
  return isUuid(id) ? id : undefined;
}

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

/**
 * Emit a clarification when the TENANT's timezone could not be resolved.
 *
 * Distinct from the unresolved-datetime clarification above: nothing is wrong
 * with what was said, so the message is aimed at the operator (fix the
 * business timezone in Settings) rather than asking the caller to repeat a
 * time they already gave clearly. The transcript rides `sourceContext` and
 * `payload.transcript` verbatim, so re-saying the booking after setting the
 * zone costs one tap, not a re-dictation.
 *
 * `voice_clarification` carries no `sourceTrustTier`, so this can never
 * auto-approve — which is the entire point. Booking at a guessed zone is the
 * one outcome that is worse than not booking.
 */
function buildTimezoneClarificationProposal(context: TaskContext): Proposal {
  const explanation =
    "I can't schedule this yet — this business has no time zone set, so I don't know what " +
    'time was actually meant. Set the business time zone in Settings, then say the booking ' +
    'again and I\'ll put it on the calendar.';
  const sourceContext: Record<string, unknown> = {
    source: 'voice',
    transcript: context.message,
    reason: 'tenant_timezone_unconfigured',
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
    summary: 'Cannot book — the business time zone is not set',
    explanation,
    sourceContext,
    createdBy: context.userId,
    // No sourceTrustTier — a clarification is never auto-approved.
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

/** Repos the draft-time bookability check needs. Both optional-by-absence. */
export interface ServiceLocationGapDeps {
  locationRepo?: Pick<LocationRepository, 'findByCustomer'>;
  /** Reads `communication_notes`, where an incomplete spoken address is preserved. */
  customerRepo?: Pick<CustomerRepository, 'findById'>;
}

/**
 * What the review card needs to close a missing-service-location gap without
 * anyone opening a database client. Rides `sourceContext.serviceLocationGap`.
 */
export interface ServiceLocationGap {
  customerId: string;
  /** The preserved address text, verbatim, when one is recoverable. */
  recoveredAddress?: string;
  /** Where it was recovered from — for the card's provenance line. */
  recoveredFrom?: 'communication_notes' | 'transcript';
  /** Best-effort structured prefill for the card's address inputs. */
  prefill?: Record<string, string>;
  /** Required `service_locations` columns still empty after parsing. */
  stillMissing?: string[];
}

/**
 * `jobs.location_id` is NOT NULL, so a customer with no `service_locations`
 * row cannot have a job created — and therefore cannot have an appointment.
 * `CreateAppointmentExecutionHandler` discovers this at EXECUTION time and
 * returns "Customer has no service location — add one before booking a new
 * job". On the autonomous capture lane that failure is terminal and invisible:
 * the proposal auto-approved at confidence 1, executed, and failed, with the
 * spoken booking left nowhere.
 *
 * Detecting the same condition at DRAFT time turns a guaranteed execution
 * failure into a reviewable gap. The caller stamps `missingFields:
 * ['locationId']`, which `decideInitialStatus` turns into 'draft' — so the
 * proposal can never auto-approve into the failure — and `approveProposal`
 * blocks until the field is filled. `editProposal` +
 * `clearSatisfiedMissingFields` is the existing, tested unblock path.
 *
 * Deliberately mirrors the executor's precondition EXACTLY: the location is
 * only required when the executor must AUTO-OPEN a job (no `jobId` /
 * `linkedJobId`) against a known `customerId`. A booking against an existing
 * job already has a location, so that path is untouched.
 *
 * Failure-soft: any repo error returns `undefined` (no gate). A lookup hiccup
 * must not block a booking that would have succeeded.
 */
export async function detectServiceLocationGap(
  deps: ServiceLocationGapDeps | undefined,
  args: { tenantId: string; customerId: string; transcript?: string },
): Promise<ServiceLocationGap | undefined> {
  const locationRepo = deps?.locationRepo;
  if (!locationRepo) return undefined;

  try {
    const locations = await locationRepo.findByCustomer(args.tenantId, args.customerId);
    // Same predicate the executor uses to pick a location: any non-archived
    // row makes the customer bookable.
    if (locations.some((loc) => !loc.isArchived)) return undefined;
  } catch {
    return undefined;
  }

  const gap: ServiceLocationGap = { customerId: args.customerId };

  // The address the voice path preserved rather than discarded. `customers
  // .communication_notes` is where CreateCustomerExecutionHandler writes an
  // address too incomplete to become a service_location (see
  // `unstructuredAddressNote`), so it is the first place to look.
  let recovered: string | undefined;
  try {
    const customer = await deps?.customerRepo?.findById(args.tenantId, args.customerId);
    recovered = extractPreservedAddress(customer?.communicationNotes);
    if (recovered) gap.recoveredFrom = 'communication_notes';
  } catch {
    recovered = undefined;
  }

  // Ashia's case: created before the address fix shipped, so nothing was
  // preserved on the customer at all. The utterance that is booking her now
  // is the last place an address can still be read from.
  if (!recovered && args.transcript) {
    const fromTranscript = parseSpokenAddressParts(args.transcript);
    if (fromTranscript.street1) {
      recovered = formatStructuredAddress(fromTranscript);
      gap.recoveredFrom = 'transcript';
    }
  }

  if (recovered) {
    gap.recoveredAddress = recovered;
    const parts = parseSpokenAddressParts(recovered);
    if (Object.keys(parts).length > 0) gap.prefill = { ...parts } as Record<string, string>;
    const stillMissing = REQUIRED_LOCATION_FIELDS.filter((f) => !parts[f]);
    if (stillMissing.length > 0) gap.stillMissing = [...stillMissing];
  }

  return gap;
}

/**
 * Pull the address back out of the note `unstructuredAddressNote` wrote:
 *   Address from voice: "1207 Riverbell Drive". Saved as a note, not a
 *   service location — still needs city, state, ZIP.
 *
 * Matched against that exact producer format (create-customer-handler.ts) so
 * the two stay coupled. Returns undefined for notes that aren't address notes.
 */
export function extractPreservedAddress(notes: string | undefined): string | undefined {
  if (typeof notes !== 'string' || notes.length === 0) return undefined;
  const m = /Address from voice:\s*"([^"]+)"/.exec(notes);
  const value = m?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export class CreateAppointmentAITaskHandler implements TaskHandler {
  readonly taskType = 'create_appointment' as const;
  private readonly gateway: LLMGateway;
  private readonly slotConflictChecker?: SlotConflictChecker;
  private readonly availabilityFinder?: AvailabilityFinder;
  private readonly appointmentRepo?: AppointmentRepository;
  private readonly jobRepo?: JobRepository;
  private readonly bookabilityRepos?: ServiceLocationGapDeps;

  constructor(
    gateway: LLMGateway,
    slotConflictChecker?: SlotConflictChecker,
    availabilityFinder?: AvailabilityFinder,
    appointmentRepo?: AppointmentRepository,
    jobRepo?: JobRepository,
    /**
     * Draft-time bookability check — see `detectServiceLocationGap`. Optional:
     * absent ⇒ no gate, byte-identical to the pre-gate handler.
     */
    bookabilityRepos?: ServiceLocationGapDeps,
  ) {
    this.gateway = gateway;
    this.slotConflictChecker = slotConflictChecker;
    this.availabilityFinder = availabilityFinder;
    this.appointmentRepo = appointmentRepo;
    this.jobRepo = jobRepo;
    this.bookabilityRepos = bookabilityRepos;
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    // REQUIRED input — see the "NO DEFAULT TIMEZONE" note in the class doc
    // above. The entry point resolves this from `tenant_settings.timezone`;
    // an unresolvable zone gates the booking instead of guessing one.
    const timezone = typeof context.timezone === 'string' ? context.timezone.trim() : '';
    // A garbage zone takes the SAME gate as a missing one. `resolveDateTime`
    // would otherwise fall back to the product default internally — the same
    // silent-US-East guess, one layer down.
    if (!timezone || !isRuntimeTimezone(timezone)) {
      return {
        proposal: buildTimezoneClarificationProposal(context),
        taskType: 'voice_clarification',
      };
    }
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

    // Round 4b (sweep row A33) — jobId verify-or-gate. Precedence: the
    // ROUTER-resolved id (a repo lookup — see resolvedJobIdFrom) always wins
    // over whatever this handler's OWN internal drafting LLM call put in
    // `parsed.jobId`. Without this, the only way a resolver-verified jobId
    // could ever reach the payload was the model choosing to echo it back
    // from the "Known entities" JSON blob in `buildUserMessage` — and on
    // the live sweep the model instead echoed the SPOKEN JOB NAME verbatim
    // into `jobId` ("QA Sweep Furnace Inspection" — a title, not a uuid,
    // despite the system prompt's "never invent a jobId"). That payload
    // previously validated fine (nothing in this handler checked its
    // shape), reached execution unmodified, and died on Postgres's
    // `invalid input syntax for type uuid`. A drafting leg that depends on
    // a model repeating a UUID is not resolution (mirrors job-edit-task.ts's
    // `resolveJobIdGate` doc comment).
    const missingFields: string[] = [];
    let verifiedJobId: string | undefined;
    const routedJobId = resolvedJobIdFrom(context);
    if (routedJobId) {
      payload.jobId = routedJobId;
      verifiedJobId = routedJobId;
    } else if (typeof payload.jobId === 'string' && !isUuid(payload.jobId)) {
      // Never a valid execution target — CreateAppointmentExecutionHandler
      // and place-hold.ts's ownership guard both require a real uuid.
      // Preserve the text as the reference the post-draft resolver reads
      // (`GATED_REFERENCE_SOURCES.jobId.payloadFields`,
      // ai/resolution/gated-reference-resolution.ts) instead of letting a
      // malformed id ride an approvable payload — #909 doctrine: an
      // unresolved reference becomes a gate with a resolver behind it,
      // never a malformed approvable payload.
      if (!payload.jobReference) payload.jobReference = payload.jobId;
      delete payload.jobId;
      missingFields.push('jobId');
    }

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

    // Draft-time bookability. `jobs.location_id` is NOT NULL, so booking a
    // customer with no `service_locations` row is a GUARANTEED execution
    // failure ("Customer has no service location — add one before booking a
    // new job"). Detect it here so the proposal carries the gap as
    // `missingFields` and lands in 'draft' instead of auto-approving into
    // that failure. Only checked on the branch the executor actually needs a
    // location for: no jobId/linkedJobId (it must auto-open a job) and a
    // known customerId. See `detectServiceLocationGap`.
    const needsAutoOpenedJob =
      typeof payload.jobId !== 'string' && typeof payload.linkedJobId !== 'string';
    const serviceLocationGap =
      needsAutoOpenedJob && customerId
        ? await detectServiceLocationGap(this.bookabilityRepos, {
            tenantId: context.tenantId,
            customerId,
            ...(context.message ? { transcript: context.message } : {}),
          })
        : undefined;

    // Round 4b — the jobId gate (pushed above, if any) joins the
    // pre-existing locationId gate. Both block auto-approval and approval
    // alike (decideInitialStatus / approveProposal read the same array).
    const allMissingFields = [...missingFields, ...(serviceLocationGap ? ['locationId'] : [])];

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload,
      summary,
      confidenceScore: confidence.score,
      confidenceFactors: confidence.factors,
      sourceContext:
        context.conversationId || serviceLocationGap || verifiedJobId
          ? {
              ...(context.conversationId ? { conversationId: context.conversationId } : {}),
              // Everything the review card needs to close the gap in place —
              // the preserved address and where it came from — so the operator
              // never has to go looking for it in the database.
              ...(serviceLocationGap ? { serviceLocationGap } : {}),
              // B4 allowlist — a router-resolved jobId is DB-verified, not
              // model text, so it must survive routes/assistant.ts's
              // dropUnverifiedIds scrub (which otherwise deletes any
              // id-shaped payload value absent from the operator's own
              // words). Mirrors ConfirmAppointmentTaskHandler's identical
              // #920 stamp (voice-extended-tasks.ts).
              ...(verifiedJobId ? { verifiedIds: { jobId: verifiedJobId } } : {}),
            }
          : undefined,
      // Blocks auto-approval (decideInitialStatus → 'draft') and blocks
      // approveProposal until the operator supplies the gated field(s).
      ...(allMissingFields.length > 0 ? { missingFields: allMissingFields } : {}),
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
