import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { runAppointmentReminderSweep } from '../../src/workers/appointment-reminder-worker';
import { TransactionalCommsListener } from '../../src/notifications/transactional-comms-listener';
import { AppointmentConfirmationNotifier } from '../../src/notifications/appointment-confirmation-notifier';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryJobRepository, createJob } from '../../src/jobs/job';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { createAppointment } from '../../src/appointments/appointment';
import { createLogger } from '../../src/logging/logger';

const TENANT = 'tenant-rem-1';
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

describe('runAppointmentReminderSweep', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let dispatch: InMemoryDispatchRepository;
  let transactionalComms: TransactionalCommsListener;
  const NOW = new Date('2026-06-09T12:00:00Z');

  beforeEach(async () => {
    appointmentRepo = new InMemoryAppointmentRepository();
    dispatch = new InMemoryDispatchRepository();
    const delivery = new InMemoryDeliveryProvider();
    const customerRepo = new InMemoryCustomerRepository();
    const jobRepo = new InMemoryJobRepository();
    const settingsRepo = new InMemorySettingsRepository();
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
      firstName: 'Rem',
      displayName: 'Rem',
      primaryPhone: '+15559876543',
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
        summary: 'Tune-up',
        createdBy: 'u1',
      },
      jobRepo,
    );

    await createAppointment(
      {
        tenantId: TENANT,
        jobId: job.id,
        scheduledStart: new Date('2026-06-10T12:00:00Z'),
        scheduledEnd: new Date('2026-06-10T13:00:00Z'),
        timezone: 'UTC',
        createdBy: 'u1',
      },
      appointmentRepo,
    );

    const confirmationNotifier = new AppointmentConfirmationNotifier({
      delivery,
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      dispatchRepo: dispatch,
      dncRepo,
    });

    transactionalComms = new TransactionalCommsListener({
      delivery,
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      dispatchRepo: dispatch,
      dncRepo,
      invoiceRepo: new InMemoryInvoiceRepository(),
      confirmationNotifier,
      publicBaseUrl: 'http://localhost:5173',
    });
  });

  it('sends a T-24h reminder once per appointment', async () => {
    const first = await runAppointmentReminderSweep({
      appointmentRepo,
      transactionalComms,
      listTenantIds: async () => [TENANT],
      logger,
      now: () => NOW,
    });
    expect(first.reminders).toBe(1);

    const second = await runAppointmentReminderSweep({
      appointmentRepo,
      transactionalComms,
      listTenantIds: async () => [TENANT],
      logger,
      now: () => NOW,
    });
    expect(second.reminders).toBe(1);

    const appts = await appointmentRepo.findByDateRange(
      TENANT,
      new Date('2026-06-10T11:00:00Z'),
      new Date('2026-06-10T13:00:00Z'),
    );
    const rows = await dispatch.findByEntity(
      TENANT,
      'appointment_reminder',
      appts[0]!.id,
    );
    expect(rows.length).toBe(1);
  });
});
