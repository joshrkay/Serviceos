/**
 * U3 (iOS blueprint) — the SHARED per-skill lookup dispatch adapter.
 *
 * The voice-action-router worker used to SKIP every `lookup_*` intent
 * because a recorded memo had no voice back-channel to speak the result
 * into. The recording row is now that back-channel: this module is the
 * per-skill dispatch adapter (mirroring `twilio-adapter.runLookupSkill`
 * and `text-mode-driver.runLookupSkill`) that executes the lookup skill
 * and flattens its NON-UNIFORM result shape (`lookup_availability`
 * returns message/slots, not `{summary, data}`) into the shared
 * `VoiceLookupAnswer` wire contract the mobile AnswerCard renders.
 *
 * SURFACE-NEUTRAL (2026-07): this switch is now the single lookup-dispatch
 * implementation behind TWO surfaces — the recorded-memo worker
 * (`workers/voice-action-router.ts`) and the in-app assistant chat
 * (`routes/assistant.ts`, via `ai/orchestration/lookup-dispatch.ts`,
 * which is where BOTH the mic button and typed input land). Nothing in
 * here may reference memo-only concepts: the correlation key is
 * `sessionId` (a memo's recordingId / a chat turn's lookup session id)
 * and the authorization subject is `actorId` (the memo creator / the
 * authenticated operator). Adding a surface means adding a caller, NOT
 * copying this switch — three drifted copies of `intentToProposalType`
 * are why that rule exists.
 *
 * Invariants honored here:
 *   - Integer cents end-to-end: skill `*Cents` values ride the answer as
 *     `money` rows; the CLIENT formats. Never floats, never pre-formatted
 *     currency strings.
 *   - Dates render in the tenant timezone (threaded by the caller).
 *   - Authorization: permission-gated lookups (`LOOKUP_REQUIRED_PERMISSION`
 *     — the owner-grade reports on `reports:view`, plus U7's lookup_leads
 *     on `customers:view` and lookup_catalog on `settings:view`, each
 *     mirroring the web route that exposes the same data) check the ASKING
 *     ACTOR's DB-authoritative role and FAIL CLOSED to a refusal answer
 *     (copy, never data) when the role is missing or lacks the permission.
 *   - Analytics: every skill call passes `lookupEvents` (keyed by the
 *     caller-supplied `sessionId`, which must be a UUID) so every surface
 *     writes the same `lookup_events` rows telephony does.
 *   - Missing deps degrade to `unsupported` (the caller keeps today's
 *     skip semantics), mirroring the adapters' LOOKUP_NOT_WIRED fallback.
 */
import type {
  VoiceAnswerEntityRef,
  VoiceAnswerRow,
  VoiceLookupAnswer,
} from '@ai-service-os/shared';
import { voiceLookupAnswerSchema, MAX_VOICE_ANSWER_ROWS } from '@ai-service-os/shared';
import { hasPermission, isValidRole, type Permission } from '../auth/rbac';
import type { IntentType } from '../ai/orchestration/intent-classifier';
import type { JobRepository } from '../jobs/job';
import type { AppointmentRepository } from '../appointments/appointment';
import type { CustomerRepository } from '../customers/customer';
import type { ProposalRepository } from '../proposals/proposal';
import type { InvoiceRepository } from '../invoices/invoice';
import type { EstimateRepository } from '../estimates/estimate';
import type { AgreementRepository } from '../agreements/agreement';
import type { MoneyDashboardRepository } from '../reports/money-dashboard';
import type { DailyDigestRepository } from '../digest/digest-service';
import type { DunningConfigRepository } from '../invoices/dunning-config';
import type { TimeEntryRepository } from '../time-tracking/time-entry';
import type { ExpenseRepository } from '../expenses/expense';
import type { LeadRepository } from '../leads/lead';
import type { CatalogItemRepository } from '../catalog/catalog-item';
import type { SettingsRepository } from '../settings/settings';
import type { LookupEventService } from '../lookup-events/lookup-event-service';
import type { AvailabilityFinder } from '../ai/tasks/availability-finder';
import type { MaterialItemRepository } from '../materials/material-item';
import type { UserRepository } from '../users/user';
import { resolveCanonicalUser } from '../users/user';
import { lookupBalance } from '../ai/skills/lookup-balance';
import { lookupInvoices } from '../ai/skills/lookup-invoices';
import { lookupCustomer } from '../ai/skills/lookup-customer';
import { lookupJobs } from '../ai/skills/lookup-jobs';
import { lookupEstimates } from '../ai/skills/lookup-estimates';
import { lookupAgreements } from '../ai/skills/lookup-agreements';
import { lookupAccountSummary } from '../ai/skills/lookup-account-summary';
import { lookupAppointments } from '../ai/skills/lookup-appointments';
import {
  lookupAvailability,
  lookupBookableAvailability,
} from '../ai/skills/lookup-availability';
import { schedulingConfigFromSettings } from '../scheduling/booking-availability';
import { lookupRevenue } from '../ai/skills/lookup-revenue';
import { lookupJobProfit } from '../ai/skills/lookup-job-profit';
import { lookupDayOverview } from '../ai/skills/lookup-day-overview';
import { lookupDigest } from '../ai/skills/lookup-digest';
import { lookupPendingItems } from '../ai/skills/lookup-pending-items';
import { lookupLeads } from '../ai/skills/lookup-leads';
import { lookupCatalog } from '../ai/skills/lookup-catalog';
import { lookupMaterials } from '../ai/skills/lookup-materials';
import { lookupCrewSchedule } from '../ai/skills/lookup-crew-schedule';
import { lookupTimesheets } from '../ai/skills/lookup-timesheets';
import { lookupMyDay } from '../ai/skills/lookup-my-day';
import { formatHours } from '../ai/skills/spoken-format';

/**
 * Permission-gated lookups: the DB-authoritative permission the ASKING
 * ACTOR must hold, checked against their resolved role and FAILING CLOSED
 * to a refusal answer. Each entry mirrors the web route exposing the same
 * data, so voice never reads out what the screen would refuse:
 *   - the owner-grade reports (E3/E4/E6/D3) — `reports:view`
 *     (routes/reports.ts); owners and dispatchers hold it, technicians
 *     get the refusal copy.
 *   - `lookup_leads` (U7) — `customers:view` (GET /api/leads); every role
 *     holds it today, so the gate only bites when the role is unresolvable.
 *   - `lookup_catalog` (U7) — `settings:view` (GET /api/catalog-items);
 *     technicians cannot browse the price book on screen, so not by voice
 *     either. (Telephony gates the same skill on `ownerSession` caller-ID
 *     identity instead, because its callers include CUSTOMERS.)
 */
export const LOOKUP_REQUIRED_PERMISSION: ReadonlyMap<IntentType, Permission> = new Map<
  IntentType,
  Permission
>([
  ['lookup_revenue', 'reports:view'],
  ['lookup_job_profit', 'reports:view'],
  ['lookup_pending_items', 'reports:view'],
  ['lookup_digest', 'reports:view'],
  ['lookup_leads', 'customers:view'],
  ['lookup_catalog', 'settings:view'],
  // Task 10 (2026-08-07 tradesperson plan) — owner-grade crew reports,
  // same permission + gating posture as the owner-extended lookups above.
  // `lookup_my_day` is deliberately ABSENT — see its case body below.
  ['lookup_crew_schedule', 'reports:view'],
  ['lookup_timesheets', 'reports:view'],
]);

/**
 * Customer-scoped lookups (E1/E5, plus E2's appointments): the skill
 * signature requires a concrete customerId, which the memo payload does
 * not carry — the router resolves the classifier's spoken customerName
 * through the entity resolver first (ambiguity → voice_clarification;
 * not-found → a "nothing found" answer; no name at all → a "which
 * customer?" answer).
 */
export const CUSTOMER_SCOPED_LOOKUP_INTENTS: ReadonlySet<IntentType> = new Set<IntentType>([
  'lookup_balance',
  'lookup_customer',
  'lookup_jobs',
  'lookup_invoices',
  'lookup_estimates',
  'lookup_agreements',
  'lookup_account_summary',
  'lookup_appointments',
]);

/**
 * Deps the router lacks for answer execution, grouped so app.ts wires
 * them as one bundle. Full repo types where the skill signatures demand
 * them (the router's own `estimateRepo`/`settingsRepo` are narrowed
 * Picks and cannot feed the skills).
 */
export interface VoiceLookupAnswerDeps {
  invoiceRepo?: InvoiceRepository;
  estimateRepo?: EstimateRepository;
  agreementRepo?: AgreementRepository;
  moneyDashboardRepo?: MoneyDashboardRepository;
  dailyDigestRepo?: DailyDigestRepository;
  dunningConfigRepo?: DunningConfigRepository;
  timeEntryRepo?: TimeEntryRepository;
  expenseRepo?: ExpenseRepository;
  /** U7 — `lookup_leads` (tenant lead pipeline; mirrors GET /api/leads). */
  leadRepo?: LeadRepository;
  /** U7 — `lookup_catalog` (price book; mirrors GET /api/catalog-items). */
  catalogRepo?: CatalogItemRepository;
  /** Full settings repo — lookup_job_profit reads the tenant labor rate. */
  settingsRepo?: SettingsRepository;
  /**
   * Task 9 (2026-08-07 tradesperson plan) — `lookup_materials` (voice
   * shopping list readback; mirrors GET-equivalent access to Task 8's
   * material_items substrate). No entry in `LOOKUP_REQUIRED_PERMISSION` —
   * deliberately unlike `lookup_leads`/`lookup_catalog` — any authenticated
   * operator (technician included) may hear the pending shopping list.
   */
  materialItemRepo?: MaterialItemRepository;
  /** P11-001 analytics table writer — the memo path now records rows too. */
  lookupEvents?: LookupEventService;
  /**
   * DB-authoritative role of the ASKING ACTOR — the memo creator
   * (voice_recordings.created_by) on the worker path, the authenticated
   * operator (req.auth.userId) on the assistant-chat path. Both are Clerk
   * subjects — resolve like `createAuthorizationLoader`. Permission-gated
   * lookups FAIL CLOSED to a refusal when absent/unresolvable.
   */
  resolveMemberRole?: (tenantId: string, userId: string) => Promise<string | null>;
}

/** Repos the router already carries that the lookup skills reuse. */
export interface SharedLookupRepos {
  jobRepo?: JobRepository;
  appointmentRepo?: AppointmentRepository;
  customerRepo?: CustomerRepository;
  proposalRepo: ProposalRepository;
  availabilityFinder?: AvailabilityFinder;
  /**
   * Task 10 (2026-08-07 tradesperson plan) — already carried by the router
   * for `en_route`'s speaker resolution (dispatch/en-route-voice.ts). Reused
   * here for the crew roster (lookup_crew_schedule), technician display
   * names (lookup_timesheets), and the SPEAKER's own identity resolution
   * (lookup_my_day) — one shared dep, not a second copy.
   */
  userRepo?: Pick<UserRepository, 'findByTenant'>;
}

export interface ExecuteLookupInput {
  tenantId: string;
  /**
   * The surface's correlation key for this lookup, written to
   * `lookup_events.session_id`. Memo path: the recording id. Assistant
   * chat: a per-turn lookup session id. MUST be a UUID — the column is
   * `session_id UUID NOT NULL` (schema.ts `061_create_lookup_events`), and
   * a non-UUID makes the analytics insert fail (silently — every skill
   * swallows audit-write errors, so the answer still lands, but the row
   * is lost).
   */
  sessionId: string;
  intent: IntentType;
  /**
   * Clerk subject of the actor asking — authoritative identity for the
   * owner-grade authz gate. Memo path: `voice_recordings.created_by`.
   * Assistant chat: `req.auth.userId`.
   */
  actorId?: string;
  /** Verified (payload) or resolver-verified customer UUID. */
  customerId?: string;
  /** Verified (payload jobId) or resolver-verified job UUID (D3). */
  jobId?: string;
  /** The spoken customer reference, when one was extracted. */
  customerReference?: string;
  /** The spoken job reference, when one was extracted (D3). */
  jobReference?: string;
  /**
   * Task 10 — verified (resolver-verified) technicianId, when a crew
   * member was named and resolved (TECHNICIAN_REF_INTENTS membership —
   * entity-resolution.ts).
   */
  technicianId?: string;
  /** Task 10 — the spoken crew-member reference, when one was extracted. */
  technicianReference?: string;
  /**
   * Task 10 — raw spoken day/window phrase ("Thursday afternoon"), when
   * one was extracted. Only consumed by `lookup_crew_schedule`; resolved
   * inside that skill via the SAME `resolveDateTime` (U4) the booking path
   * uses.
   */
  dateTimeDescription?: string;
  /** Tenant IANA timezone for date rendering. */
  timezone?: string;
  now: Date;
}

export type LookupExecution =
  /** A renderable answer — found / none / refused all land here. */
  | { kind: 'answer'; answer: VoiceLookupAnswer }
  /** The skill errored — persisted as answer_status='failed' (client retry). */
  | { kind: 'failed'; error: string }
  /** Not an E-lane intent, or its deps aren't wired — caller keeps the skip. */
  | { kind: 'unsupported' };

const REFUSAL_SUMMARY =
  "That's an owner-level report. Ask an owner or dispatcher on your team to pull it up.";
/** lookup_catalog (`settings:view`) — technicians can't browse the price book. */
const CATALOG_REFUSAL_SUMMARY =
  'The service catalog is an office-level view. Ask an owner or dispatcher on your team to pull it up.';
/** lookup_leads (`customers:view`) — only reachable when the role is unresolvable. */
const LEADS_REFUSAL_SUMMARY =
  "I couldn't verify your access to the lead pipeline. Ask an owner or dispatcher on your team to pull it up.";

/** Honest per-intent refusal copy — never data, never a fabricated answer. */
function refusalSummary(intent: IntentType): string {
  if (intent === 'lookup_catalog') return CATALOG_REFUSAL_SUMMARY;
  if (intent === 'lookup_leads') return LEADS_REFUSAL_SUMMARY;
  return REFUSAL_SUMMARY;
}

function buildAnswer(
  intent: IntentType,
  result: 'found' | 'none' | 'refused',
  summary: string,
  rows: VoiceAnswerRow[] = [],
  entityRef?: VoiceAnswerEntityRef,
): VoiceLookupAnswer {
  // Parse (don't just cast) so a malformed row can never reach storage —
  // same posture as assertValidProposalPayload on the clarification path.
  return voiceLookupAnswerSchema.parse({
    version: 1,
    intent,
    result,
    summary: summary.slice(0, 2000),
    rows: rows.slice(0, MAX_VOICE_ANSWER_ROWS),
    ...(entityRef ? { entityRef } : {}),
  });
}

function text(label: string, value: string): VoiceAnswerRow {
  return { kind: 'text', label: label.slice(0, 80), text: value.slice(0, 200) };
}
function money(label: string, amountCents: number): VoiceAnswerRow {
  return { kind: 'money', label: label.slice(0, 80), amountCents };
}
function count(label: string, value: number): VoiceAnswerRow {
  return { kind: 'count', label: label.slice(0, 80), count: value };
}

function shortDate(d: Date, timezone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(d);
}

function shortDateTime(d: Date, timezone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(d);
}

/** "Which customer?" answer for a customer-scoped ask with no resolvable name. */
function customerUnresolvedAnswer(intent: IntentType, reference: string | undefined): VoiceLookupAnswer {
  const summary = reference
    ? `I couldn't find a customer matching "${reference}". Try again with their full name.`
    : 'Say which customer you mean — for example, "What\'s the Hendersons\' balance?"';
  return buildAnswer(intent, 'none', summary);
}

/**
 * Execute one E-lane lookup and shape the result for the answer column.
 * Never throws for skill-level failures — those map to `failed` so the
 * worker can stamp answer_status='failed' instead of crashing the message.
 */
export async function executeLookupAnswer(
  input: ExecuteLookupInput,
  deps: VoiceLookupAnswerDeps,
  shared: SharedLookupRepos,
): Promise<LookupExecution> {
  const { tenantId, sessionId, intent, customerId, timezone, now } = input;

  // ── Authorization gate (permission-gated lookups fail closed) ───────────
  const requiredPermission = LOOKUP_REQUIRED_PERMISSION.get(intent);
  if (requiredPermission) {
    let role: string | null = null;
    if (deps.resolveMemberRole && input.actorId) {
      try {
        role = await deps.resolveMemberRole(tenantId, input.actorId);
      } catch {
        role = null; // fail closed — refusal, never data
      }
    }
    if (!role || !isValidRole(role) || !hasPermission(role, requiredPermission)) {
      return { kind: 'answer', answer: buildAnswer(intent, 'refused', refusalSummary(intent)) };
    }
  }

  // ── Customer-scoped lookups require a resolved customerId ───────────────
  if (CUSTOMER_SCOPED_LOOKUP_INTENTS.has(intent) && !customerId) {
    return {
      kind: 'answer',
      answer: customerUnresolvedAnswer(intent, input.customerReference),
    };
  }

  const events = deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {};
  // lookup_events.session_id is a UUID column — the caller supplies a
  // surface-appropriate UUID correlation key (memo recording id / chat
  // per-turn lookup session id).
  const sharedInput = { tenantId, customerId: customerId!, sessionId, timezone };

  try {
    switch (intent) {
      case 'lookup_balance': {
        if (!shared.jobRepo || !deps.invoiceRepo) return { kind: 'unsupported' };
        const r = await lookupBalance(sharedInput, {
          jobRepo: shared.jobRepo,
          invoiceRepo: deps.invoiceRepo,
          ...events,
        });
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const rows: VoiceAnswerRow[] =
          r.status === 'found'
            ? [
                money('Outstanding balance', r.data.balanceCents),
                count('Open invoices', r.data.openCount),
                ...(r.data.oldestDueDate
                  ? [text('Oldest due', shortDate(r.data.oldestDueDate, timezone))]
                  : []),
              ]
            : [];
        return {
          kind: 'answer',
          answer: buildAnswer(intent, r.status, r.summary, rows, {
            kind: 'customer',
            id: customerId,
          }),
        };
      }

      case 'lookup_invoices': {
        if (!shared.jobRepo || !deps.invoiceRepo) return { kind: 'unsupported' };
        const r = await lookupInvoices(sharedInput, {
          jobRepo: shared.jobRepo,
          invoiceRepo: deps.invoiceRepo,
          ...events,
        });
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const rows: VoiceAnswerRow[] =
          r.status === 'found'
            ? [
                money('Total due', r.data.totalCents),
                count('Open invoices', r.data.count),
                ...r.data.invoices
                  .slice(0, 3)
                  .map((inv) => money(`#${inv.invoiceNumber}`, inv.amountDueCents)),
              ]
            : [];
        const soleInvoice = r.status === 'found' && r.data.invoices.length === 1
          ? r.data.invoices[0].invoiceId
          : undefined;
        return {
          kind: 'answer',
          answer: buildAnswer(intent, r.status, r.summary, rows, {
            kind: 'invoice',
            ...(soleInvoice ? { id: soleInvoice } : {}),
          }),
        };
      }

      case 'lookup_customer': {
        if (!shared.customerRepo) return { kind: 'unsupported' };
        const r = await lookupCustomer(
          { tenantId, identifier: { type: 'id', value: customerId! }, sessionId },
          { customerRepo: shared.customerRepo, ...events },
        );
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const first = r.status === 'found' ? r.data.customers[0] : undefined;
        const rows: VoiceAnswerRow[] = first
          ? [
              text('Name', first.displayName),
              ...(first.primaryPhoneMasked ? [text('Phone', first.primaryPhoneMasked)] : []),
              ...(first.email ? [text('Email', first.email)] : []),
            ]
          : [];
        return {
          kind: 'answer',
          answer: buildAnswer(intent, r.status, r.summary, rows, {
            kind: 'customer',
            id: customerId,
          }),
        };
      }

      case 'lookup_jobs': {
        if (!shared.jobRepo) return { kind: 'unsupported' };
        const r = await lookupJobs(sharedInput, { jobRepo: shared.jobRepo, ...events });
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const jobs = r.status === 'found' ? r.data.jobs : [];
        const rows = jobs
          .slice(0, 3)
          .map((j) => text(`#${j.jobNumber}`, `${j.summary} — ${j.status.replace(/_/g, ' ')}`));
        const entityRef: VoiceAnswerEntityRef =
          jobs.length === 1
            ? { kind: 'job', id: jobs[0].jobId }
            : { kind: 'customer', id: customerId };
        return { kind: 'answer', answer: buildAnswer(intent, r.status, r.summary, rows, entityRef) };
      }

      case 'lookup_estimates': {
        if (!shared.jobRepo || !deps.estimateRepo) return { kind: 'unsupported' };
        const r = await lookupEstimates(sharedInput, {
          jobRepo: shared.jobRepo,
          estimateRepo: deps.estimateRepo,
          ...events,
        });
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const rows: VoiceAnswerRow[] =
          r.status === 'found'
            ? [
                money('Total value', r.data.totalCents),
                count('Estimates', r.data.count),
                ...r.data.estimates
                  .slice(0, 3)
                  .map((e) => money(`#${e.estimateNumber} (${e.status.replace(/_/g, ' ')})`, e.totalCents)),
              ]
            : [];
        const sole = r.status === 'found' && r.data.estimates.length === 1
          ? r.data.estimates[0].estimateId
          : undefined;
        return {
          kind: 'answer',
          answer: buildAnswer(intent, r.status, r.summary, rows, {
            kind: 'estimate',
            ...(sole ? { id: sole } : {}),
          }),
        };
      }

      case 'lookup_agreements': {
        if (!deps.agreementRepo) return { kind: 'unsupported' };
        const r = await lookupAgreements(sharedInput, {
          agreementRepo: deps.agreementRepo,
          ...events,
        });
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const rows: VoiceAnswerRow[] =
          r.status === 'found'
            ? r.data.agreements.flatMap((a) => [
                money(a.name, a.priceCents),
                text('Next visit', shortDate(a.nextRunAt, timezone)),
              ])
            : [];
        // Agreements deep-link lands on customer detail until a dedicated
        // agreements screen exists (U10) — the client maps 'customer'.
        return {
          kind: 'answer',
          answer: buildAnswer(intent, r.status, r.summary, rows, {
            kind: 'customer',
            id: customerId,
          }),
        };
      }

      case 'lookup_account_summary': {
        if (
          !shared.jobRepo ||
          !shared.appointmentRepo ||
          !deps.invoiceRepo ||
          !deps.agreementRepo
        ) {
          return { kind: 'unsupported' };
        }
        const r = await lookupAccountSummary(sharedInput, {
          jobRepo: shared.jobRepo,
          appointmentRepo: shared.appointmentRepo,
          invoiceRepo: deps.invoiceRepo,
          agreementRepo: deps.agreementRepo,
          ...events,
        });
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const rows: VoiceAnswerRow[] = [
          text('Next appointment', r.data.nextAppointmentSummary),
          text('Balance', r.data.balanceSummary),
          text('Plan', r.data.agreementSummary),
        ];
        return {
          kind: 'answer',
          answer: buildAnswer(intent, r.status, r.summary, rows, {
            kind: 'customer',
            id: customerId,
          }),
        };
      }

      case 'lookup_appointments': {
        if (!shared.jobRepo || !shared.appointmentRepo) return { kind: 'unsupported' };
        const r = await lookupAppointments(sharedInput, {
          jobRepo: shared.jobRepo,
          appointmentRepo: shared.appointmentRepo,
          ...events,
        });
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const appts = r.status === 'found' ? r.data.appointments : [];
        const rows = appts
          .slice(0, 3)
          .map((a) => text(shortDateTime(a.scheduledStart, timezone), a.jobSummary || `#${a.jobNumber}`));
        return {
          kind: 'answer',
          answer: buildAnswer(intent, r.status, r.summary, rows, { kind: 'appointment' }),
        };
      }

      case 'lookup_availability': {
        let r;
        if (shared.appointmentRepo) {
          // Business-hours-aware path (F2): only speak slots the tenant
          // could honor. Settings failures degrade to defaults.
          const settings = deps.settingsRepo
            ? await deps.settingsRepo.findByTenant(tenantId).catch(() => null)
            : null;
          const config = schedulingConfigFromSettings(settings);
          r = await lookupBookableAvailability(
            {
              tenantId,
              timezone: timezone ?? config.timezone ?? 'America/New_York',
              searchFrom: now,
              searchDays: 14,
              durationMs: 2 * 60 * 60 * 1000,
              weeklyHours: config.weeklyHours,
              bufferMinutes: config.bufferMinutes,
            },
            { appointmentRepo: shared.appointmentRepo },
          );
        } else if (shared.availabilityFinder) {
          r = await lookupAvailability(
            {
              tenantId,
              searchFrom: now,
              searchTo: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
              durationMs: 2 * 60 * 60 * 1000,
              ...(timezone ? { timezone } : {}),
            },
            shared.availabilityFinder,
          );
        } else {
          return { kind: 'unsupported' };
        }
        if (r.status === 'unavailable') return { kind: 'failed', error: r.reason };
        const rows =
          r.status === 'ok'
            ? r.slots.slice(0, 3).map((s, i) => text(`Slot ${i + 1}`, shortDateTime(s.start, timezone)))
            : [];
        return {
          kind: 'answer',
          answer: buildAnswer(
            intent,
            r.status === 'ok' ? 'found' : 'none',
            r.message,
            rows,
            { kind: 'appointment' },
          ),
        };
      }

      case 'lookup_revenue': {
        if (!deps.moneyDashboardRepo) return { kind: 'unsupported' };
        const r = await lookupRevenue(
          { tenantId, sessionId, now },
          { moneyDashboardRepo: deps.moneyDashboardRepo, ...events },
        );
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        return {
          kind: 'answer',
          answer: buildAnswer(intent, 'found', r.summary, [
            money('Revenue this month', r.data.revenueCents),
            money('Outstanding', r.data.outstandingCents),
          ]),
        };
      }

      case 'lookup_job_profit': {
        if (
          !shared.jobRepo ||
          !deps.settingsRepo ||
          !deps.invoiceRepo ||
          !deps.timeEntryRepo ||
          !deps.expenseRepo
        ) {
          return { kind: 'unsupported' };
        }
        if (!input.jobId) {
          const summary = input.jobReference
            ? `I couldn't find a job matching "${input.jobReference}".`
            : 'Say which job you mean — for example, "Did I make money on the Miller job?"';
          return { kind: 'answer', answer: buildAnswer(intent, 'none', summary) };
        }
        const r = await lookupJobProfit(
          { tenantId, jobId: input.jobId, sessionId },
          {
            jobRepo: shared.jobRepo,
            settingsRepo: deps.settingsRepo,
            invoiceRepo: deps.invoiceRepo,
            timeEntryRepo: deps.timeEntryRepo,
            expenseRepo: deps.expenseRepo,
            ...events,
          },
        );
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        if (r.status === 'not_found') {
          return { kind: 'answer', answer: buildAnswer(intent, 'none', r.summary) };
        }
        const rows: VoiceAnswerRow[] = [
          money('Revenue', r.data.revenueCents),
          ...(r.data.materialsCents > 0 ? [money('Materials', r.data.materialsCents)] : []),
          ...(r.data.expensesCents > 0 ? [money('Expenses', r.data.expensesCents)] : []),
          ...(r.data.laborCents !== null ? [money('Labor', r.data.laborCents)] : []),
          money('Margin', r.data.marginCents),
          ...(r.data.marginPct !== null ? [text('Margin %', `${r.data.marginPct}%`)] : []),
        ];
        return {
          kind: 'answer',
          answer: buildAnswer(intent, 'found', r.summary, rows, {
            kind: 'job',
            id: input.jobId,
          }),
        };
      }

      // Task 9 (2026-08-07 tradesperson plan) — read back Task 8's
      // material_items shopping list (src/materials/material-item.ts). No
      // permission gate (see LOOKUP_REQUIRED_PERMISSION's doc comment
      // above) — any authenticated operator may hear it.
      //
      // Spec-review MAJOR A fix — an unresolved spoken job reference must
      // NOT silently widen to the tenant's whole pending list. Mirrors
      // `lookup_job_profit`'s identical guard a few cases up: when a job
      // WAS named (`input.jobReference` set) but the entity resolver
      // couldn't match it (`resolveVoiceEntityReferences` returns
      // `kind: 'ok'` with `resolved.jobId` left undefined for a genuine
      // not_found — only 'ambiguous' short-circuits upstream before this
      // function ever runs), `input.jobId` is absent while `jobReference`
      // is present. Without this check the caller who asked "what
      // materials are open on the Patel job?" with no matching Patel got
      // back EVERY pending item for the tenant, announced as a normal
      // found-answer — the worse failure mode, since the operator actively
      // named a scope and silently got unscoped data instead of an honest
      // "not found". Absent any jobReference at all, the unfiltered list is
      // the CORRECT, intended answer ("read me the shopping list").
      case 'lookup_materials': {
        if (!deps.materialItemRepo) return { kind: 'unsupported' };
        if (!input.jobId && input.jobReference) {
          return {
            kind: 'answer',
            answer: buildAnswer(intent, 'none', `I couldn't find a job matching "${input.jobReference}".`),
          };
        }
        const r = await lookupMaterials(
          { tenantId, sessionId, ...(input.jobId ? { jobId: input.jobId } : {}) },
          { materialItemRepo: deps.materialItemRepo, ...events },
        );
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const rows: VoiceAnswerRow[] =
          r.status === 'found'
            ? r.data.spokenItems.map((m) =>
                text(
                  m.description,
                  `qty ${m.quantity}${m.vendor ? ` — ${m.vendor}` : ''}${
                    m.neededByLabel ? `, needed by ${m.neededByLabel}` : ''
                  }`,
                ),
              )
            : [];
        return { kind: 'answer', answer: buildAnswer(intent, r.status, r.summary, rows) };
      }

      // Task 10 (2026-08-07 tradesperson plan) — owner/dispatcher asks who
      // is free / where a named crew member is, on a given day or window.
      // Owner-extended + permission-gated (reports:view, see
      // LOOKUP_REQUIRED_PERMISSION above) — mirrors lookup_day_overview.
      //
      // An unresolved spoken technician name refuses honestly rather than
      // silently falling back to the WHOLE crew's schedule — this failure
      // mode matters MORE here than lookup_materials's job-reference
      // precedent (spec-review MAJOR A): a named PERSON who didn't resolve
      // must never widen to "everyone's schedule".
      case 'lookup_crew_schedule': {
        if (!shared.appointmentRepo || !shared.jobRepo || !shared.userRepo) {
          return { kind: 'unsupported' };
        }
        if (!input.technicianId && input.technicianReference) {
          return {
            kind: 'answer',
            answer: buildAnswer(
              intent,
              'none',
              `I couldn't find a crew member matching "${input.technicianReference}".`,
            ),
          };
        }
        const r = await lookupCrewSchedule(
          {
            tenantId,
            sessionId,
            ...(input.technicianId ? { technicianId: input.technicianId } : {}),
            ...(input.dateTimeDescription ? { dateTimeDescription: input.dateTimeDescription } : {}),
            ...(timezone ? { timezone } : {}),
            now,
          },
          {
            appointmentRepo: shared.appointmentRepo,
            jobRepo: shared.jobRepo,
            userRepo: shared.userRepo,
            ...events,
          },
        );
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const rows: VoiceAnswerRow[] =
          r.status === 'found'
            ? r.data.bookings
                .slice(0, 5)
                .map((b) =>
                  text(
                    b.technicianName,
                    `${shortDateTime(b.scheduledStart, timezone)}${b.jobSummary ? ` — ${b.jobSummary}` : ''}`,
                  ),
                )
            : [];
        return { kind: 'answer', answer: buildAnswer(intent, r.status, r.summary, rows) };
      }

      // Task 10 — owner asks logged hours per crew member for the current
      // tenant-local week. Same gating + unresolved-name refusal posture
      // as lookup_crew_schedule immediately above.
      case 'lookup_timesheets': {
        if (!deps.timeEntryRepo || !shared.userRepo) return { kind: 'unsupported' };
        if (!input.technicianId && input.technicianReference) {
          return {
            kind: 'answer',
            answer: buildAnswer(
              intent,
              'none',
              `I couldn't find a crew member matching "${input.technicianReference}".`,
            ),
          };
        }
        const r = await lookupTimesheets(
          {
            tenantId,
            sessionId,
            ...(input.technicianId ? { technicianId: input.technicianId } : {}),
            ...(timezone ? { timezone } : {}),
            now,
          },
          { timeEntryRepo: deps.timeEntryRepo, userRepo: shared.userRepo, ...events },
        );
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const rows: VoiceAnswerRow[] =
          r.status === 'found'
            ? r.data.entries
                .slice(0, 5)
                // I4 — reuse the SAME formatHours the skill's own spoken
                // summary uses, rather than the raw 2-decimal totalHours:
                // the card used to read "7.83 hrs" while the operator
                // HEARD "7.8 hours" for the identical value.
                .map((e) => text(e.name, `${formatHours(e.totalHours)} this week`))
            : [];
        return { kind: 'answer', answer: buildAnswer(intent, r.status, r.summary, rows) };
      }

      // Task 10 — the SPEAKER asks about their OWN schedule today.
      // Deliberately NOT in LOOKUP_REQUIRED_PERMISSION (available to any
      // technician) — self-scoping to the resolved SPEAKER is this
      // intent's entire access-control story, so the speaker is resolved
      // to a concrete technician HERE, before the skill ever runs. An
      // unresolvable speaker fails the turn — it must NEVER fall back to
      // an unscoped (whole-crew) answer.
      case 'lookup_my_day': {
        if (!shared.appointmentRepo || !shared.jobRepo || !shared.userRepo) {
          return { kind: 'unsupported' };
        }
        if (!input.actorId) {
          return { kind: 'failed', error: 'could not match you to a technician' };
        }
        const technician = await resolveCanonicalUser(shared.userRepo, tenantId, input.actorId);
        if (!technician) {
          return { kind: 'failed', error: 'could not match you to a technician' };
        }
        const r = await lookupMyDay(
          {
            tenantId,
            sessionId,
            technicianId: technician.id,
            ...(timezone ? { timezone } : {}),
            now,
          },
          { appointmentRepo: shared.appointmentRepo, jobRepo: shared.jobRepo, ...events },
        );
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const rows: VoiceAnswerRow[] =
          r.status === 'found'
            ? r.data.appointments
                .slice(0, 5)
                .map((a) =>
                  text(
                    shortDateTime(a.scheduledStart, timezone),
                    // I1 — `jobs.summary` is TEXT NOT NULL with no non-empty
                    // CHECK (imports/direct writes can produce ''), and
                    // `voiceAnswerRowSchema` requires `text: z.string().min(1)`.
                    // buildAnswer PARSES rather than casts, so an empty
                    // string here throws a ZodError caught by the outer
                    // catch — discarding an otherwise-correct, already-
                    // computed answer. Never emit an empty row value.
                    a.jobSummary || `Job ${a.jobId.slice(0, 8)}`,
                  ),
                )
            : [];
        return { kind: 'answer', answer: buildAnswer(intent, r.status, r.summary, rows) };
      }

      case 'lookup_day_overview': {
        if (!shared.appointmentRepo || !shared.jobRepo) return { kind: 'unsupported' };
        const r = await lookupDayOverview(
          { tenantId, sessionId, now, ...(timezone ? { timezone } : {}) },
          {
            appointmentRepo: shared.appointmentRepo,
            jobRepo: shared.jobRepo,
            proposalRepo: shared.proposalRepo,
            ...events,
          },
        );
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        return {
          kind: 'answer',
          answer: buildAnswer(
            intent,
            r.status,
            r.summary,
            [
              count('Appointments today', r.data.appointments.length),
              count('Needs approval', r.data.pendingApprovalsCount),
              count('Urgent jobs', r.data.urgentJobs.length),
            ],
            { kind: 'appointment' },
          ),
        };
      }

      case 'lookup_pending_items': {
        if (!deps.estimateRepo || !deps.invoiceRepo) return { kind: 'unsupported' };
        const r = await lookupPendingItems(
          { tenantId, sessionId, now },
          {
            estimateRepo: deps.estimateRepo,
            invoiceRepo: deps.invoiceRepo,
            ...(deps.dunningConfigRepo ? { dunningConfigRepo: deps.dunningConfigRepo } : {}),
            ...events,
          },
        );
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const invoiceDueCents = r.data.invoices.reduce((sum, i) => sum + i.amountDueCents, 0);
        return {
          kind: 'answer',
          answer: buildAnswer(intent, r.status, r.summary, [
            count('Estimates awaiting reply', r.data.estimates.length),
            count('Unpaid invoices', r.data.invoices.length),
            ...(invoiceDueCents > 0 ? [money('Invoice total due', invoiceDueCents)] : []),
          ]),
        };
      }

      case 'lookup_digest': {
        if (!deps.dailyDigestRepo) return { kind: 'unsupported' };
        const r = await lookupDigest(
          { tenantId, sessionId, now, ...(timezone ? { timezone } : {}) },
          { digestRepo: deps.dailyDigestRepo, ...events },
        );
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const rows =
          r.status === 'found' ? [text('Digest date', r.data.digestDate)] : [];
        return { kind: 'answer', answer: buildAnswer(intent, r.status, r.summary, rows) };
      }

      // U7 — operator-surface parity for the two tenant-scoped lookups
      // telephony already answers. Same shared skills the twilio-adapter
      // calls (`ai/skills/lookup-leads`, `ai/skills/lookup-catalog`) —
      // one implementation, three surfaces.
      case 'lookup_leads': {
        if (!deps.leadRepo) return { kind: 'unsupported' };
        const r = await lookupLeads(
          { tenantId, sessionId },
          { leadRepo: deps.leadRepo, ...events },
        );
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const rows: VoiceAnswerRow[] =
          r.status === 'found' ? [count('Open leads', r.data.openCount)] : [];
        return { kind: 'answer', answer: buildAnswer(intent, r.status, r.summary, rows) };
      }

      case 'lookup_catalog': {
        if (!deps.catalogRepo) return { kind: 'unsupported' };
        const r = await lookupCatalog(
          { tenantId, sessionId },
          { catalogRepo: deps.catalogRepo, ...events },
        );
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const rows: VoiceAnswerRow[] =
          r.status === 'found'
            ? [
                count('Catalog items', r.data.count),
                // The catalog's exact integer cents — the CLIENT formats.
                ...r.data.items.slice(0, 3).map((i) => money(i.name, i.unitPriceCents)),
              ]
            : [];
        return { kind: 'answer', answer: buildAnswer(intent, r.status, r.summary, rows) };
      }

      // Not a lookup this module answers (callers gate on isLookupIntent) —
      // keep the skip semantics.
      default:
        return { kind: 'unsupported' };
    }
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
