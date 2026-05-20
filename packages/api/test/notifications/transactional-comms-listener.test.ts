import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { TransactionalCommsListener } from '../../src/notifications/transactional-comms-listener';
import { AppointmentConfirmationNotifier } from '../../src/notifications/appointment-confirmation-notifier';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryJobRepository, createJob } from '../../src/jobs/job';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { createAppointment } from '../../src/appointments/appointment';
import { createAuditEvent } from '../../src/audit/audit';

const TENANT = 'tenant-tx-1';

describe('TransactionalCommsListener', () => {
  let dispatch: InMemoryDispatchRepository;
  let listener: TransactionalCommsListener;
  let appointmentId: string;

  beforeEach(async () => {
    dispatch = new InMemoryDispatchRepository();
    const delivery = new InMemoryDeliveryProvider();
    const customerRepo = new InMemoryCustomerRepository();
    const jobRepo = new InMemoryJobRepository();
    const appointmentRepo = new InMemoryAppointmentRepository();
    const settingsRepo = new InMemorySettingsRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const dncRepo = new InMemoryDncRepository();

    await settingsRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      businessName: 'Acme',
      timezone: 'UTC',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      autoSendAppointmentReminders: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId: TENANT,
      firstName: 'Sam',
      displayName: 'Sam',
      primaryPhone: '+15551234567',
      smsConsent: true,
      isArchived: false,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const job = await createJob(
      {
        tenantId: TENANT,
        customerId,
        locationId: uuidv4(),
        summary: 'Job',
        createdBy: 'u1',
      },
      jobRepo,
    );

    const appt = await createAppointment(
      {
        tenantId: TENANT,
        jobId: job.id,
        scheduledStart: new Date('2026-06-10T15:00:00Z'),
        scheduledEnd: new Date('2026-06-10T16:00:00Z'),
        timezone: 'UTC',
        createdBy: 'u1',
      },
      appointmentRepo,
    );
    appointmentId = appt.id;

    const confirmationNotifier = new AppointmentConfirmationNotifier({
      delivery,
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      dispatchRepo: dispatch,
      dncRepo,
    });

    listener = new TransactionalCommsListener({
      delivery,
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      dispatchRepo: dispatch,
      dncRepo,
      invoiceRepo,
      confirmationNotifier,
      publicBaseUrl: 'http://localhost:5173',
    });
  });

  it('sends confirmation on appointment.booked', async () => {
    await listener.handleAuditEvent(
      createAuditEvent({
        tenantId: TENANT,
        actorId: 'system',
        actorRole: 'system',
        eventType: 'appointment.booked',
        entityType: 'appointment',
        entityId: appointmentId,
        metadata: { jobId: 'x' },
      }),
    );

    const rows = await dispatch.findByEntity(
      TENANT,
      'appointment_confirmation',
      appointmentId,
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('sends reschedule notice on appointment.rescheduled', async () => {
    await listener.handleAuditEvent(
      createAuditEvent({
        tenantId: TENANT,
        actorId: 'system',
        actorRole: 'system',
        eventType: 'appointment.rescheduled',
        entityType: 'appointment',
        entityId: appointmentId,
        metadata: { newScheduledStart: '2026-06-11T15:00:00Z' },
      }),
    );

    const rows = await dispatch.findByEntity(
      TENANT,
      'appointment_reschedule',
      appointmentId,
    );
    expect(rows.length).toBe(1);
  });

  it('is idempotent for reschedule notices', async () => {
    const event = createAuditEvent({
      tenantId: TENANT,
      actorId: 'system',
      actorRole: 'system',
      eventType: 'appointment.rescheduled',
      entityType: 'appointment',
      entityId: appointmentId,
      metadata: { newScheduledStart: '2026-06-11T15:00:00Z' },
    });
    await listener.handleAuditEvent(event);
    await listener.handleAuditEvent(event);

    const rows = await dispatch.findByEntity(
      TENANT,
      'appointment_reschedule',
      appointmentId,
    );
    expect(rows.length).toBe(1);
  });
});
