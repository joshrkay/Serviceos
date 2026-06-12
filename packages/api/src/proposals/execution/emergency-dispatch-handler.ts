/**
 * RV-141 — `emergency_dispatch` execution handler.
 *
 * The proposal type has existed in the Zod contract (and the FSM fast-path
 * queues it) since Phase 12, but NO handler was registered — an approved
 * emergency_dispatch proposal silently failed. This closes that gap:
 *
 *   1. Create an URGENT job (priority 'urgent', summary from the
 *      emergencyDescription) for the matched customer.
 *   2. Page the owner by SMS via the existing dispatch infra
 *      (MessageDeliveryProvider + tenant_settings.owner_phone, falling back
 *      to transfer_number when no owner cell is on file).
 *
 * DOCUMENTED DEVIATION (appointment HOLD): the story's "appointment HOLD on
 * the soonest slot" is intentionally NOT implemented here. Held slots are
 * created by the voice booking path with availability/feasibility deps
 * (AvailabilityFinder + working-hours + assignment conflict machinery) that
 * the execution registry does not carry, and a wrong auto-picked slot on an
 * emergency is worse than none. Instead the urgent job lands on the dispatch
 * board immediately and the owner page directs a human to slot it. If hold
 * mechanics are later wanted, thread an AvailabilityFinder into
 * `createExecutionHandlerRegistry` and create the appointment with
 * holdPendingApproval (see create-booking-handler.ts).
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

/** Minimal SMS seam — satisfied by MessageDeliveryProvider and test stubs. */
export interface EmergencySmsSender {
  sendSms(message: {
    to: string;
    body: string;
    tenantId?: string;
    idempotencyKey?: string;
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

/** Compose the owner page (≤320 chars, no PII beyond the caller number). */
export function composeEmergencyPageSms(opts: {
  businessName: string;
  emergencyDescription: string;
  callerPhone?: string;
  jobCreated: boolean;
}): string {
  const who = opts.callerPhone ? ` Caller: ${opts.callerPhone}.` : '';
  const job = opts.jobCreated
    ? ' An urgent job was opened on your board.'
    : ' No customer match — call back immediately.';
  const body = `${opts.businessName} EMERGENCY: ${opts.emergencyDescription}.${who}${job}`;
  return body.length > 320 ? `${body.slice(0, 317)}…` : body;
}

export class EmergencyDispatchExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'emergency_dispatch';

  constructor(
    private readonly jobRepo?: JobRepository,
    private readonly locationRepo?: LocationRepository,
    private readonly settingsRepo?: SettingsRepository,
    private readonly smsSender?: EmergencySmsSender,
    private readonly auditRepo?: AuditRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const fields = extractEmergencyFields(proposal.payload);

    // Idempotency: a re-run of an already-executed proposal returns the
    // prior entity (matches CreateJobExecutionHandler's guard).
    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
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

    // 2. Owner SMS page via the existing dispatch infra.
    let pagedTo: string | undefined;
    let pageError: string | undefined;
    if (this.smsSender) {
      try {
        const settings = this.settingsRepo
          ? await this.settingsRepo.findByTenant(context.tenantId)
          : null;
        const ownerPhone =
          settings?.ownerPhone ?? settings?.transferNumber ?? undefined;
        if (ownerPhone) {
          await this.smsSender.sendSms({
            to: ownerPhone,
            body: composeEmergencyPageSms({
              businessName: settings?.businessName ?? 'Your shop',
              emergencyDescription: fields.emergencyDescription,
              callerPhone: fields.callerPhone,
              jobCreated: jobId !== undefined,
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
    return { success: true, ...(jobId ? { resultEntityId: jobId } : {}) };
  }
}
