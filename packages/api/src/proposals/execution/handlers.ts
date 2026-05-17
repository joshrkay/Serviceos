import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { CreateInvoiceExecutionHandler } from './invoice-execution-handler';
import { UpdateInvoiceExecutionHandler } from './update-invoice-handler';
import { IssueInvoiceExecutionHandler } from '../handlers/issue-invoice';
import { UpdateEstimateExecutionHandler } from './update-estimate-handler';
import { ReassignAppointmentExecutionHandler } from './reassignment-handler';
import { RescheduleAppointmentExecutionHandler } from './reschedule-handler';
import { CancelAppointmentExecutionHandler } from './cancellation-handler';
import {
  AddNoteExecutionHandler,
  SendInvoiceExecutionHandler,
  RecordPaymentExecutionHandler,
  InvoiceDeliveryProvider,
} from './voice-extended-handlers';
import { LogExpenseExecutionHandler } from './log-expense-handler';
import {
  ReviewResponseExecutionHandler,
  type ReviewResponseHandlerDeps,
} from './review-response-handler';
import { NoteRepository } from '../../notes/note';
import { PaymentRepository } from '../../invoices/payment';
import { ExpenseRepository } from '../../expenses/expense';
import { AuditRepository } from '../../audit/audit';
import { JobRepository } from '../../jobs/job';
import { RefreshJobMoneyStateDeps } from '../../jobs/job-money-state';
import { AppointmentRepository, createAppointment } from '../../appointments/appointment';
import { AssignmentRepository, assignTechnician } from '../../appointments/assignment';
import { InvoiceRepository } from '../../invoices/invoice';
import { EstimateRepository } from '../../estimates/estimate';
import { SettingsRepository } from '../../settings/settings';
import { DispatchAnalyticsRepository } from '../../dispatch/analytics';
import { detectOverlappingAppointments } from '../../dispatch/validation';
import { NoopSchedulingConfirmationNotifier, SchedulingConfirmationNotifier } from './scheduling-notifications';
import { CreateBookingExecutionHandler } from './create-booking-handler';

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

export class CreateCustomerExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_customer';

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.name || typeof payload.name !== 'string') {
      return { success: false, error: 'Payload must include a valid name' };
    }
    return { success: true, resultEntityId: uuidv4() };
  }
}

export class UpdateCustomerExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_customer';

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.customerId || typeof payload.customerId !== 'string') {
      return { success: false, error: 'Payload must include a valid customerId' };
    }
    return { success: true };
  }
}

export class CreateJobExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_job';

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.customerId || typeof payload.customerId !== 'string') {
      return { success: false, error: 'Payload must include a valid customerId' };
    }
    if (!payload.title || typeof payload.title !== 'string') {
      return { success: false, error: 'Payload must include a valid title' };
    }
    return { success: true, resultEntityId: uuidv4() };
  }
}

export class CreateAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_appointment';

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly assignmentRepo?: AssignmentRepository,
    private readonly confirmationNotifier: SchedulingConfirmationNotifier = new NoopSchedulingConfirmationNotifier(),
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.jobId || typeof payload.jobId !== 'string') {
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

    const scheduledStart = new Date(payload.scheduledStart);
    const scheduledEnd = new Date(payload.scheduledEnd);
    if (isNaN(scheduledStart.getTime()) || isNaN(scheduledEnd.getTime())) {
      return { success: false, error: 'Payload contains invalid appointment times' };
    }

    const timezone = typeof payload.timezone === 'string' ? payload.timezone : 'UTC';

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
      jobId: payload.jobId,
      scheduledStart,
      scheduledEnd,
      timezone,
      notes: typeof payload.notes === 'string' ? payload.notes : undefined,
      createdBy: context.executedBy,
    }, this.appointmentRepo);

    if (this.assignmentRepo && payload.technicianId && typeof payload.technicianId === 'string') {
      await assignTechnician({
        tenantId: context.tenantId,
        appointmentId: appointment.id,
        technicianId: payload.technicianId,
        technicianRole: 'technician',
        assignedBy: context.executedBy,
      }, this.assignmentRepo);
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

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.customerId || typeof payload.customerId !== 'string') {
      return { success: false, error: 'Payload must include a valid customerId' };
    }
    if (!Array.isArray(payload.lineItems) || payload.lineItems.length === 0) {
      return { success: false, error: 'Payload must include at least one lineItem' };
    }
    return { success: true, resultEntityId: uuidv4() };
  }
}

export function createExecutionHandlerRegistry(deps?: {
  appointmentRepo?: AppointmentRepository;
  assignmentRepo?: AssignmentRepository;
  invoiceRepo?: InvoiceRepository;
  estimateRepo?: EstimateRepository;
  settingsRepo?: SettingsRepository;
  schedulingNotifier?: SchedulingConfirmationNotifier;
  noteRepo?: NoteRepository;
  paymentRepo?: PaymentRepository;
  invoiceDeliveryProvider?: InvoiceDeliveryProvider;
  analyticsRepo?: DispatchAnalyticsRepository;
  expenseRepo?: ExpenseRepository;
  auditRepo?: AuditRepository;
  jobRepo?: JobRepository;
  /** P7-026 — optional review-response handler deps. When omitted, the
   * handler is still registered but each sub-action runs in synthetic
   * mode (executes without provider side-effects, for tests). */
  reviewResponse?: ReviewResponseHandlerDeps;
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
    new CreateCustomerExecutionHandler(),
    new UpdateCustomerExecutionHandler(),
    new CreateJobExecutionHandler(),
    new CreateAppointmentExecutionHandler(deps?.appointmentRepo, deps?.assignmentRepo, deps?.schedulingNotifier),
    new CreateBookingExecutionHandler(deps?.appointmentRepo, deps?.auditRepo),
    new DraftEstimateExecutionHandler(),
    new CreateInvoiceExecutionHandler(deps?.invoiceRepo, deps?.settingsRepo),
    new ReassignAppointmentExecutionHandler(deps?.appointmentRepo, deps?.assignmentRepo, deps?.analyticsRepo),
    new RescheduleAppointmentExecutionHandler(deps?.appointmentRepo, deps?.assignmentRepo, deps?.analyticsRepo, deps?.auditRepo),
    new CancelAppointmentExecutionHandler(deps?.appointmentRepo, deps?.analyticsRepo, deps?.auditRepo),
    // Stage-2 voice handlers wired against real repositories. Each
    // handler degrades to a synthetic-id passthrough when its dep is
    // absent (used by in-memory tests that don't exercise the
    // mutation path). Production wires the real deps in app.ts.
    new AddNoteExecutionHandler(deps?.noteRepo),
    new SendInvoiceExecutionHandler(deps?.invoiceDeliveryProvider),
    new RecordPaymentExecutionHandler(deps?.paymentRepo, deps?.invoiceRepo, moneyStateDeps),
    new LogExpenseExecutionHandler(deps?.expenseRepo, deps?.auditRepo),
    // P7-026 — review-response handler. Registered unconditionally so
    // a pending proposal can be executed in test/dev (synthetic mode)
    // without requiring full provider wiring.
    new ReviewResponseExecutionHandler({
      ...(deps?.reviewResponse ?? {}),
      auditRepo: deps?.reviewResponse?.auditRepo ?? deps?.auditRepo,
    }),
  ];

  // Handlers that mutate existing entities take a repo dep. Registered
  // only when the repo is wired in, so in-memory tests that don't
  // touch these don't have to provide the dep.
  if (deps?.invoiceRepo) {
    handlers.push(new UpdateInvoiceExecutionHandler(deps.invoiceRepo));
    handlers.push(new IssueInvoiceExecutionHandler(deps.invoiceRepo, moneyStateDeps));
  }
  if (deps?.estimateRepo) {
    handlers.push(new UpdateEstimateExecutionHandler(deps.estimateRepo));
  }

  const registry = new Map<ProposalType, ExecutionHandler>();
  for (const handler of handlers) {
    registry.set(handler.proposalType, handler);
  }
  return registry;
}
