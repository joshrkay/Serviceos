import { Queue, QueueMessage, WorkerHandler } from '../queues/queue';
import { Appointment, AppointmentRepository } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';
import { JobRepository } from '../jobs/job';
import { Customer, CustomerRepository } from '../customers/customer';
import { DispatchAnalyticsRepository, captureDispatchEvent } from '../dispatch/analytics';
import { Logger } from '../logging/logger';

export type DelayNotificationChannel = 'sms' | 'email' | 'in_app';

export interface DelayNotificationService {
  sendDelayNotice(request: {
    tenantId: string;
    customerId: string;
    channel: Exclude<DelayNotificationChannel, 'in_app'>;
    destination: string;
    message: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ providerMessageId?: string }>;
}

export class DelayNotificationTransientError extends Error {
  readonly transient = true;
}

export interface DelayNoticeDeliveryState {
  idempotencyKey: string;
  tenantId: string;
  appointmentId: string;
  delayVersion: number;
  status: 'queued' | 'retrying' | 'sent' | 'failed' | 'fallback_in_app';
  channel: DelayNotificationChannel;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  providerMessageId?: string;
  updatedAt: Date;
}

export interface DelayNoticeStateRepository {
  upsert(state: DelayNoticeDeliveryState): Promise<DelayNoticeDeliveryState>;
  findByKey(idempotencyKey: string): Promise<DelayNoticeDeliveryState | null>;
}

export class InMemoryDelayNoticeStateRepository implements DelayNoticeStateRepository {
  private states = new Map<string, DelayNoticeDeliveryState>();

  async upsert(state: DelayNoticeDeliveryState): Promise<DelayNoticeDeliveryState> {
    this.states.set(state.idempotencyKey, { ...state });
    return { ...state };
  }

  async findByKey(idempotencyKey: string): Promise<DelayNoticeDeliveryState | null> {
    const found = this.states.get(idempotencyKey);
    return found ? { ...found } : null;
  }
}

export interface DelayTemplateRenderInput {
  customerName: string;
  technicianName?: string;
  delayMinutes: number;
  etaWindow?: { start: Date; end: Date; timezone?: string };
}

export interface DelayTemplateVariants {
  m10: string;
  m15: string;
  m20: string;
  m60: string;
}

function formatEtaWindow(eta?: { start: Date; end: Date; timezone?: string }): string {
  if (!eta) return '';
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: eta.timezone ?? 'UTC',
  });
  const start = formatter.format(eta.start);
  const end = formatter.format(eta.end);
  return ` Updated ETA window: ${start}–${end}${eta.timezone ? ` (${eta.timezone})` : ''}.`;
}

export function renderDelayTemplateVariants(input: DelayTemplateRenderInput): DelayTemplateVariants {
  const greeting = input.customerName ? `Hi ${input.customerName}, ` : 'Hi, ';
  const tech = input.technicianName ? `${input.technicianName} is` : 'our technician is';
  const etaText = formatEtaWindow(input.etaWindow);

  return {
    m10: `${greeting}just a quick heads up: ${tech} running about 10 minutes behind schedule.${etaText}`,
    m15: `${greeting}thanks for your patience — ${tech} running about 15 minutes late.${etaText}`,
    m20: `${greeting}we want to keep you updated: ${tech} delayed by around 20 minutes.${etaText}`,
    m60: `${greeting}important update: ${tech} about 60 minutes delayed due to a longer prior visit.${etaText}`,
  };
}

export function selectDelayTemplate(variants: DelayTemplateVariants, delayMinutes: number): string {
  if (delayMinutes >= 60) return variants.m60;
  if (delayMinutes >= 20) return variants.m20;
  if (delayMinutes >= 15) return variants.m15;
  return variants.m10;
}

function isSameServiceDay(a: Date, b: Date, timezone = 'UTC'): boolean {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  });
  return formatter.format(a) === formatter.format(b);
}

function resolveCustomerChannel(customer: Customer): { channel: DelayNotificationChannel; destination?: string } {
  if (customer.preferredChannel === 'sms') {
    if (customer.smsConsent && customer.primaryPhone) {
      return { channel: 'sms', destination: customer.primaryPhone };
    }
    return { channel: 'in_app' };
  }

  if (customer.preferredChannel === 'email' && customer.email) {
    return { channel: 'email', destination: customer.email };
  }

  if (customer.smsConsent && customer.primaryPhone) {
    return { channel: 'sms', destination: customer.primaryPhone };
  }

  if (customer.email) {
    return { channel: 'email', destination: customer.email };
  }

  return { channel: 'in_app' };
}

export interface NextCustomerSelection {
  appointment: Appointment;
  customer: Customer;
  channel: DelayNotificationChannel;
  destination?: string;
}

export class NextCustomerSelector {
  constructor(
    private readonly appointmentRepo: AppointmentRepository,
    private readonly assignmentRepo: AssignmentRepository,
    private readonly jobRepo: JobRepository,
    private readonly customerRepo: CustomerRepository,
  ) {}

  async select(tenantId: string, currentAppointmentId: string): Promise<NextCustomerSelection | null> {
    const current = await this.appointmentRepo.findById(tenantId, currentAppointmentId);
    if (!current) return null;

    const currentAssignments = await this.assignmentRepo.findByAppointment(tenantId, currentAppointmentId);
    const primary = currentAssignments.find((a) => a.isPrimary);
    if (!primary) return null;

    const techAssignments = await this.assignmentRepo.findByTechnician(tenantId, primary.technicianId);
    const appointments = await Promise.all(
      techAssignments.map((a) => this.appointmentRepo.findById(tenantId, a.appointmentId)),
    );

    const nextAppointment = appointments
      .filter((a): a is Appointment => Boolean(a))
      .filter((a) => a.id !== currentAppointmentId)
      .filter((a) => a.status !== 'canceled' && a.status !== 'completed' && a.status !== 'no_show')
      .filter((a) => a.scheduledStart > current.scheduledStart)
      .filter((a) => isSameServiceDay(current.scheduledStart, a.scheduledStart, current.timezone))
      .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime())[0];

    if (!nextAppointment) return null;

    const job = await this.jobRepo.findById(tenantId, nextAppointment.jobId);
    if (!job) return null;

    const customer = await this.customerRepo.findById(tenantId, job.customerId);
    if (!customer) return null;

    const { channel, destination } = resolveCustomerChannel(customer);

    return { appointment: nextAppointment, customer, channel, destination };
  }
}

export interface DelayNoticeQueuePayload {
  tenantId: string;
  appointmentId: string;
  delayVersion: number;
  delayMinutes: number;
  targetCustomerId: string;
  customerName: string;
  channel: DelayNotificationChannel;
  destination?: string;
  message: string;
  idempotencyKey: string;
}

export interface EnqueueDelayNoticeInput {
  tenantId: string;
  currentAppointmentId: string;
  delayVersion: number;
  delayMinutes: number;
  technicianName?: string;
  etaWindow?: { start: Date; end: Date; timezone?: string };
}

export class DelayNotificationCoordinator {
  static readonly QUEUE_TYPE = 'delay_notice_delivery';

  constructor(
    private readonly queue: Queue,
    private readonly selector: NextCustomerSelector,
    private readonly stateRepo: DelayNoticeStateRepository,
  ) {}

  async enqueueDelayNotice(input: EnqueueDelayNoticeInput): Promise<string | null> {
    const target = await this.selector.select(input.tenantId, input.currentAppointmentId);
    if (!target) return null;

    const idempotencyKey = `${target.appointment.id}:${input.delayVersion}`;
    const variants = renderDelayTemplateVariants({
      customerName: target.customer.firstName || target.customer.displayName,
      technicianName: input.technicianName,
      delayMinutes: input.delayMinutes,
      etaWindow: input.etaWindow,
    });
    const message = selectDelayTemplate(variants, input.delayMinutes);

    await this.stateRepo.upsert({
      idempotencyKey,
      tenantId: input.tenantId,
      appointmentId: target.appointment.id,
      delayVersion: input.delayVersion,
      status: target.channel === 'in_app' ? 'fallback_in_app' : 'queued',
      channel: target.channel,
      attempts: 0,
      maxAttempts: this.queue.getConfig().maxRetries,
      updatedAt: new Date(),
    });

    if (target.channel === 'in_app') {
      return idempotencyKey;
    }

    await this.queue.send<DelayNoticeQueuePayload>(
      DelayNotificationCoordinator.QUEUE_TYPE,
      {
        tenantId: input.tenantId,
        appointmentId: target.appointment.id,
        delayVersion: input.delayVersion,
        delayMinutes: input.delayMinutes,
        targetCustomerId: target.customer.id,
        customerName: target.customer.displayName,
        channel: target.channel,
        destination: target.destination,
        message,
        idempotencyKey,
      },
      idempotencyKey,
    );

    return idempotencyKey;
  }
}

export function createDelayNotificationWorker(deps: {
  service: DelayNotificationService;
  stateRepo: DelayNoticeStateRepository;
  analyticsRepo: DispatchAnalyticsRepository;
}): WorkerHandler<DelayNoticeQueuePayload> {
  return {
    type: DelayNotificationCoordinator.QUEUE_TYPE,
    async handle(message: QueueMessage<DelayNoticeQueuePayload>, logger: Logger): Promise<void> {
      const payload = message.payload;
      const statusBase = {
        idempotencyKey: payload.idempotencyKey,
        tenantId: payload.tenantId,
        appointmentId: payload.appointmentId,
        delayVersion: payload.delayVersion,
        channel: payload.channel,
        maxAttempts: message.maxAttempts,
      } as const;

      try {
        const response = await deps.service.sendDelayNotice({
          tenantId: payload.tenantId,
          customerId: payload.targetCustomerId,
          channel: payload.channel as 'sms' | 'email',
          destination: payload.destination || '',
          message: payload.message,
          idempotencyKey: payload.idempotencyKey,
          metadata: {
            delayMinutes: payload.delayMinutes,
            appointmentId: payload.appointmentId,
          },
        });

        await deps.stateRepo.upsert({
          ...statusBase,
          status: 'sent',
          attempts: message.attempts,
          providerMessageId: response.providerMessageId,
          updatedAt: new Date(),
        });

        await captureDispatchEvent(deps.analyticsRepo, payload.tenantId, 'delay_notice_sent', {
          appointmentId: payload.appointmentId,
          metadata: { channel: payload.channel, delayVersion: payload.delayVersion },
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const isTransient = error instanceof DelayNotificationTransientError;
        const exhausted = message.attempts >= message.maxAttempts;

        await deps.stateRepo.upsert({
          ...statusBase,
          status: isTransient && !exhausted ? 'retrying' : 'failed',
          attempts: message.attempts,
          lastError: err.message,
          updatedAt: new Date(),
        });

        if (!isTransient || exhausted) {
          await captureDispatchEvent(deps.analyticsRepo, payload.tenantId, 'delay_notice_failed', {
            appointmentId: payload.appointmentId,
            metadata: {
              channel: payload.channel,
              delayVersion: payload.delayVersion,
              transient: isTransient,
              exhausted,
              error: err.message,
            },
          });
          logger.error('Delay notification delivery failed', {
            appointmentId: payload.appointmentId,
            error: err.message,
            transient: isTransient,
            exhausted,
          });
          return;
        }

        logger.warn('Transient delay notification delivery failure, retrying', {
          appointmentId: payload.appointmentId,
          attempt: message.attempts,
          maxAttempts: message.maxAttempts,
          error: err.message,
        });
        throw err;
      }
    },
  };
}
