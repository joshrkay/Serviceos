import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { CreateInvoiceExecutionHandler } from './invoice-execution-handler';
import { UpdateInvoiceExecutionHandler } from './update-invoice-handler';
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
import { NoteRepository } from '../../notes/note';
import { PaymentRepository } from '../../invoices/payment';
import { AppointmentRepository, createAppointment } from '../../appointments/appointment';
import { AssignmentRepository, assignTechnician } from '../../appointments/assignment';
import { InvoiceRepository } from '../../invoices/invoice';
import {
  EstimateRepository,
  CreateEstimateInput,
  createEstimate,
} from '../../estimates/estimate';
import { LineItem } from '../../shared/billing-engine';
import {
  SettingsRepository,
  getNextEstimateNumber,
} from '../../settings/settings';
import { DispatchAnalyticsRepository } from '../../dispatch/analytics';
import { detectOverlappingAppointments } from '../../dispatch/validation';
import { NoopSchedulingConfirmationNotifier, SchedulingConfirmationNotifier } from './scheduling-notifications';
import {
  CustomerRepository,
  UpdateCustomerInput,
  createCustomer,
  updateCustomer,
} from '../../customers/customer';
import { JobRepository, createJob } from '../../jobs/job';
import { LocationRepository } from '../../locations/location';

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

  constructor(private readonly customerRepo?: CustomerRepository) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.name || typeof payload.name !== 'string') {
      return { success: false, error: 'Payload must include a valid name' };
    }

    // Idempotency — a retry of an already-executed proposal returns
    // the id produced on the first run.
    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    // Legacy fallback — in-memory tests that exercise proposal
    // lifecycle without persistence skip the repo. Production always
    // wires it in (app.ts), so the synthetic id path is never hit
    // in deployed environments.
    if (!this.customerRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    try {
      // Voice classifier captures a single `displayName` string;
      // `CreateCustomerInput` requires `firstName` + `lastName` (or
      // `companyName`). Dump the full captured name into `firstName`
      // with empty `lastName` — `validateCustomerInput` only requires
      // one of them. Proper first/last splitting is a classifier/UX
      // follow-up, not a blocker for persistence.
      const customer = await createCustomer(
        {
          tenantId: context.tenantId,
          firstName: payload.name,
          lastName: '',
          email: typeof payload.email === 'string' ? payload.email : undefined,
          primaryPhone: typeof payload.phone === 'string' ? payload.phone : undefined,
          createdBy: context.executedBy,
        },
        this.customerRepo
      );
      return { success: true, resultEntityId: customer.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

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

    // Map the voice-shaped payload to UpdateCustomerInput. Only keys
    // actually present in the payload are forwarded so unrelated
    // fields aren't accidentally cleared. `payload.name` and
    // `payload.phone` mirror the shape used by CreateCustomer — no
    // caller emits firstName/lastName yet, but accept both so future
    // classifier output works too.
    const input: UpdateCustomerInput = {};
    if (typeof payload.name === 'string') input.firstName = payload.name;
    if (typeof payload.firstName === 'string') input.firstName = payload.firstName;
    if (typeof payload.lastName === 'string') input.lastName = payload.lastName;
    if (typeof payload.companyName === 'string') input.companyName = payload.companyName;
    if (typeof payload.email === 'string') input.email = payload.email;
    if (typeof payload.phone === 'string') input.primaryPhone = payload.phone;
    if (typeof payload.primaryPhone === 'string') input.primaryPhone = payload.primaryPhone;

    try {
      const updated = await updateCustomer(
        context.tenantId,
        payload.customerId,
        input,
        this.customerRepo,
        context.executedBy
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
    private readonly locationRepo?: LocationRepository
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.customerId || typeof payload.customerId !== 'string') {
      return { success: false, error: 'Payload must include a valid customerId' };
    }

    // Accept both `title` (voice-classifier output today) and `summary`
    // (matches CreateJobInput's field name, likely to become the canonical
    // payload key once the classifier is updated). Prefer an explicit
    // summary if both are provided.
    const summary =
      typeof payload.summary === 'string'
        ? payload.summary
        : typeof payload.title === 'string'
          ? payload.title
          : undefined;
    if (!summary) {
      return {
        success: false,
        error: 'Payload must include a valid title or summary',
      };
    }

    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    // Legacy synthetic-id path for in-memory tests that don't exercise
    // persistence. Production always wires both repos in app.ts.
    if (!this.jobRepo || !this.locationRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    // Resolve locationId. The voice classifier never captures a
    // location, so the handler picks the customer's primary service
    // location. A dispatcher UI may pre-select a different site by
    // attaching `payload.locationId`; in that case we honor it
    // verbatim (still tenant-scoped — the FK in the jobs table
    // enforces that the location belongs to this tenant).
    let locationId: string;
    if (typeof payload.locationId === 'string') {
      locationId = payload.locationId;
    } else {
      const locations = await this.locationRepo.findByCustomer(
        context.tenantId,
        payload.customerId
      );
      const primary = locations.find((loc) => loc.isPrimary && !loc.isArchived);
      if (!primary) {
        return {
          success: false,
          error:
            'Customer has no service location — add one before opening a job',
        };
      }
      locationId = primary.id;
    }

    try {
      const job = await createJob(
        {
          tenantId: context.tenantId,
          customerId: payload.customerId,
          locationId,
          summary,
          createdBy: context.executedBy,
        },
        this.jobRepo
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

  constructor(
    private readonly estimateRepo?: EstimateRepository,
    private readonly settingsRepo?: SettingsRepository
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.customerId || typeof payload.customerId !== 'string') {
      return { success: false, error: 'Payload must include a valid customerId' };
    }
    // jobId is REQUIRED by CreateEstimateInput — estimates key off a
    // specific job for billing, numbering, and acceptance. Fail loud
    // rather than fabricating a phantom job; the classifier /
    // proposal-review UI is responsible for attaching one.
    if (!payload.jobId || typeof payload.jobId !== 'string') {
      return {
        success: false,
        error:
          'Estimate requires a jobId — pick a job before drafting',
      };
    }
    if (!Array.isArray(payload.lineItems) || payload.lineItems.length === 0) {
      return { success: false, error: 'Payload must include at least one lineItem' };
    }

    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    // Legacy synthetic-id fallback for in-memory tests.
    if (!this.estimateRepo || !this.settingsRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    try {
      const estimateNumber = await getNextEstimateNumber(
        context.tenantId,
        this.settingsRepo
      );

      const input: CreateEstimateInput = {
        tenantId: context.tenantId,
        jobId: payload.jobId,
        estimateNumber,
        lineItems: payload.lineItems as LineItem[],
        discountCents:
          typeof payload.discountCents === 'number' ? payload.discountCents : undefined,
        taxRateBps:
          typeof payload.taxRateBps === 'number' ? payload.taxRateBps : undefined,
        customerMessage:
          typeof payload.customerMessage === 'string' ? payload.customerMessage : undefined,
        internalNotes:
          typeof payload.internalNotes === 'string' ? payload.internalNotes : undefined,
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

export function createExecutionHandlerRegistry(deps?: {
  customerRepo?: CustomerRepository;
  jobRepo?: JobRepository;
  locationRepo?: LocationRepository;
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
}): Map<ProposalType, ExecutionHandler> {
  const handlers: ExecutionHandler[] = [
    new CreateCustomerExecutionHandler(deps?.customerRepo),
    new UpdateCustomerExecutionHandler(deps?.customerRepo),
    new CreateJobExecutionHandler(deps?.jobRepo, deps?.locationRepo),
    new CreateAppointmentExecutionHandler(deps?.appointmentRepo, deps?.assignmentRepo, deps?.schedulingNotifier),
    new DraftEstimateExecutionHandler(deps?.estimateRepo, deps?.settingsRepo),
    new CreateInvoiceExecutionHandler(deps?.invoiceRepo, deps?.settingsRepo),
    new ReassignAppointmentExecutionHandler(deps?.appointmentRepo, deps?.assignmentRepo, deps?.analyticsRepo),
    new RescheduleAppointmentExecutionHandler(deps?.appointmentRepo, deps?.assignmentRepo, deps?.analyticsRepo),
    new CancelAppointmentExecutionHandler(deps?.appointmentRepo, deps?.analyticsRepo),
    // Stage-2 voice handlers wired against real repositories. Each
    // handler degrades to a synthetic-id passthrough when its dep is
    // absent (used by in-memory tests that don't exercise the
    // mutation path). Production wires the real deps in app.ts.
    new AddNoteExecutionHandler(deps?.noteRepo),
    new SendInvoiceExecutionHandler(deps?.invoiceDeliveryProvider),
    new RecordPaymentExecutionHandler(deps?.paymentRepo, deps?.invoiceRepo),
  ];

  // Handlers that mutate existing entities take a repo dep. Registered
  // only when the repo is wired in, so in-memory tests that don't
  // touch these don't have to provide the dep.
  if (deps?.invoiceRepo) {
    handlers.push(new UpdateInvoiceExecutionHandler(deps.invoiceRepo));
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
