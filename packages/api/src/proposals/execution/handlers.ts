import { v4 as uuidv4 } from 'uuid';
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
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { ConflictError } from '../../shared/errors';
import { JobRepository, createJob } from '../../jobs/job';
import { RefreshJobMoneyStateDeps } from '../../jobs/job-money-state';
import { AppointmentRepository, createAppointment } from '../../appointments/appointment';
import { AssignmentRepository, assignTechnician } from '../../appointments/assignment';
import { InvoiceRepository } from '../../invoices/invoice';
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
import { LineItem } from '../../shared/billing-engine';
import {
  EmergencyDispatchExecutionHandler,
  EmergencySmsSender,
} from './emergency-dispatch-handler';
import { dispatchEstimateNudge } from '../../estimates/estimate-nudge';
import type { SendService } from '../../notifications/send-service';
import type { DispatchRepository } from '../../notifications/dispatch-repository';

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
}

/**
 * @deprecated Use {@link CreateCustomerVoiceExecutionHandler}. Kept as an
 * alias so legacy imports/tests keep compiling; registry always wires the
 * voice handler.
 */
export class CreateCustomerExecutionHandler extends CreateCustomerVoiceExecutionHandler {}

export class UpdateCustomerExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_customer';

  constructor(private readonly customerRepo?: CustomerRepository) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.customerId || typeof payload.customerId !== 'string') {
      return { success: false, error: 'Payload must include a valid customerId' };
    }

    if (!this.customerRepo) {
      return { success: true };
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
  ) {}

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

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly assignmentRepo?: AssignmentRepository,
    private readonly confirmationNotifier: SchedulingConfirmationNotifier = new NoopSchedulingConfirmationNotifier(),
    private readonly auditRepo?: AuditRepository,
    // RV-081 — revisit linkage: validates payload.linkedJobId exists
    // (tenant-scoped) before attaching the appointment to it.
    private readonly jobRepo?: JobRepository,
  ) {}

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
      notes: typeof payload.notes === 'string' ? payload.notes : undefined,
      createdBy: context.executedBy,
    }, this.appointmentRepo);

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

export class DraftEstimateExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'draft_estimate';

  constructor(
    private readonly estimateRepo?: EstimateRepository,
    private readonly settingsRepo?: SettingsRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.customerId || typeof payload.customerId !== 'string') {
      return { success: false, error: 'Payload must include a valid customerId' };
    }
    if (!payload.jobId || typeof payload.jobId !== 'string') {
      return {
        success: false,
        error: 'Estimate requires a jobId — pick a job before drafting',
      };
    }
    if (!Array.isArray(payload.lineItems) || payload.lineItems.length === 0) {
      return { success: false, error: 'Payload must include at least one lineItem' };
    }

    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    if (!this.estimateRepo || !this.settingsRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    try {
      const estimateNumber = await getNextEstimateNumber(context.tenantId, this.settingsRepo);
      const validUntil =
        typeof payload.validUntil === 'string' ? new Date(payload.validUntil) : undefined;
      if (validUntil && isNaN(validUntil.getTime())) {
        return { success: false, error: 'Payload contains an invalid validUntil date' };
      }

      const input: CreateEstimateInput = {
        tenantId: context.tenantId,
        jobId: payload.jobId,
        estimateNumber,
        lineItems: payload.lineItems as LineItem[],
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
      const estimate = await createEstimate(input, this.estimateRepo);
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

  constructor(
    private readonly estimateRepo?: EstimateRepository,
    private readonly sendService?: Pick<SendService, 'sendEstimate'>,
    private readonly dispatchRepo?: DispatchRepository,
    private readonly auditRepo?: AuditRepository,
    /** Injectable clock for deterministic cooldown tests. */
    private readonly now: () => Date = () => new Date(),
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
}): Map<ProposalType, ExecutionHandler> {
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
    new UpdateCustomerExecutionHandler(deps?.customerRepo),
    new CreateJobExecutionHandler(deps?.jobRepo, deps?.locationRepo),
    new CreateAppointmentExecutionHandler(deps?.appointmentRepo, deps?.assignmentRepo, deps?.schedulingNotifier, deps?.auditRepo, deps?.jobRepo),
    new CreateBookingExecutionHandler(deps?.appointmentRepo, deps?.auditRepo),
    new DraftEstimateExecutionHandler(deps?.estimateRepo, deps?.settingsRepo),
    new CreateInvoiceExecutionHandler(deps?.invoiceRepo, deps?.settingsRepo),
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
    new AddNoteExecutionHandler(deps?.noteRepo),
    new SendInvoiceExecutionHandler(deps?.invoiceDeliveryProvider),
    new SendEstimateExecutionHandler(deps?.estimateDeliveryProvider),
    // RV-086 — comms-class nudge for aging sent estimates; 48h cooldown
    // enforced against message_dispatches inside the handler.
    new SendEstimateNudgeExecutionHandler(
      deps?.estimateRepo,
      deps?.sendService,
      deps?.dispatchRepo,
      deps?.auditRepo,
    ),
    new RecordPaymentExecutionHandler(
      deps?.paymentRepo,
      deps?.invoiceRepo,
      moneyStateDeps,
      deps?.transactionalComms,
      deps?.auditRepo,
    ),
    new LogExpenseExecutionHandler(deps?.expenseRepo, deps?.auditRepo),
    new ConvertLeadExecutionHandler(deps?.leadRepo, deps?.customerRepo, deps?.auditRepo),
    new ConfirmAppointmentExecutionHandler(deps?.appointmentRepo),
    new MarkLeadLostExecutionHandler(deps?.leadRepo, deps?.auditRepo),
    new AddServiceLocationExecutionHandler(deps?.locationRepo, deps?.auditRepo),
    new LogTimeEntryExecutionHandler(deps?.timeEntryService),
    new NotifyDelayExecutionHandler(
      deps?.delayNotificationService,
      deps?.appointmentRepo,
      deps?.jobRepo,
      deps?.customerRepo,
    ),
    new RequestFeedbackExecutionHandler(deps?.feedbackRepo),
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
    ),
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

  const registry = new Map<ProposalType, ExecutionHandler>();
  for (const handler of handlers) {
    registry.set(handler.proposalType, handler);
  }
  return registry;
}
