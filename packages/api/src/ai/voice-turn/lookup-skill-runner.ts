/**
 * The voice LOOKUP family, owned in one place.
 *
 * WHY THIS EXISTS
 * ---------------
 * These ~400 lines lived as private methods on `TwilioGatherAdapter`, reachable
 * only from `_handleGatherLocked`. The consequence was structural, not
 * cosmetic: the **Gather** transport answered 15 of the 20 `lookup_*` intents
 * and the **media-streams** transport answered *none*. A media-streams caller
 * asking for their balance heard "Just to confirm — lookup balance. Is that
 * right?" and, on saying yes, minted a `voice_clarification` card for an
 * operator to review. A read-only question produced human review and no answer.
 *
 * STATUS: step 1 of 2. Only `telephony/twilio-adapter.ts` imports this module
 * today, so media-streams still answers no lookups — nothing about the caller
 * experience has changed yet. Step 2 wires `speechTurn`, and is deliberately
 * held back pending #838 Q2 (whether media-streams becomes the primary
 * transport at all). Until then this is a relocation that makes step 2
 * possible, NOT a fix for the transport gap.
 *
 * The goal it serves: a transport should be a transport — audio in, audio out —
 * and a capability should target "the phone", not "Gather".
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is a RELOCATION, not a redesign. Behaviour is byte-for-byte the same as
 * the methods it replaces, including the parts that are wrong:
 *
 *   - Five intents still have no case and fall to `lookupNotWiredFallback()` —
 *     `lookup_my_day`, `lookup_materials`, `lookup_job_profit`,
 *     `lookup_crew_schedule`, `lookup_timesheets` (#843).
 *   - Authorization is still `ownerSession` + prompt gating, NOT the
 *     DB-authoritative RBAC that `workers/voice-lookup-answer.ts` enforces for
 *     the memo and chat surfaces. Reconciling those two models is the open
 *     question on #843; moving the code does not settle it.
 *
 * Both are pinned as current behaviour by
 * `test/telephony/lookup-dispatch-characterization.test.ts`, so fixing either
 * stays a deliberate act in its own change rather than a side effect of this
 * one.
 *
 * FSM CONTRACT
 * ------------
 * A lookup deliberately does NOT dispatch `intent_classified`. The turn stays
 * in `intent_capture` so the caller can immediately ask something else.
 * Callers must preserve that: dispatching would strand every lookup in a
 * confirm loop.
 */
import { createLogger } from '../../logging/logger';
import type { VoiceSession } from '../agents/customer-calling/voice-session-store';
import { OWNER_LOOKUP_INTENT_TYPES, type IntentType } from '../orchestration/intent-classifier';
import { lookupExecutedEvent } from '../voice-quality/events';
import { lookupAppointments } from '../skills/lookup-appointments';
import { lookupInvoices } from '../skills/lookup-invoices';
import { lookupBalance } from '../skills/lookup-balance';
import { lookupJobs } from '../skills/lookup-jobs';
import { lookupAgreements } from '../skills/lookup-agreements';
import { lookupAccountSummary } from '../skills/lookup-account-summary';
import { lookupCustomer } from '../skills/lookup-customer';
import { lookupEstimates } from '../skills/lookup-estimates';
import { lookupLeads } from '../skills/lookup-leads';
import { lookupRevenue } from '../skills/lookup-revenue';
import { lookupCatalog } from '../skills/lookup-catalog';
import { lookupAvailability, lookupBookableAvailability } from '../skills/lookup-availability';
import { lookupDayOverview } from '../skills/lookup-day-overview';
import { lookupDigest } from '../skills/lookup-digest';
import { lookupPendingItems } from '../skills/lookup-pending-items';
import { schedulingConfigFromSettings } from '../../scheduling/booking-availability';
import type { DroppedCallRecoveryRepository } from '../../sms/recovery/scheduler';
import type { AgreementRepository } from '../../agreements/agreement';
import type { AppointmentRepository } from '../../appointments/appointment';
import type { AvailabilityFinder } from '../tasks/availability-finder';
import type { CatalogItemRepository } from '../../catalog/catalog-item';
import type { CustomerRepository } from '../../customers/customer';
import type { DailyDigestRepository } from '../../digest/digest-service';
import type { DunningConfigRepository } from '../../invoices/dunning-config';
import type { EstimateRepository } from '../../estimates/estimate';
import type { InvoiceRepository } from '../../invoices/invoice';
import type { JobRepository } from '../../jobs/job';
import type { LeadRepository } from '../../leads/lead';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import type { MoneyDashboardRepository } from '../../reports/money-dashboard';
import type { ProposalRepository } from '../../proposals/proposal';
import type { SettingsRepository } from '../../settings/settings';
import type { UserRepository } from '../../users/user';

/**
 * Everything the lookup family reads. Every field optional: a missing repo
 * degrades that skill to the not-wired fallback, exactly as before.
 */
export interface LookupSkillDeps {
  agreementRepo?: AgreementRepository;
  appointmentRepo?: AppointmentRepository;
  availabilityFinder?: AvailabilityFinder;
  catalogRepo?: CatalogItemRepository;
  customerRepo?: CustomerRepository;
  dailyDigestRepo?: DailyDigestRepository;
  droppedCallRecoveryRepo?: Pick<DroppedCallRecoveryRepository, 'listUnansweredRecoveries'>;
  dunningConfigRepo?: DunningConfigRepository;
  estimateRepo?: EstimateRepository;
  invoiceRepo?: InvoiceRepository;
  jobRepo?: JobRepository;
  leadRepo?: LeadRepository;
  lookupEvents?: LookupEventService;
  moneyDashboardRepo?: MoneyDashboardRepository;
  proposalRepo?: ProposalRepository;
  settingsRepo?: SettingsRepository;
  userRepo?: UserRepository;
}

// Service name follows the module's new home. The two warn() call sites below
// are the only logging in the family; they previously reported under
// 'telephony.twilio-adapter', which would now be a lie about where the code
// lives. Flagged rather than silently renamed in case anything alerts on it.
const logger = createLogger({
  service: 'voice.lookup-skill-runner',
  environment: process.env.NODE_ENV || 'development',
});

/** True when the intent is one of the owner-extended lookups. */
function isOwnerLookupIntent(intentType: string): boolean {
  return OWNER_LOOKUP_INTENT_TYPES.has(intentType as IntentType);
}

function lookupNotWiredFallback(): string {
  return "I'm having trouble pulling that up right now. Let me get a person to help.";
}

export async function runLookupSkill(
  deps: LookupSkillDeps,
  session: VoiceSession,
  intentType: string,
  tenantId: string,
): Promise<string> {
  const customerId = session.customerId;
  const ownerSession = session.machine.currentContext.ownerSession === true;
  const extendedIntents = session.machine.currentContext.extendedIntents === true;
  const ownerLookup = isOwnerLookupIntent(intentType);
  if (ownerLookup) {
    if (!ownerSession || !extendedIntents) {
      return lookupNotWiredFallback();
    }
    return runOwnerLookupSkill(deps, session, intentType, tenantId);
  }
  // WS5 — `lookup_catalog` (browsing the price book) is OWNER-ONLY and
  // tenant-scoped (no customerId needed). A customer asking about prices now
  // flows through the grounded estimate path, which speaks catalog-grounded
  // prices safely; they must never get a raw catalog recital. Gated on the
  // RV-070 ownerSession flag (caller-ID identity), never utterance content —
  // same identity source as the owner lookups above, without the
  // extended-intents tenant opt-in. Handled here, BEFORE the customer-scoped
  // gate, because the owner line is not itself a customer.
  if (intentType === 'lookup_catalog') {
    if (!ownerSession || !deps.catalogRepo) {
      return lookupNotWiredFallback();
    }
    const catalogStart = Date.now();
    try {
      const result = await lookupCatalog(
        { tenantId, sessionId: session.id },
        {
          catalogRepo: deps.catalogRepo,
          ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
        },
      );
      session.events.emit(
        'voice-event',
        lookupExecutedEvent(intentType, Date.now() - catalogStart, true),
      );
      return result.summary;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session.events.emit(
        'voice-event',
        lookupExecutedEvent(intentType, Date.now() - catalogStart, false, message),
      );
      return lookupNotWiredFallback();
    }
  }
  if (!customerId) {
    // Lookups are customer-scoped. An anonymous caller doesn't have
    // an account to read from; we never want to leak a different
    // tenant's summary. Degrade gracefully.
    return "I can't pull up your account without identifying you first. Let me get a person to help.";
  }

  const sharedInput = {
    tenantId,
    customerId,
    sessionId: session.id,
  };

  // VQ-003: time the skill end-to-end and emit `lookup_executed` on
  // the session bus. Both the success and error branches emit so the
  // harness sees that a lookup attempt occurred even when it fell
  // back to the "let me get someone" string. Errors carry the raw
  // message; successes set `success: true` with no error field.
  const startMs = Date.now();
  try {
    switch (intentType) {
      case 'lookup_appointments': {
        if (!deps.jobRepo || !deps.appointmentRepo) {
          return lookupNotWiredFallback();
        }
        const result = await lookupAppointments(sharedInput, {
          jobRepo: deps.jobRepo,
          appointmentRepo: deps.appointmentRepo,
          ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
        });
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.summary;
      }
      case 'lookup_invoices': {
        if (!deps.jobRepo || !deps.invoiceRepo) {
          return lookupNotWiredFallback();
        }
        const result = await lookupInvoices(sharedInput, {
          jobRepo: deps.jobRepo,
          invoiceRepo: deps.invoiceRepo,
          ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
        });
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.summary;
      }
      case 'lookup_balance': {
        if (!deps.jobRepo || !deps.invoiceRepo) {
          return lookupNotWiredFallback();
        }
        const result = await lookupBalance(sharedInput, {
          jobRepo: deps.jobRepo,
          invoiceRepo: deps.invoiceRepo,
          ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
        });
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.summary;
      }
      case 'lookup_jobs': {
        if (!deps.jobRepo) {
          return lookupNotWiredFallback();
        }
        const result = await lookupJobs(sharedInput, {
          jobRepo: deps.jobRepo,
          ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
        });
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.summary;
      }
      case 'lookup_agreements': {
        if (!deps.agreementRepo) {
          return lookupNotWiredFallback();
        }
        const result = await lookupAgreements(sharedInput, {
          agreementRepo: deps.agreementRepo,
          ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
        });
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.summary;
      }
      case 'lookup_account_summary': {
        if (
          !deps.jobRepo ||
          !deps.appointmentRepo ||
          !deps.invoiceRepo ||
          !deps.agreementRepo
        ) {
          return lookupNotWiredFallback();
        }
        const result = await lookupAccountSummary(sharedInput, {
          jobRepo: deps.jobRepo,
          appointmentRepo: deps.appointmentRepo,
          invoiceRepo: deps.invoiceRepo,
          agreementRepo: deps.agreementRepo,
          ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
        });
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.summary;
      }
      case 'lookup_customer': {
        if (!deps.customerRepo) {
          return lookupNotWiredFallback();
        }
        // The caller is already identity-resolved (customerId in
        // session) — use that as the fuzzy-lookup target so the
        // skill returns the record matching this caller, not a
        // free-form fuzzy phone search.
        const result = await lookupCustomer(
          {
            tenantId,
            identifier: { type: 'id', value: customerId },
            sessionId: session.id,
          },
          {
            customerRepo: deps.customerRepo,
            ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
          },
        );
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.summary;
      }
      case 'lookup_estimates': {
        if (!deps.jobRepo || !deps.estimateRepo) {
          return lookupNotWiredFallback();
        }
        const result = await lookupEstimates(sharedInput, {
          jobRepo: deps.jobRepo,
          estimateRepo: deps.estimateRepo,
          ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
        });
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.summary;
      }
      case 'lookup_leads': {
        if (!deps.leadRepo) {
          return lookupNotWiredFallback();
        }
        const result = await lookupLeads(
          { tenantId, sessionId: session.id },
          {
            leadRepo: deps.leadRepo,
            ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
          },
        );
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.summary;
      }
      case 'lookup_revenue': {
        if (!deps.moneyDashboardRepo) {
          return lookupNotWiredFallback();
        }
        const result = await lookupRevenue(
          { tenantId, sessionId: session.id },
          {
            moneyDashboardRepo: deps.moneyDashboardRepo,
            ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
          },
        );
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.summary;
      }
      case 'lookup_availability': {
        const from = new Date();
        let result;
        if (deps.appointmentRepo) {
          // Business-hours-aware path (F2): only offer slots the tenant
          // could honor, spoken in the tenant timezone. Settings failures
          // degrade to defaults, never block the call.
          const settings = deps.settingsRepo
            ? await deps.settingsRepo.findByTenant(tenantId).catch(() => null)
            : null;
          const config = schedulingConfigFromSettings(settings);
          result = await lookupBookableAvailability(
            {
              tenantId,
              timezone: config.timezone ?? 'America/New_York',
              searchFrom: from,
              searchDays: 14,
              durationMs: 2 * 60 * 60 * 1000,
              weeklyHours: config.weeklyHours,
              bufferMinutes: config.bufferMinutes,
            },
            { appointmentRepo: deps.appointmentRepo },
          );
        } else if (deps.availabilityFinder) {
          // Legacy raw-finder fallback for wirings without an appointment
          // repo (calendar-gap walk, no hours awareness).
          result = await lookupAvailability(
            {
              tenantId,
              searchFrom: from,
              searchTo: new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000),
              durationMs: 2 * 60 * 60 * 1000,
            },
            deps.availabilityFinder,
          );
        } else {
          return lookupNotWiredFallback();
        }
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.status === 'unavailable'
          ? lookupNotWiredFallback()
          : result.message;
      }
      default:
        return lookupNotWiredFallback();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('runLookupSkill failed', {
      sessionId: session.id,
      intentType,
      error: message,
    });
    session.events.emit(
      'voice-event',
      lookupExecutedEvent(intentType, Date.now() - startMs, false, message),
    );
    return lookupNotWiredFallback();
  }
}

async function runOwnerLookupSkill(
  deps: LookupSkillDeps,
  session: VoiceSession,
  intentType: string,
  tenantId: string,
): Promise<string> {
  const startMs = Date.now();
  try {
    switch (intentType) {
      case 'lookup_day_overview': {
        if (!deps.appointmentRepo || !deps.jobRepo || !deps.proposalRepo) {
          return lookupNotWiredFallback();
        }
        const result = await lookupDayOverview(
          { tenantId, sessionId: session.id },
          {
            appointmentRepo: deps.appointmentRepo,
            jobRepo: deps.jobRepo,
            proposalRepo: deps.proposalRepo,
            ...(deps.userRepo ? { userRepo: deps.userRepo } : {}),
            ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
          },
        );
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.summary;
      }
      case 'lookup_digest': {
        if (!deps.dailyDigestRepo) {
          return lookupNotWiredFallback();
        }
        const result = await lookupDigest(
          { tenantId, sessionId: session.id },
          {
            digestRepo: deps.dailyDigestRepo,
            ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
          },
        );
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.summary;
      }
      case 'lookup_pending_items': {
        if (!deps.estimateRepo || !deps.invoiceRepo) {
          return lookupNotWiredFallback();
        }
        const result = await lookupPendingItems(
          { tenantId, sessionId: session.id },
          {
            estimateRepo: deps.estimateRepo,
            invoiceRepo: deps.invoiceRepo,
            ...(deps.dunningConfigRepo
              ? { dunningConfigRepo: deps.dunningConfigRepo }
              : {}),
            ...(deps.droppedCallRecoveryRepo
              ? {
                  listUnansweredRecoveries: (tenant: string) =>
                    deps.droppedCallRecoveryRepo!.listUnansweredRecoveries(tenant),
                }
              : {}),
            ...(deps.lookupEvents ? { lookupEvents: deps.lookupEvents } : {}),
          },
        );
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(intentType, Date.now() - startMs, true),
        );
        return result.summary;
      }
      default:
        return lookupNotWiredFallback();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('runOwnerLookupSkill failed', {
      intentType,
      tenantId,
      sessionId: session.id,
      error: message,
    });
    session.events.emit(
      'voice-event',
      lookupExecutedEvent(intentType, Date.now() - startMs, false, message),
    );
    return lookupNotWiredFallback();
  }
}
