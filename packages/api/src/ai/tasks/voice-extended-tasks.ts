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
import { createProposal } from '../../proposals/proposal';
import { ExtractedEntities } from '../orchestration/intent-classifier';
import type { AppointmentRepository } from '../../appointments/appointment';
import type { JobRepository } from '../../jobs/job';
import type { CatalogItem, CatalogItemRepository } from '../../catalog/catalog-item';
import type { InvoiceRepository } from '../../invoices/invoice';
import type { Estimate, EstimateRepository } from '../../estimates/estimate';
import type { LLMGateway } from '../gateway/gateway';
import { resolveDateTime } from '../scheduling/resolve-datetime';
import { isRuntimeTimezone } from '../../shared/timezone';
import { findJobsRequiringInvoicing, InvoicingQueueDeps } from '../../invoices/invoicing-queue';
import {
  DunningEvent,
  DunningEventRepository,
  DUNNING_MARKER_WINDOW_MS,
} from '../../invoices/dunning-config';
import { parseMilestoneSentence } from '../../invoices/milestone-sentence-parser';
import { candidatesForReference } from '../resolution/reference-candidates';
import type { EntityCandidate } from '../resolution/entity-resolver';
import { resolveLineItemToCatalog } from '../resolution/catalog-resolver';
import { formatCents } from '../skills/spoken-format';
import { entitiesFrom, baseSourceContext, inputFor } from './task-input';

const DAY_MS = 24 * 60 * 60 * 1000;

// Mirrors the execution-side check (isUuid in
// proposals/execution/voice-extended-handlers.ts / UUID_RE in
// proposals/execution/issue-invoice-handler.ts): a classifier-extracted
// reference is free text ("the Henderson invoice", "INV-0042") in the
// overwhelming case, but on rare re-drafts (e.g. a resolved review-card pick
// carried forward) it may already BE the resolved id. Used to decide whether
// a task handler can hand the execution handler a usable id directly or must
// gate the proposal for review-time resolution.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
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

/**
 * The appointment id the router's entity resolver already verified, if any.
 *
 * Found-by-proof (rivet-voice-19 item 9): the scheduling tasks used to skip
 * this seam entirely and re-resolve from scratch via
 * `resolveActiveAppointmentId`, which can only answer when the tenant has
 * exactly ONE active appointment. So in any shop with two jobs on the books,
 * "Move the Garcia job to Thursday at 10" could not resolve — even though the
 * router had already disambiguated "the Garcia job" and threaded the correct
 * id onto `existingEntities.appointmentId`
 * (workers/voice-action-router.ts:1490-1508). The verified id must win; the
 * single-active-appointment fallback stays for the references the resolver
 * could not answer (the SCH-03 first-turn case it was built for).
 */
function resolvedAppointmentIdFrom(context: TaskContext): string | undefined {
  const id = context.existingEntities?.appointmentId;
  return isUuid(id) ? id : undefined;
}

/**
 * The estimate id the router's entity resolver already verified, if any.
 * House style matches `resolvedAppointmentIdFrom` above: `send_estimate` and
 * `send_estimate_nudge` are `ESTIMATE_DOC_INTENTS` (ai/agents/customer-calling/
 * entity-resolution.ts), so the router already plans an 'estimate' kind
 * lookup for a spoken jobReference/customerName before the task handler ever
 * runs. Still just a shape check — SendEstimateNudgeTaskHandler.handle
 * additionally VERIFIES this against the repo before trusting it (never trust
 * an LLM/router-shaped UUID on its own; see resolveEstimateIdGate,
 * estimate-edit-task.ts:427-461, for the pattern this copies), while
 * SendEstimateTaskHandler consumes it the same way
 * ReassignAppointmentTaskHandler consumes `appointmentId` (B5.3): resolved id
 * → payload, gate lifts; anything else keeps today's gated behavior.
 */
function resolvedEstimateIdFrom(context: TaskContext): string | undefined {
  const id = context.existingEntities?.estimateId;
  return isUuid(id) ? id : undefined;
}

/**
 * The invoice id the router's entity resolver already verified, if any.
 * `send_invoice` / `send_payment_reminder` / `apply_late_fee` are all
 * `INVOICE_DOC_INTENTS` (ai/agents/customer-calling/entity-resolution.ts), so
 * the router plans an 'invoice' kind lookup for the spoken reference and
 * threads a unique high-confidence match onto `existingEntities.invoiceId`
 * (workers/voice-action-router.ts, annotation.resolved.invoiceId). Shape check
 * only, mirroring `resolvedAppointmentIdFrom` — an ambiguous reference never
 * reaches a task handler (the router short-circuits to voice_clarification),
 * and a not_found/low-confidence one leaves this seam empty so the legacy
 * missing-fields gate holds.
 */
function resolvedInvoiceIdFrom(context: TaskContext): string | undefined {
  const id = context.existingEntities?.invoiceId;
  return isUuid(id) ? id : undefined;
}

// ───────────── reschedule_appointment ─────────────
//
// Reschedule needs ISO datetimes. The classifier returns a natural-
// language `newDateTimeDescription` ("next Tuesday at 2pm"), which we
// resolve deterministically (tenant timezone + now) via `resolveDateTime`.
// When the phrase is ambiguous/unparseable the ISO fields stay missing so
// the proposal holds in draft for the dispatcher to complete — it can
// never silently mis-book.
export class RescheduleAppointmentTaskHandler implements TaskHandler {
  readonly taskType = 'reschedule_appointment' as const;

  constructor(
    // Retained for construction-site compatibility; date resolution is now
    // deterministic, so no LLM round-trip is made here.
    private readonly gateway?: LLMGateway,
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly jobRepo?: JobRepository,
  ) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    // Prefer the id the entity resolver already verified for the spoken
    // reference; only fall back to the caller's single-active-appointment
    // lookup when it could not answer.
    const resolvedId =
      resolvedAppointmentIdFrom(context) ??
      (await resolveActiveAppointmentId(this.appointmentRepo, context.tenantId, {
        customerId: context.customerId,
        jobRepo: this.jobRepo,
      }));
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

    // Preserve the ORIGINAL appointment's duration on reschedule: load the
    // resolved appointment and carry its length so "move it to Tuesday at
    // 2pm" keeps a 2-hour job 2 hours instead of collapsing to the 60-min
    // default. Best-effort — a lookup miss falls back to the default.
    let originalDurationMin: number | undefined;
    if (typeof payload.appointmentId === 'string' && this.appointmentRepo) {
      try {
        const appt = await this.appointmentRepo.findById(context.tenantId, payload.appointmentId);
        if (appt) {
          const ms = toDate(appt.scheduledEnd).getTime() - toDate(appt.scheduledStart).getTime();
          if (ms > 0) originalDurationMin = ms / 60000;
        }
      } catch {
        // ignore — resolver default duration applies
      }
    }

    // HYBRID resolution (P0 fix): resolve the verbatim phrase
    // deterministically against the TENANT timezone + now — no LLM
    // timezone math, no hardcoded America/Los_Angeles. Ambiguous or
    // invalid phrases leave the ISO fields missing so the proposal stays
    // in draft for the dispatcher to complete.
    const phrase =
      typeof ee.newDateTimeDescription === 'string' ? ee.newDateTimeDescription.trim() : '';
    // No tenant timezone ⇒ no resolution. Falling back to a product-default
    // zone here silently moved a Phoenix tenant's appointment three hours
    // (the create-side bug this mirrors — see create-appointment-task.ts's
    // "NO DEFAULT TIMEZONE" note). Leaving the ISO fields unresolved routes
    // through the SAME missingFields gate an unparseable phrase already
    // takes: the reschedule stays in draft for the dispatcher instead of
    // moving a real appointment to a guessed hour.
    const tenantTimezone =
      typeof context.timezone === 'string' && isRuntimeTimezone(context.timezone.trim())
        ? context.timezone.trim()
        : undefined;
    const resolved =
      phrase && tenantTimezone
        ? resolveDateTime(phrase, {
            timezone: tenantTimezone,
            now: context.now ?? new Date(),
            ...(originalDurationMin ? { defaultDurationMin: originalDurationMin } : {}),
          })
        : undefined;

    if (resolved && resolved.ok) {
      payload.newScheduledStart = resolved.startUtc;
      payload.newScheduledEnd = resolved.endUtc;
    } else {
      missing.push('newScheduledStart');
      missing.push('newScheduledEnd');
    }

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

    // Resolver-verified id first (see resolvedAppointmentIdFrom), then the
    // caller's single-active-appointment lookup, then the free-text gate.
    const resolvedId =
      resolvedAppointmentIdFrom(context) ??
      (await resolveActiveAppointmentId(this.appointmentRepo, context.tenantId, {
        customerId: context.customerId,
        jobRepo: this.jobRepo,
      }));
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
// The classifier returns a TECHNICIAN NAME, never a UUID. The execution
// handler needs a concrete `toTechnicianId`. U1: the router's entity
// resolver (kind 'technician', pg_trgm over users) resolves the spoken
// name BEFORE this handler runs — a unique match rides
// `context.existingEntities.technicianId` as a verified UUID and lands
// on the payload; an AMBIGUOUS name never reaches here (the router
// short-circuits to a voice_clarification picker). Only when the name
// stayed unresolved (not_found / no resolver) do we keep the legacy
// missing-marker so the review UI resolves it before approval.
//
// B5.3 (defect fix) — this used to push 'appointmentId' onto missing
// UNCONDITIONALLY, ignoring the id the router's entity resolver already
// verified and threaded onto `existingEntities.appointmentId` (the same
// seam RescheduleAppointmentTaskHandler/CancelAppointmentTaskHandler read
// via `resolvedAppointmentIdFrom`). So even a fully-resolved "Assign Carlos
// to the Johnson job" — appointment AND technician both verified — landed
// with `missingFields: ['appointmentId']` and could never auto-clear the
// gate. Fix: resolve-then-gate, exactly the sibling handlers' shape —
// resolved id -> payload; free-text reference -> carry the reference AND
// gate; nothing -> gate.
export class ReassignAppointmentTaskHandler implements TaskHandler {
  readonly taskType = 'reassign_appointment' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    // Resolver-verified id first (see resolvedAppointmentIdFrom) — the same
    // precedence RescheduleAppointmentTaskHandler/CancelAppointmentTaskHandler
    // use. Only a free-text reference that never resolved falls to the gate.
    const resolvedAppointmentId = resolvedAppointmentIdFrom(context);
    if (resolvedAppointmentId) {
      payload.appointmentId = resolvedAppointmentId;
    } else if (ee.appointmentReference) {
      payload.appointmentReference = ee.appointmentReference;
      missing.push('appointmentId');
    } else {
      missing.push('appointmentId');
    }

    if (ee.targetTechnicianName) payload.targetTechnicianName = ee.targetTechnicianName;
    const resolvedTechnicianId = resolvedTechnicianIdFrom(context);
    if (resolvedTechnicianId) {
      payload.toTechnicianId = resolvedTechnicianId;
    } else {
      // Unresolved name (or no resolver wired) — the review UI resolves
      // the reference to a UUID before approval is allowed.
      missing.push('toTechnicianId');
    }

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

/**
 * U1 — verified technician UUID the router's entity resolver annotated onto
 * the task context (same seam customerId/jobId ride). Undefined when the
 * spoken name did not uniquely resolve.
 */
function resolvedTechnicianIdFrom(context: TaskContext): string | undefined {
  const id = context.existingEntities?.technicianId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

// ───────────── add_crew_member / remove_crew_member ─────────────
//
// Crew add/remove attach or detach a NON-PRIMARY technician on an existing
// appointment. The classifier returns a technician NAME and an appointment
// REFERENCE, never UUIDs. U1: the router's technician resolver fills
// `context.existingEntities.technicianId` when the spoken name uniquely
// matches a team member. U2 (B7.10): both intents are now
// APPOINTMENT_REF_INTENTS too, so the router's appointment resolver resolves
// "the 2pm tomorrow" the same way reassign's does — a unique verified match
// rides `existingEntities.appointmentId` (resolvedAppointmentIdFrom, the
// B5.3 seam) and lifts the gate; an ambiguous reference never reaches here
// (voice_clarification picker first, bounded at the resolver's candidate
// cap — the P-43 overflow rule); an unresolved one keeps the missing-marker.
// Capture-class, but any missing id keeps the proposal in draft until an
// operator resolves it.
export class AddCrewMemberTaskHandler implements TaskHandler {
  readonly taskType = 'add_crew_member' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    // U2 — resolver-verified appointment id first (B5.3 shape); only a
    // reference the resolver could not answer falls to the gate.
    const resolvedAppointmentId = resolvedAppointmentIdFrom(context);
    if (resolvedAppointmentId) payload.appointmentId = resolvedAppointmentId;
    else missing.push('appointmentId');

    if (ee.appointmentReference) payload.appointmentReference = ee.appointmentReference;
    if (ee.targetTechnicianName) payload.targetTechnicianName = ee.targetTechnicianName;
    const resolvedTechnicianId = resolvedTechnicianIdFrom(context);
    if (resolvedTechnicianId) payload.technicianId = resolvedTechnicianId;
    else missing.push('technicianId');

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

export class RemoveCrewMemberTaskHandler implements TaskHandler {
  readonly taskType = 'remove_crew_member' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    // U2 — same resolve-then-gate seam as AddCrewMemberTaskHandler above.
    const resolvedAppointmentId = resolvedAppointmentIdFrom(context);
    if (resolvedAppointmentId) payload.appointmentId = resolvedAppointmentId;
    else missing.push('appointmentId');

    if (ee.appointmentReference) payload.appointmentReference = ee.appointmentReference;
    if (ee.targetTechnicianName) payload.targetTechnicianName = ee.targetTechnicianName;
    const resolvedTechnicianId = resolvedTechnicianIdFrom(context);
    if (resolvedTechnicianId) payload.technicianId = resolvedTechnicianId;
    else missing.push('technicianId');

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── add_note ─────────────
//
// B7.4 — this used to be the most dangerous voice defect in the product: the
// handler set only `targetReference` (free text) and left `missingFields`
// EMPTY, so "Note on the Patel job — wants morning visits" was approvable
// straight from drafting, and then AddNoteExecutionHandler
// (proposals/execution/voice-extended-handlers.ts:92-97) refused it because
// `targetId` was never a UUID. The owner tapped approve and the note was
// silently lost — no row, no error reaching them.
//
// The fix is the tiered resolve-then-gate ladder ComplaintTaskHandler already
// uses (ai/tasks/complaint-task.ts:92-107): consume the id the router's entity
// resolver already put on `existingEntities` (voice-action-router.ts:1490-1508)
// for the target kind, and gate honestly whenever no id is resolvable. An
// AMBIGUOUS reference never arrives here — the router short-circuits to a
// voice_clarification picker before drafting.
//
// `targetKind` is also gated (not silently defaulted) when the classifier
// emitted a kind the note store cannot hold: NOTE_ENTITY_TYPES has no
// 'appointment', so an appointment-scoped note is another approve-then-fail
// shape. Gating it keeps the refusal at review time, where it is visible.

/** Note target kinds the execution handler can actually persist. */
const EXECUTABLE_NOTE_TARGET_KINDS = ['job', 'customer', 'invoice', 'estimate'] as const;
type ExecutableNoteTargetKind = (typeof EXECUTABLE_NOTE_TARGET_KINDS)[number];

function isExecutableNoteTargetKind(value: unknown): value is ExecutableNoteTargetKind {
  return (
    typeof value === 'string' &&
    (EXECUTABLE_NOTE_TARGET_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The resolver-verified id for a note's target kind, read from the same
 * `existingEntities` seam every other voice task consumes. `customer` also
 * accepts the verified caller identity (`context.customerId`), matching
 * ComplaintTaskHandler's precedence: caller-ID first, then resolver output.
 */
function resolvedNoteTargetId(
  context: TaskContext,
  kind: ExecutableNoteTargetKind,
): string | undefined {
  const ee = entitiesFrom(context) as Record<string, unknown>;
  const candidate =
    kind === 'customer' ? context.customerId ?? ee.customerId : ee[`${kind}Id`];
  return isUuid(candidate) ? candidate : undefined;
}

export class AddNoteTaskHandler implements TaskHandler {
  readonly taskType = 'add_note' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const targetKind = ee.noteTargetKind ?? 'job';
    const payload: Record<string, unknown> = {
      targetKind,
      // The dictated note verbatim. Falls back to the whole utterance only
      // when the classifier extracted no distinct body.
      body: ee.noteBody ?? context.message,
    };
    const missing: string[] = [];

    if (!isExecutableNoteTargetKind(targetKind)) {
      // 'appointment' (or anything unmapped): the note store has no such
      // entity type, so approving could only ever fail at execution.
      missing.push('targetKind');
    }

    const resolvedId = isExecutableNoteTargetKind(targetKind)
      ? resolvedNoteTargetId(context, targetKind)
      : undefined;

    if (resolvedId) {
      payload.targetId = resolvedId;
    } else {
      // No verified id — carry the spoken reference so the review card has
      // something to resolve from, and hold the proposal at the gate.
      const reference = ee.jobReference ?? ee.customerName;
      if (reference) payload.targetReference = reference;
      missing.push('targetId');
    }

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
//
// PR review finding (2026-07): unlike issue_invoice's execution handler
// (resolveInvoice() in proposals/execution/issue-invoice-handler.ts, which
// looks a bare/"INV-0042"-style reference up by repo), SendInvoiceExecutionHandler
// (proposals/execution/voice-extended-handlers.ts) requires payload.invoiceId
// to ALREADY be a UUID and never reads invoiceReference at all — there is no
// resolution step between the REVIEW GATE and execution for this proposal
// type. This handler used to flag invoiceId missing only when NO reference
// was extracted, so e.g. "send the Henderson invoice" landed with
// invoiceReference: 'Henderson' and an EMPTY missingFields. approveProposal
// (proposals/actions.ts) only blocks on missingFields, so the proposal was
// approvable straight from drafting and execution would then fail on the
// unresolved reference — approval succeeding for an action that can never
// execute.
//
// U1 (voice back-office workflows) — resolve-then-gate. `send_invoice` is one
// of INVOICE_DOC_INTENTS, so the router's entity resolver ALREADY resolves the
// spoken reference pre-draft and threads a unique verified match onto
// `existingEntities.invoiceId` (annotateResolvedEntities → annotation.resolved
// .invoiceId). This handler now consumes that seam (resolvedInvoiceIdFrom),
// exactly the B5.3 ReassignAppointmentTaskHandler shape: resolver-verified id
// → payload, gate lifts; free-text reference that never resolved → gate +
// B2 candidates (unchanged); nothing → gate. Comms class is untouched — a
// fully-resolved draft still lands in 'draft' and waits for a human tap.
export interface SendInvoiceTaskDeps {
  /**
   * B2 — optional. When present, a gated free-text invoiceReference is
   * additionally searched (candidatesForReference, the same
   * findByTenant({search,limit}) ILIKE technique InvoiceEditTaskHandler
   * uses) so the review card can offer a one-tap AmbiguityPicker instead
   * of a dead end. Candidates are recorded on sourceContext ONLY — on the
   * UNRESOLVED branch they NEVER lift the missingFields gate (an ILIKE
   * display-text match is not the entity resolver; only the resolver seam
   * or a literal UUID reference lifts it); see the class doc comment.
   */
  invoiceRepo?: Pick<InvoiceRepository, 'findByTenant'>;
}

export class SendInvoiceTaskHandler implements TaskHandler {
  readonly taskType = 'send_invoice' as const;
  private readonly deps: SendInvoiceTaskDeps;

  constructor(deps: SendInvoiceTaskDeps = {}) {
    this.deps = deps;
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {
      channel: ee.sendChannel ?? 'email',
    };
    const missing: string[] = [];
    let extraSourceContext: Record<string, unknown> | undefined;

    const reference = ee.jobReference ?? ee.customerName;
    // U1 — the router's entity resolver already verified the spoken
    // reference (INVOICE_DOC_INTENTS) and threaded the unique match onto
    // existingEntities.invoiceId. That seam wins; a literal UUID reference
    // is next; only a reference that never resolved falls to the gate.
    const resolvedInvoiceId = resolvedInvoiceIdFrom(context);
    if (resolvedInvoiceId) {
      payload.invoiceId = resolvedInvoiceId;
      // Keep the spoken reference for the review card's display.
      if (typeof reference === 'string' && !isUuid(reference)) {
        payload.invoiceReference = reference;
      }
    } else if (isUuid(reference)) {
      // Already a resolved id — the execution handler can use it directly,
      // no review-time resolution needed.
      payload.invoiceId = reference;
    } else {
      if (reference) payload.invoiceReference = reference;
      missing.push('invoiceId');

      // B2 — layer candidates ON TOP of the gate above; never a substitute
      // for it (an ILIKE search match, even a single unambiguous one, still
      // does not lift missingFields — see SendInvoiceTaskDeps doc comment).
      // Re-reads ee.jobReference/customerName fresh (rather than reusing
      // `reference` above) so this isn't subject to isUuid's type-predicate
      // narrowing of that binding to `undefined` in this branch.
      const searchReference = ee.jobReference ?? ee.customerName;
      if (typeof searchReference === 'string' && searchReference.trim().length > 0) {
        const candidates = await candidatesForReference({
          tenantId: context.tenantId,
          reference: searchReference,
          kind: 'invoice',
          invoiceRepo: this.deps.invoiceRepo,
        });
        if (candidates.length > 0) {
          extraSourceContext = {
            entityCandidates: candidates,
            entityKind: 'invoice',
            entityReference: searchReference,
          };
        }
      }
    }

    // NOTE deliberately NO verifiedIds stamping here: `existingEntities` can
    // carry classifier output, and dropUnverifiedIds' allowlist must only
    // ever be fed by code that itself performed the DB lookup (see the
    // CRITICAL SECURITY note on IssueInvoiceTaskHandler). The chat surface
    // (routes/assistant.ts) runs the entity resolver pre-draft and stamps
    // `sourceContext.verifiedIds` from that resolver call directly.
    return {
      proposal: createProposal(
        inputFor(context, this.taskType, payload, missing, { sourceContext: extraSourceContext }),
      ),
      taskType: this.taskType,
    };
  }
}

// ───────────── send_estimate ─────────────
//
// Comms class — never auto-approves. Mirrors SendInvoiceTaskHandler
// EXACTLY: SendEstimateExecutionHandler requires payload.estimateId to
// ALREADY be a UUID and never reads estimateReference — there is no
// resolution step between the REVIEW GATE and execution. A free-text
// reference ("the Khan estimate", "EST-0042") that never resolved must
// land with missingFields: ['estimateId'] so approveProposal blocks until
// the review card resolves it. The previous implementation only gated when
// NO reference was extracted, leaving "send the Khan estimate"
// approvable and doomed at execution — the same bug fixed for
// send_invoice (see class comment above).
//
// U1 — resolve-then-gate, same as SendInvoiceTaskHandler: `send_estimate`
// is one of ESTIMATE_DOC_INTENTS, so the router's entity resolver already
// resolves the spoken reference pre-draft and threads a unique verified
// match onto `existingEntities.estimateId` (resolvedEstimateIdFrom). That
// seam lifts the gate; anything unresolved keeps today's gated behavior.
export interface SendEstimateTaskDeps {
  /**
   * B2 — optional. When present, a gated free-text estimateReference is
   * searched (candidatesForReference) so the review card can offer a
   * one-tap AmbiguityPicker. On the UNRESOLVED branch candidates NEVER
   * lift the missingFields gate (an ILIKE display-text match is not the
   * entity resolver; only the resolver seam or a literal UUID reference
   * lifts it).
   */
  estimateRepo?: Pick<EstimateRepository, 'findByTenant'>;
}

export class SendEstimateTaskHandler implements TaskHandler {
  readonly taskType = 'send_estimate' as const;
  private readonly deps: SendEstimateTaskDeps;

  constructor(deps: SendEstimateTaskDeps = {}) {
    this.deps = deps;
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {
      channel: ee.sendChannel ?? 'email',
    };
    const missing: string[] = [];
    let extraSourceContext: Record<string, unknown> | undefined;

    const reference = ee.jobReference ?? ee.customerName;
    // U1 — resolver-verified seam first (ESTIMATE_DOC_INTENTS), then a
    // literal UUID reference, then the gate. Same ladder as send_invoice.
    const resolvedEstimateId = resolvedEstimateIdFrom(context);
    if (resolvedEstimateId) {
      payload.estimateId = resolvedEstimateId;
      // Keep the spoken reference for the review card's display.
      if (typeof reference === 'string' && !isUuid(reference)) {
        payload.estimateReference = reference;
      }
    } else if (isUuid(reference)) {
      // Already a resolved id — the execution handler can use it directly.
      payload.estimateId = reference;
    } else {
      if (reference) payload.estimateReference = reference;
      missing.push('estimateId');

      const searchReference = ee.jobReference ?? ee.customerName;
      if (typeof searchReference === 'string' && searchReference.trim().length > 0) {
        const candidates = await candidatesForReference({
          tenantId: context.tenantId,
          reference: searchReference,
          kind: 'estimate',
          estimateRepo: this.deps.estimateRepo,
        });
        if (candidates.length > 0) {
          extraSourceContext = {
            entityCandidates: candidates,
            entityKind: 'estimate',
            entityReference: searchReference,
          };
        }
      }
    }

    return {
      proposal: createProposal(
        inputFor(context, this.taskType, payload, missing, { sourceContext: extraSourceContext }),
      ),
      taskType: this.taskType,
    };
  }
}

// ───────────── send_estimate_nudge ─────────────
//
// Comms class — never auto-approves. A nudge re-sends the link for an
// ALREADY-sent estimate (SendEstimateNudgeExecutionHandler enforces a 48h
// cooldown and requires estimate.status === 'sent').
//
// B8.10 (rivet-voice-19, see projects/rivet-voice-19/b8.10-design.md) —
// "Nudge the Khan estimate" used to be blocked by a design comment
// (missing = ['estimateId'] unconditional), not a missing capability: the
// resolution technique already existed elsewhere. This reuses
// EstimateEditTaskHandler.resolveEstimateIdGate's VERIFICATION half exactly
// (estimate-edit-task.ts:427-461) — an id-shaped reference is only trusted
// once a repo lookup confirms it, never from raw LLM/router text — but goes
// one step further: a unique, VERIFIED, NUDGEABLE match lifts the gate
// outright (payload.estimateId set, missingFields: []), because that is
// this item's whole point. A free-text reference that resolves to more than
// one nudgeable estimate still asks (voice_clarification) rather than
// guessing.
//
// Nudgeable states: only 'sent' participates in matching. There is no
// separate 'viewed' EstimateStatus (view activity is tracked on
// estimate.firstViewedAt, a substate of 'sent', not a distinct status) — so
// the design doc's "sent/viewed" language collapses to exactly
// `status === 'sent'`, matching SendEstimateNudgeExecutionHandler's own gate
// (`estimate.status !== 'sent'`) verbatim. No drift is possible between
// draft-time and execute-time nudgeability.
//
// DECISION (b8.10-design.md, AC-3 — logged, not re-litigated here): a
// UNIQUE match that exists but is in a non-nudgeable status (draft/
// accepted/rejected/expired) GATES with a reason, it does NOT become a
// clarification. Rationale: clarification is for picking among several
// live options; here there is nothing to pick — the estimate is simply not
// nudgeable, and "the Khan estimate was already accepted" beats a picker
// with one disabled row. The reason rides `Proposal.explanation` (not the
// payload — sendEstimateNudgePayloadSchema has no reason field and
// proposals/contracts.ts is out of scope for this item).
const NUDGEABLE_ESTIMATE_STATUSES = new Set<Estimate['status']>(['sent']);

/** AC-2 — nudge disambiguation candidate: estimate number + amount + age,
 *  so a spoken picker ("the first one" / "EST-0042") is answerable by ear —
 *  a bare label/status hint (mapEstimatesToCandidates) isn't enough here. */
function nudgeCandidateFrom(estimate: Estimate, now: Date): EntityCandidate {
  return {
    id: estimate.id,
    kind: 'estimate',
    label: estimate.estimateNumber,
    hint: `${formatCents(estimate.totals.totalCents)} • ${nudgeAgeDescription(estimate, now)}`,
    score: 1,
  };
}

/** "sent today" / "sent 1 day ago" / "sent 12 days ago" — falls back to
 *  createdAt for the (should-never-happen) case of a 'sent' row with no
 *  sentAt, rather than throwing on a null date. */
function nudgeAgeDescription(estimate: Estimate, now: Date): string {
  const since = estimate.sentAt ?? estimate.createdAt;
  const days = Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS));
  return days === 0 ? 'sent today' : `sent ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export interface SendEstimateNudgeTaskDeps {
  /**
   * B8.10 — powers BOTH halves of resolution: `findById` verifies a
   * router-resolved `existingEntities.estimateId` (resolvedEstimateIdFrom)
   * before it's trusted; `findByTenant` runs the customer-scoped
   * `job_id = ANY(...)` query (with `jobRepo` below) and, as a fallback, the
   * same ILIKE estimate_number/customer_message search
   * `candidatesForReference` uses — widened here to ALSO see non-nudgeable
   * matches so a unique non-nudgeable hit (AC-3) can be told apart from real
   * ambiguity (AC-2).
   * Absent → today's unconditional gate (AC-4 fallback only) — unchanged.
   */
  estimateRepo?: Pick<EstimateRepository, 'findById' | 'findByTenant'>;
  /**
   * Maps the router-resolved customerId to that customer's jobs, which is
   * the ONLY real path from a spoken person's name to their estimates
   * (estimates carry job_id; jobs carry customer_id — there is no
   * estimates.customer_id). Optional by the same convention as
   * `estimateRepo` and SendPaymentReminderTaskDeps: absent (or an
   * implementation without the optional `findByCustomer`) degrades to the
   * ILIKE display-text search alone, exactly today's behavior.
   */
  jobRepo?: Pick<JobRepository, 'findByCustomer'>;
}

/**
 * Cap on the customer-anchored candidate set. Generous compared with the
 * ILIKE search's `limit: 5` because the status filter runs client-side (a
 * customer with many old accepted estimates must not push their one 'sent'
 * estimate out of the window), still bounded so a pathological account can't
 * pull an unbounded result set into a draft-time path.
 */
const NUDGE_CUSTOMER_JOB_LIMIT = 50;
const NUDGE_CUSTOMER_ESTIMATE_LIMIT = 25;

export class SendEstimateNudgeTaskHandler implements TaskHandler {
  readonly taskType = 'send_estimate_nudge' as const;
  private readonly deps: SendEstimateNudgeTaskDeps;

  constructor(deps: SendEstimateNudgeTaskDeps = {}) {
    this.deps = deps;
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const reference = ee.jobReference ?? ee.customerName;
    if (reference) payload.estimateReference = reference;

    const repo = this.deps.estimateRepo;
    const now = context.now ?? new Date();

    if (repo) {
      // Router-verified id first (mirrors resolvedAppointmentIdFrom's
      // convention) — VERIFY it against the repo before trusting it; a
      // repo miss (or a hallucinated id) is never trusted on its own.
      const resolvedId = resolvedEstimateIdFrom(context);
      if (resolvedId) {
        const verified = await safeFindEstimateById(repo, context.tenantId, resolvedId);
        if (verified) {
          return NUDGEABLE_ESTIMATE_STATUSES.has(verified.status)
            ? this.liftGate(context, payload, verified)
            : this.gateNonNudgeable(context, payload, verified);
        }
        // Unverifiable — fall through to the reference search below rather
        // than trusting an id that didn't check out.
      }

      // No router-verified id (or it didn't verify) — build the candidate set
      // from the customer relationship when one was resolved, else from the
      // ILIKE display-text search. Either way keep ALL matches (any status)
      // so a unique-but-non-nudgeable hit (AC-3) is distinguishable from
      // genuine ambiguity (AC-2) and from no match at all (AC-4).
      {
        const matches = await this.candidateEstimates(context, repo, reference);
        const nudgeable = matches.filter((m) => NUDGEABLE_ESTIMATE_STATUSES.has(m.status));

        if (nudgeable.length === 1) {
          return this.liftGate(context, payload, nudgeable[0]);
        }
        // A picker needs the spoken phrase to echo back. Caller-identity-only
        // resolution (no reference at all) has nothing to echo, so genuine
        // ambiguity there falls through to the AC-4 gate rather than asking a
        // question the operator can't tie to anything — still never a guess.
        if (nudgeable.length > 1 && reference) {
          return this.clarify(context, reference, nudgeable, now);
        }
        if (matches.length === 1) {
          // AC-3 — exactly one estimate matched the reference at all, and it
          // isn't nudgeable. Multiple non-nudgeable matches (0 nudgeable,
          // >1 total) fall through to the plain AC-4 gate below instead: the
          // "one disabled row" rationale for a custom explanation doesn't
          // extend cleanly to "several disabled rows", and the ACs don't
          // require it — scope stays literal to what was asked.
          return this.gateNonNudgeable(context, payload, matches[0]);
        }
      }
    }

    // AC-4 — no repo wired, no reference extracted, or nothing matched:
    // today's behavior becomes the fallback, not the default.
    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, ['estimateId'])),
      taskType: this.taskType,
    };
  }

  /**
   * Candidate set for the spoken request, strongest signal first.
   *
   * 1. The REAL relationship: a router-resolved customerId (spoken name →
   *    `existingEntities.customerId`, CUSTOMER_REF_INTENTS) or the verified
   *    inbound caller → that customer's jobs → `findByTenant({ jobIds })`,
   *    the same customer → jobs → estimates traversal the estimates list
   *    route already uses (pg-estimate.ts's `job_id = ANY(...)` branch).
   *    "Nudge the Khan estimate" must not depend on the optional, operator-
   *    authored `customer_message` happening to contain the word "Khan".
   * 2. Fallback: the ILIKE estimate_number/customer_message search. This is
   *    the path for a spoken DOCUMENT NUMBER ("nudge EST-0042"), for tenants
   *    whose caller wasn't resolved, and whenever `jobRepo` isn't wired.
   */
  private async candidateEstimates(
    context: TaskContext,
    repo: Pick<EstimateRepository, 'findByTenant'>,
    reference: string | undefined,
  ): Promise<Estimate[]> {
    const byCustomer = await this.estimatesForResolvedCustomer(context, repo);
    if (byCustomer.length > 0) {
      // "Nudge EST-0042 for the Khans" — when the spoken reference also names
      // a specific document, narrow within the customer's own estimates
      // rather than handing back every one of them as ambiguous. Narrowing
      // only ever applies when it matches something.
      const narrowed = reference ? narrowByEstimateNumber(byCustomer, reference) : [];
      return narrowed.length > 0 ? narrowed : byCustomer;
    }
    if (typeof reference === 'string' && reference.trim().length > 0) {
      return safeFindEstimatesByTenant(repo, context.tenantId, reference.trim());
    }
    return [];
  }

  /**
   * customer → jobs → estimates. Empty (never throws) when no customer was
   * resolved, when `jobRepo` isn't wired or lacks the OPTIONAL
   * `findByCustomer`, or when the customer has no jobs/estimates — each of
   * which degrades to the display-text fallback above, i.e. today's behavior.
   */
  private async estimatesForResolvedCustomer(
    context: TaskContext,
    repo: Pick<EstimateRepository, 'findByTenant'>,
  ): Promise<Estimate[]> {
    const customerId = resolvedCustomerIdFrom(context);
    const jobRepo = this.deps.jobRepo;
    if (!customerId || !jobRepo?.findByCustomer) return [];
    try {
      // Default scope (active jobs — canceled excluded) is deliberate: an
      // estimate on a canceled job isn't something to chase. If that scope
      // yields nothing the display-text fallback still runs.
      const jobs = await jobRepo.findByCustomer(context.tenantId, customerId, {
        limit: NUDGE_CUSTOMER_JOB_LIMIT,
      });
      if (jobs.length === 0) return [];
      return await repo.findByTenant(context.tenantId, {
        jobIds: jobs.map((j) => j.id),
        limit: NUDGE_CUSTOMER_ESTIMATE_LIMIT,
      });
    } catch {
      return [];
    }
  }

  /** AC-1 — unique, verified, NUDGEABLE match: lifts the gate outright. */
  private liftGate(
    context: TaskContext,
    payload: Record<string, unknown>,
    target: Estimate,
  ): TaskResult {
    payload.estimateId = target.id;
    return {
      proposal: createProposal(
        inputFor(context, this.taskType, payload, [], {
          // Repo-confirmed, not copied from LLM/router text — safe to
          // allowlist against assistant.ts's dropUnverifiedIds the same way
          // resolveEstimateIdGate's verifiedIds does.
          sourceContext: { verifiedIds: { estimateId: target.id } },
        }),
      ),
      taskType: this.taskType,
    };
  }

  /** AC-2 — two or more nudgeable matches: ask, never guess. */
  private clarify(
    context: TaskContext,
    reference: string,
    candidates: Estimate[],
    now: Date,
  ): TaskResult {
    return {
      proposal: createProposal({
        tenantId: context.tenantId,
        proposalType: 'voice_clarification',
        payload: {
          transcript: context.message,
          reason: 'ambiguous_entity',
          entityReference: reference,
          entityCandidates: candidates.map((c) => nudgeCandidateFrom(c, now)),
        },
        summary: `Which estimate? "${reference}" matched ${candidates.length} sent, unanswered estimates`,
        explanation: `Heard the request, but ${candidates.length} sent-and-unanswered estimates match. Tap the right one below.`,
        sourceContext: baseSourceContext(context),
        createdBy: context.userId,
      }),
      taskType: 'voice_clarification',
    };
  }

  /**
   * AC-3 (decision, logged above and in b8.10-design.md) — a unique match
   * exists but its status isn't nudgeable: gate honestly with the reason on
   * `explanation`, rather than a clarification picker with one dead row.
   * estimateId is still stamped (review-card context, exactly as
   * resolveEstimateIdGate stamps a free-text-resolved target) but the gate
   * never lifts.
   */
  private gateNonNudgeable(
    context: TaskContext,
    payload: Record<string, unknown>,
    target: Estimate,
  ): TaskResult {
    payload.estimateId = target.id;
    return {
      proposal: createProposal(
        inputFor(context, this.taskType, payload, ['estimateId'], {
          explanation:
            `The ${target.estimateNumber} estimate is '${target.status}' — only a sent, ` +
            'still-unanswered estimate can be nudged.',
        }),
      ),
      taskType: this.taskType,
    };
  }
}

/** Never throws — a repo hiccup fails closed to "unverified", same posture
 *  as resolveTargetEstimate (estimate-edit-task.ts). */
async function safeFindEstimateById(
  repo: Pick<EstimateRepository, 'findById'>,
  tenantId: string,
  id: string,
): Promise<Estimate | null> {
  try {
    return await repo.findById(tenantId, id);
  } catch {
    return null;
  }
}

/**
 * The customer the request is about: the router-resolved spoken name first
 * (`existingEntities.customerId`, populated for send_estimate_nudge via
 * CUSTOMER_REF_INTENTS), then the verified inbound caller
 * (`context.customerId`) — the same precedence SendPaymentReminderTaskHandler
 * uses for its customer → jobs → invoices walk. UUID-shaped only, so
 * free-text that leaked into the id slot is never used as a scope.
 */
function resolvedCustomerIdFrom(context: TaskContext): string | undefined {
  const fromRouter = context.existingEntities?.customerId;
  if (isUuid(fromRouter)) return fromRouter;
  return isUuid(context.customerId) ? context.customerId : undefined;
}

/** Estimates whose number contains the spoken reference ("EST-0042"). */
function narrowByEstimateNumber(estimates: Estimate[], reference: string): Estimate[] {
  const needle = reference.trim().toLowerCase();
  if (needle.length === 0) return [];
  return estimates.filter((e) => e.estimateNumber.toLowerCase().includes(needle));
}

/** Never throws — a repo hiccup degrades to "no matches", same posture as
 *  candidatesForReference (resolution/reference-candidates.ts). */
async function safeFindEstimatesByTenant(
  repo: Pick<EstimateRepository, 'findByTenant'>,
  tenantId: string,
  search: string,
): Promise<Estimate[]> {
  try {
    return await repo.findByTenant(tenantId, { search, limit: 5 });
  } catch {
    return [];
  }
}

// ───────────── send_payment_reminder ─────────────
//
// Comms class — never auto-approves. An ad-hoc voice reminder ("chase the
// Smith invoice") delivers the same overdue notice the dunning sweep sends,
// but on demand. The execution handler only acts on invoiceId; the cadence
// fields (stepKey / offsetDays / channel) are audit-only metadata, so we stamp
// manual defaults. U1: the router's entity resolver (INVOICE_DOC_INTENTS)
// resolves the spoken reference pre-draft — a unique verified match lifts the
// invoiceId gate; anything else stays flagged missing for the review UI.
export class SendPaymentReminderTaskHandler implements TaskHandler {
  readonly taskType = 'send_payment_reminder' as const;

  // Layer 3 (best-effort) — when a resolved caller's invoices already got a
  // reminder recently, the draft is annotated so the owner sees it before
  // approving. All three deps are optional; any missing → no marker, exact
  // legacy drafting. The authoritative dedup is the 72h execution-time cooldown.
  constructor(
    private readonly deps?: {
      dunningEventRepo?: DunningEventRepository;
      invoiceRepo?: InvoiceRepository;
      jobRepo?: JobRepository;
    },
  ) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {
      stepKey: 'manual',
      offsetDays: 0,
      channel: ee.sendChannel ?? 'sms',
    };
    const missing: string[] = [];

    // U1 — `send_payment_reminder` is one of INVOICE_DOC_INTENTS, so the
    // router's entity resolver resolves the spoken reference pre-draft and a
    // unique verified match rides existingEntities.invoiceId. Consume it
    // (resolve-then-gate, B5.3 shape); only an unresolved reference keeps the
    // legacy missing-marker for review-time resolution.
    const resolvedInvoiceId = resolvedInvoiceIdFrom(context);
    if (resolvedInvoiceId) {
      payload.invoiceId = resolvedInvoiceId;
    } else {
      missing.push('invoiceId');
    }

    if (ee.jobReference) payload.invoiceReference = ee.jobReference;
    else if (ee.customerName) payload.invoiceReference = ee.customerName;

    await this.attachDuplicateReminderMarker(context, payload);

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }

  /**
   * Best-effort draft-time duplicate-reminder marker. When the router resolved
   * a concrete caller (`context.customerId`) and all three deps are wired, walk
   * that customer's recent jobs → unpaid invoices → reminder events; if the
   * most recent reminder is within DUNNING_MARKER_WINDOW_MS, annotate the
   * payload with a synthesized 'medium' confidence + a marker on `invoiceId`.
   * Never throws and never blocks drafting: any error → draft without a marker.
   */
  private async attachDuplicateReminderMarker(
    context: TaskContext,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const customerId = context.customerId;
    const dunningEventRepo = this.deps?.dunningEventRepo;
    const invoiceRepo = this.deps?.invoiceRepo;
    const jobRepo = this.deps?.jobRepo;
    // findByCustomer is OPTIONAL on JobRepository — guard for its absence.
    if (!customerId || !dunningEventRepo || !invoiceRepo || !jobRepo?.findByCustomer) {
      return;
    }
    try {
      const now = context.now ?? new Date();
      const jobs = (await jobRepo.findByCustomer(context.tenantId, customerId)).slice(0, 20);
      if (jobs.length === 0) return;

      const invoices = await invoiceRepo.findByJobs(
        context.tenantId,
        jobs.map((j) => j.id),
      );
      const unpaid = invoices.filter(
        (inv) => inv.status === 'open' || inv.status === 'partially_paid',
      );
      if (unpaid.length === 0) return;

      let mostRecent: DunningEvent | undefined;
      for (const inv of unpaid) {
        const events = await dunningEventRepo.findByInvoice(context.tenantId, inv.id);
        for (const e of events) {
          if (e.kind !== 'reminder') continue;
          if (!mostRecent || e.sentAt.getTime() > mostRecent.sentAt.getTime()) {
            mostRecent = e;
          }
        }
      }
      if (!mostRecent) return;

      const ageMs = now.getTime() - mostRecent.sentAt.getTime();
      if (ageMs < 0 || ageMs > DUNNING_MARKER_WINDOW_MS) return;

      const days = Math.max(1, Math.round(ageMs / DAY_MS));
      const channel = mostRecent.channel ?? 'unknown channel';
      const reason =
        `A payment reminder already went to this customer ${days} day(s) ago ` +
        `(${mostRecent.stepKey}, ${channel}) — approving will send another.`;

      const existingMeta =
        payload._meta && typeof payload._meta === 'object' && !Array.isArray(payload._meta)
          ? (payload._meta as Record<string, unknown>)
          : {};
      const existingMarkers = Array.isArray(existingMeta.markers)
        ? (existingMeta.markers as unknown[])
        : [];
      payload._meta = {
        ...existingMeta,
        // Synthesized envelope requires overallConfidence; advisory layer is
        // only authorized to assert the neutral 'medium' (marker.ts contract).
        overallConfidence: 'medium',
        markers: [...existingMarkers, { path: 'invoiceId', reason }],
      };
    } catch {
      // best-effort — a duplicate-check hiccup must never block drafting.
    }
  }
}

// ───────────── apply_late_fee ─────────────
//
// Money class — never auto-approves; the owner sees and approves the amount.
// We surface what the owner stated ("add a $25 late fee") or flag feeCents
// missing for the review card — we never invent a charge. stepKey 'manual'
// distinguishes an on-demand fee from the dunning ledger's accrual steps and
// makes the fee line idempotent (the execution handler keys on
// `late-fee:<stepKey>`, so re-executing this proposal can't double-charge).
// U1: `apply_late_fee` is one of INVOICE_DOC_INTENTS — the router's entity
// resolver resolves the spoken reference pre-draft and a unique verified
// match (existingEntities.invoiceId) lifts the gate; an unresolved reference
// keeps invoiceId flagged for the review UI. feeCents stays integer cents
// end-to-end (ee.amount is already cents from the classifier).
export class ApplyLateFeeTaskHandler implements TaskHandler {
  readonly taskType = 'apply_late_fee' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = { stepKey: 'manual' };
    const missing: string[] = [];

    // U1 — resolve-then-gate on the resolver seam (see class comment).
    const resolvedInvoiceId = resolvedInvoiceIdFrom(context);
    if (resolvedInvoiceId) {
      payload.invoiceId = resolvedInvoiceId;
    } else {
      missing.push('invoiceId');
    }

    if (ee.jobReference) payload.invoiceReference = ee.jobReference;
    else if (ee.customerName) payload.invoiceReference = ee.customerName;

    if (typeof ee.amount === 'number' && ee.amount > 0) {
      payload.feeCents = ee.amount;
    } else {
      missing.push('feeCents');
    }

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── batch_invoice ─────────────
//
// "Invoice all my completed jobs" — enumerates the SAME completed-unbilled
// candidates the batch sweep + digest use (findJobsRequiringInvoicing) and
// mints ONE batch_invoice proposal that, on approval, fans out a draft_invoice
// per job (each separately reviewed before sending). Capture-class. When
// nothing is billable, emits a clarification instead of an empty batch (the
// execution handler rejects an empty jobs[] / the schema requires min 1).
export class BatchInvoiceTaskHandler implements TaskHandler {
  readonly taskType = 'batch_invoice' as const;

  constructor(private readonly invoicingDeps?: InvoicingQueueDeps) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    if (!this.invoicingDeps) {
      return this.clarify(context, 'Batch invoicing is not available right now.');
    }
    const candidates = await findJobsRequiringInvoicing(context.tenantId, this.invoicingDeps);
    if (candidates.length === 0) {
      return this.clarify(context, 'You have no completed jobs waiting to be invoiced right now.');
    }
    const now = context.now ?? new Date();
    const payload: Record<string, unknown> = {
      batchDate: now.toISOString().slice(0, 10),
      totalCents: candidates.reduce((sum, c) => sum + c.amountCents, 0),
      jobs: candidates.map((c) => ({
        jobId: c.jobId,
        customerId: c.customerId,
        ...(c.estimateId ? { estimateId: c.estimateId } : {}),
        amountCents: c.amountCents,
        discountCents: c.discountCents,
        taxRateBps: c.taxRateBps,
        lineItems: c.lineItems,
      })),
    };
    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, [])),
      taskType: this.taskType,
    };
  }

  // voice_clarification is the established "can't proceed, tell the operator"
  // surface. Reuses the file's createProposal + baseSourceContext; missing_entities
  // is the right reason for "nothing billable to put in the batch".
  private clarify(context: TaskContext, message: string): TaskResult {
    return {
      proposal: createProposal({
        tenantId: context.tenantId,
        proposalType: 'voice_clarification',
        payload: {
          transcript: context.message,
          reason: 'missing_entities',
          classifierReasoning: message,
        },
        summary: context.message,
        sourceContext: baseSourceContext(context),
        createdBy: context.userId,
      }),
      taskType: 'voice_clarification',
    };
  }
}

// ───────────── create_invoice_schedule (U2) ─────────────
//
// "Set up 50% deposit, 50% on completion for the Hendersons" — the voice
// on-ramp for the EXISTING create_invoice_schedule proposal type + execution
// handler (P21-002). The classifier extracts the VERBATIM milestone sentence
// (scheduleDescription); the deterministic milestone-sentence parser — never
// the LLM — turns it into typed milestones that satisfy validateMilestones.
// jobReference rides the router's entity annotation: a unique job match lands
// as a verified payload.jobId; otherwise jobId is flagged missing for the
// review UI. An unparseable sentence flags `milestones` missing and preserves
// the raw sentence on the payload so the reviewer sees exactly what was said.
// Capture-class; no sourceTrustTier is passed, so it always drafts for review.
export class CreateInvoiceScheduleTaskHandler implements TaskHandler {
  readonly taskType = 'create_invoice_schedule' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    // P8 — verified jobId resolved by the router from the spoken reference.
    const resolvedJobId =
      typeof context.existingEntities?.jobId === 'string'
        ? context.existingEntities.jobId
        : undefined;
    if (resolvedJobId) payload.jobId = resolvedJobId;
    if (ee.jobReference) payload.jobReference = ee.jobReference;
    if (!resolvedJobId) missing.push('jobId');

    const sentence =
      typeof ee.scheduleDescription === 'string' ? ee.scheduleDescription.trim() : '';
    if (sentence) payload.scheduleDescription = sentence;
    const milestones = sentence ? parseMilestoneSentence(sentence) : null;
    if (milestones) {
      payload.milestones = milestones;
    } else {
      // Unparseable (or absent) plan — hold in draft; the raw sentence above
      // gives the reviewer the exact words to build the plan from.
      missing.push('milestones');
    }

    // Spoken job total, when stated. Optional on the contract — the executor
    // derives the total from the estimate when omitted.
    if (typeof ee.amount === 'number' && ee.amount > 0) {
      payload.totalAmountCents = ee.amount;
    }

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

// ───────────── record_refund ─────────────
//
// Tradesperson wave 1, Task 3 (2026-08-07 plan) — a NEW money-class
// proposal type for recording a MANUAL refund (cash/check/external card)
// given back to a customer. Money class — never auto-approves under any
// confidence (D3). Stripe-AUTOMATED refunds are explicitly OUT OF SCOPE
// (YAGNI) — see RecordRefundExecutionHandler
// (proposals/execution/record-refund-handler.ts) for the full analysis of
// why this rides the existing `recordRefund()` domain function instead of
// a new refund ledger.
//
// Reference resolution: unlike `update_catalog_item` (whose reference has
// no membership in the generic entity-resolver's `EntityKind`), an invoice
// reference is a first-class kind the resolver already handles for
// `record_payment` and its siblings — this intent joins
// `INVOICE_DOC_INTENTS` (entity-resolution.ts) instead of re-resolving it
// here. That means by the time this handler runs, the voice-action-router
// has ALREADY resolved the spoken reference (carried on `ee.jobReference` —
// there is no separate `invoiceReference` extraction field anywhere in this
// taxonomy; every invoice-doc intent reuses jobReference, disambiguated by
// intent-set membership) to a verified `invoiceId` and stamped it onto
// `context.existingEntities`, OR short-circuited to a `voice_clarification`
// on an ambiguous match, OR left it absent on no match / nothing spoken.
// `invoiceId` is therefore read off `ee` with a local type-widening cast
// (house pattern — see `ComplaintTaskHandler`, which does the same for a
// router-resolved `jobId`/`customerId`): it is a ROUTER-INJECTED verified
// id, never an LLM-extracted field, so it is deliberately NOT added to
// `ExtractedEntities` or the classifier's JSON template/parse allowlist.
//
// Unlike `record_payment`'s contract, `record_refund`'s has NO
// `invoiceReference` fallback field — an unresolved reference gates the
// proposal (`missingFields: ['invoiceId']`) rather than persisting free
// text (e.g. a bare customer name) as a stand-in "reference" for a later
// step to puzzle out. This is a deliberately SAFER posture than
// `record_payment`'s own precedent for the identical case.
export class RecordRefundTaskHandler implements TaskHandler {
  readonly taskType = 'record_refund' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context) as ExtractedEntities & { invoiceId?: string };
    const payload: Record<string, unknown> = {
      // Method defaults to 'cash' when unstated — the most common manual
      // refund, and never blocks drafting on a detail the reviewer can
      // correct with one tap before approving.
      method: ee.refundMethod ?? 'cash',
    };
    const missing: string[] = [];

    if (typeof ee.invoiceId === 'string' && ee.invoiceId.length > 0) {
      payload.invoiceId = ee.invoiceId;
    } else {
      missing.push('invoiceId');
    }

    if (typeof ee.amount === 'number' && ee.amount > 0) {
      payload.amountCents = Math.round(ee.amount);
    } else {
      missing.push('amountCents');
    }

    if (typeof ee.refundReason === 'string' && ee.refundReason.trim().length > 0) {
      payload.reason = ee.refundReason.trim();
    }
    if (typeof ee.refundCheckNumber === 'string' && ee.refundCheckNumber.trim().length > 0) {
      payload.checkNumber = ee.refundCheckNumber.trim();
    }

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
//
// U3 (B7.8) — `log_expense` joined JOB_REF_INTENTS, so the router's entity
// resolver resolves "the Henderson job" pre-draft and a unique verified
// match rides existingEntities.jobId. The handler stamps it onto the
// payload so LogExpenseExecutionHandler persists the link and job P&L
// (lookup_job_profit) counts the spoken expense. No new gate: an expense
// with no (or an unresolved) job mention still logs UNLINKED, exactly as
// before — resolution only adds the link. An AMBIGUOUS job never reaches
// here (the router short-circuits to a voice_clarification picker).
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

    // U3 — resolver-verified job id (shape-checked; same seam every other
    // voice task consumes). The spoken reference is kept for the review card.
    const resolvedJobId = context.existingEntities?.jobId;
    if (isUuid(resolvedJobId)) payload.jobId = resolvedJobId;
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

/** "2 hours", "1 hour 30 minutes", "45 minutes" — readback only. */
function formatWorkedDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} ${h === 1 ? 'hour' : 'hours'}`);
  if (m > 0 || h === 0) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`);
  return parts.join(' ');
}

//
// Clocks the speaking technician in on a job/task. entryType defaults to
// 'job'.
//
// RV-051 finding — the confirm turn IS the proposal. This handler creates
// a capture-class proposal with no sourceTrustTier, so decideInitialStatus
// lands it in 'draft': a human always confirms (review card / one-tap SMS)
// before LogTimeEntryExecutionHandler actually clocks anyone in. There is
// no separate spoken confirm turn to invent on this path — what was
// missing was the CONTENT of that confirmation:
//
//   1. The router's entity resolver (P8) already resolves the free-text
//      jobReference ("the Patel job") to a verified jobId on
//      context.existingEntities.jobId — but this handler used to DROP it,
//      so the executor (which reads ONLY payload.jobId) clocked in with
//      no job even after a successful resolution. The resolved id now
//      lands on the payload (jobReference kept for display).
//   2. A job-type entry with no resolved job now flags `jobId` missing,
//      holding the proposal in draft for the operator to complete instead
//      of silently clocking in unattached to any job. (An AMBIGUOUS
//      reference never reaches here — the router short-circuits to a
//      voice_clarification with the candidate list first.)
//   3. The proposal summary is now a readback — "Clocking you in on the
//      Patel job — right?" — so every confirm surface (review card, SMS
//      render, voice readback) asks the question instead of echoing the
//      raw transcript.
export class LogTimeEntryTaskHandler implements TaskHandler {
  readonly taskType = 'log_time_entry' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const entryType = ee.timeEntryType ?? 'job';
    const payload: Record<string, unknown> = { entryType };
    const missing: string[] = [];

    // RETROACTIVE capture — "put me down for two hours on this one".
    // The classifier now states a COMPLETED duration in whole minutes (the
    // unit time_entries.duration_minutes stores). Before this the number was
    // dropped on the floor: the utterance landed as an add_note whose body
    // said "this was two hours", and no billable time entry ever existed.
    // Absent => the unchanged clock-in path.
    const durationMinutes =
      typeof ee.durationMinutes === 'number' &&
      Number.isFinite(ee.durationMinutes) &&
      ee.durationMinutes > 0
        ? Math.round(ee.durationMinutes)
        : undefined;
    if (durationMinutes !== undefined) payload.durationMinutes = durationMinutes;

    // P8 — verified jobId resolved by the router from the spoken name.
    const resolvedJobId =
      typeof context.existingEntities?.jobId === 'string'
        ? context.existingEntities.jobId
        : undefined;
    if (resolvedJobId) payload.jobId = resolvedJobId;
    if (ee.jobReference) payload.jobReference = ee.jobReference;
    if (entryType === 'job' && !resolvedJobId) missing.push('jobId');

    const readback =
      durationMinutes !== undefined
        ? entryType === 'job'
          ? `Logging ${formatWorkedDuration(durationMinutes)} on ${ee.jobReference ?? 'this job'} — right?`
          : `Logging ${formatWorkedDuration(durationMinutes)} of ${entryType} time — right?`
        : entryType === 'job'
          ? `Clocking you in on ${ee.jobReference ?? 'a job'} — right?`
          : entryType === 'drive'
            ? 'Starting your drive time — right?'
            : entryType === 'break'
              ? 'Starting your break — right?'
              : 'Logging admin time — right?';

    return {
      proposal: createProposal({
        ...inputFor(context, this.taskType, payload, missing),
        summary: readback,
      }),
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
// classifier's extracted fields to the required schema shape.
//
// B6 fix — the router's entity resolver (P8) already resolves the
// free-text customerName to a verified customerId on
// context.existingEntities.customerId when the match is unique — but
// this handler used to DROP it and unconditionally gate customerId,
// so every create_job stalled at review even on an unambiguous
// resolution. Mirror LogTimeEntryTaskHandler/CreateInvoiceScheduleTaskHandler:
// consume the resolved id when present, only gate when genuinely absent.
export class CreateJobVoiceTaskHandler implements TaskHandler {
  readonly taskType = 'create_job' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    // P8 — verified customerId resolved by the router from the spoken name.
    const resolvedCustomerId =
      typeof context.existingEntities?.customerId === 'string'
        ? context.existingEntities.customerId
        : undefined;
    if (resolvedCustomerId) payload.customerId = resolvedCustomerId;
    if (ee.customerName) payload.customerReference = ee.customerName;
    if (!resolvedCustomerId) missing.push('customerId');

    if (ee.jobTitle) payload.title = ee.jobTitle;
    else if (ee.jobReference) payload.title = ee.jobReference;
    else missing.push('title');

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── update_catalog_item ─────────────
//
// Tradesperson wave 1, Task 2 (2026-08-07 plan) — the voice ON-RAMP for
// WS20's existing correction-repetition proposal type
// (proposals/contracts/update-catalog-item.ts) and its execution handler
// (proposals/execution/update-catalog-item-handler.ts) — both pre-exist and
// are NOT modified here. Capture-class: moves no money, only shapes a
// FUTURE catalog write that is itself reviewed.
//
// Contract-compatibility notes (read before changing this class):
//
//   1. `evidence` (lessonIds + correctionCount) is a REQUIRED nested object
//      on `updateCatalogItemPayloadSchema`, but it exists to carry the
//      correction-repetition loop's real provenance ("you've corrected this
//      N times") — a live voice utterance has no lesson to point to, and
//      `lessonIds` requires at least one real id. This handler deliberately
//      OMITS `evidence` rather than fabricating one:
//        - UpdateCatalogItemExecutionHandler.execute() never reads
//          payload.evidence (only catalogItemId + proposedUnitPriceCents),
//          so omitting it does not affect execution.
//        - approveProposal (proposals/actions.ts) only blocks on the
//          tracked `missingFields` list, not full Zod re-validation, so an
//          unambiguous price-only draft (missingFields: []) still approves
//          with one tap — proven by this type's row in
//          test/proposals/voice-payload-contract.test.ts.
//        - The one thing this cannot support: editing this proposal's
//          fields via the generic `editProposal` path before approval,
//          which revalidates the FULL merged payload against the Zod
//          schema and would reject it for the still-missing `evidence` key.
//          Fixing that means loosening the WS20 contract itself, which is
//          out of this task's scope (Files list) — flagged as a follow-up,
//          not silently worked around.
//
//   2. `catalogItemNewName`/`catalogItemNewDescription` changes cannot
//      actually EXECUTE today: the contract's `name` field is documented as
//      informational-only ("name at proposal time") and there is no
//      `description` field on the contract at all — the execution handler
//      only ever writes `proposedUnitPriceCents`. So a spoken rename/
//      description change is never written to `payload.name`/
//      `payload.description` (that would silently no-op on approval,
//      misleading the reviewer into thinking it applied); instead it rides
//      `proposal.explanation` as a human-readable note pointing at the
//      Catalog screen. Only a price change is a real, executable proposal
//      field here.
//
//   3. Reference resolution reuses `resolveLineItemToCatalog` (ai/resolution/
//      catalog-resolver.ts) — the SAME matcher draft_invoice/draft_estimate
//      use to ground spoken line items — rather than a bespoke substring
//      match. Quality-review correction (2026-08-08): the real win here is
//      RECOVERABLE ambiguity (a flat gate key + scored candidates the
//      reviewer can pick from) and robustness to speech variants
//      (punctuation/plural folding, token overlap) — NOT prefix
//      disambiguation. A prefix-shadowed pair ("AC tune-up" vs "AC tune-up
//      deluxe") still lands 'ambiguous' here: this task's own test proves
//      it (the two candidates score within MARGIN=0.15 of each other, and a
//      price-differing tie is never broken silently). 'exact'/'high' resolve
//      outright; 'ambiguous' gates with candidates surfaced on
//      `sourceContext.entityCandidates` (AC-3/B2 pattern — see
//      SendEstimateNudgeTaskHandler); 'none' gates with no candidates.
//      `missingFields` entries are FLAT payload keys (`catalogItemId` /
//      `proposedUnitPriceCents`), never prose — prose reasons live on
//      `explanation` instead, per `clearSatisfiedMissingFields`
//      (missing-fields.ts): it only lifts a gate on an EXACT flat-key edit,
//      so a prose entry can never clear.
export class UpdateCatalogItemTaskHandler implements TaskHandler {
  readonly taskType = 'update_catalog_item' as const;

  constructor(private readonly catalogRepo?: CatalogItemRepository) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];
    const explanationParts: string[] = [];
    let sourceContext: Record<string, unknown> | undefined;

    const reference = typeof ee.catalogItemReference === 'string' ? ee.catalogItemReference.trim() : '';
    let resolvedItem: CatalogItem | undefined;

    if (!reference || !this.catalogRepo) {
      missing.push('catalogItemId');
    } else {
      const items = await this.catalogRepo.listByTenant(context.tenantId);
      const resolution = resolveLineItemToCatalog(reference, items);
      if ((resolution.tier === 'exact' || resolution.tier === 'high') && resolution.match) {
        resolvedItem = resolution.match;
      } else {
        missing.push('catalogItemId');
        if (resolution.tier === 'ambiguous' && resolution.candidates) {
          explanationParts.push(
            `No confident single match for "${reference}" — edit the proposal with the correct catalog item.`,
          );
          // Not `EntityCandidate[]` — 'catalogItem' isn't a member of
          // `EntityKind` (entity-resolver.ts), which is out of this task's
          // scope to extend. Same field SHAPE (id/kind/label/hint/score) as
          // the AC-3/B2 pattern for display purposes only; this type has no
          // resolve-entity.ts redraft handler, so nothing depends on `kind`
          // being a real EntityKind member.
          sourceContext = {
            entityCandidates: resolution.candidates.map((c) => ({
              id: c.item.id,
              kind: 'catalogItem',
              label: c.item.name,
              hint: formatCents(c.item.unitPriceCents),
              score: c.score,
            })),
            entityKind: 'catalogItem',
            entityReference: reference,
          };
        } else {
          explanationParts.push(`No catalog item matches "${reference}".`);
        }
      }
    }

    // Only a stated, non-negative integer cents value is a real price
    // change — mirrors the durationMinutes sanity check elsewhere in this
    // file (an LLM occasionally answers with a negative or fractional
    // number).
    const requestedPriceCents =
      typeof ee.unitPriceCents === 'number' && Number.isFinite(ee.unitPriceCents) && ee.unitPriceCents >= 0
        ? Math.round(ee.unitPriceCents)
        : undefined;
    const hasName = typeof ee.catalogItemNewName === 'string' && ee.catalogItemNewName.trim().length > 0;
    const hasDescription =
      typeof ee.catalogItemNewDescription === 'string' && ee.catalogItemNewDescription.trim().length > 0;
    if (requestedPriceCents === undefined && !hasName && !hasDescription) {
      missing.push('proposedUnitPriceCents');
      explanationParts.push('No price, name, or description change was stated.');
    }

    if (resolvedItem) {
      payload.catalogItemId = resolvedItem.id;
      // Informational per the contract's own doc comment (name AT PROPOSAL
      // TIME, for the summary/UI) — the resolved item's REAL current name,
      // never the requested new one (see class doc comment note 2).
      payload.name = resolvedItem.name;
      payload.currentUnitPriceCents = resolvedItem.unitPriceCents;
      // No stated price change ⇒ proposed === current (an honest "no price
      // change" value the schema's required field accepts) rather than a
      // fabricated number.
      payload.proposedUnitPriceCents = requestedPriceCents ?? resolvedItem.unitPriceCents;
    }

    if (hasName) {
      explanationParts.push(
        `Requested new name: "${(ee.catalogItemNewName as string).trim()}" — not applied by this proposal; rename from the Catalog screen.`,
      );
    }
    if (hasDescription) {
      explanationParts.push(
        `Requested new description: "${(ee.catalogItemNewDescription as string).trim()}" — not applied by this proposal; edit from the Catalog screen.`,
      );
    }

    return {
      proposal: createProposal(
        inputFor(context, this.taskType, payload, missing, {
          ...(explanationParts.length > 0 ? { explanation: explanationParts.join(' ') } : {}),
          ...(sourceContext ? { sourceContext } : {}),
        }),
      ),
      taskType: this.taskType,
    };
  }
}
