import { describe, it, expect, vi } from 'vitest';
import { InMemoryAppointmentRepository, createAppointment } from '../../src/appointments/appointment';
import { InMemoryAssignmentRepository, assignTechnician } from '../../src/appointments/assignment';
import { InMemoryJobRepository, createJob } from '../../src/jobs/job';
import { InMemoryCustomerRepository, createCustomer } from '../../src/customers/customer';
import { InMemoryQueue } from '../../src/queues/queue';
import {
  DelayNotificationCoordinator,
  DelayNotificationTransientError,
  InMemoryDelayNoticeStateRepository,
  NextCustomerSelector,
  createDelayNotificationWorker,
  renderDelayTemplateVariants,
  renderEnRouteTemplate,
  selectDelayTemplate,
} from '../../src/notifications/delay-notifications';
import { InMemoryDispatchAnalyticsRepository } from '../../src/dispatch/analytics';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { createLogger } from '../../src/logging/logger';

const tenantId = '550e8400-e29b-41d4-a716-446655440000';
const techId = '660e8400-e29b-41d4-a716-446655440001';

describe('delay notification flow', () => {
  it('selects technician next same-day customer and enqueues sms notice', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const assignmentRepo = new InMemoryAssignmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const queue = new InMemoryQueue();
    const stateRepo = new InMemoryDelayNoticeStateRepository();

    const currentCustomer = await createCustomer({
      tenantId,
      firstName: 'Current',
      lastName: 'Customer',
      createdBy: 'dispatcher',
    }, customerRepo);
    const currentJob = await createJob({
      tenantId,
      customerId: currentCustomer.id,
      locationId: 'loc-1',
      summary: 'Current call',
      createdBy: 'dispatcher',
    }, jobRepo);

    const nextCustomer = await createCustomer({
      tenantId,
      firstName: 'Alex',
      lastName: 'Smith',
      primaryPhone: '+15555550123',
      preferredChannel: 'sms',
      smsConsent: true,
      createdBy: 'dispatcher',
    }, customerRepo);
    const nextJob = await createJob({
      tenantId,
      customerId: nextCustomer.id,
      locationId: 'loc-2',
      summary: 'Next call',
      createdBy: 'dispatcher',
    }, jobRepo);

    const currentAppt = await createAppointment({
      tenantId,
      jobId: currentJob.id,
      scheduledStart: new Date('2026-04-20T13:00:00Z'),
      scheduledEnd: new Date('2026-04-20T14:00:00Z'),
      timezone: 'UTC',
      createdBy: 'dispatcher',
    }, appointmentRepo);
    const nextAppt = await createAppointment({
      tenantId,
      jobId: nextJob.id,
      scheduledStart: new Date('2026-04-20T15:00:00Z'),
      scheduledEnd: new Date('2026-04-20T16:00:00Z'),
      timezone: 'UTC',
      createdBy: 'dispatcher',
    }, appointmentRepo);

    await assignTechnician({ tenantId, appointmentId: currentAppt.id, technicianId: techId, technicianRole: 'technician', assignedBy: 'dispatcher' }, assignmentRepo);
    await assignTechnician({ tenantId, appointmentId: nextAppt.id, technicianId: techId, technicianRole: 'technician', assignedBy: 'dispatcher' }, assignmentRepo);

    const selector = new NextCustomerSelector(appointmentRepo, assignmentRepo, jobRepo, customerRepo);
    const coordinator = new DelayNotificationCoordinator(queue, selector, stateRepo);

    const key = await coordinator.enqueueDelayNotice({
      tenantId,
      currentAppointmentId: currentAppt.id,
      delayVersion: 2,
      delayMinutes: 20,
      technicianName: 'Taylor',
      triggerContext: {
        thresholdMinutes: 65,
        confidenceScore: 0.82,
        pingSampleCount: 6,
        reason: 'threshold_breached',
      },
    });

    expect(key).toBe(`${nextAppt.id}:2`);

    const queued = await queue.receive<any>();
    expect(queued?.type).toBe(DelayNotificationCoordinator.QUEUE_TYPE);
    expect(queued?.payload.idempotencyKey).toBe(`${nextAppt.id}:2`);
    expect(queued?.payload.channel).toBe('sms');

    const state = await stateRepo.findByKey(`${nextAppt.id}:2`);
    expect(state?.status).toBe('queued');
    expect(state?.triggerContext).toMatchObject({
      thresholdMinutes: 65,
      confidenceScore: 0.82,
      pingSampleCount: 6,
      reason: 'threshold_breached',
    });
  });

  it('falls back to in_app when sms is preferred but consent is missing', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const assignmentRepo = new InMemoryAssignmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const queue = new InMemoryQueue();
    const stateRepo = new InMemoryDelayNoticeStateRepository();

    const currentCustomer = await createCustomer({ tenantId, firstName: 'Current', lastName: 'C', createdBy: 'dispatcher' }, customerRepo);
    const nextCustomer = await createCustomer({
      tenantId,
      firstName: 'No',
      lastName: 'Consent',
      primaryPhone: '+15555550123',
      preferredChannel: 'sms',
      smsConsent: false,
      createdBy: 'dispatcher',
    }, customerRepo);

    const currentJob = await createJob({ tenantId, customerId: currentCustomer.id, locationId: 'loc-1', summary: 'Current', createdBy: 'dispatcher' }, jobRepo);
    const nextJob = await createJob({ tenantId, customerId: nextCustomer.id, locationId: 'loc-2', summary: 'Next', createdBy: 'dispatcher' }, jobRepo);

    const currentAppt = await createAppointment({ tenantId, jobId: currentJob.id, scheduledStart: new Date('2026-04-20T09:00:00Z'), scheduledEnd: new Date('2026-04-20T10:00:00Z'), timezone: 'UTC', createdBy: 'dispatcher' }, appointmentRepo);
    const nextAppt = await createAppointment({ tenantId, jobId: nextJob.id, scheduledStart: new Date('2026-04-20T11:00:00Z'), scheduledEnd: new Date('2026-04-20T12:00:00Z'), timezone: 'UTC', createdBy: 'dispatcher' }, appointmentRepo);

    await assignTechnician({ tenantId, appointmentId: currentAppt.id, technicianId: techId, technicianRole: 'technician', assignedBy: 'dispatcher' }, assignmentRepo);
    await assignTechnician({ tenantId, appointmentId: nextAppt.id, technicianId: techId, technicianRole: 'technician', assignedBy: 'dispatcher' }, assignmentRepo);

    const coordinator = new DelayNotificationCoordinator(
      queue,
      new NextCustomerSelector(appointmentRepo, assignmentRepo, jobRepo, customerRepo),
      stateRepo,
    );

    const key = await coordinator.enqueueDelayNotice({
      tenantId,
      currentAppointmentId: currentAppt.id,
      delayVersion: 1,
      delayMinutes: 10,
    });

    expect(key).toBe(`${nextAppt.id}:1`);
    expect(await queue.receive()).toBeNull();

    const state = await stateRepo.findByKey(`${nextAppt.id}:1`);
    expect(state?.status).toBe('fallback_in_app');
    expect(state?.channel).toBe('in_app');
  });

  it('retries transient failures and records sent/failed analytics events', async () => {
    const analyticsRepo = new InMemoryDispatchAnalyticsRepository();
    const stateRepo = new InMemoryDelayNoticeStateRepository();
    const sendDelayNotice = vi.fn()
      .mockRejectedValueOnce(new DelayNotificationTransientError('provider timeout'))
      .mockResolvedValueOnce({ providerMessageId: 'msg-123' });
    const worker = createDelayNotificationWorker({
      service: { sendDelayNotice },
      stateRepo,
      analyticsRepo,
    });

    const logger = createLogger({ service: 'test', environment: 'test' });
    const message = {
      id: 'q1',
      type: DelayNotificationCoordinator.QUEUE_TYPE,
      attempts: 1,
      maxAttempts: 3,
      idempotencyKey: 'appt-1:1',
      createdAt: new Date().toISOString(),
      payload: {
        tenantId,
        appointmentId: 'appt-1',
        delayVersion: 1,
        delayMinutes: 15,
        targetCustomerId: 'cust-1',
        customerName: 'Alex',
        channel: 'sms' as const,
        destination: '+15555550123',
        message: 'test',
        idempotencyKey: 'appt-1:1',
      },
    };

    await expect(worker.handle(message, logger)).rejects.toThrow('provider timeout');
    const retryState = await stateRepo.findByKey('appt-1:1');
    expect(retryState?.status).toBe('retrying');

    await worker.handle({ ...message, attempts: 2 }, logger);

    const finalState = await stateRepo.findByKey('appt-1:1');
    expect(finalState?.status).toBe('sent');

    const sentMetrics = await analyticsRepo.getMetricsByType(tenantId, 'delay_notice_sent');
    expect(sentMetrics).toHaveLength(1);
  });

  it('#1201 — a failed sent-state write after delivery is logged, never recorded failed, never thrown', async () => {
    const analyticsRepo = new InMemoryDispatchAnalyticsRepository();
    const stateRepo = new InMemoryDelayNoticeStateRepository();
    await stateRepo.upsert({
      idempotencyKey: 'appt-9:en_route',
      tenantId,
      appointmentId: 'appt-9',
      delayVersion: 0,
      status: 'queued',
      channel: 'sms',
      attempts: 0,
      maxAttempts: 3,
      updatedAt: new Date(),
    });
    const realUpsert = stateRepo.upsert.bind(stateRepo);
    stateRepo.upsert = async (state) => {
      if (state.status === 'sent') throw new Error('state db down');
      return realUpsert(state);
    };
    const sendDelayNotice = vi.fn().mockResolvedValue({ providerMessageId: 'msg-9' });
    const worker = createDelayNotificationWorker({ service: { sendDelayNotice }, stateRepo, analyticsRepo });
    const error = vi.fn();
    const logger = { ...createLogger({ service: 'test', environment: 'test' }), error };

    await expect(
      worker.handle(
        {
          id: 'q9',
          type: DelayNotificationCoordinator.QUEUE_TYPE,
          attempts: 1,
          maxAttempts: 3,
          idempotencyKey: 'appt-9:en_route',
          createdAt: new Date().toISOString(),
          payload: {
            tenantId,
            appointmentId: 'appt-9',
            delayVersion: 0,
            delayMinutes: 0,
            targetCustomerId: 'cust-9',
            customerName: 'Alex',
            channel: 'sms' as const,
            destination: '+15555550199',
            message: 'on my way',
            idempotencyKey: 'appt-9:en_route',
            kind: 'en_route' as const,
          },
        },
        logger,
      ),
    ).resolves.toBeUndefined();

    expect(sendDelayNotice).toHaveBeenCalledTimes(1);
    expect((await stateRepo.findByKey('appt-9:en_route'))?.status).toBe('queued');
    expect(error).toHaveBeenCalledWith(
      'Delay notification sent, but persisting the sent state failed',
      expect.objectContaining({ idempotencyKey: 'appt-9:en_route', error: 'state db down' }),
    );
    expect(await analyticsRepo.getMetricsByType(tenantId, 'en_route_notice_sent')).toHaveLength(1);
  });

  it('chooses delay-specific template variants including ETA window text', () => {
    const variants = renderDelayTemplateVariants({
      customerName: 'Alex',
      technicianName: 'Taylor',
      delayMinutes: 60,
      etaWindow: {
        start: new Date('2026-04-20T18:00:00Z'),
        end: new Date('2026-04-20T18:30:00Z'),
        timezone: 'UTC',
      },
    });

    expect(selectDelayTemplate(variants, 10)).toContain('10 minutes');
    expect(selectDelayTemplate(variants, 15)).toContain('15 minutes');
    expect(selectDelayTemplate(variants, 20)).toContain('20 minutes');
    expect(selectDelayTemplate(variants, 60)).toContain('60 minutes');
    expect(variants.m60).toContain('Updated ETA window');
  });

  it('does not enqueue duplicate jobs for same appointment delay version', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const assignmentRepo = new InMemoryAssignmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const queue = new InMemoryQueue();
    const stateRepo = new InMemoryDelayNoticeStateRepository();

    const currentCustomer = await createCustomer({ tenantId, firstName: 'Current', lastName: 'Customer', createdBy: 'dispatcher' }, customerRepo);
    const nextCustomer = await createCustomer({
      tenantId,
      firstName: 'Alex',
      lastName: 'Smith',
      primaryPhone: '+15555550123',
      preferredChannel: 'sms',
      smsConsent: true,
      createdBy: 'dispatcher',
    }, customerRepo);
    const currentJob = await createJob({ tenantId, customerId: currentCustomer.id, locationId: 'loc-1', summary: 'Current call', createdBy: 'dispatcher' }, jobRepo);
    const nextJob = await createJob({ tenantId, customerId: nextCustomer.id, locationId: 'loc-2', summary: 'Next call', createdBy: 'dispatcher' }, jobRepo);
    const currentAppt = await createAppointment({ tenantId, jobId: currentJob.id, scheduledStart: new Date('2026-04-20T13:00:00Z'), scheduledEnd: new Date('2026-04-20T14:00:00Z'), timezone: 'UTC', createdBy: 'dispatcher' }, appointmentRepo);
    const nextAppt = await createAppointment({ tenantId, jobId: nextJob.id, scheduledStart: new Date('2026-04-20T15:00:00Z'), scheduledEnd: new Date('2026-04-20T16:00:00Z'), timezone: 'UTC', createdBy: 'dispatcher' }, appointmentRepo);
    await assignTechnician({ tenantId, appointmentId: currentAppt.id, technicianId: techId, technicianRole: 'technician', assignedBy: 'dispatcher' }, assignmentRepo);
    await assignTechnician({ tenantId, appointmentId: nextAppt.id, technicianId: techId, technicianRole: 'technician', assignedBy: 'dispatcher' }, assignmentRepo);

    const coordinator = new DelayNotificationCoordinator(
      queue,
      new NextCustomerSelector(appointmentRepo, assignmentRepo, jobRepo, customerRepo),
      stateRepo,
    );

    await coordinator.enqueueDelayNotice({
      tenantId,
      currentAppointmentId: currentAppt.id,
      delayVersion: 3,
      delayMinutes: 20,
    });
    await coordinator.enqueueDelayNotice({
      tenantId,
      currentAppointmentId: currentAppt.id,
      delayVersion: 3,
      delayMinutes: 20,
    });

    const first = await queue.receive();
    const second = await queue.receive();
    expect(first?.idempotencyKey).toBe(`${nextAppt.id}:3`);
    expect(second).toBeNull();
  });
});

describe('en-route notification flow', () => {
  it('renders a neutral on-the-way message with ETA window', () => {
    const message = renderEnRouteTemplate({
      customerName: 'Alex',
      technicianName: 'Taylor',
      etaWindow: {
        start: new Date('2026-04-20T18:00:00Z'),
        end: new Date('2026-04-20T18:30:00Z'),
        timezone: 'UTC',
      },
    });
    expect(message).toContain('Taylor is on the way');
    expect(message).toContain('Updated ETA window');
    expect(message).not.toContain('late');
    expect(message).not.toContain('behind');
  });

  it('targets the current appointment customer and enqueues an en_route notice', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const assignmentRepo = new InMemoryAssignmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const queue = new InMemoryQueue();
    const stateRepo = new InMemoryDelayNoticeStateRepository();

    const customer = await createCustomer({
      tenantId,
      firstName: 'Jordan',
      lastName: 'Doe',
      primaryPhone: '+15555550199',
      preferredChannel: 'sms',
      smsConsent: true,
      createdBy: 'dispatcher',
    }, customerRepo);
    const job = await createJob({ tenantId, customerId: customer.id, locationId: 'loc-1', summary: 'Repair', createdBy: 'dispatcher' }, jobRepo);
    const appt = await createAppointment({
      tenantId,
      jobId: job.id,
      scheduledStart: new Date('2026-04-20T13:00:00Z'),
      scheduledEnd: new Date('2026-04-20T14:00:00Z'),
      timezone: 'UTC',
      createdBy: 'dispatcher',
    }, appointmentRepo);

    const coordinator = new DelayNotificationCoordinator(
      queue,
      new NextCustomerSelector(appointmentRepo, assignmentRepo, jobRepo, customerRepo),
      stateRepo,
    );

    const key = await coordinator.enqueueEnRouteNotice({
      tenantId,
      appointmentId: appt.id,
      technicianName: 'Taylor',
    });
    expect(key).toBe(`${appt.id}:en_route`);

    const queued = await queue.receive<any>();
    expect(queued?.payload.kind).toBe('en_route');
    expect(queued?.payload.entityType).toBe('appointment_en_route');
    expect(queued?.payload.channel).toBe('sms');
    expect(queued?.payload.message).toContain('on the way');

    // Re-tap is idempotent — no second job.
    await coordinator.enqueueEnRouteNotice({ tenantId, appointmentId: appt.id });
    expect(await queue.receive()).toBeNull();
  });

  it('suppresses the en-route SMS when the number is on DNC (Story 10.3)', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const assignmentRepo = new InMemoryAssignmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const queue = new InMemoryQueue();
    const stateRepo = new InMemoryDelayNoticeStateRepository();
    const dncRepo = new InMemoryDncRepository();

    const phone = '+15555550199';
    const customer = await createCustomer({
      tenantId,
      firstName: 'Jordan',
      lastName: 'Doe',
      primaryPhone: phone,
      preferredChannel: 'sms',
      smsConsent: true,
      createdBy: 'dispatcher',
    }, customerRepo);
    dncRepo.add(tenantId, normalizePhone(phone));
    const job = await createJob({ tenantId, customerId: customer.id, locationId: 'loc-1', summary: 'Repair', createdBy: 'dispatcher' }, jobRepo);
    const appt = await createAppointment({
      tenantId,
      jobId: job.id,
      scheduledStart: new Date('2026-04-20T13:00:00Z'),
      scheduledEnd: new Date('2026-04-20T14:00:00Z'),
      timezone: 'UTC',
      createdBy: 'dispatcher',
    }, appointmentRepo);

    const coordinator = new DelayNotificationCoordinator(
      queue,
      new NextCustomerSelector(appointmentRepo, assignmentRepo, jobRepo, customerRepo),
      stateRepo,
      undefined,
      dncRepo,
    );

    const key = await coordinator.enqueueEnRouteNotice({ tenantId, appointmentId: appt.id, technicianName: 'Taylor' });
    expect(key).toBeNull();
    expect(await queue.receive()).toBeNull();
    expect(await stateRepo.findByKey(`${appt.id}:en_route`)).toBeNull();
  });

  it('falls back to in_app when the customer has no SMS consent and no email', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const assignmentRepo = new InMemoryAssignmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const queue = new InMemoryQueue();
    const stateRepo = new InMemoryDelayNoticeStateRepository();

    const customer = await createCustomer(
      { tenantId, firstName: 'No', lastName: 'Contact', preferredChannel: 'sms', smsConsent: false, createdBy: 'dispatcher' },
      customerRepo,
    );
    const job = await createJob({ tenantId, customerId: customer.id, locationId: 'loc-1', summary: 'Repair', createdBy: 'dispatcher' }, jobRepo);
    const appt = await createAppointment(
      { tenantId, jobId: job.id, scheduledStart: new Date('2026-04-20T13:00:00Z'), scheduledEnd: new Date('2026-04-20T14:00:00Z'), timezone: 'UTC', createdBy: 'dispatcher' },
      appointmentRepo,
    );

    const coordinator = new DelayNotificationCoordinator(
      queue,
      new NextCustomerSelector(appointmentRepo, assignmentRepo, jobRepo, customerRepo),
      stateRepo,
    );

    const key = await coordinator.enqueueEnRouteNotice({ tenantId, appointmentId: appt.id });
    expect(key).toBe(`${appt.id}:en_route`);
    // No SMS/email job is queued — it routed to the in-app sink instead.
    expect(await queue.receive()).toBeNull();
    const state = await stateRepo.findByKey(`${appt.id}:en_route`);
    expect(state?.status).toBe('fallback_in_app');
    expect(state?.channel).toBe('in_app');
  });

  it('returns null for a completed appointment', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const assignmentRepo = new InMemoryAssignmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const queue = new InMemoryQueue();
    const stateRepo = new InMemoryDelayNoticeStateRepository();

    const customer = await createCustomer({ tenantId, firstName: 'C', lastName: 'Y', createdBy: 'dispatcher' }, customerRepo);
    const job = await createJob({ tenantId, customerId: customer.id, locationId: 'loc-1', summary: 'Repair', createdBy: 'dispatcher' }, jobRepo);
    const appt = await createAppointment(
      { tenantId, jobId: job.id, scheduledStart: new Date('2026-04-20T13:00:00Z'), scheduledEnd: new Date('2026-04-20T14:00:00Z'), timezone: 'UTC', createdBy: 'dispatcher' },
      appointmentRepo,
    );
    await appointmentRepo.update(tenantId, appt.id, { status: 'completed' });

    const coordinator = new DelayNotificationCoordinator(
      queue,
      new NextCustomerSelector(appointmentRepo, assignmentRepo, jobRepo, customerRepo),
      stateRepo,
    );
    expect(await coordinator.enqueueEnRouteNotice({ tenantId, appointmentId: appt.id })).toBeNull();
  });

  it('returns null for a canceled appointment', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const assignmentRepo = new InMemoryAssignmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const queue = new InMemoryQueue();
    const stateRepo = new InMemoryDelayNoticeStateRepository();

    const customer = await createCustomer({ tenantId, firstName: 'C', lastName: 'X', createdBy: 'dispatcher' }, customerRepo);
    const job = await createJob({ tenantId, customerId: customer.id, locationId: 'loc-1', summary: 'Repair', createdBy: 'dispatcher' }, jobRepo);
    const appt = await createAppointment({
      tenantId,
      jobId: job.id,
      scheduledStart: new Date('2026-04-20T13:00:00Z'),
      scheduledEnd: new Date('2026-04-20T14:00:00Z'),
      timezone: 'UTC',
      createdBy: 'dispatcher',
    }, appointmentRepo);
    await appointmentRepo.update(tenantId, appt.id, { status: 'canceled' });

    const coordinator = new DelayNotificationCoordinator(
      queue,
      new NextCustomerSelector(appointmentRepo, assignmentRepo, jobRepo, customerRepo),
      stateRepo,
    );

    const key = await coordinator.enqueueEnRouteNotice({ tenantId, appointmentId: appt.id });
    expect(key).toBeNull();
  });
});

// #1131 — analytics is bookkeeping about a delivery, never the delivery. A
// failing analytics write must not flip an already-sent notice to 'failed'
// (which would also let the next tap re-text the customer) nor throw out of
// the handler (which makes the queue redeliver — and re-send — the message).
describe('delay notification worker — analytics failures never affect delivery state (#1131)', () => {
  function recordingLogger() {
    const errors: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message: string, meta?: Record<string, unknown>) => {
        errors.push({ message, meta });
      },
      child: () => logger,
    };
    return { logger, errors };
  }

  function enRouteMessage(attempts = 1) {
    return {
      id: 'q-en-route',
      type: DelayNotificationCoordinator.QUEUE_TYPE,
      attempts,
      maxAttempts: 3,
      idempotencyKey: 'appt-9:en_route',
      createdAt: new Date().toISOString(),
      payload: {
        tenantId,
        appointmentId: 'appt-9',
        delayVersion: 0,
        delayMinutes: 0,
        targetCustomerId: 'cust-9',
        customerName: 'Robin',
        channel: 'sms' as const,
        destination: '+15555550199',
        message: 'on the way',
        idempotencyKey: 'appt-9:en_route',
        kind: 'en_route' as const,
        entityType: 'appointment_en_route' as const,
      },
    };
  }

  const failingAnalytics = {
    recordMetric: vi.fn().mockRejectedValue(
      new Error('new row for relation "dispatch_analytics" violates check constraint "dispatch_analytics_event_type_check"'),
    ),
    getMetrics: vi.fn().mockResolvedValue([]),
    getMetricsByType: vi.fn().mockResolvedValue([]),
  };

  it('a delivered notice stays sent, the handler resolves (no redelivery), and the analytics failure is logged', async () => {
    const stateRepo = new InMemoryDelayNoticeStateRepository();
    const sendDelayNotice = vi.fn().mockResolvedValue({ providerMessageId: 'SM-delivered' });
    const worker = createDelayNotificationWorker({
      service: { sendDelayNotice },
      stateRepo,
      analyticsRepo: failingAnalytics,
    });
    const { logger, errors } = recordingLogger();

    const outcome = await worker.handle(enRouteMessage(), logger).then(
      () => 'resolved',
      (err: Error) => `threw: ${err.message}`,
    );

    const state = await stateRepo.findByKey('appt-9:en_route');
    expect({
      outcome,
      status: state?.status,
      providerMessageId: state?.providerMessageId,
      sends: sendDelayNotice.mock.calls.length,
    }).toEqual({ outcome: 'resolved', status: 'sent', providerMessageId: 'SM-delivered', sends: 1 });
    expect(errors.map((e) => e.message)).toContain('Dispatch analytics write failed');
    expect(errors.find((e) => e.message === 'Dispatch analytics write failed')?.meta).toMatchObject({
      appointmentId: 'appt-9',
      eventType: 'en_route_notice_sent',
    });
  });

  it('a permanently failed send still settles failed and resolves when its analytics write also fails', async () => {
    const stateRepo = new InMemoryDelayNoticeStateRepository();
    const sendDelayNotice = vi.fn().mockRejectedValue(new Error('invalid destination'));
    const worker = createDelayNotificationWorker({
      service: { sendDelayNotice },
      stateRepo,
      analyticsRepo: failingAnalytics,
    });
    const { logger, errors } = recordingLogger();

    const outcome = await worker.handle(enRouteMessage(), logger).then(
      () => 'resolved',
      (err: Error) => `threw: ${err.message}`,
    );

    const state = await stateRepo.findByKey('appt-9:en_route');
    expect({ outcome, status: state?.status, lastError: state?.lastError }).toEqual({
      outcome: 'resolved',
      status: 'failed',
      lastError: 'invalid destination',
    });
    expect(errors.map((e) => e.message)).toContain('Dispatch analytics write failed');
  });
});
