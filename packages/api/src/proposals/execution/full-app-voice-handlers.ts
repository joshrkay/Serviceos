/**
 * Execution handlers for the wave-2 full-app voice capabilities:
 * confirm_appointment, mark_lead_lost, add_service_location,
 * log_time_entry, notify_delay, request_feedback.
 *
 * Each handler resolves the concrete entity ids the voice task handler
 * left as `missingFields` (the classifier never touches the DB), then
 * calls the existing domain service so the voice path and the
 * authenticated route path share one mutation implementation. Handlers
 * degrade to a success passthrough when their optional dep is absent so
 * in-memory tests that don't exercise the mutation path can omit it —
 * the same convention the voice-extended handlers use.
 */
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { AppointmentRepository } from '../../appointments/appointment';
import { LeadRepository } from '../../leads/lead';
import { loseLead } from '../../leads/lead-service';
import { LocationRepository, createLocation } from '../../locations/location';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { TimeEntryService } from '../../time-tracking/time-entry-service';
import { EntryType } from '../../time-tracking/time-entry';
import {
  FeedbackRequestRepository,
  createFeedbackRequest,
} from '../../feedback/feedback-request';
import { JobRepository } from '../../jobs/job';
import { CustomerRepository } from '../../customers/customer';
import {
  DelayNotificationService,
  resolveCustomerChannel,
  renderDelayTemplateVariants,
  selectDelayTemplate,
} from '../../notifications/delay-notifications';

export class ConfirmAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'confirm_appointment';

  constructor(
    private readonly appointmentRepo: AppointmentRepository | undefined,
    // WS3 — auditRepo is structurally REQUIRED: confirming an appointment is a
    // state mutation and must emit its appointment.confirmed audit event. There
    // is no domain fn for this bare status flip, so the handler emits it
    // directly. Non-optional so a call site cannot skip the audit.
    private readonly auditRepo: AuditRepository,
  ) {}

  // WS3 — degrades to nothing without the appointment repo; boot fails when a
  // pool is configured but this is false.
  isFullyWired(): boolean {
    return Boolean(this.appointmentRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const appointmentId = typeof payload.appointmentId === 'string' ? payload.appointmentId : undefined;
    if (!appointmentId) {
      return { success: false, error: 'confirm_appointment requires a resolved appointmentId' };
    }
    if (!this.appointmentRepo) {
      // WS3 — no synthetic success: a missing repo is a wiring fault.
      return { success: false, error: 'handler_not_wired:appointmentRepo' };
    }
    try {
      const updated = await this.appointmentRepo.update(context.tenantId, appointmentId, {
        status: 'confirmed',
        updatedAt: new Date(),
      });
      if (!updated) {
        return { success: false, error: `Appointment ${appointmentId} not found` };
      }
      // WS3 — emit the appointment.confirmed audit event. Bare `await` (no
      // try/catch): the audit joins the ambient tenant transaction, so a
      // failure here rolls back the status flip rather than silently losing
      // the only audit record of this mutation.
      await this.auditRepo.create(
        createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.executedBy,
          actorRole: 'system',
          eventType: 'appointment.confirmed',
          entityType: 'appointment',
          entityId: appointmentId,
          metadata: { proposalId: proposal.id, jobId: updated.jobId },
        }),
      );
      return { success: true, resultEntityId: appointmentId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export class MarkLeadLostExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'mark_lead_lost';

  constructor(
    private readonly leadRepo?: LeadRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  // WS3 — degrades to a synthetic-id passthrough (saves nothing) without the
  // lead repo; boot fails when a pool is configured but this is false.
  isFullyWired(): boolean {
    return Boolean(this.leadRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const leadId = typeof payload.leadId === 'string' ? payload.leadId : undefined;
    const reason = typeof payload.reason === 'string' && payload.reason.length > 0
      ? payload.reason
      : 'Lost (voice)';
    if (!leadId) {
      return { success: false, error: 'mark_lead_lost requires a resolved leadId' };
    }
    if (!this.leadRepo) {
      return { success: true, resultEntityId: leadId };
    }
    try {
      const updated = await loseLead(
        context.tenantId,
        leadId,
        reason,
        this.leadRepo,
        context.executedBy,
        'owner',
        this.auditRepo,
      );
      if (!updated) {
        return { success: false, error: `Lead ${leadId} not found` };
      }
      return { success: true, resultEntityId: leadId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export class AddServiceLocationExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'add_service_location';

  constructor(
    private readonly locationRepo?: LocationRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  // WS3 — degrades to a synthetic-id passthrough (saves nothing) without the
  // location repo; boot fails when a pool is configured but this is false.
  isFullyWired(): boolean {
    return Boolean(this.locationRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const customerId = typeof payload.customerId === 'string' ? payload.customerId : undefined;
    const street1 = typeof payload.street1 === 'string' ? payload.street1 : undefined;
    const city = typeof payload.city === 'string' ? payload.city : undefined;
    const state = typeof payload.state === 'string' ? payload.state : undefined;
    const postalCode = typeof payload.postalCode === 'string' ? payload.postalCode : undefined;

    if (!customerId || !street1 || !city || !state || !postalCode) {
      return {
        success: false,
        error: 'add_service_location requires a resolved customerId and full address',
      };
    }
    if (!this.locationRepo) {
      return { success: true, resultEntityId: customerId };
    }
    try {
      const created = await createLocation(
        {
          tenantId: context.tenantId,
          customerId,
          street1,
          city,
          state,
          postalCode,
          label: typeof payload.label === 'string' ? payload.label : undefined,
          street2: typeof payload.street2 === 'string' ? payload.street2 : undefined,
        },
        this.locationRepo,
        this.auditRepo,
        context.executedBy,
        'owner',
      );
      return { success: true, resultEntityId: created.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export class LogTimeEntryExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'log_time_entry';

  constructor(private readonly timeEntryService?: TimeEntryService) {}

  // WS3 — degrades to a success passthrough (clocks in nothing) without the
  // time-entry service; boot fails when a pool is configured but this is false.
  isFullyWired(): boolean {
    return Boolean(this.timeEntryService);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const entryType = (typeof payload.entryType === 'string' ? payload.entryType : 'job') as EntryType;
    const jobId = typeof payload.jobId === 'string' ? payload.jobId : undefined;
    const notes = typeof payload.notes === 'string' ? payload.notes : undefined;

    if (!this.timeEntryService) {
      return { success: true };
    }
    try {
      const entry = await this.timeEntryService.clockIn(context.tenantId, context.executedBy, {
        entryType,
        ...(jobId ? { jobId } : {}),
        ...(notes ? { notes } : {}),
      });
      return { success: true, resultEntityId: entry.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export class NotifyDelayExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'notify_delay';
  // Awaits delayService.sendDelayNotice — outbound customer delay SMS/email via
  // the delivery provider. Read-only on the DB otherwise (no domain mutation).
  performsExternalIo = true;

  constructor(
    private readonly delayService?: DelayNotificationService,
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly jobRepo?: JobRepository,
    private readonly customerRepo?: CustomerRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const appointmentId = typeof payload.appointmentId === 'string' ? payload.appointmentId : undefined;
    const delayMinutes = typeof payload.delayMinutes === 'number' ? payload.delayMinutes : 15;
    if (!appointmentId) {
      return { success: false, error: 'notify_delay requires a resolved appointmentId' };
    }

    // Degrade to a validated passthrough when the send path isn't fully
    // wired (in-memory tests) — mirrors the Noop-provider gate used by
    // send_invoice / send_estimate.
    if (!this.delayService || !this.appointmentRepo || !this.jobRepo || !this.customerRepo) {
      return { success: true, resultEntityId: appointmentId };
    }

    try {
      const appointment = await this.appointmentRepo.findById(context.tenantId, appointmentId);
      if (!appointment) {
        return { success: false, error: `Appointment ${appointmentId} not found` };
      }
      const job = await this.jobRepo.findById(context.tenantId, appointment.jobId);
      if (!job) {
        return { success: false, error: `Job for appointment ${appointmentId} not found` };
      }
      const customer = await this.customerRepo.findById(context.tenantId, job.customerId);
      if (!customer) {
        return { success: false, error: `Customer for appointment ${appointmentId} not found` };
      }

      const { channel, destination } = resolveCustomerChannel(customer);
      // in_app (or no destination) means there is no external channel the
      // customer opted into — nothing to send, but not a failure.
      if (channel === 'in_app' || !destination) {
        return { success: true, resultEntityId: appointmentId };
      }

      const variants = renderDelayTemplateVariants({
        customerName: customer.displayName,
        delayMinutes,
      });
      const message = selectDelayTemplate(variants, delayMinutes);

      await this.delayService.sendDelayNotice({
        tenantId: context.tenantId,
        customerId: customer.id,
        channel,
        destination,
        message,
        idempotencyKey: proposal.id,
      });
      return { success: true, resultEntityId: appointmentId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export class RequestFeedbackExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'request_feedback';

  constructor(
    private readonly feedbackRepo: FeedbackRequestRepository | undefined,
    // WS3 — auditRepo is structurally REQUIRED: creating a feedback request is
    // a mutation that must emit its audit event. createFeedbackRequest has no
    // audit hook, so the handler emits it directly. Non-optional so a call site
    // cannot skip the audit.
    private readonly auditRepo: AuditRepository,
  ) {}

  // WS3 — degrades to nothing without the feedback repo; boot fails when a pool
  // is configured but this is false.
  isFullyWired(): boolean {
    return Boolean(this.feedbackRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const jobId = typeof payload.jobId === 'string' ? payload.jobId : undefined;
    if (!jobId) {
      return { success: false, error: 'request_feedback requires a resolved jobId' };
    }
    if (!this.feedbackRepo) {
      // WS3 — no synthetic success: a missing repo is a wiring fault.
      return { success: false, error: 'handler_not_wired:feedbackRepo' };
    }
    try {
      const request = createFeedbackRequest({ tenantId: context.tenantId, jobId });
      const created = await this.feedbackRepo.create(request);
      // WS3 — emit the feedback_request.created audit event. Bare `await` (no
      // try/catch): the audit joins the ambient tenant transaction, so a
      // failure rolls back the feedback-request insert rather than losing the
      // only audit record of this mutation.
      await this.auditRepo.create(
        createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.executedBy,
          actorRole: 'system',
          eventType: 'feedback_request.created',
          entityType: 'feedback_request',
          entityId: created.id,
          metadata: { proposalId: proposal.id, jobId },
        }),
      );
      return { success: true, resultEntityId: created.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
