/**
 * U3 (iOS blueprint) — E-lane answer execution for the recorded-memo path.
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
 * Invariants honored here:
 *   - Integer cents end-to-end: skill `*Cents` values ride the answer as
 *     `money` rows; the CLIENT formats. Never floats, never pre-formatted
 *     currency strings.
 *   - Dates render in the tenant timezone (threaded by the caller).
 *   - Authorization: owner-grade lookups (lookup_revenue,
 *     lookup_job_profit, lookup_pending_items, lookup_digest — E3/E4/E6/D3)
 *     check the MEMO CREATOR's DB-authoritative role and FAIL CLOSED to a
 *     refusal answer (copy, never data) when the role is missing or lacks
 *     `reports:view` (technicians).
 *   - Analytics: every skill call passes `lookupEvents` (keyed by the
 *     recordingId as the session id — both are UUIDs) so the memo path
 *     starts writing the same `lookup_events` rows telephony does.
 *   - Missing deps degrade to `unsupported` (the caller keeps today's
 *     skip semantics), mirroring the adapters' LOOKUP_NOT_WIRED fallback.
 */
import type {
  VoiceAnswerEntityRef,
  VoiceAnswerRow,
  VoiceLookupAnswer,
} from '@ai-service-os/shared';
import { voiceLookupAnswerSchema, MAX_VOICE_ANSWER_ROWS } from '@ai-service-os/shared';
import { hasPermission, isValidRole } from '../auth/rbac';
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
import type { SettingsRepository } from '../settings/settings';
import type { LookupEventService } from '../lookup-events/lookup-event-service';
import type { AvailabilityFinder } from '../ai/tasks/availability-finder';
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

/**
 * Owner-grade lookups (E3/E4/E6/D3): tenant-wide financial / operational
 * reporting. Gated on the memo creator's role via `reports:view` —
 * owners and dispatchers hold it; technicians get a refusal answer.
 */
export const OWNER_GRADE_LOOKUP_INTENTS: ReadonlySet<IntentType> = new Set<IntentType>([
  'lookup_revenue',
  'lookup_job_profit',
  'lookup_pending_items',
  'lookup_digest',
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
  /** Full settings repo — lookup_job_profit reads the tenant labor rate. */
  settingsRepo?: SettingsRepository;
  /** P11-001 analytics table writer — the memo path now records rows too. */
  lookupEvents?: LookupEventService;
  /**
   * DB-authoritative role of the memo creator (voice_recordings.created_by
   * is the Clerk subject — resolve like `createAuthorizationLoader`).
   * Owner-grade lookups FAIL CLOSED to a refusal when absent/unresolvable.
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
}

export interface ExecuteLookupInput {
  tenantId: string;
  /** The recording being answered — also the lookup_events session key. */
  recordingId: string;
  intent: IntentType;
  /** voice_recordings.created_by — authoritative identity for the authz gate. */
  memoCreatorId?: string;
  /** Verified (payload) or resolver-verified customer UUID. */
  customerId?: string;
  /** Verified (payload jobId) or resolver-verified job UUID (D3). */
  jobId?: string;
  /** The spoken customer reference, when one was extracted. */
  customerReference?: string;
  /** The spoken job reference, when one was extracted (D3). */
  jobReference?: string;
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
  const { tenantId, recordingId, intent, customerId, timezone, now } = input;

  // ── Authorization gate (owner-grade lookups fail closed) ────────────────
  if (OWNER_GRADE_LOOKUP_INTENTS.has(intent)) {
    let role: string | null = null;
    if (deps.resolveMemberRole && input.memoCreatorId) {
      try {
        role = await deps.resolveMemberRole(tenantId, input.memoCreatorId);
      } catch {
        role = null; // fail closed — refusal, never data
      }
    }
    if (!role || !isValidRole(role) || !hasPermission(role, 'reports:view')) {
      return { kind: 'answer', answer: buildAnswer(intent, 'refused', REFUSAL_SUMMARY) };
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
  // lookup_events.session_id is a UUID; the recording id is the memo
  // path's session-equivalent correlation key.
  const sharedInput = { tenantId, customerId: customerId!, sessionId: recordingId, timezone };

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
          { tenantId, identifier: { type: 'id', value: customerId! }, sessionId: recordingId },
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
          { tenantId, sessionId: recordingId, now },
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
          { tenantId, jobId: input.jobId, sessionId: recordingId },
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

      case 'lookup_day_overview': {
        if (!shared.appointmentRepo || !shared.jobRepo) return { kind: 'unsupported' };
        const r = await lookupDayOverview(
          { tenantId, sessionId: recordingId, now, ...(timezone ? { timezone } : {}) },
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
          { tenantId, sessionId: recordingId, now },
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
          { tenantId, sessionId: recordingId, now, ...(timezone ? { timezone } : {}) },
          { digestRepo: deps.dailyDigestRepo, ...events },
        );
        if (r.status === 'error') return { kind: 'failed', error: r.data.error };
        const rows =
          r.status === 'found' ? [text('Digest date', r.data.digestDate)] : [];
        return { kind: 'answer', answer: buildAnswer(intent, r.status, r.summary, rows) };
      }

      // lookup_leads / lookup_catalog are not E-lane workflows (no memo
      // answer surface planned) — keep today's skip semantics.
      default:
        return { kind: 'unsupported' };
    }
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
