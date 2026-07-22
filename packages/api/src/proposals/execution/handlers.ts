import { v4 as uuidv4 } from 'uuid';
import type { Pool } from 'pg';
import { appointmentTypeSchema, type AppointmentTypeValue } from '@ai-service-os/shared';
import { Proposal, ProposalType, ProposalRepository } from '../proposal';
import { CreateInvoiceExecutionHandler } from './invoice-execution-handler';
import { CreateInvoiceScheduleExecutionHandler } from './invoice-schedule-handler';
import { InvoiceScheduleRepository } from '../../invoices/invoice-schedule';
import { BatchInvoiceExecutionHandler } from './batch-invoice-handler';
import { UpdateInvoiceExecutionHandler } from './update-invoice-handler';
import { IssueInvoiceExecutionHandler } from './issue-invoice-handler';
import { SendPaymentReminderExecutionHandler } from './send-payment-reminder-handler';
import { ApplyLateFeeExecutionHandler } from './apply-late-fee-handler';
import { UpdateEstimateExecutionHandler } from './update-estimate-handler';
import { UpdateJobExecutionHandler } from './update-job-handler';
import { ReassignAppointmentExecutionHandler } from './reassignment-handler';
import { RescheduleAppointmentExecutionHandler } from './reschedule-handler';
import { AddCrewMemberExecutionHandler, RemoveCrewMemberExecutionHandler } from './crew-handler';
import { CancelAppointmentExecutionHandler } from './cancellation-handler';
import {
  AddNoteExecutionHandler,
  SendInvoiceExecutionHandler,
  SendEstimateExecutionHandler,
  RecordPaymentExecutionHandler,
  InvoiceDeliveryProvider,
  EstimateDeliveryProvider,
} from './voice-extended-handlers';
import { LogExpenseExecutionHandler } from './log-expense-handler';
import {
  ReviewResponseExecutionHandler,
  GoogleBusinessReplyResolver,
  ReviewPrivateMessageSender,
} from './review-response-handler';
import { ServiceCreditRepository } from '../../reputation/service-credit';
import { NoteRepository } from '../../notes/note';
import { PaymentRepository } from '../../invoices/payment';
import { ExpenseRepository } from '../../expenses/expense';
import { AuditRepository, InMemoryAuditRepository, createAuditEvent } from '../../audit/audit';
import type { ConsentEventRepository } from '../../compliance/consent-events';
import { ConflictError, ValidationError } from '../../shared/errors';
import { JobRepository, createJob } from '../../jobs/job';
import { JobTimelineRepository } from '../../jobs/job-lifecycle';
import { JobCompletionEffectsDeps } from '../../jobs/completion-effects';
import { TimeEntryRepository } from '../../time-tracking/time-entry';
import { RefreshJobMoneyStateDeps } from '../../jobs/job-money-state';
import { AppointmentRepository, createAppointment } from '../../appointments/appointment';
import { AssignmentRepository, assignTechnician } from '../../appointments/assignment';
import { InvoiceRepository } from '../../invoices/invoice';
import { DunningEventRepository } from '../../invoices/dunning-config';
import {
  EstimateRepository,
  createEstimate,
  CreateEstimateInput,
} from '../../estimates/estimate';
import { SettingsRepository, getNextEstimateNumber } from '../../settings/settings';
import { DocumentRevisionRepository } from '../../ai/document-revision';
import { EditDeltaRepository } from '../../estimates/edit-delta';
import { DispatchAnalyticsRepository } from '../../dispatch/analytics';
import { detectOverlappingAppointments } from '../../dispatch/validation';
import { NoopSchedulingConfirmationNotifier, SchedulingConfirmationNotifier } from './scheduling-notifications';
import { TransactionalCommsService } from '../../notifications/transactional-comms-service';
import { CreateBookingExecutionHandler } from './create-booking-handler';
import {
  CreateCustomerVoiceExecutionHandler,
  splitName,
} from './create-customer-handler';
import {
  CustomerRepository,
  UpdateCustomerInput,
  updateCustomer,
} from '../../customers/customer';
import { LocationRepository } from '../../locations/location';
import { LeadRepository } from '../../leads/lead';
import { ConvertLeadExecutionHandler } from './convert-lead-handler';
import {
  ConfirmAppointmentExecutionHandler,
  MarkLeadLostExecutionHandler,
  AddServiceLocationExecutionHandler,
  LogTimeEntryExecutionHandler,
  NotifyDelayExecutionHandler,
  RequestFeedbackExecutionHandler,
} from './full-app-voice-handlers';
import { TimeEntryService } from '../../time-tracking/time-entry-service';
import { FeedbackRequestRepository } from '../../feedback/feedback-request';
import { DelayNotificationService } from '../../notifications/delay-notifications';
import { LineItem, LineItemCategory, buildLineItem } from '../../shared/billing-engine';
import type { PricingSource } from '../../ai/resolution/catalog-resolver';
import {
  EmergencyDispatchExecutionHandler,
  EmergencySmsSender,
} from './emergency-dispatch-handler';
import { dispatchEstimateNudge } from '../../estimates/estimate-nudge';
import type { SendService } from '../../notifications/send-service';
import type { DispatchRepository } from '../../notifications/dispatch-repository';
import { CreateStandingInstructionExecutionHandler } from './standing-instruction-handler';
import { UpdateCatalogItemExecutionHandler } from './update-catalog-item-handler';
import { CatalogItemRepository } from '../../catalog/catalog-item';
import type { StandingInstructionRepository } from '../../instructions/standing-instructions';
import type { EntityAliasRepository } from '../../learning/entity-aliases/entity-alias';
import { EntityAliasExecutionHandler } from './entity-alias-handler';

export interface ExecutionContext {
  tenantId: string;
  executedBy: string;
}

export interface ExecutionResult {
  success: boolean;
  resultEntityId?: string;
  error?: string;
}

export interface ExecutionHandler {
  proposalType: ProposalType;
  execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult>;
  /**
   * True when `execute()` performs synchronous external network I/O — email /
   * SMS / push / 3rd-party API — so the executor runs it OUTSIDE the DB
   * transaction; the domain DB writes then commit in their own per-call
   * transactions and only the idempotency record + status transition are
   * wrapped in the executor's transaction. Absent/false = DB-only = fully
   * atomic per DATA-31.
   *
   * Rationale (PR #666, Gemini HIGH): a handler that awaits an external send
   * while its domain mutation's row locks are held inside the executor's
   * transaction pins a pooled connection AND holds those locks for the whole
   * network round-trip — a pool-exhaustion + long-lived-lock risk. Marking it
   * here moves the send (and its DB writes) out of the executor transaction.
   */
  performsExternalIo?: boolean;
  /**
   * Optional capability signal for the boot-time wiring guard
   * (proposals/execution/wiring-assertions.ts). Returns false when the
   * handler is missing a dependency it needs to PERSIST — i.e. it would
   * fall back to a synthetic-id passthrough that returns success without
   * saving anything. Handlers that always persist (or have no degraded
   * path) omit this; the guard treats absence as "fully wired".
   */
  isFullyWired?(): boolean;
}

export class UpdateCustomerExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_customer';

  constructor(
    private readonly customerRepo: CustomerRepository | undefined,
    // WS3 — auditRepo is structurally REQUIRED (not optional): update_customer
    // is a consent-bearing mutation and must always emit its customer.updated
    // audit event. A non-optional constructor param makes it impossible to
    // wire this handler without an audit sink. updateCustomer forwards it.
    private readonly auditRepo: AuditRepository,
    // WS3/WS12 — voice consent parity: a spoken smsConsent toggle must append
    // to the consent ledger exactly like the authenticated route does
    // (routes/customers.ts). Optional only so pool-less unit tests can omit
    // it. When a consent-bearing field changes and the ledger is wired, an
    // append failure FAILS the update (see customer.ts updateCustomer) — the
    // whole mutation rolls back atomically via the ambient tenant transaction.
    private readonly consentLedger?: ConsentEventRepository,
  ) {}

  // WS3 — degrades to nothing without the customer repo. The boot-time guard
  // (wiring-assertions.ts) fails boot when a pool is configured but this is
  // false, so the synthetic-success no-op can never run in production.
  isFullyWired(): boolean {
    return Boolean(this.customerRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.customerId || typeof payload.customerId !== 'string') {
      return { success: false, error: 'Payload must include a valid customerId' };
    }

    if (!this.customerRepo) {
      // WS3 — no synthetic success: a missing repo is a wiring fault, never a
      // silent no-op that reports success while persisting nothing.
      return { success: false, error: 'handler_not_wired:customerRepo' };
    }

    const input: UpdateCustomerInput = {};
    if (typeof payload.name === 'string' && payload.name.trim().length > 0) {
      const { firstName, lastName, companyName } = splitName(payload.name);
      input.firstName = firstName;
      input.lastName = lastName;
      if (companyName) input.companyName = companyName;
    }
    if (typeof payload.firstName === 'string') input.firstName = payload.firstName;
    if (typeof payload.lastName === 'string') input.lastName = payload.lastName;
    if (typeof payload.companyName === 'string') input.companyName = payload.companyName;
    if (typeof payload.email === 'string') input.email = payload.email;
    if (typeof payload.phone === 'string') input.primaryPhone = payload.phone;
    if (typeof payload.primaryPhone === 'string') input.primaryPhone = payload.primaryPhone;
    if (typeof payload.secondaryPhone === 'string') input.secondaryPhone = payload.secondaryPhone;
    if (typeof payload.notes === 'string') input.communicationNotes = payload.notes;
    if (typeof payload.communicationNotes === 'string') input.communicationNotes = payload.communicationNotes;
    if (typeof payload.smsConsent === 'boolean') input.smsConsent = payload.smsConsent;

    if (Object.keys(input).length === 0) {
      return { success: false, error: 'Payload must include at least one field to update' };
    }

    try {
      const updated = await updateCustomer(
        context.tenantId,
        payload.customerId,
        input,
        this.customerRepo,
        context.executedBy,
        // WS3 — thread audit + consent ledger through the voice path so
        // updateCustomer emits customer.updated and appends the consent event
        // (all three writes join one transaction via the ambient tenant
        // context established by the executor / request middleware).
        this.auditRepo,
        this.consentLedger,
      );
      if (!updated) {
        return { success: false, error: 'Customer not found' };
      }
      return { success: true, resultEntityId: updated.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export class CreateJobExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_job';

  constructor(
    private readonly jobRepo?: JobRepository,
    private readonly locationRepo?: LocationRepository,
    // Without this the executed job persists but emits no job.created
    // audit event. createJob already forwards it to the audit repo.
    private readonly auditRepo?: AuditRepository,
  ) {}

  // Degrades to a synthetic-id passthrough (saves nothing) without both
  // the job repo and the location repo — see execute().
  isFullyWired(): boolean {
    return Boolean(this.jobRepo) && Boolean(this.locationRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.customerId || typeof payload.customerId !== 'string') {
      return { success: false, error: 'Payload must include a valid customerId' };
    }
    const summary =
      typeof payload.title === 'string'
        ? payload.title
        : typeof payload.summary === 'string'
          ? payload.summary
          : undefined;
    if (!summary || summary.trim().length === 0) {
      return { success: false, error: 'Payload must include a valid title' };
    }

    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    if (!this.jobRepo || !this.locationRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    let locationId: string | undefined =
      typeof payload.locationId === 'string' ? payload.locationId : undefined;
    if (!locationId) {
      const locations = await this.locationRepo.findByCustomer(
        context.tenantId,
        payload.customerId,
      );
      const primary = locations.find((loc) => loc.isPrimary && !loc.isArchived);
      const fallback = locations.find((loc) => !loc.isArchived);
      locationId = primary?.id ?? fallback?.id;
    }
    if (!locationId) {
      return {
        success: false,
        error: 'Customer has no service location — add one before opening a job',
      };
    }

    try {
      const job = await createJob(
        {
          tenantId: context.tenantId,
          customerId: payload.customerId,
          locationId,
          summary: summary.trim(),
          problemDescription:
            typeof payload.problemDescription === 'string'
              ? payload.problemDescription
              : undefined,
          priority:
            payload.priority === 'low' ||
            payload.priority === 'normal' ||
            payload.priority === 'high' ||
            payload.priority === 'urgent'
              ? payload.priority
              : undefined,
          createdBy: context.executedBy,
        },
        this.jobRepo,
        this.auditRepo,
      );
      return { success: true, resultEntityId: job.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export class CreateAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_appointment';
  // Awaits confirmationNotifier.enqueue — in production this is
  // TransactionalCommsService, which sends the customer confirmation SMS/email
  // synchronously via the delivery provider — external network I/O alongside the
  // appointment + assignment DB writes. Those writes already tolerate
  // per-connection commits (assignment-failure compensation), so running out of
  // the executor tx is safe.
  performsExternalIo = true;

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly assignmentRepo?: AssignmentRepository,
    private readonly confirmationNotifier: SchedulingConfirmationNotifier = new NoopSchedulingConfirmationNotifier(),
    private readonly auditRepo?: AuditRepository,
    // RV-081 — revisit linkage: validates payload.linkedJobId exists
    // (tenant-scoped) before attaching the appointment to it.
    private readonly jobRepo?: JobRepository,
  ) {}

  // Degrades to a synthetic-id passthrough (saves nothing) without the
  // appointment repo — see execute().
  isFullyWired(): boolean {
    return Boolean(this.appointmentRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    // RV-081 — a revisit books an appointment against an EXISTING job: when
    // linkedJobId is present it is the job the appointment attaches to (no
    // new job is created), overriding jobId.
    const linkedJobId =
      typeof payload.linkedJobId === 'string' && payload.linkedJobId.length > 0
        ? payload.linkedJobId
        : undefined;
    const targetJobId =
      linkedJobId ?? (typeof payload.jobId === 'string' && payload.jobId.length > 0 ? payload.jobId : undefined);
    if (!targetJobId) {
      return { success: false, error: 'Payload must include a valid jobId' };
    }
    if (!payload.scheduledStart || typeof payload.scheduledStart !== 'string') {
      return { success: false, error: 'Payload must include a valid scheduledStart' };
    }
    if (!payload.scheduledEnd || typeof payload.scheduledEnd !== 'string') {
      return { success: false, error: 'Payload must include a valid scheduledEnd' };
    }

    if (!this.appointmentRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    if (linkedJobId) {
      // Tenant-scoped existence check — a cross-tenant (or deleted) job id
      // must surface as not-found, never silently book against it.
      if (!this.jobRepo) {
        return {
          success: false,
          error: 'Revisit linkage requires the job repository to be wired',
        };
      }
      const linkedJob = await this.jobRepo.findById(context.tenantId, linkedJobId);
      if (!linkedJob) {
        return {
          success: false,
          error: `Linked job ${linkedJobId} not found in this tenant — a revisit must reference an existing job`,
        };
      }
    }

    const scheduledStart = new Date(payload.scheduledStart);
    const scheduledEnd = new Date(payload.scheduledEnd);
    if (isNaN(scheduledStart.getTime()) || isNaN(scheduledEnd.getTime())) {
      return { success: false, error: 'Payload contains invalid appointment times' };
    }

    const timezone = typeof payload.timezone === 'string' ? payload.timezone : 'UTC';

    // Optional customer-facing arrival window (e.g. "we'll be there 8–12").
    const arrivalWindowStart =
      typeof payload.arrivalWindowStart === 'string' ? new Date(payload.arrivalWindowStart) : undefined;
    const arrivalWindowEnd =
      typeof payload.arrivalWindowEnd === 'string' ? new Date(payload.arrivalWindowEnd) : undefined;

    if (this.assignmentRepo && payload.technicianId && typeof payload.technicianId === 'string') {
      const techAssignments = await this.assignmentRepo.findByTechnician(context.tenantId, payload.technicianId);
      const techAppointments = await Promise.all(
        techAssignments.map((a) => this.appointmentRepo!.findById(context.tenantId, a.appointmentId))
      );
      const existingAppts = techAppointments
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => ({
          id: a.id,
          technicianId: payload.technicianId as string,
          scheduledStart: a.scheduledStart,
          scheduledEnd: a.scheduledEnd,
          status: a.status,
        }));
      const conflicts = detectOverlappingAppointments(
        payload.technicianId,
        scheduledStart,
        scheduledEnd,
        existingAppts,
      );
      const blocking = conflicts.find((c) => c.severity === 'blocking');
      if (blocking) {
        return { success: false, error: blocking.message };
      }
    }

    const appointment = await createAppointment({
      tenantId: context.tenantId,
      jobId: targetJobId,
      scheduledStart,
      scheduledEnd,
      ...(arrivalWindowStart && arrivalWindowEnd && !isNaN(arrivalWindowStart.getTime()) && !isNaN(arrivalWindowEnd.getTime())
        ? { arrivalWindowStart, arrivalWindowEnd }
        : {}),
      timezone,
      // Reason-for-visit persistence: voice proposals carry the spoken work
      // description in `summary` (the LLM-extracted "one-line description of
      // the work requested"), while programmatic callers set `notes`. Persist
      // whichever is present — `notes` wins when both exist — so an inbound
      // cold-call create_appointment (no jobId → skips the held-slot path that
      // already maps summary→notes) never drops the caller's reason.
      notes:
        typeof payload.notes === 'string'
          ? payload.notes
          : typeof payload.summary === 'string'
            ? payload.summary
            : undefined,
      // Typed visit kind — enum-validate before persisting. The payload was
      // Zod-checked upstream, but never forward a raw value unguarded.
      appointmentType: appointmentTypeSchema.safeParse(payload.appointmentType).success
        ? (payload.appointmentType as AppointmentTypeValue)
        : undefined,
      createdBy: context.executedBy,
    }, this.appointmentRepo, undefined, this.auditRepo, 'system');

    if (this.assignmentRepo && payload.technicianId && typeof payload.technicianId === 'string') {
      try {
        await assignTechnician({
          tenantId: context.tenantId,
          appointmentId: appointment.id,
          technicianId: payload.technicianId,
          technicianRole: 'technician',
          assignedBy: context.executedBy,
        }, this.assignmentRepo, { appointmentRepo: this.appointmentRepo, auditRepo: this.auditRepo });
      } catch (err) {
        // Atomicity guard: the pre-flight feasibility check above is subject
        // to a TOCTOU race; the authoritative protection is the DB EXCLUDE
        // constraint `no_double_booking` (migration 131), which surfaces here
        // as a ConflictError from assignTechnician. The repositories don't
        // share a client/transaction, so we compensate instead: cancel the
        // appointment we just created so a failed booking never leaves an
        // orphan unassigned appointment behind. The compensation itself must
        // never mask the original failure, and its outcome is audited so an
        // operator can find any orphan it failed to clean up.
        let compensated = true;
        try {
          await this.appointmentRepo.update(context.tenantId, appointment.id, {
            status: 'canceled',
            updatedAt: new Date(),
          });
        } catch {
          compensated = false;
        }
        if (this.auditRepo) {
          try {
            await this.auditRepo.create(
              createAuditEvent({
                tenantId: context.tenantId,
                actorId: context.executedBy,
                actorRole: 'system',
                eventType: compensated
                  ? 'appointment.compensation_canceled'
                  : 'appointment.compensation_failed',
                entityType: 'appointment',
                entityId: appointment.id,
                metadata: {
                  reason: 'assignment_failed_after_create',
                  conflict: err instanceof ConflictError,
                },
              }),
            );
          } catch {
            // Audit emission is best-effort here; the original error wins.
          }
        }
        if (err instanceof ConflictError) {
          return { success: false, error: err.message };
        }
        throw err;
      }
    }

    // RV-081 — audit the revisit linkage so the trail shows this
    // appointment was booked against an existing job rather than a new one.
    if (linkedJobId && this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'system',
            eventType: 'appointment.revisit_linked',
            entityType: 'appointment',
            entityId: appointment.id,
            metadata: {
              revisit: true,
              linkedJobId,
              proposalId: proposal.id,
            },
          }),
        );
      } catch {
        // Audit emission is best-effort — the appointment is already booked.
      }
    }

    const channels: Array<'sms' | 'email'> = Array.isArray(payload.notificationChannels)
      ? payload.notificationChannels.filter((c): c is 'sms' | 'email' => c === 'sms' || c === 'email')
      : ['sms', 'email'];
    const shouldSendConfirmation = payload.sendConfirmation !== false;
    if (shouldSendConfirmation && channels.length > 0) {
      await this.confirmationNotifier.enqueue({
        tenantId: context.tenantId,
        appointmentId: appointment.id,
        jobId: appointment.jobId,
        channels,
      });
    }

    return { success: true, resultEntityId: appointment.id };
  }
}

const VALID_LINE_ITEM_CATEGORIES: readonly LineItemCategory[] = [
  'labor',
  'material',
  'equipment',
  'other',
];

const VALID_PRICING_SOURCES: readonly PricingSource[] = [
  'catalog',
  'ambiguous',
  'uncatalogued',
  'manual',
];

function isPricingSource(value: unknown): value is PricingSource {
  return typeof value === 'string' && (VALID_PRICING_SOURCES as readonly string[]).includes(value);
}

/**
 * Normalize AI-drafted line items (contracts.ts `lineItemSchema`:
 * `{description, quantity, unitPrice? | unitPriceCents?, …}` — no `totalCents`,
 * no `id`/`sortOrder`/`taxable`) into the billing engine's `LineItem` shape.
 *
 * Journey QA 2026-07-02 (bug 10): the executor previously blind-cast the
 * payload to `LineItem[]`, so a drafted line without `totalCents` produced
 * NaN totals and the approved proposal died in Postgres with
 * `invalid input syntax for type integer: "NaN"`.
 *
 * - `totalCents` is derived from `quantity × unitPriceCents` when absent.
 * - `unitPrice` (the estimate-draft emitter's field, integer cents) is
 *   accepted as a fallback for `unitPriceCents`.
 * - A line that cannot be priced/parsed is reported in `malformed` with a
 *   human-readable reason — callers fail the execution with that reason
 *   instead of silently dropping money lines or writing NaN.
 * - Preserves catalog-grounding + tier metadata (pricingSource, groupKey,
 *   groupLabel, isOptional, isDefaultSelected) from main's normalizeEstimateLineItems.
 */
export function normalizeDraftLineItems(raw: unknown[]): {
  lineItems: LineItem[];
  malformed: string[];
} {
  const lineItems: LineItem[] = [];
  const malformed: string[] = [];

  raw.forEach((entry, index) => {
    const label = `Line ${index + 1}`;
    if (typeof entry !== 'object' || entry === null) {
      malformed.push(`${label} is not an object`);
      return;
    }
    const li = entry as Record<string, unknown>;
    const description = typeof li.description === 'string' ? li.description.trim() : '';
    if (!description) {
      malformed.push(`${label} is missing a description`);
      return;
    }
    const quantity =
      typeof li.quantity === 'number' && Number.isFinite(li.quantity) && li.quantity > 0
        ? li.quantity
        : undefined;
    if (quantity === undefined) {
      malformed.push(`${label} ("${description}") has no valid quantity`);
      return;
    }
    const rawPrice =
      typeof li.unitPriceCents === 'number' && Number.isFinite(li.unitPriceCents)
        ? li.unitPriceCents
        : typeof li.unitPrice === 'number' && Number.isFinite(li.unitPrice)
          ? li.unitPrice
          : undefined;
    if (rawPrice === undefined || rawPrice < 0) {
      malformed.push(`${label} ("${description}") has no usable unit price`);
      return;
    }
    const unitPriceCents = Math.round(rawPrice);
    const totalCents =
      typeof li.totalCents === 'number' && Number.isFinite(li.totalCents)
        ? Math.round(li.totalCents)
        : Math.round(quantity * unitPriceCents);

    const rawCategory = typeof li.category === 'string' ? li.category.toLowerCase() : '';

    lineItems.push({
      id: typeof li.id === 'string' && li.id.length > 0 ? li.id : uuidv4(),
      description,
      quantity,
      unitPriceCents,
      totalCents,
      sortOrder: lineItems.length,
      taxable: typeof li.taxable === 'boolean' ? li.taxable : true,
      ...(VALID_LINE_ITEM_CATEGORIES.includes(rawCategory as LineItemCategory)
        ? { category: rawCategory as LineItemCategory }
        : {}),
      ...(isPricingSource(li.pricingSource) ? { pricingSource: li.pricingSource } : {}),
      ...(typeof li.groupKey === 'string' ? { groupKey: li.groupKey } : {}),
      ...(typeof li.groupLabel === 'string' ? { groupLabel: li.groupLabel } : {}),
      ...(typeof li.isOptional === 'boolean' ? { isOptional: li.isOptional } : {}),
      ...(typeof li.isDefaultSelected === 'boolean'
        ? { isDefaultSelected: li.isDefaultSelected }
        : {}),
      // EE-4 — forward the frozen catalog image snapshot; this whitelist would
      // otherwise drop it between the approved proposal and the persisted line
      // (the parity bug this unit exists to prevent).
      ...(typeof li.imageFileId === 'string' ? { imageFileId: li.imageFileId } : {}),
    });
  });

  return { lineItems, malformed };
}

export class DraftEstimateExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'draft_estimate';

  constructor(
    private readonly estimateRepo?: EstimateRepository,
    private readonly settingsRepo?: SettingsRepository,
    // Journey QA 2026-07-02 (bug 10) — voice/assistant-drafted payloads carry a
    // customerId but often no jobId (jobId is optional in
    // draftEstimatePayloadSchema), while the estimate domain requires a job
    // container. When these two repos are wired the handler opens a job for
    // the customer (mirroring CreateJobExecutionHandler's location fallback)
    // instead of refusing the canonical drafted payload.
    private readonly jobRepo?: JobRepository,
    private readonly locationRepo?: LocationRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  // WS3 — degrades to a synthetic-id passthrough (saves nothing) without both
  // the estimate repo and the settings repo (estimate numbering). Boot fails
  // when a pool is configured but this is false.
  isFullyWired(): boolean {
    return Boolean(this.estimateRepo) && Boolean(this.settingsRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    const customerId =
      typeof payload.customerId === 'string' && payload.customerId.length > 0
        ? payload.customerId
        : undefined;
    let jobId =
      typeof payload.jobId === 'string' && payload.jobId.length > 0 ? payload.jobId : undefined;
    if (!customerId && !jobId) {
      return {
        success: false,
        error:
          'Estimate draft has neither a customerId nor a jobId — link a customer before approving',
      };
    }
    if (!Array.isArray(payload.lineItems) || payload.lineItems.length === 0) {
      return { success: false, error: 'Payload must include at least one lineItem' };
    }
    const { lineItems, malformed } = normalizeDraftLineItems(payload.lineItems);
    if (malformed.length > 0) {
      return {
        success: false,
        error: `Estimate draft has line items that can't be priced: ${malformed.join('; ')}`,
      };
    }
    const validUntil =
      typeof payload.validUntil === 'string' ? new Date(payload.validUntil) : undefined;
    if (validUntil && isNaN(validUntil.getTime())) {
      return { success: false, error: 'Payload contains an invalid validUntil date' };
    }

    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    if (!this.estimateRepo || !this.settingsRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    try {
      // Estimates require a job container (estimate.ts validateEstimateInput).
      // A drafted payload without one gets a job opened for the customer.
      if (!jobId) {
        if (!this.jobRepo || !this.locationRepo) {
          return {
            success: false,
            error:
              'Estimate draft has no jobId and job auto-creation is not configured — pick a job before approving',
          };
        }
        const locations = await this.locationRepo.findByCustomer(context.tenantId, customerId!);
        const location =
          locations.find((loc) => loc.isPrimary && !loc.isArchived) ??
          locations.find((loc) => !loc.isArchived);
        if (!location) {
          return {
            success: false,
            error: 'Customer has no service location — add one before approving this estimate',
          };
        }
        const job = await createJob(
          {
            tenantId: context.tenantId,
            customerId: customerId!,
            locationId: location.id,
            summary:
              typeof payload.summary === 'string' && payload.summary.trim().length > 0
                ? payload.summary.trim()
                : proposal.summary || lineItems[0].description,
            createdBy: context.executedBy,
          },
          this.jobRepo,
          this.auditRepo,
        );
        jobId = job.id;
      }

      const estimateNumber = await getNextEstimateNumber(context.tenantId, this.settingsRepo);

      const input: CreateEstimateInput = {
        tenantId: context.tenantId,
        jobId,
        estimateNumber,
        lineItems,
        discountCents:
          typeof payload.discountCents === 'number' ? payload.discountCents : undefined,
        taxRateBps: typeof payload.taxRateBps === 'number' ? payload.taxRateBps : undefined,
        validUntil,
        customerMessage:
          typeof payload.customerMessage === 'string' ? payload.customerMessage : undefined,
        internalNotes:
          typeof payload.notes === 'string'
            ? payload.notes
            : typeof payload.internalNotes === 'string'
              ? payload.internalNotes
              : undefined,
        createdBy: context.executedBy,
      };
      const estimate = await createEstimate(input, this.estimateRepo, this.auditRepo);
      return { success: true, resultEntityId: estimate.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ─── send_estimate_nudge (RV-086) ─────────────────────────────────────────
//
// Re-sends an aging, still-unanswered estimate to the customer through the
// SAME send composition the estimate-reminder worker uses
// (dispatchEstimateNudge → SendService.sendEstimate + reminder bookkeeping +
// `estimate.reminder_sent` audit). Comms-class: only ever runs after an
// explicit human approval.
//
// Cooldown: the handler REFUSES (execution_failed with a clear reason) when
// any message for this estimate was already dispatched within the last 48
// hours — checked against message_dispatches (entity_type='estimate', by
// recency, ignoring failed rows) plus the estimate's own last_reminder_at as
// a belt-and-braces fallback when the dispatch repo isn't wired.
export const ESTIMATE_NUDGE_COOLDOWN_MS = 48 * 60 * 60 * 1000;

export class SendEstimateNudgeExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'send_estimate_nudge';
  // Awaits dispatchEstimateNudge → sendService.sendEstimate (outbound estimate
  // re-send via the send service) — external network I/O alongside the
  // estimate reminder-bookkeeping DB write.
  performsExternalIo = true;

  constructor(
    private readonly estimateRepo?: EstimateRepository,
    private readonly sendService?: Pick<SendService, 'sendEstimate'>,
    private readonly dispatchRepo?: DispatchRepository,
    private readonly auditRepo?: AuditRepository,
    /** Injectable clock for deterministic cooldown tests. */
    private readonly now: () => Date = () => new Date(),
    /**
     * T4-F01 claim ledger pool, threaded into dispatchEstimateNudge's
     * claim-before-send gate. Undefined/null in dev/test without a DB —
     * the claim wrapper no-ops and the send proceeds directly.
     */
    private readonly pool?: Pool | null,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    const estimateId = payload.estimateId;
    if (
      typeof estimateId !== 'string' ||
      !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(estimateId)
    ) {
      return {
        success: false,
        error: 'Payload must include a valid estimateId UUID (resolve estimateReference at review time first)',
      };
    }

    if (!this.estimateRepo || !this.sendService) {
      // Fail-closed: customer-facing sends must never silently no-op with a
      // clean audit trail. Owner-approved comms that reach this handler
      // without the required deps wired are a misconfiguration — surface it.
      return {
        success: false,
        error: 'send service not configured',
      };
    }

    const estimate = await this.estimateRepo.findById(context.tenantId, estimateId);
    if (!estimate) {
      return { success: false, error: `Estimate ${estimateId} not found in this tenant` };
    }
    if (estimate.status !== 'sent') {
      return {
        success: false,
        error: `Estimate ${estimate.estimateNumber} is '${estimate.status}' — only a sent, still-unanswered estimate can be nudged`,
      };
    }

    const asOf = this.now();
    const cooldownFloor = asOf.getTime() - ESTIMATE_NUDGE_COOLDOWN_MS;

    // Cooldown source of truth: message_dispatches for this estimate.
    if (this.dispatchRepo) {
      const dispatches = await this.dispatchRepo.findByEntity(
        context.tenantId,
        'estimate',
        estimateId,
      );
      const recent = dispatches.find(
        (d) =>
          // 'failed' and 'bounced' dispatches never reached the customer —
          // neither counts against the 48h spacing.
          d.status !== 'failed' &&
          d.status !== 'bounced' &&
          d.sentAt.getTime() >= cooldownFloor,
      );
      if (recent) {
        return {
          success: false,
          error:
            `Nudge refused: a message for estimate ${estimate.estimateNumber} was already sent ` +
            `at ${recent.sentAt.toISOString()} — wait 48h between reminders`,
        };
      }
    }

    // Belt-and-braces: ALSO check estimate.lastReminderAt regardless of
    // whether the dispatch repo is wired. Whichever source is more recent
    // governs; both checks must pass for the nudge to proceed.
    if (
      estimate.lastReminderAt !== undefined &&
      estimate.lastReminderAt.getTime() >= cooldownFloor
    ) {
      return {
        success: false,
        error:
          `Nudge refused: estimate ${estimate.estimateNumber} was already reminded ` +
          `at ${estimate.lastReminderAt.toISOString()} — wait 48h between reminders`,
      };
    }

    try {
      await dispatchEstimateNudge(
        {
          estimateRepo: this.estimateRepo,
          sendService: this.sendService,
          pool: this.pool ?? null,
          ...(this.auditRepo ? { auditRepo: this.auditRepo } : {}),
        },
        {
          tenantId: context.tenantId,
          estimate,
          channel: 'sms',
          asOf,
          actorId: context.executedBy,
          ...(typeof payload.note === 'string' && payload.note.trim().length > 0
            ? { customMessage: payload.note }
            : {}),
        },
      );
      return { success: true, resultEntityId: estimate.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Estimate nudge failed',
      };
    }
  }
}

export function createExecutionHandlerRegistry(deps?: {
  customerRepo?: CustomerRepository;
  jobRepo?: JobRepository;
  // B7 (money-loss fix) — required so update_job routes a status change through
  // the governed transitionJobStatus (timeline entry + completedAt).
  timelineRepo?: JobTimelineRepository;
  // B7 — recompute the labor line from logged time before auto-invoicing on
  // completion (mirrors the route's autoInvoiceDeps.timeEntryRepo).
  timeEntryRepo?: TimeEntryRepository;
  locationRepo?: LocationRepository;
  appointmentRepo?: AppointmentRepository;
  assignmentRepo?: AssignmentRepository;
  invoiceRepo?: InvoiceRepository;
  estimateRepo?: EstimateRepository;
  settingsRepo?: SettingsRepository;
  // P21-002 — create_invoice_schedule. Absent → handler degrades to passthrough.
  scheduleRepo?: InvoiceScheduleRepository;
  // P21-003 — batch_invoice fans out draft_invoice proposals via this repo.
  proposalRepo?: ProposalRepository;
  // Collections cadence — dunning-event ledger. When wired, MANUAL (voice)
  // send_payment_reminder proposals are deduped at execution time (72h
  // cooldown + record-first idempotency). Absent → legacy send behavior.
  dunningEventRepo?: DunningEventRepository;
  // Estimate edit history — when wired, voice update_estimate snapshots a
  // revision + edit delta, matching the authenticated edit path.
  docRevisionRepo?: DocumentRevisionRepository;
  editDeltaRepo?: EditDeltaRepository;
  schedulingNotifier?: SchedulingConfirmationNotifier;
  transactionalComms?: TransactionalCommsService;
  noteRepo?: NoteRepository;
  paymentRepo?: PaymentRepository;
  invoiceDeliveryProvider?: InvoiceDeliveryProvider;
  estimateDeliveryProvider?: EstimateDeliveryProvider;
  analyticsRepo?: DispatchAnalyticsRepository;
  expenseRepo?: ExpenseRepository;
  auditRepo?: AuditRepository;
  feasibilityDeps?: import('../../scheduling/feasibility-types').FeasibilityDependencies;
  // P7-026 PR c — review-response wiring. All three are optional;
  // when absent the handler degrades sub-actions to passthrough so
  // unit tests that don't exercise the mutation path can omit them.
  serviceCreditRepo?: ServiceCreditRepository;
  googleReplyResolver?: GoogleBusinessReplyResolver;
  reviewPrivateMessageSender?: ReviewPrivateMessageSender;
  // convert_lead / mark_lead_lost wiring. When absent the handler
  // degrades to a passthrough so in-memory tests can omit it.
  leadRepo?: LeadRepository;
  // Wave-2 full-app voice handlers. All optional; absent → passthrough.
  timeEntryService?: TimeEntryService;
  feedbackRepo?: FeedbackRequestRepository;
  delayNotificationService?: DelayNotificationService;
  // RV-141 — emergency_dispatch owner page. Optional; absent → the handler
  // degrades per its own per-dep guards (job-only / passthrough).
  emergencySmsSender?: EmergencySmsSender;
  // RV-086 — send_estimate_nudge. sendService drives the actual re-send;
  // dispatchRepo backs the 48h cooldown check. Absent → degraded behavior
  // documented on the handler.
  sendService?: Pick<SendService, 'sendEstimate'>;
  dispatchRepo?: DispatchRepository;
  // T4-F01 — claim-before-send pool for send_estimate_nudge's
  // dispatchEstimateNudge call. Absent/null → the claim wrapper no-ops.
  pool?: Pool | null;
  // UB-A2 — create_standing_instruction inserts via the UB-A1 repo.
  // Absent → the handler degrades to a synthetic-id passthrough.
  standingInstructionRepo?: StandingInstructionRepository;
  // WS20 — update_catalog_item writes the new SKU price via the catalog repo.
  // Absent → the handler degrades to a synthetic passthrough.
  catalogRepo?: CatalogItemRepository;
  // Tenant entity aliases activate only through an owner-approved proposal.
  // Absent fails closed inside the handler.
  entityAliasRepo?: EntityAliasRepository;
  // WS3 — voice update_customer consent parity. When wired, a spoken smsConsent
  // toggle appends to the consent ledger (kind 'sms', source 'manual') in the
  // SAME transaction as the customer update + audit event.
  consentEventRepo?: ConsentEventRepository;
}): Map<ProposalType, ExecutionHandler> {
  // WS3 — audit is a structural invariant for the consent/entity mutation
  // handlers below (their constructors take a non-optional AuditRepository).
  // Production always passes deps.auditRepo (app.ts); an in-memory fallback
  // keeps `createExecutionHandlerRegistry({})` unit-test call sites valid
  // without letting a handler skip auditing entirely.
  const requiredAuditRepo: AuditRepository = deps?.auditRepo ?? new InMemoryAuditRepository();
  // §6 Time-to-Cash. Built once; passed to the handlers that call the
  // widened money-mutation domain functions (recordPayment, issueInvoice).
  // `logger` is intentionally omitted — the registry has no ambient logger
  // in scope, so rollup failures from AI-driven payment/invoice paths are
  // silently swallowed here. Route-layer call sites in Task 5 + Task 6
  // include a logger; the registry can adopt one when a Logger param is
  // threaded through createExecutionHandlerRegistry's deps.
  const moneyStateDeps: RefreshJobMoneyStateDeps | undefined =
    deps?.jobRepo && deps?.estimateRepo && deps?.invoiceRepo
      ? {
          jobRepo: deps.jobRepo,
          estimateRepo: deps.estimateRepo,
          invoiceRepo: deps.invoiceRepo,
          auditRepo: deps.auditRepo,
        }
      : undefined;

  const handlers: ExecutionHandler[] = [
    new CreateCustomerVoiceExecutionHandler(deps?.customerRepo, deps?.auditRepo),
    new UpdateCustomerExecutionHandler(deps?.customerRepo, requiredAuditRepo, deps?.consentEventRepo),
    new CreateJobExecutionHandler(deps?.jobRepo, deps?.locationRepo, deps?.auditRepo),
    new CreateAppointmentExecutionHandler(deps?.appointmentRepo, deps?.assignmentRepo, deps?.schedulingNotifier, deps?.auditRepo, deps?.jobRepo),
    new CreateBookingExecutionHandler(deps?.appointmentRepo, deps?.auditRepo),
    new DraftEstimateExecutionHandler(
      deps?.estimateRepo,
      deps?.settingsRepo,
      deps?.jobRepo,
      deps?.locationRepo,
      deps?.auditRepo,
    ),
    new CreateInvoiceExecutionHandler(
      deps?.invoiceRepo,
      deps?.settingsRepo,
      deps?.auditRepo,
      deps?.jobRepo,
      deps?.locationRepo,
    ),
    new CreateInvoiceScheduleExecutionHandler(deps?.scheduleRepo, deps?.invoiceRepo, deps?.settingsRepo, deps?.estimateRepo),
    new BatchInvoiceExecutionHandler(deps?.proposalRepo),
    new ReassignAppointmentExecutionHandler(deps?.appointmentRepo, deps?.assignmentRepo, deps?.analyticsRepo, deps?.feasibilityDeps, deps?.auditRepo),
    new AddCrewMemberExecutionHandler(deps?.appointmentRepo, deps?.assignmentRepo, deps?.analyticsRepo, deps?.feasibilityDeps, deps?.auditRepo),
    new RemoveCrewMemberExecutionHandler(deps?.appointmentRepo, deps?.assignmentRepo, deps?.analyticsRepo, deps?.auditRepo),
    new RescheduleAppointmentExecutionHandler(
      deps?.appointmentRepo,
      deps?.assignmentRepo,
      deps?.analyticsRepo,
      deps?.auditRepo,
      deps?.feasibilityDeps,
      deps?.transactionalComms,
    ),
    new CancelAppointmentExecutionHandler(
      deps?.appointmentRepo,
      deps?.analyticsRepo,
      deps?.auditRepo,
      deps?.transactionalComms,
    ),
    // Stage-2 voice handlers wired against real repositories. Each
    // handler degrades to a synthetic-id passthrough when its dep is
    // absent (used by in-memory tests that don't exercise the
    // mutation path). Production wires the real deps in app.ts.
    new AddNoteExecutionHandler(deps?.noteRepo, requiredAuditRepo),
    new SendInvoiceExecutionHandler(deps?.invoiceDeliveryProvider),
    new SendEstimateExecutionHandler(deps?.estimateDeliveryProvider),
    // RV-086 — comms-class nudge for aging sent estimates; 48h cooldown
    // enforced against message_dispatches inside the handler.
    new SendEstimateNudgeExecutionHandler(
      deps?.estimateRepo,
      deps?.sendService,
      deps?.dispatchRepo,
      deps?.auditRepo,
      undefined,
      deps?.pool,
    ),
    new RecordPaymentExecutionHandler(
      deps?.paymentRepo,
      deps?.invoiceRepo,
      moneyStateDeps,
      deps?.transactionalComms,
      deps?.auditRepo,
    ),
    new LogExpenseExecutionHandler(deps?.expenseRepo, deps?.auditRepo),
    new ConvertLeadExecutionHandler(deps?.leadRepo, deps?.customerRepo, deps?.auditRepo, deps?.locationRepo),
    new ConfirmAppointmentExecutionHandler(deps?.appointmentRepo, requiredAuditRepo),
    new MarkLeadLostExecutionHandler(deps?.leadRepo, deps?.auditRepo),
    new AddServiceLocationExecutionHandler(deps?.locationRepo, deps?.auditRepo),
    new LogTimeEntryExecutionHandler(deps?.timeEntryService),
    new NotifyDelayExecutionHandler(
      deps?.delayNotificationService,
      deps?.appointmentRepo,
      deps?.jobRepo,
      deps?.customerRepo,
    ),
    new RequestFeedbackExecutionHandler(deps?.feedbackRepo, requiredAuditRepo),
    // P7-026 PR c — review-response handler. Wired with optional deps;
    // see ReviewResponseExecutionHandler constructor for per-dep
    // degraded behavior. Action class 'comms' guarantees the proposal
    // can never auto-approve, so this only ever runs after explicit
    // owner approval per component.
    new ReviewResponseExecutionHandler(
      deps?.serviceCreditRepo,
      deps?.googleReplyResolver,
      deps?.reviewPrivateMessageSender,
      deps?.auditRepo,
    ),
    // RV-141 — emergency_dispatch: urgent job + tentative appointment hold on
    // the soonest feasible slot + owner SMS page. appointmentRepo/assignmentRepo
    // drive the hold; absent → the handler skips the hold and still pages.
    new EmergencyDispatchExecutionHandler(
      deps?.jobRepo,
      deps?.locationRepo,
      deps?.settingsRepo,
      deps?.emergencySmsSender,
      deps?.auditRepo,
      deps?.appointmentRepo,
      deps?.assignmentRepo,
    ),
    // Collections cadence — send_payment_reminder. Comms-class: only runs
    // after owner approval. Sends through the Layer-A transactional-comms
    // path; degrades to a synthetic-id passthrough when comms is absent.
    new SendPaymentReminderExecutionHandler(
      deps?.transactionalComms,
      deps?.auditRepo,
      deps?.dunningEventRepo,
    ),
    // UB-A2 — create_standing_instruction: inserts the approved directive via
    // the UB-A1 domain service (500-char cap, scope validation, 20-active
    // cap, standing_instruction.created audit). Capture-class, but the voice
    // task never passes a trust tier, so it only ever runs after a human tap.
    new CreateStandingInstructionExecutionHandler(
      deps?.standingInstructionRepo,
      deps?.auditRepo,
    ),
    // WS20 — update_catalog_item: applies the owner-ratified catalog price via
    // the catalog domain fn (which emits catalog_item.updated). Capture-class,
    // but the correction loop creates it with no trust tier, so it only ever
    // runs after a human tap.
    new UpdateCatalogItemExecutionHandler(deps?.catalogRepo, deps?.auditRepo),
    new EntityAliasExecutionHandler(deps?.entityAliasRepo),
  ];

  // Handlers that mutate existing entities take a repo dep. Registered
  // only when the repo is wired in, so in-memory tests that don't
  // touch these don't have to provide the dep.
  if (deps?.invoiceRepo) {
    handlers.push(new UpdateInvoiceExecutionHandler(deps.invoiceRepo));
    // P22-002 — issue_invoice: draft → open with tenant payment terms,
    // tenant-timezone due date, and an invoice.issued audit event.
    handlers.push(new IssueInvoiceExecutionHandler(
      deps.invoiceRepo,
      deps.settingsRepo,
      deps.auditRepo,
      moneyStateDeps,
    ));
    // Collections cadence — apply_late_fee: appends a non-taxable late-fee
    // line to an overdue invoice and refreshes the money-state rollup.
    // Money-class: only runs after explicit owner approval.
    handlers.push(new ApplyLateFeeExecutionHandler(
      deps.invoiceRepo,
      deps.auditRepo,
      moneyStateDeps,
    ));
  }
  if (deps?.estimateRepo) {
    handlers.push(new UpdateEstimateExecutionHandler(
      deps.estimateRepo,
      deps.auditRepo,
      deps.docRevisionRepo,
      deps.editDeltaRepo,
      // Deposit lock: the handler resolves the linked job's
      // depositPaidCents and refuses the edit once money was collected.
      // Fail-closed inside the handler when the repo is absent.
      deps.jobRepo,
    ));
  }
  // B7 — update_job mutates an EXISTING job; only registered when the job
  // repo is wired (mirrors update_estimate/update_invoice above — no
  // synthetic-id passthrough for an edit to a real, already-created entity).
  if (deps?.jobRepo) {
    // Completion side effects (auto-invoice + milestone minting) fire when a
    // voice-approved update_job marks a job completed — the SAME effects the
    // route runs. Built only when the invoice/estimate/proposal/settings deps
    // are present; scheduleRepo/timeEntryRepo are optional (milestone minting /
    // labor-from-time-entries degrade off when absent).
    const jobCompletionDeps: JobCompletionEffectsDeps | undefined =
      deps.estimateRepo && deps.invoiceRepo && deps.proposalRepo && deps.settingsRepo
        ? {
            estimateRepo: deps.estimateRepo,
            invoiceRepo: deps.invoiceRepo,
            proposalRepo: deps.proposalRepo,
            settingsRepo: deps.settingsRepo,
            ...(deps.auditRepo ? { auditRepo: deps.auditRepo } : {}),
            ...(deps.scheduleRepo ? { scheduleRepo: deps.scheduleRepo } : {}),
            ...(deps.timeEntryRepo ? { timeEntryRepo: deps.timeEntryRepo } : {}),
          }
        : undefined;
    handlers.push(
      new UpdateJobExecutionHandler(
        deps.jobRepo,
        deps.auditRepo,
        deps.timelineRepo,
        jobCompletionDeps,
      ),
    );
  }

  const registry = new Map<ProposalType, ExecutionHandler>();
  for (const handler of handlers) {
    registry.set(handler.proposalType, handler);
  }
  return registry;
}
