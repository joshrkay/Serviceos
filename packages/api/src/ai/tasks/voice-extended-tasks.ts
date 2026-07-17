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
import type { InvoiceRepository } from '../../invoices/invoice';
import type { LLMGateway } from '../gateway/gateway';
import { resolveDateTime, DEFAULT_TENANT_TIMEZONE } from '../scheduling/resolve-datetime';
import { findJobsRequiringInvoicing, InvoicingQueueDeps } from '../../invoices/invoicing-queue';
import {
  DunningEvent,
  DunningEventRepository,
  DUNNING_MARKER_WINDOW_MS,
} from '../../invoices/dunning-config';
import { parseMilestoneSentence } from '../../invoices/milestone-sentence-parser';

const DAY_MS = 24 * 60 * 60 * 1000;

function entitiesFrom(context: TaskContext): ExtractedEntities {
  return (context.existingEntities ?? {}) as ExtractedEntities;
}

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
    const resolved = phrase
      ? resolveDateTime(phrase, {
          timezone: context.timezone ?? DEFAULT_TENANT_TIMEZONE,
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
// The classifier returns a TECHNICIAN NAME, never a UUID. The execution
// handler needs a concrete `toTechnicianId`. U1: the router's entity
// resolver (kind 'technician', pg_trgm over users) resolves the spoken
// name BEFORE this handler runs — a unique match rides
// `context.existingEntities.technicianId` as a verified UUID and lands
// on the payload; an AMBIGUOUS name never reaches here (the router
// short-circuits to a voice_clarification picker). Only when the name
// stayed unresolved (not_found / no resolver) do we keep the legacy
// missing-marker so the review UI resolves it before approval.
export class ReassignAppointmentTaskHandler implements TaskHandler {
  readonly taskType = 'reassign_appointment' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    // The execution handler acts only on a concrete appointmentId (uuid), so
    // a free-text reference always flags the id for review-time resolution.
    // Pre-U1 this was masked by the always-missing toTechnicianId; now that
    // the technician can resolve, the appointment gate must stand on its own.
    if (ee.appointmentReference) payload.appointmentReference = ee.appointmentReference;
    missing.push('appointmentId');

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
// matches a team member, so only the appointmentId still needs review-time
// resolution; an unresolved name keeps the legacy technicianId
// missing-marker. Capture-class, but the missing appointmentId keeps the
// proposal in draft until an operator resolves it.
export class AddCrewMemberTaskHandler implements TaskHandler {
  readonly taskType = 'add_crew_member' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = ['appointmentId'];

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
    const missing: string[] = ['appointmentId'];

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
//
// PR review finding (2026-07): unlike issue_invoice's execution handler
// (resolveInvoice() in proposals/execution/issue-invoice-handler.ts, which
// looks a bare/"INV-0042"-style reference up by repo), SendInvoiceExecutionHandler
// (proposals/execution/voice-extended-handlers.ts) requires payload.invoiceId
// to ALREADY be a UUID and never reads invoiceReference at all — there is no
// resolution step anywhere between drafting and execution for this proposal
// type. This handler used to flag invoiceId missing only when NO reference
// was extracted, so e.g. "send the Henderson invoice" landed with
// invoiceReference: 'Henderson' and an EMPTY missingFields. approveProposal
// (proposals/actions.ts) only blocks on missingFields, so the proposal was
// approvable straight from drafting and execution would then fail on the
// unresolved reference — approval succeeding for an action that can never
// execute. Mirrors the established sibling convention (ApplyLateFeeTaskHandler,
// SendEstimateNudgeTaskHandler, SendPaymentReminderTaskHandler,
// ReassignAppointmentTaskHandler): always gate the id for review-time
// resolution unless the extracted reference already IS a usable id.
export class SendInvoiceTaskHandler implements TaskHandler {
  readonly taskType = 'send_invoice' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {
      channel: ee.sendChannel ?? 'email',
    };
    const missing: string[] = [];

    const reference = ee.jobReference ?? ee.customerName;
    if (isUuid(reference)) {
      // Already a resolved id — the execution handler can use it directly,
      // no review-time resolution needed.
      payload.invoiceId = reference;
    } else {
      if (reference) payload.invoiceReference = reference;
      missing.push('invoiceId');
    }

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

// ───────────── send_estimate_nudge ─────────────
//
// Comms class — never auto-approves. A nudge re-sends the link for an
// ALREADY-sent estimate (the execution handler enforces a 48h cooldown and
// requires the estimate to be in 'sent'). Mirrors SendEstimateTaskHandler:
// carry estimateReference (free text) and flag estimateId missing so the
// operator resolves it in the review card before approval.
export class SendEstimateNudgeTaskHandler implements TaskHandler {
  readonly taskType = 'send_estimate_nudge' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    // estimateId is a required UUID for the execution handler and is NOT
    // resolved by the customer/job entity resolver — always flag it missing so
    // the approval gate holds until the operator resolves the estimate (matches
    // reassign_appointment's toTechnicianId contract). The reference, when
    // present, gives the review card something to resolve from.
    const missing: string[] = ['estimateId'];

    if (ee.jobReference) payload.estimateReference = ee.jobReference;
    else if (ee.customerName) payload.estimateReference = ee.customerName;

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}

// ───────────── send_payment_reminder ─────────────
//
// Comms class — never auto-approves. An ad-hoc voice reminder ("chase the
// Smith invoice") delivers the same overdue notice the dunning sweep sends,
// but on demand. The execution handler only acts on invoiceId; the cadence
// fields (stepKey / offsetDays / channel) are audit-only metadata, so we stamp
// manual defaults and flag invoiceId missing for the review UI to resolve.
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
    // invoiceId is a required UUID for the execution handler and is NOT
    // resolved by the customer/job entity resolver — always flag it missing so
    // the approval gate holds until the operator resolves the invoice.
    const missing: string[] = ['invoiceId'];

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
// invoiceId is resolved from the reference by the review UI.
export class ApplyLateFeeTaskHandler implements TaskHandler {
  readonly taskType = 'apply_late_fee' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = { stepKey: 'manual' };
    // invoiceId is a required UUID for the execution handler and is NOT
    // resolved by the customer/job entity resolver — always flag it missing so
    // the approval gate holds until the operator resolves the invoice.
    const missing: string[] = ['invoiceId'];

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

    // P8 — verified jobId resolved by the router from the spoken name.
    const resolvedJobId =
      typeof context.existingEntities?.jobId === 'string'
        ? context.existingEntities.jobId
        : undefined;
    if (resolvedJobId) payload.jobId = resolvedJobId;
    if (ee.jobReference) payload.jobReference = ee.jobReference;
    if (entryType === 'job' && !resolvedJobId) missing.push('jobId');

    const readback =
      entryType === 'job'
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
