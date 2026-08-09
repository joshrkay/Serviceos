/**
 * Voice-safety entity resolution for the calling agent and voice-action-router.
 *
 * P0 invariant (CLAUDE.md): "All free-text entity references on voice paths
 * are resolved via the entity resolver; ambiguity becomes a one-tap
 * voice_clarification, never a silent guess."
 *
 * Intent-conditioned lookups route invoice/estimate document numbers, customer
 * names, jobs, appointments, and technician names through the shared
 * tenant-scoped EntityResolver (production: AliasFirstEntityResolver →
 * PgEntityResolver, pg_trgm + exact document-number match, τ_ent=0.80).
 */

import type {
  EntityResolver,
  EntityResolverResult,
  EntityCandidate,
  EntityKind,
} from '../../resolution/entity-resolver';
import type { ExtractedEntities } from '../../orchestration/intent-classifier';
import { resolveDateTime } from '../../scheduling/resolve-datetime';
import { isRuntimeTimezone } from '../../../shared/timezone';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INV_NUMBER_RE = /^INV-\d+$/i;
const EST_NUMBER_RE = /^EST-\d+$/i;

const GENERIC_CUSTOMER_REFS = new Set([
  'our customer', 'the customer', 'a customer', 'customer', 'them', 'that customer', 'this customer',
]);

const SKIP_CUSTOMER_RESOLUTION_INTENTS = new Set(['create_customer']);

const CUSTOMER_REF_INTENTS = new Set([
  // Customer-scoped lookup_* intents (mirror CUSTOMER_SCOPED_LOOKUP_INTENTS).
  'lookup_balance',
  'lookup_customer',
  'lookup_jobs',
  'lookup_invoices',
  'lookup_estimates',
  'lookup_agreements',
  'lookup_account_summary',
  'lookup_appointments',
  'update_customer',
  'create_job',
  'create_invoice',
  'draft_estimate',
  'create_appointment',
  'create_booking', // vacuous today — see the note at SCHEDULING_CREATE_INTENTS below.
  'send_invoice',
  'send_estimate',
  // A spoken nudge names a PERSON ("nudge the Khan estimate"), not display
  // text. Without this the router never resolved that name to a customerId,
  // so SendEstimateNudgeTaskHandler could only ILIKE estimate_number /
  // customer_message and never traverse customer → jobs → estimates.
  // requiresExistingEntity() already returned true for this intent via
  // ESTIMATE_DOC_INTENTS, so its VOX-02 escalation posture is unchanged.
  'send_estimate_nudge',
  'update_invoice',
  'update_estimate',
  'issue_invoice',
  'record_payment',
  'apply_late_fee',
  'send_payment_reminder',
  'convert_lead',
  'add_note',
  'request_feedback',
  'notify_delay',
  // Tradesperson wave 1, Task 5 — a spoken "text/email the Hendersons..."
  // names a PERSON, not display text. Without this the router never
  // resolved that name to a customerId, so SendCustomerMessageTaskHandler
  // could only see raw free text — mirrors send_estimate_nudge's rationale
  // above.
  'send_customer_message',
  'log_expense',
  'add_service_location',
  'mark_lead_lost',
  'confirm_appointment',
  // Tradesperson wave 1 — each alias joins the SAME customer-reference
  // resolution its target proposal type already gets (per-alias, not a
  // blanket rule — a future alias must be checked against its own target,
  // not assumed):
  //   schedule_inspection  → create_appointment (already above) resolves
  //                          customerName; the inspection's own customer
  //                          reference needs the same resolution.
  //   log_permit           → add_note (already above) resolves
  //                          customerName when a permit note names a
  //                          customer rather than a job ("Note the
  //                          electrical permit was approved for the
  //                          Hendersons") — without this, that customer
  //                          reference stayed fully manual even though
  //                          plain add_note already resolves it.
  //   log_warranty_claim   → create_job (already above) resolves
  //                          customerName for the new warranty job record.
  'schedule_inspection',
  'log_permit',
  'log_warranty_claim',
  // Task 7 (2026-08-07 tradesperson plan) — "sign the Garcias up for the
  // annual maintenance plan" names a PERSON, not display text. Mirrors
  // send_customer_message's rationale above: without this the router
  // never resolved that name to a customerId, so
  // CreateServiceAgreementTaskHandler could only see raw free text.
  'create_service_agreement',
]);

const INVOICE_DOC_INTENTS = new Set([
  'update_invoice',
  'send_invoice',
  'record_payment',
  'apply_late_fee',
  'issue_invoice',
  'send_payment_reminder',
  // Tradesperson wave 1, Task 3 — record_refund needs the SAME invoice-
  // reference resolution record_payment gets: the spoken invoice reference
  // rides `entities.jobReference` (there is no separate `invoiceReference`
  // extraction field anywhere in this taxonomy — every invoice-doc intent
  // reuses jobReference/jobTitle, disambiguated by this set's membership),
  // resolved here to a verified `invoiceId` BEFORE RecordRefundTaskHandler
  // runs (voice-action-router.ts stamps it onto `context.existingEntities`).
  'record_refund',
  // Tradesperson wave 1, Task 4 — apply_credit needs the SAME invoice-
  // reference resolution record_refund/record_payment get: the spoken
  // invoice reference rides `entities.jobReference`, resolved here to a
  // verified `invoiceId` BEFORE ApplyCreditTaskHandler runs
  // (voice-action-router.ts stamps it onto `context.existingEntities`).
  'apply_credit',
]);

const ESTIMATE_DOC_INTENTS = new Set([
  'update_estimate',
  'send_estimate',
  'send_estimate_nudge',
]);

/**
 * Job-reference resolution membership. Before adding a NEW intent here,
 * decide TWO separate questions — conflating them is exactly what caused
 * schedule_inspection's real bug (e255bbc0 introduced it, 3b10d44d fixed
 * it):
 *   1. Does an EXPLICIT spoken jobReference for this intent need to resolve
 *      to an existing job? If yes, join this set.
 *   2. Does this intent's `jobTitle` field carry a NEW job's descriptive
 *      name rather than an existing-job lookup key? If yes, it must ALSO
 *      join `JOB_TITLE_FALLBACK_EXCLUDED_INTENTS` below — even while
 *      staying a member of THIS set — otherwise the `jobReference ??
 *      jobTitle` fallback (in `planVoiceEntityLookups` below) will search
 *      for a job that was never meant to exist by that name.
 * `create_job`/`create_booking` answer NO to (1): they never join this set
 * at all (see the fallback's own comment for the full rationale).
 * `schedule_inspection` answers YES to both.
 */
const JOB_REF_INTENTS = new Set([
  'update_job',
  'log_time_entry',
  'create_invoice',
  'draft_estimate',
  'add_note',
  'notify_delay',
  'request_feedback',
  // U3 (B7.8) — "$40 in parts for the Henderson job": resolve the spoken
  // jobReference → jobId so the logged expense keeps its job link and job
  // P&L (lookup_job_profit) counts it. jobId is OPTIONAL on the expense
  // contract, so an unresolved (or absent) reference still logs the expense
  // unlinked — resolution only ever ADDS the link, never gates the capture.
  'log_expense',
  // Tradesperson wave 1 — per-alias job-reference rationale (log_warranty_claim
  // is deliberately ABSENT: its target, create_job, never joins
  // JOB_REF_INTENTS either — see the comment above the fallback below —
  // so a new warranty job's descriptive jobTitle can never be misread as a
  // lookup for an existing job):
  //   log_permit           → add_note (already above) resolves an EXPLICIT
  //                          spoken jobReference ("on the Patel job") the
  //                          same way; a permit note names the job it
  //                          attaches to just like any other add_note.
  //   schedule_inspection  → is ALSO in JOB_TITLE_FALLBACK_EXCLUDED_INTENTS
  //                          below — its jobTitle carries descriptive
  //                          inspection text, never an existing-job name —
  //                          but stays a JOB_REF_INTENTS member so an
  //                          EXPLICIT spoken jobReference ("on the Patel
  //                          job") still resolves to a jobId.
  'log_permit',
  'schedule_inspection',
  // Tradesperson wave 1, Task 6 — create_change_order mints a NEW estimate
  // pinned to an EXISTING job: the spoken jobReference MUST resolve to a
  // real jobId (a change order without its job is meaningless), same
  // resolution ladder as update_job/log_expense. jobId is REQUIRED on the
  // contract (unlike log_expense's optional link), so an unresolved
  // reference gates the proposal — see CreateChangeOrderTaskHandler.
  'create_change_order',
  // Task 9 (2026-08-07 tradesperson plan) — add_material: "grab three
  // boxes of PEX for the Patel job" resolves the spoken jobReference →
  // jobId so the captured material item keeps its job link. jobId is
  // OPTIONAL on the add_material contract, so an unresolved (or absent)
  // reference still captures the item unlinked — resolution only ever
  // ADDS the link, never gates the proposal (same posture as
  // log_expense's jobId).
  'add_material',
  // Task 9 — lookup_materials: "what materials are open on the Patel
  // job?" resolves the SAME way so the shopping-list readback can scope
  // to one job. Read-only — no contract/gating implications at all.
  'lookup_materials',
]);

/**
 * Spec-review fix (2026-08-07) — intents whose jobTitle must NEVER be used
 * as the jobReference fallback below, even though they ARE JOB_REF_INTENTS
 * members (unlike create_job/create_booking, which get this for free by
 * never joining JOB_REF_INTENTS at all — see the comment above the fallback).
 * schedule_inspection needs BOTH behaviors at once: an explicit "on the
 * Patel job" must still resolve (JOB_REF_INTENTS membership, OR-branch
 * below), but its jobTitle carries the inspection's own descriptive text
 * ("Inspection — rough-in", intent-classifier.ts), not a job name — using it
 * as a lookup key would search for a job that was never meant to exist by
 * that name, producing a bogus not_found. Because
 * requiresExistingEntity('schedule_inspection') is TRUE (e255bbc0 — a NAMED
 * job must actually exist), that bogus not_found would incorrectly escalate
 * an inspection that never named a job at all, instead of proceeding the
 * same way create_appointment does: falling through to
 * CreateAppointmentExecutionHandler's SCH-02 fallback (proposals/execution/
 * handlers.ts), which auto-opens a NEW job named `jobTitle || proposal.
 * summary` when a customerId is resolvable (or fails with the same
 * missing-customerId error any other unresolved jobId hits) — never "no job
 * link" (a booked appointment always ends up attached to a job one way or
 * another).
 */
const JOB_TITLE_FALLBACK_EXCLUDED_INTENTS = new Set(['schedule_inspection']);

// Quality-review note (2026-08-08) — 'create_booking' in this set (and in
// CUSTOMER_REF_INTENTS above) is a defensive, currently-VACUOUS entry: it
// names a ProposalType (proposals/proposal.ts), never a classifier
// IntentType (ai/orchestration/intent-classifier.ts) — grep confirms no
// `IntentType` union member is named `create_booking`. Since every `intent`
// value these sets are checked against (`.has(intent)`) is classifier
// output, this entry can never match today. Kept (not removed) as a
// forward guard in case a future classifier intent is ever named to match
// it directly — removing it would be a silent behavior no-op either way,
// so there is no urgency to delete it.
const SCHEDULING_CREATE_INTENTS = new Set(['create_appointment', 'create_booking']);

const APPOINTMENT_REF_INTENTS = new Set([
  'cancel_appointment',
  'reschedule_appointment',
  'confirm_appointment',
  'reassign_appointment',
  // U2 (B7.10) — crew add/remove name an appointment ("add Jake to the 2pm
  // tomorrow"). Route the spoken reference through the same appointment
  // resolver reassign uses; a unique match rides
  // existingEntities.appointmentId into the crew task handlers, anything
  // else keeps their review-time gate. Deliberately NOT added to
  // APPOINTMENT_JOB_FALLBACK_INTENTS — the sticky-job fallback stays scoped
  // to the intents it was measured on (SCH-03).
  'add_crew_member',
  'remove_crew_member',
]);

/**
 * SCH-03 — intents whose appointment reference is often anchored to a job
 * discussed earlier in the same call ("cancel the upcoming appointment for
 * that job") rather than a date phrase. When the reference doesn't parse as
 * a date, these intents fall back to the caller's sticky `context.jobId`
 * (transitions.ts) so the resolver can look up the job's own appointments
 * (appointments.job_id, idx_appointments_job) instead of returning
 * `not_found`. confirm_appointment is deliberately excluded — it has no
 * "for that job" phrasing in the corpus and stays date-only.
 */
const APPOINTMENT_JOB_FALLBACK_INTENTS = new Set([
  'cancel_appointment',
  'reschedule_appointment',
  'reassign_appointment',
]);

const TECHNICIAN_REF_INTENTS = new Set([
  'reassign_appointment',
  'add_crew_member',
  'remove_crew_member',
]);

/**
 * VOX-02 — intents whose whole point is to OPEN a record that does not exist
 * yet. A `not_found` on one of these is the normal, expected outcome, not a
 * failure: `create_appointment` carrying only a `jobTitle` is auto-opened as
 * a job at execution time (proposals/execution/handlers.ts, 95a260cd), and
 * `create_customer`/`create_job` never had a pre-existing record to find.
 * Only SCHEDULING_CREATE_INTENTS is reused verbatim; the rest are named here
 * because no existing set expresses "creation intent" (the intent families
 * above are keyed by which reference they RESOLVE, not by what they create).
 */
const ENTITY_CREATION_INTENTS = new Set([
  'create_customer',
  'create_job',
  'create_invoice',
  'draft_estimate',
  ...SCHEDULING_CREATE_INTENTS,
]);

/**
 * VOX-02 — does a `not_found` resolution for `intent` mean the caller's
 * request cannot proceed?
 *
 * TRUE for intents that operate on a record that must already exist (invoice
 * / estimate document families, appointment references, job references,
 * technician references, and the customer-scoped lookup/update family):
 * "send the estimate for the Miller job" is meaningless if no such estimate
 * exists, so the caller is handed to on-call rather than left with a
 * proposal that can never execute (46a954e1's fix — preserved).
 *
 * FALSE for creation intents: a caller asking to BOOK NEW WORK has, by
 * definition, no record to find. Those fall through to `entity_resolved`
 * with the partial refs, so the FSM reads the intent back for confirmation
 * and the proposal carries `pendingReference` for operator review.
 */
export function requiresExistingEntity(intent: string): boolean {
  if (ENTITY_CREATION_INTENTS.has(intent)) return false;
  return (
    INVOICE_DOC_INTENTS.has(intent) ||
    ESTIMATE_DOC_INTENTS.has(intent) ||
    APPOINTMENT_REF_INTENTS.has(intent) ||
    JOB_REF_INTENTS.has(intent) ||
    TECHNICIAN_REF_INTENTS.has(intent) ||
    CUSTOMER_REF_INTENTS.has(intent)
  );
}

const REF_KEY_BY_KIND: Record<EntityKind, string | undefined> = {
  customer: 'customerId',
  job: 'jobId',
  invoice: 'invoiceId',
  estimate: 'estimateId',
  appointment: 'appointmentId',
  technician: 'technicianId',
  pending_proposal: undefined,
};

export interface VoiceEntityLookup {
  kind: EntityKind;
  reference: string;
  refKey: string;
  /**
   * SCH-03 — sticky job anchor threaded to the resolver for `kind:
   * 'appointment'` lookups on APPOINTMENT_JOB_FALLBACK_INTENTS. Only set
   * when the caller supplied a stickyJobId to `planVoiceEntityLookups`.
   */
  jobId?: string;
}

export interface ParsedWindow {
  scheduledStart: string;
  scheduledEnd: string;
}

/**
 * U4 (Part E punch #1) — per-session inputs for spoken-datetime resolution.
 * Threaded by the two live-call entry points (create-voice-turn-processor's
 * `resolveTurnEntities` and InAppVoiceAdapter's `resolveEntities`), each of
 * which resolves the tenant settings ONCE per session.
 */
export interface SchedulingResolutionOptions {
  /**
   * Tenant IANA timezone (`tenant_settings.timezone`). REQUIRED for any
   * spoken time to resolve: absent or invalid ⇒ the ISO fields stay
   * unresolved so the proposal gates/refuses downstream (B5.5 precedent —
   * "refuse a service day with no tenant zone"), NEVER a silent UTC or
   * product-default parse. The July timezone fixes covered the recorded-memo
   * and reschedule task paths; this module was the last one parsing spoken
   * times in a hardcoded UTC frame (docs/PRD-v4-part-E-state.md).
   */
  timezone?: string;
  /** Test seam for "now"; defaults to the wall clock inside resolveDateTime. */
  now?: Date;
}

/**
 * U4 — resolve a spoken datetime phrase against the TENANT's zone via the
 * SAME `resolveDateTime` the recorded-memo path (create-appointment-task,
 * RescheduleAppointmentTaskHandler) uses, so the live-call and memo entry
 * points can never disagree on what "Thursday at 2pm" means. Returns
 * undefined when no verified tenant zone is available or the phrase doesn't
 * parse — the fields stay absent, never guessed (replaces the old
 * `parseNaturalDatetime`, which did UTC-frame arithmetic regardless of the
 * tenant's zone).
 */
function resolveSpokenWindow(
  desc: string,
  opts: SchedulingResolutionOptions | undefined,
): ParsedWindow | undefined {
  const timezone =
    typeof opts?.timezone === 'string' && isRuntimeTimezone(opts.timezone.trim())
      ? opts.timezone.trim()
      : undefined;
  // NO tenant zone ⇒ no resolution. `resolveDateTime` itself falls back to a
  // product-default zone when handed an invalid/absent one, so the gate MUST
  // sit here: a Phoenix tenant's "2pm" must never book at a default zone's
  // 2pm (the exact create-side bug the July fixes closed elsewhere).
  if (!timezone) return undefined;
  const resolved = resolveDateTime(desc, {
    timezone,
    ...(opts?.now ? { now: opts.now } : {}),
  });
  if (!resolved.ok) return undefined;
  return { scheduledStart: resolved.startUtc, scheduledEnd: resolved.endUtc };
}

export interface SchedulingEntityResolution {
  status: 'resolved' | 'ambiguous' | 'not_found' | 'low_confidence';
  refs: Record<string, string>;
  ambiguous?: {
    entityKind: EntityKind;
    reference: string;
    candidates: EntityCandidate[];
  };
  notFound?: {
    entityKind: EntityKind;
    reference: string;
  };
  /**
   * One candidate in [τ_ent_confirm_low, τ_ent) — probably right, but not
   * confident enough to act without a one-tap voice confirmation turn.
   */
  lowConfidence?: {
    entityKind: EntityKind;
    candidate: EntityCandidate;
    reference: string;
  };
}

function trimReference(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function documentKindForReference(intent: string, reference: string): 'invoice' | 'estimate' | null {
  if (INVOICE_DOC_INTENTS.has(intent) || INV_NUMBER_RE.test(reference)) return 'invoice';
  if (ESTIMATE_DOC_INTENTS.has(intent) || EST_NUMBER_RE.test(reference)) return 'estimate';
  return null;
}

/**
 * Build the ordered resolver lookups for one classified intent. Only emits
 * references the intent family actually needs — create_customer never
 * pre-resolves a customer, and document numbers route to invoice/estimate kinds.
 */
export function planVoiceEntityLookups(
  intent: string,
  entities: Record<string, unknown>,
  stickyJobId?: string,
): VoiceEntityLookup[] {
  const lookups: VoiceEntityLookup[] = [];

  // Ambiguity/clarification order: customer → job → technician → appointment.
  // Customer-first keeps "Invoice Bob for the water heater job" from stalling
  // on a job picker before the operator picks WHICH Bob; technician-before-
  // appointment keeps reassign flows from surfacing the appointment picker
  // before the operator picks WHICH Carlos.
  const customerName = trimReference(entities.customerName);
  if (
    customerName &&
    !SKIP_CUSTOMER_RESOLUTION_INTENTS.has(intent) &&
    CUSTOMER_REF_INTENTS.has(intent) &&
    !GENERIC_CUSTOMER_REFS.has(customerName.toLowerCase())
  ) {
    lookups.push({ kind: 'customer', reference: customerName, refKey: 'customerId' });
  }

  // The extraction schema documents `jobTitle` as "title of new job on
  // create_job" (intent-classifier.ts) — a NAME for a job being created, not
  // a reference to resolve. But real-LLM output is non-deterministic: for
  // reference-needing intents (draft_estimate, create_invoice, ...) the model
  // sometimes puts an existing-job description in `jobTitle` instead of
  // `jobReference` (observed live: "Draft an estimate for the QA Matrix job"
  // classified with entities.jobTitle="QA Matrix job" and no jobReference at
  // all, silently dropping the job link and failing execution downstream).
  // create_job/create_booking are deliberately excluded from JOB_REF_INTENTS
  // /SCHEDULING_CREATE_INTENTS's fallback below (they never join
  // JOB_REF_INTENTS at all), so this can never misread an intentional
  // new-job title as a reference to an existing job. schedule_inspection
  // needs the opposite shape — it IS a JOB_REF_INTENTS member (an explicit
  // "on the Patel job" must still resolve) — so it is excluded from this
  // fallback by name via JOB_TITLE_FALLBACK_EXCLUDED_INTENTS instead: its
  // jobTitle carries descriptive inspection text, never a job name.
  const jobReference =
    trimReference(entities.jobReference) ??
    (JOB_REF_INTENTS.has(intent) && !JOB_TITLE_FALLBACK_EXCLUDED_INTENTS.has(intent)
      ? trimReference(entities.jobTitle)
      : undefined);
  if (jobReference) {
    const documentKind = documentKindForReference(intent, jobReference);
    if (documentKind) {
      const refKey = REF_KEY_BY_KIND[documentKind];
      if (refKey) lookups.push({ kind: documentKind, reference: jobReference, refKey });
    } else if (JOB_REF_INTENTS.has(intent) || SCHEDULING_CREATE_INTENTS.has(intent)) {
      lookups.push({ kind: 'job', reference: jobReference, refKey: 'jobId' });
    }
  }

  const targetTechnicianName = trimReference(entities.targetTechnicianName);
  if (targetTechnicianName && TECHNICIAN_REF_INTENTS.has(intent)) {
    lookups.push({
      kind: 'technician',
      reference: targetTechnicianName,
      refKey: 'technicianId',
    });
  }

  const appointmentReference = trimReference(entities.appointmentReference);
  if (appointmentReference && APPOINTMENT_REF_INTENTS.has(intent)) {
    lookups.push({
      kind: 'appointment',
      reference: appointmentReference,
      refKey: 'appointmentId',
      // SCH-03 — anchor to the sticky session jobId only for the intents
      // where a bare job reference ("that job") is plausible; the resolver
      // only uses this when the reference fails to parse as a date.
      ...(stickyJobId && APPOINTMENT_JOB_FALLBACK_INTENTS.has(intent)
        ? { jobId: stickyJobId }
        : {}),
    });
  }

  return lookups;
}

function foldResolution(
  result: EntityResolverResult,
  entityKind: EntityKind,
  reference: string,
  refs: Record<string, string>,
  refKey: string,
): SchedulingEntityResolution | undefined {
  switch (result.kind) {
    case 'resolved':
      refs[refKey] = result.candidate.id;
      return undefined;
    case 'ambiguous':
      return {
        status: 'ambiguous',
        refs,
        ambiguous: { entityKind, reference, candidates: result.candidates },
      };
    case 'not_found':
      return {
        status: 'not_found',
        refs,
        notFound: { entityKind, reference },
      };
    case 'low_confidence':
      return {
        status: 'low_confidence',
        refs,
        lowConfidence: { entityKind, candidate: result.candidate, reference },
      };
    case 'skipped':
      return undefined;
  }
}

async function resolvePlannedLookups(
  resolver: EntityResolver | undefined,
  tenantId: string,
  lookups: readonly VoiceEntityLookup[],
  refs: Record<string, string>,
): Promise<SchedulingEntityResolution | undefined> {
  if (!resolver) return undefined;
  for (const lookup of lookups) {
    const result = await resolver.resolve({
      tenantId,
      reference: lookup.reference,
      kind: lookup.kind,
      ...(lookup.jobId ? { jobId: lookup.jobId } : {}),
    });
    const terminal = foldResolution(
      result,
      lookup.kind,
      lookup.reference,
      refs,
      lookup.refKey,
    );
    if (terminal) return terminal;
  }
  return undefined;
}

export async function resolveSchedulingEntities(
  resolver: EntityResolver | undefined,
  tenantId: string,
  intent: string,
  entities: Record<string, unknown>,
  /**
   * SCH-03 — the caller's sticky `context.jobId` (transitions.ts), carried
   * forward across turns the same way `context.customerId` is. Only
   * consulted for APPOINTMENT_JOB_FALLBACK_INTENTS, and only when the
   * appointment reference fails to parse as a date.
   */
  stickyJobId?: string,
  /**
   * U4 — tenant timezone (+ optional clock seam) for spoken-datetime
   * resolution. Without a verified zone the ISO datetime fields stay
   * unresolved (see resolveSpokenWindow) — never a silent UTC parse.
   */
  opts?: SchedulingResolutionOptions,
): Promise<SchedulingEntityResolution> {
  const refs: Record<string, string> = {};

  const IDENTITY_KEYS = new Set([
    'customerId',
    'jobId',
    'appointmentId',
    'invoiceId',
    'estimateId',
    'technicianId',
  ]);
  for (const [k, v] of Object.entries(entities)) {
    if (typeof v === 'string' && !IDENTITY_KEYS.has(k)) refs[k] = v;
  }

  const dt = typeof entities.dateTimeDescription === 'string'
    ? entities.dateTimeDescription
    : typeof entities.datetime === 'string' ? entities.datetime : undefined;
  if (dt && typeof entities.scheduledStart !== 'string') {
    const win = resolveSpokenWindow(dt, opts);
    if (win) {
      refs.scheduledStart = win.scheduledStart;
      refs.scheduledEnd = win.scheduledEnd;
    }
  }

  // A reschedule names its NEW time in `newDateTimeDescription` (the classifier
  // keeps it distinct from `dateTimeDescription` — see intent-classifier.ts's
  // ExtractedEntities), and `rescheduleAppointmentPayloadSchema` /
  // `RescheduleAppointmentExecutionHandler` read `newScheduledStart` +
  // `newScheduledEnd`. Without this the phrase reached the proposal as raw
  // free text and every voice reschedule died at execution with 'Payload must
  // include a valid newScheduledStart'. Deterministic and non-guessing: the
  // SAME `resolveSpokenWindow` (tenant zone, U4) the booking window above
  // uses; an unparseable phrase — or an unconfigured tenant zone — leaves the
  // ISO fields absent so the proposal fails its contract rather than
  // mis-booking (the operator-side RescheduleAppointmentTaskHandler takes the
  // identical "leave them missing" stance).
  const newDt = typeof entities.newDateTimeDescription === 'string'
    ? entities.newDateTimeDescription
    : undefined;
  if (newDt && typeof entities.newScheduledStart !== 'string') {
    const win = resolveSpokenWindow(newDt, opts);
    if (win) {
      refs.newScheduledStart = win.scheduledStart;
      refs.newScheduledEnd = win.scheduledEnd;
    }
  }

  const explicitCustomerId =
    typeof entities.customerId === 'string' && UUID_RE.test(entities.customerId)
      ? entities.customerId
      : undefined;
  if (explicitCustomerId) {
    refs.customerId = explicitCustomerId;
  }

  for (const key of ['jobId', 'appointmentId', 'invoiceId', 'estimateId', 'technicianId'] as const) {
    const value = entities[key];
    if (typeof value === 'string' && UUID_RE.test(value)) {
      refs[key] = value;
    }
  }

  const planned = planVoiceEntityLookups(intent, entities, stickyJobId).filter((lookup) => {
    if (lookup.refKey === 'customerId' && refs.customerId) return false;
    if (lookup.refKey === 'jobId' && refs.jobId) return false;
    if (lookup.refKey === 'appointmentId' && refs.appointmentId) return false;
    if (lookup.refKey === 'invoiceId' && refs.invoiceId) return false;
    if (lookup.refKey === 'estimateId' && refs.estimateId) return false;
    if (lookup.refKey === 'technicianId' && refs.technicianId) return false;
    return true;
  });

  const terminal = await resolvePlannedLookups(resolver, tenantId, planned, refs);
  if (terminal) return terminal;

  if (intent === 'cancel_appointment' && typeof entities.reason !== 'string') {
    refs.reason = 'Requested by caller via voice session';
  }

  return { status: 'resolved', refs };
}

/** Router annotation shape — mirrors resolveSchedulingEntities outcomes. */
export interface VoiceEntityAnnotation {
  kind: 'ok';
  resolved: {
    customerId?: string;
    jobId?: string;
    invoiceId?: string;
    estimateId?: string;
    appointmentId?: string;
    technicianId?: string;
  };
  pendingReferences: Array<{ kind: EntityKind; reference: string }>;
}

export interface VoiceEntityAmbiguity {
  kind: 'ambiguous';
  entityKind: EntityKind;
  reference: string;
  candidates: EntityCandidate[];
  additionalAmbiguities?: Array<{
    entityKind: EntityKind;
    reference: string;
    candidates: EntityCandidate[];
  }>;
}

export type VoiceEntityResolution = VoiceEntityAnnotation | VoiceEntityAmbiguity;

/**
 * Intent-conditioned entity resolution for the voice-action-router. Resolves
 * every planned reference; the first ambiguity short-circuits. Unresolved
 * references become pendingReference entries for operator review — never a
 * silent guess.
 */
export async function resolveVoiceEntityReferences(
  resolver: EntityResolver | undefined,
  input: {
    tenantId: string;
    intent: string;
    entities: ExtractedEntities | Record<string, unknown> | undefined;
    verifiedCustomerId?: string;
    verifiedJobId?: string;
  },
): Promise<VoiceEntityResolution> {
  const ok: VoiceEntityAnnotation = { kind: 'ok', resolved: {}, pendingReferences: [] };
  if (!resolver || !input.entities) return ok;

  const entities: Record<string, unknown> = { ...input.entities };
  if (input.verifiedCustomerId) delete entities.customerName;
  if (input.verifiedJobId) delete entities.jobReference;

  // SCH-03 — the already-known job (verifiedJobId) doubles as the sticky
  // anchor for an appointment reference that isn't a date phrase ("that
  // job"). Only consulted by planVoiceEntityLookups for
  // APPOINTMENT_JOB_FALLBACK_INTENTS, and only when the resolver's date
  // parse misses.
  const planned = planVoiceEntityLookups(input.intent, entities, input.verifiedJobId);
  if (planned.length === 0) return ok;

  const results = await Promise.all(
    planned.map(async (lookup) => {
      try {
        return {
          lookup,
          result: await resolver.resolve({
            tenantId: input.tenantId,
            reference: lookup.reference,
            kind: lookup.kind,
            ...(lookup.jobId ? { jobId: lookup.jobId } : {}),
          }),
        };
      } catch {
        return { lookup, result: undefined };
      }
    }),
  );

  const ambiguities: Array<{
    entityKind: EntityKind;
    reference: string;
    candidates: EntityCandidate[];
  }> = [];

  for (const entry of results) {
    if (!entry.result) continue;
    switch (entry.result.kind) {
      case 'resolved':
        ok.resolved[entry.lookup.refKey as keyof VoiceEntityAnnotation['resolved']] =
          entry.result.candidate.id;
        break;
      case 'ambiguous':
        ambiguities.push({
          entityKind: entry.lookup.kind,
          reference: entry.lookup.reference,
          candidates: entry.result.candidates,
        });
        break;
      case 'not_found':
        ok.pendingReferences.push({
          kind: entry.lookup.kind,
          reference: entry.lookup.reference,
        });
        break;
      case 'skipped':
        break;
    }
  }

  if (ambiguities.length > 0) {
    const [first, ...rest] = ambiguities;
    return {
      kind: 'ambiguous',
      ...first,
      ...(rest.length > 0 ? { additionalAmbiguities: rest } : {}),
    };
  }

  if (input.verifiedCustomerId) ok.resolved.customerId = input.verifiedCustomerId;
  if (input.verifiedJobId) ok.resolved.jobId = input.verifiedJobId;

  return ok;
}

// ─── Disambiguation follow-up (in-app voice turn 2+) ─────────────────────────

/** Hard cap on consecutive unmatched disambiguation answers before proceeding. */
export const MAX_DISAMBIGUATION_ATTEMPTS = 2;

export interface PendingEntityAmbiguityCandidate {
  id: string;
  name: string;
  score: number;
  hint?: string;
}

export interface PendingEntityAmbiguity {
  entityKind: EntityKind;
  reference: string;
  refKey: string;
  candidates: PendingEntityAmbiguityCandidate[];
  partialRefs: Record<string, string>;
  attemptCount: number;
}

export type DisambiguationFollowUpResult =
  | { status: 'resolved'; candidateId: string }
  | { status: 'unmatched' }
  | { status: 'still_ambiguous' };

export function refKeyForEntityKind(kind: EntityKind): string | undefined {
  return REF_KEY_BY_KIND[kind];
}

function normalizeFollowUp(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?,]+$/g, '').trim();
}

function extractDigits(text: string): string {
  return text.replace(/\D/g, '');
}

function extractStreetNumber(text: string): string | undefined {
  const match = text.match(/\b(\d{1,5})\b/);
  return match?.[1];
}

/** Prefer the service-address segment of an enriched candidate hint over phone digits. */
function hintAddressPortion(hint: string | undefined): string {
  if (!hint) return '';
  const segments = hint.split('·').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length <= 1) return '';
  return segments.slice(1).join(' ').trim();
}

function phoneTailMatchesStreetNumber(hint: string | undefined, streetNumber: string): boolean {
  const digits = extractDigits(hint ?? '');
  if (!digits || !streetNumber) return false;
  return digits.endsWith(streetNumber) || digits.endsWith(`0${streetNumber}`);
}

function parseOrdinalIndex(normalized: string, candidateCount: number): number | undefined {
  const compact = normalized
    .replace(/^the\s+/, '')
    .replace(/\s+one$/, '')
    .trim();
  const ordinalMap: Array<[RegExp, number]> = [
    [/^(first|1|one|option\s+1|primero?)$/, 0],
    [/^(second|2|two|option\s+2|segundo)$/, 1],
    [/^(third|3|three|option\s+3|tercero)$/, 2],
  ];
  for (const [pattern, index] of ordinalMap) {
    if (pattern.test(compact) && index < candidateCount) return index;
  }
  return undefined;
}

function intersectResolverResult(
  result: EntityResolverResult,
  candidateIds: Set<string>,
): DisambiguationFollowUpResult | undefined {
  if (result.kind === 'resolved' && candidateIds.has(result.candidate.id)) {
    return { status: 'resolved', candidateId: result.candidate.id };
  }
  if (result.kind === 'ambiguous') {
    const intersection = result.candidates.filter((c) => candidateIds.has(c.id));
    if (intersection.length === 1) {
      return { status: 'resolved', candidateId: intersection[0].id };
    }
    if (intersection.length > 1) return { status: 'still_ambiguous' };
  }
  return undefined;
}

/**
 * Deterministic follow-up parsing against a bounded candidate set. Never picks
 * outside the pending list — ordinals, phone hints, and street numbers only.
 */
export function matchDisambiguationFollowUp(
  followUp: string,
  pending: PendingEntityAmbiguity,
): DisambiguationFollowUpResult {
  const normalized = normalizeFollowUp(followUp);
  if (!normalized) return { status: 'unmatched' };

  for (const candidate of pending.candidates) {
    if (candidate.id.toLowerCase() === normalized) {
      return { status: 'resolved', candidateId: candidate.id };
    }
  }

  const ordinalIndex = parseOrdinalIndex(normalized, pending.candidates.length);
  if (ordinalIndex !== undefined) {
    return { status: 'resolved', candidateId: pending.candidates[ordinalIndex].id };
  }

  const distinctLabels = [...new Set(pending.candidates.map((c) => c.name.trim().toLowerCase()))];
  if (distinctLabels.length >= 2) {
    const labelMatches = pending.candidates.filter((candidate) => {
      const label = candidate.name.trim().toLowerCase();
      return normalized.includes(label) || label.includes(normalized);
    });
    if (labelMatches.length === 1) {
      return { status: 'resolved', candidateId: labelMatches[0].id };
    }
    if (labelMatches.length > 1) return { status: 'still_ambiguous' };
  }

  const followDigits = extractDigits(normalized);
  const streetNumber = extractStreetNumber(normalized);
  const hintMatches: string[] = [];

  for (const candidate of pending.candidates) {
    const addressHay = hintAddressPortion(candidate.hint).toLowerCase();
    if (streetNumber) {
      if (addressHay.length > 0 && addressHay.includes(streetNumber)) {
        hintMatches.push(candidate.id);
        continue;
      }
      if (phoneTailMatchesStreetNumber(candidate.hint, streetNumber)) {
        hintMatches.push(candidate.id);
        continue;
      }
    }
    if (followDigits.length >= 7) {
      const hintDigits = extractDigits(candidate.hint ?? '');
      if (
        hintDigits.length >= 7 &&
        (followDigits.includes(hintDigits) || hintDigits.includes(followDigits))
      ) {
        hintMatches.push(candidate.id);
      }
    }
  }

  const uniqueHintMatches = [...new Set(hintMatches)];
  if (uniqueHintMatches.length === 1) {
    return { status: 'resolved', candidateId: uniqueHintMatches[0] };
  }
  if (uniqueHintMatches.length > 1) return { status: 'still_ambiguous' };

  if (streetNumber) {
    const tokens = normalized.split(/\s+/).filter((token) => token.length > 2);
    const tokenMatches = pending.candidates.filter((candidate) => {
      const haystack = `${hintAddressPortion(candidate.hint)} ${candidate.name}`.toLowerCase();
      return haystack.includes(streetNumber) || tokens.every((token) => haystack.includes(token));
    });
    if (tokenMatches.length === 1) {
      return { status: 'resolved', candidateId: tokenMatches[0].id };
    }
    if (tokenMatches.length > 1) return { status: 'still_ambiguous' };
  }

  return { status: 'unmatched' };
}

/**
 * Parse a caller's disambiguation answer. Tries deterministic matching first,
 * then re-resolves through the tenant resolver and intersects with the pending
 * candidate set (never accepts an id outside that set).
 */
export async function resolveDisambiguationFollowUp(
  resolver: EntityResolver | undefined,
  tenantId: string,
  followUp: string,
  pending: PendingEntityAmbiguity,
): Promise<DisambiguationFollowUpResult> {
  const direct = matchDisambiguationFollowUp(followUp, pending);
  if (direct.status === 'resolved' || direct.status === 'still_ambiguous') {
    return direct;
  }
  if (!resolver) return { status: 'unmatched' };

  const candidateIds = new Set(pending.candidates.map((candidate) => candidate.id));

  try {
    const primary = await resolver.resolve({
      tenantId,
      reference: followUp,
      kind: pending.entityKind,
    });
    const primaryMatch = intersectResolverResult(primary, candidateIds);
    if (primaryMatch) return primaryMatch;

    if (pending.entityKind === 'customer' && extractStreetNumber(followUp)) {
      const jobResult = await resolver.resolve({
        tenantId,
        reference: followUp,
        kind: 'job',
      });
      if (jobResult.kind === 'resolved') {
        const streetNumber = extractStreetNumber(followUp);
        const jobLabel = jobResult.candidate.label.toLowerCase();
        if (streetNumber && jobLabel.includes(streetNumber)) {
          const addressMatches = pending.candidates.filter((candidate) =>
            `${candidate.name} ${candidate.hint ?? ''}`.toLowerCase().includes(streetNumber),
          );
          if (addressMatches.length === 1) {
            return { status: 'resolved', candidateId: addressMatches[0].id };
          }
          if (addressMatches.length > 1) return { status: 'still_ambiguous' };
        }
      }
    }
  } catch {
    return { status: 'unmatched' };
  }

  return { status: 'unmatched' };
}
