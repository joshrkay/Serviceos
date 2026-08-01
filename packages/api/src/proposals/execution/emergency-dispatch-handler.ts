/**
 * RV-141 — `emergency_dispatch` execution handler.
 *
 * Executes an approved emergency_dispatch proposal:
 *
 *   1. Create an URGENT job (priority 'urgent', summary from the
 *      emergencyDescription) for the matched customer.
 *   2. Place a TENTATIVE appointment hold on the soonest feasible slot for
 *      that job (holdPendingApproval = true, short holdExpiryAt) so the
 *      emergency lands pre-slotted on the dispatch board for a human to
 *      confirm. A hold — not a booking — keeps the human-approval gate (it is
 *      confirmed via create-booking-handler.ts) and means a wrong auto-slot is
 *      reversible: the hold auto-releases at expiry if nobody confirms it.
 *   3. Page the owner by SMS via the existing dispatch infra
 *      (MessageDeliveryProvider + tenant_settings.owner_phone, falling back
 *      to transfer_number when no owner cell is on file). When a hold landed,
 *      the page names the held time so the owner knows a slot is reserved.
 *
 * Graceful degradation (the previously-documented appointment-HOLD deviation,
 * now closed): the hold needs an AppointmentRepository — threaded through
 * `createExecutionHandlerRegistry` — and a feasible slot. With no repo, no
 * feasible slot (after-hours / fully booked), or an anonymous caller (no job),
 * the handler skips the hold and still creates the job + pages the owner. The
 * hold never fails or delays the dispatch; this runs at proposal-execution
 * time, off the live-call path (the FSM already spoke the 911 line and fired
 * notify_oncall at detection).
 *
 * Payload tolerance: voice proposals arrive in the generic
 * `{ intent, entities, sessionId, callSid }` envelope (handleCreateProposal),
 * while contract-validated payloads carry `emergencyDescription` at the top
 * level — both shapes are read.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Proposal, ProposalType } from '../proposal';
import type {
  ExecutionHandler,
  ExecutionContext,
  ExecutionResult,
} from './handlers';
import { JobRepository, createJob } from '../../jobs/job';
import type { LocationRepository } from '../../locations/location';
import type { SettingsRepository } from '../../settings/settings';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { AppointmentRepository, createAppointment } from '../../appointments/appointment';
import type { AssignmentRepository } from '../../appointments/assignment';
import {
  findBookableSlots,
  schedulingConfigFromSettings,
} from '../../scheduling/booking-availability';
import { isValidTimezone } from '../../shared/timezone';
import { notifyOwner } from '../../notifications/owner-notifications-instance';

/** Duration of the tentatively-held emergency slot. */
const EMERGENCY_SLOT_DURATION_MIN = 60;
/**
 * How long the tentative emergency hold survives before auto-releasing if a
 * dispatcher hasn't confirmed it — long enough for a paged owner to act,
 * short enough that an unactioned hold returns the slot to availability.
 */
const EMERGENCY_HOLD_TTL_MS = 2 * 60 * 60 * 1000;
/** How many days ahead to search for the soonest feasible emergency slot. */
const EMERGENCY_SLOT_SEARCH_DAYS = 2;

/** Minimal SMS seam — satisfied by MessageDeliveryProvider and test stubs. */
export interface EmergencySmsSender {
  sendSms(message: {
    to: string;
    body: string;
    tenantId?: string;
    idempotencyKey?: string;
    // WS1 — required on MessageDeliveryProvider.sendSms; emergency pages are
    // owner/on-call, so the call site sets 'owner' (never customer-gated).
    recipientClass: 'customer' | 'owner';
  }): Promise<unknown>;
}

interface EmergencyPayloadFields {
  emergencyDescription: string;
  detectedKeywords: string[];
  callerPhone?: string;
  customerId?: string;
}

/** Read both the contract shape and the voice `{intent, entities}` envelope. */
export function extractEmergencyFields(
  payload: Record<string, unknown>,
): EmergencyPayloadFields {
  const entities =
    typeof payload.entities === 'object' && payload.entities !== null
      ? (payload.entities as Record<string, unknown>)
      : {};
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v : undefined;
  const description =
    str(payload.emergencyDescription) ??
    str(entities.emergencyDescription) ??
    'Emergency reported on an inbound call';
  const rawKeywords = Array.isArray(payload.detectedKeywords)
    ? payload.detectedKeywords
    : Array.isArray(entities.detectedKeywords)
      ? entities.detectedKeywords
      : [];
  return {
    emergencyDescription: description,
    detectedKeywords: rawKeywords.filter((k): k is string => typeof k === 'string'),
    callerPhone: str(payload.callerPhone) ?? str(entities.callerPhone),
    customerId: str(payload.customerId) ?? str(entities.customerId),
  };
}

/** Render a held-slot start in the tenant timezone, e.g. "Tue 2:30 PM". */
function formatHeldSlot(start: Date, timezone: string): string {
  const tz = isValidTimezone(timezone) ? timezone : 'UTC';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(start);
}

/** Compose the owner page (≤320 chars, no PII beyond the caller number). */
export function composeEmergencyPageSms(opts: {
  businessName: string;
  emergencyDescription: string;
  callerPhone?: string;
  jobCreated: boolean;
  /** When a tentative hold landed, name the held time (rendered in tenant tz). */
  heldSlot?: { start: Date; timezone: string };
}): string {
  const who = opts.callerPhone ? ` Caller: ${opts.callerPhone}.` : '';
  const job = opts.jobCreated
    ? ' An urgent job was opened on your board.'
    : ' No customer match — call back immediately.';
  const hold = opts.heldSlot
    ? ` Held ${formatHeldSlot(opts.heldSlot.start, opts.heldSlot.timezone)} pending your confirmation.`
    : '';
  const body = `${opts.businessName} EMERGENCY: ${opts.emergencyDescription}.${who}${job}${hold}`;
  return body.length > 320 ? `${body.slice(0, 317)}…` : body;
}

export class EmergencyDispatchExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'emergency_dispatch';
  // Awaits smsSender.sendSms (owner page) and notifyOwner (owner push) —
  // external network I/O alongside the urgent-job + appointment-hold DB writes.
  performsExternalIo = true;

  constructor(
    private readonly jobRepo?: JobRepository,
    private readonly locationRepo?: LocationRepository,
    private readonly settingsRepo?: SettingsRepository,
    private readonly smsSender?: EmergencySmsSender,
    private readonly auditRepo?: AuditRepository,
    // RV-141 hold — when wired, place a tentative hold on the soonest feasible
    // slot. Appended so existing positional callers stay compatible.
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly assignmentRepo?: AssignmentRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const fields = extractEmergencyFields(proposal.payload);

    // Idempotency: a re-run of an already-executed proposal returns the
    // prior entity (matches CreateJobExecutionHandler's guard).
    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    // Idempotency for the PAGE-ONLY path: a prior execution that paged the
    // owner but landed no job (anonymous caller / job-row failure) has no
    // resultEntityId, so the guard above can't see it. The
    // `emergency_dispatch.executed` audit event this handler writes below is
    // the durable marker — re-executing after a page-only success must not
    // page the owner a second time. Best-effort: a degraded audit lookup
    // never blocks a life-safety dispatch (the per-proposal SMS
    // idempotencyKey still suppresses true duplicates at the provider).
    if (this.auditRepo) {
      try {
        const priorEvents = await this.auditRepo.findByEntity(
          context.tenantId,
          'proposal',
          proposal.id,
        );
        const executed = priorEvents.find(
          (e) => e.eventType === 'emergency_dispatch.executed',
        );
        if (executed) {
          const priorJobId = executed.metadata?.jobId;
          return {
            success: true,
            ...(typeof priorJobId === 'string' && priorJobId
              ? { resultEntityId: priorJobId }
              : {}),
          };
        }
      } catch {
        /* fall through to a fresh dispatch — paging twice beats never paging */
      }
    }

    // Degraded passthrough when no deps are wired (in-memory tests that
    // don't exercise the mutation path) — same convention as the other
    // registry handlers.
    if (!this.jobRepo && !this.smsSender) {
      return { success: true, resultEntityId: uuidv4() };
    }

    // 1. Urgent job for the matched customer. Anonymous callers (no
    //    customerId / no service location) cannot get a job row — the owner
    //    page below says so explicitly instead of failing the dispatch.
    let jobId: string | undefined;
    let jobSkipReason: string | undefined;
    if (this.jobRepo && this.locationRepo && fields.customerId) {
      try {
        const locations = await this.locationRepo.findByCustomer(
          context.tenantId,
          fields.customerId,
        );
        const primary = locations.find((l) => l.isPrimary && !l.isArchived);
        const fallback = locations.find((l) => !l.isArchived);
        const locationId = primary?.id ?? fallback?.id;
        if (!locationId) {
          jobSkipReason = 'customer_has_no_service_location';
        } else {
          const job = await createJob(
            {
              tenantId: context.tenantId,
              customerId: fields.customerId,
              locationId,
              summary: `EMERGENCY: ${fields.emergencyDescription}`.slice(0, 200),
              problemDescription: fields.emergencyDescription,
              priority: 'urgent',
              createdBy: context.executedBy,
            },
            this.jobRepo,
          );
          jobId = job.id;
        }
      } catch (err) {
        // The page is the life-safety action — a job-row failure must not
        // block it. Recorded on the audit event below.
        jobSkipReason = err instanceof Error ? err.message : String(err);
      }
    } else if (!fields.customerId) {
      jobSkipReason = 'anonymous_caller';
    } else {
      jobSkipReason = 'job_repos_not_wired';
    }

    // Tenant settings drive both the hold timezone and the owner page
    // target/copy. Fetched once; a lookup failure degrades both to safe
    // defaults rather than failing the dispatch.
    const settings = this.settingsRepo
      ? await this.settingsRepo.findByTenant(context.tenantId).catch(() => null)
      : null;
    const timezone =
      settings?.timezone && isValidTimezone(settings.timezone)
        ? settings.timezone
        : 'UTC';

    // 2. Tentative appointment hold on the soonest feasible slot. Only for an
    //    identified caller whose urgent job exists, and only when an
    //    appointmentRepo is wired. The hold is tentative (holdPendingApproval)
    //    — a human confirms it via the create_booking path, and it auto-
    //    releases at expiry if untouched, so a wrong auto-slot is never
    //    committed. A hold failure never blocks the page/dispatch below.
    let heldAppointmentId: string | undefined;
    let heldSlotStart: Date | undefined;
    let holdSkipReason: string | undefined;
    if (jobId && this.appointmentRepo) {
      try {
        const now = new Date();
        const schedulingConfig = schedulingConfigFromSettings(settings);
        const slots = await findBookableSlots(
          { appointmentRepo: this.appointmentRepo, assignmentRepo: this.assignmentRepo },
          {
            tenantId: context.tenantId,
            fromDate: now.toISOString().slice(0, 10),
            toDate: new Date(
              now.getTime() + EMERGENCY_SLOT_SEARCH_DAYS * 24 * 60 * 60 * 1000,
            )
              .toISOString()
              .slice(0, 10),
            timezone,
            durationMin: EMERGENCY_SLOT_DURATION_MIN,
            weeklyHours: schedulingConfig.weeklyHours,
            bufferMinutes: schedulingConfig.bufferMinutes,
            maxSlots: 1,
            now,
          },
        );
        const soonest = slots[0];
        if (!soonest) {
          holdSkipReason = 'no_feasible_slot';
        } else {
          const held = await createAppointment(
            {
              tenantId: context.tenantId,
              jobId,
              scheduledStart: soonest.start,
              scheduledEnd: soonest.end,
              timezone,
              notes: `EMERGENCY hold — ${fields.emergencyDescription}`.slice(0, 200),
              createdBy: context.executedBy,
              holdPendingApproval: true,
              holdExpiryAt: new Date(now.getTime() + EMERGENCY_HOLD_TTL_MS),
              // Per-proposal dedup: a re-run returns the existing hold instead
              // of placing a second one (belt-and-braces behind the handler's
              // top-level idempotency guards above).
              idempotencyKey: `emergency_dispatch_hold:${proposal.id}`,
            },
            this.appointmentRepo,
          );
          heldAppointmentId = held.id;
          heldSlotStart = held.scheduledStart;
        }
      } catch (err) {
        holdSkipReason = err instanceof Error ? err.message : String(err);
      }
    } else if (!jobId) {
      holdSkipReason = 'no_job_to_hold';
    } else {
      holdSkipReason = 'appointment_repo_not_wired';
    }

    // 3. Owner SMS page via the existing dispatch infra.
    let pagedTo: string | undefined;
    let pageError: string | undefined;
    if (this.smsSender) {
      try {
        const ownerPhone =
          settings?.ownerPhone ?? settings?.transferNumber ?? undefined;
        if (ownerPhone) {
          await this.smsSender.sendSms({
            to: ownerPhone,
            recipientClass: 'owner',
            body: composeEmergencyPageSms({
              businessName: settings?.businessName ?? 'Your shop',
              emergencyDescription: fields.emergencyDescription,
              callerPhone: fields.callerPhone,
              jobCreated: jobId !== undefined,
              ...(heldSlotStart
                ? { heldSlot: { start: heldSlotStart, timezone } }
                : {}),
            }),
            tenantId: context.tenantId,
            idempotencyKey: `emergency_dispatch:${proposal.id}`,
          });
          pagedTo = ownerPhone;
        } else {
          pageError = 'no_owner_phone_configured';
        }
      } catch (err) {
        pageError = err instanceof Error ? err.message : String(err);
      }
    } else {
      pageError = 'sms_sender_not_wired';
    }

    // The dispatch fails ONLY when neither action landed — an urgent job
    // with a failed page (or a page with no job) is still a successful,
    // auditable dispatch.
    const success = jobId !== undefined || pagedTo !== undefined;

    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'system',
            eventType: success
              ? 'emergency_dispatch.executed'
              : 'emergency_dispatch.failed',
            entityType: 'proposal',
            entityId: proposal.id,
            metadata: {
              jobId: jobId ?? null,
              jobSkipReason: jobSkipReason ?? null,
              appointmentHoldId: heldAppointmentId ?? null,
              appointmentHoldStart: heldSlotStart ? heldSlotStart.toISOString() : null,
              holdSkipReason: holdSkipReason ?? null,
              pagedOwner: pagedTo !== undefined,
              pageError: pageError ?? null,
              detectedKeywords: fields.detectedKeywords,
            },
          }),
        );
      } catch {
        // Audit emission is best-effort; the dispatch outcome wins.
      }
    }

    if (!success) {
      return {
        success: false,
        error: `Emergency dispatch could not act: job=${jobSkipReason ?? 'skipped'}, page=${pageError ?? 'skipped'}`,
      };
    }

    // U6 — owner `emergency` push alongside the SMS page. Best-effort and
    // failure-isolated by the notifier; never blocks the life-safety dispatch.
    await notifyOwner(context.tenantId, 'emergency', {
      reason: fields.emergencyDescription,
      proposalId: proposal.id,
      ...(fields.customerId ? { customerId: fields.customerId } : {}),
    });

    return { success: true, ...(jobId ? { resultEntityId: jobId } : {}) };
  }
}
