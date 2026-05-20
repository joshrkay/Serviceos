import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  runAppointmentReminderSweep,
  APPOINTMENT_REMINDER_LEAD_MS,
} from '../../src/workers/appointment-reminder-worker';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { createAppointment } from '../../src/appointments/appointment';
import { TransactionalCommsService } from '../../src/notifications/transactional-comms-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { createLogger } from '../../src/logging/logger';

const TENANT = 'tenant-reminder-1';

describe('appointment-reminder-worker', () => {
  it('sends a reminder for appointments in the T-24h window', async () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const start = new Date(now.getTime() + APPOINTMENT_REMINDER_LEAD_MS);

    const appointmentRepo = new InMemoryAppointmentRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId: TENANT,
      firstName: 'Sam',
      lastName: 'Lee',
      displayName: 'Sam Lee',
      primaryPhone: '+15559876543',
      smsConsent: true,
      isArchived: false,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobRepo = new InMemoryJobRepository();
    const jobId = uuidv4();
    await jobRepo.create({
      id: jobId,
      tenantId: TENANT,
      customerId,
      locationId: uuidv4(),
      jobNumber: 'JOB-R1',
      summary: 'Tune-up',
      status: 'scheduled',
      priority: 'normal',
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const appt = await createAppointment(
      {
        tenantId: TENANT,
        jobId,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 60 * 60 * 1000),
        timezone: 'UTC',
        createdBy: 'u1',
      },
      appointmentRepo,
    );

    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      businessName: 'Reminder Co',
      timezone: 'UTC',
      estimatePrefix: 'E-',
      invoicePrefix: 'I-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      autoSendAppointmentReminders: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const delivery = new InMemoryDeliveryProvider();
    const dispatch = new InMemoryDispatchRepository();
    const transactionalComms = new TransactionalCommsService({
      delivery,
      dispatchRepo: dispatch,
      dncRepo: new InMemoryDncRepository(),
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      invoiceRepo: new InMemoryInvoiceRepository(),
    });

    const result = await runAppointmentReminderSweep({
      appointmentRepo,
      transactionalComms,
      listTenantIds: async () => [TENANT],
      logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
      now: () => now,
    });

    expect(result.reminders).toBe(1);
    const rows = await dispatch.findByEntity(TENANT, 'appointment_reminder', appt.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(delivery.sentSms.some((m) => m.body.includes('Reminder'))).toBe(true);
  });
});
