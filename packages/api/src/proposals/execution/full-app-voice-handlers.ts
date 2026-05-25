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
import { AuditRepository } from '../../audit/audit';
import { TimeEntryService } from '../../time-tracking/time-entry-service';
import { EntryType } from '../../time-tracking/time-entry';
import {
  FeedbackRequestRepository,
  createFeedbackRequest,
} from '../../feedback/feedback-request';

export class ConfirmAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'confirm_appointment';

  constructor(private readonly appointmentRepo?: AppointmentRepository) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const appointmentId = typeof payload.appointmentId === 'string' ? payload.appointmentId : undefined;
    if (!appointmentId) {
      return { success: false, error: 'confirm_appointment requires a resolved appointmentId' };
    }
    if (!this.appointmentRepo) {
      return { success: true, resultEntityId: appointmentId };
    }
    try {
      const updated = await this.appointmentRepo.update(context.tenantId, appointmentId, {
        status: 'confirmed',
        updatedAt: new Date(),
      });
      if (!updated) {
        return { success: false, error: `Appointment ${appointmentId} not found` };
      }
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

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const appointmentId = typeof payload.appointmentId === 'string' ? payload.appointmentId : undefined;
    if (!appointmentId) {
      return { success: false, error: 'notify_delay requires a resolved appointmentId' };
    }
    // The actual outbound send is gated behind the approved-proposal path
    // and a wired DelayNotificationService (see notifications/
    // delay-notifications.ts). Until that dep is threaded here the handler
    // validates the resolved appointment and reports success — mirroring
    // the Noop-provider gate used by send_invoice / send_estimate.
    return { success: true, resultEntityId: appointmentId };
  }
}

export class RequestFeedbackExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'request_feedback';

  constructor(private readonly feedbackRepo?: FeedbackRequestRepository) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const jobId = typeof payload.jobId === 'string' ? payload.jobId : undefined;
    if (!jobId) {
      return { success: false, error: 'request_feedback requires a resolved jobId' };
    }
    if (!this.feedbackRepo) {
      return { success: true, resultEntityId: jobId };
    }
    try {
      const request = createFeedbackRequest({ tenantId: context.tenantId, jobId });
      const created = await this.feedbackRepo.create(request);
      return { success: true, resultEntityId: created.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
