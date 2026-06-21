import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  runAppointmentReminderSweep,
  ownerReminderDispatchKey,
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
import { OwnerNotificationService } from '../../src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import { InMemoryDeviceTokenRepository } from '../../src/push/device-token-service';
import { setOwnerNotifications } from '../../src/notifications/owner-notifications-instance';

const TENANT = 'tenant-owner-push-1';
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

describe('appointment-reminder owner push (U4)', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let customerRepo: InMemoryCustomerRepository;
  let jobRepo: InMemoryJobRepository;
  let settingsRepo: InMemorySettingsRepository;
  let dispatchRepo: InMemoryDispatchRepository;
  let transactionalComms: TransactionalCommsService;
  let provider: InMemoryPushDeliveryProvider;
  let now: Date;
  let apptId: string;

  beforeEach(async () => {
    now = new Date('2026-06-01T12:00:00Z');
    const start = new Date(now.getTime() + APPOINTMENT_REMINDER_LEAD_MS);

    appointmentRepo = new InMemoryAppointmentRepository();
    customerRepo = new InMemoryCustomerRepository();
    jobRepo = new InMemoryJobRepository();
    settingsRepo = new InMemorySettingsRepository();
    dispatchRepo = new InMemoryDispatchRepository();

    const customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId: TENANT,
      firstName: 'Sam',
      lastName: 'Lee',
      displayName: 'Sam Lee',
      primaryPhone: '+15559876543',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

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
        timezone: 'America/Chicago',
        createdBy: 'u1',
      },
      appointmentRepo,
    );
    apptId = appt.id;

    await settingsRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      businessName: 'Reminder Co',
      timezone: 'America/Chicago',
      estimatePrefix: 'E-',
      invoicePrefix: 'I-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      autoSendAppointmentReminders: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    transactionalComms = new TransactionalCommsService({
      delivery: new InMemoryDeliveryProvider(),
      dispatchRepo,
      dncRepo: new InMemoryDncRepository(),
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      invoiceRepo: new InMemoryInvoiceRepository(),
    });

    // Register an owner device + the notifier instance.
    const tokenRepo = new InMemoryDeviceTokenRepository();
    await tokenRepo.register({
      tenantId: TENANT,
      userId: 'owner-1',
      expoPushToken: 'ExponentPushToken[owner-device]',
      platform: 'ios',
    });
    provider = new InMemoryPushDeliveryProvider();
    setOwnerNotifications(
      new OwnerNotificationService({ deviceTokenRepo: tokenRepo, provider }),
    );
  });

  afterEach(() => {
    setOwnerNotifications(undefined);
  });

  function sweep() {
    return runAppointmentReminderSweep({
      appointmentRepo,
      transactionalComms,
      jobRepo,
      customerRepo,
      settingsRepo,
      dispatchRepo,
      listTenantIds: async () => [TENANT],
      logger,
      now: () => now,
    });
  }

  it('fires an owner appointment_reminder push alongside the customer reminder', async () => {
    await sweep();

    expect(provider.sent).toHaveLength(1);
    const msg = provider.sent[0];
    expect(msg.data?.type).toBe('appointment_reminder');
    expect(msg.data?.entityId).toBe(apptId);
    // whenLabel rendered in the tenant timezone (Chicago = UTC-5 in June).
    expect(msg.body).toContain('Sam Lee');
    expect(msg.body).toContain('7:00'); // 12:00 UTC next day → 07:00 CDT

    // A separate owner-push dispatch row was persisted under its own key.
    const rows = await dispatchRepo.findByEntity(TENANT, 'appointment_reminder', apptId);
    expect(rows.some((r) => r.idempotencyKey === ownerReminderDispatchKey(apptId))).toBe(true);
  });

  it('does not double-push across repeated sweeps (separate dispatch key idempotency)', async () => {
    await sweep();
    await sweep();
    await sweep();

    expect(provider.sent).toHaveLength(1);
  });

  it('is best-effort: a missing owner-push dep skips the push without affecting the sweep', async () => {
    const result = await runAppointmentReminderSweep({
      appointmentRepo,
      transactionalComms,
      // jobRepo/customerRepo/settingsRepo/dispatchRepo omitted → push skipped.
      listTenantIds: async () => [TENANT],
      logger,
      now: () => now,
    });

    expect(result.reminders).toBe(1);
    expect(provider.sent).toHaveLength(0);
  });

  it('never throws when no notifier is registered', async () => {
    setOwnerNotifications(undefined);
    const result = await sweep();
    expect(result.reminders).toBe(1);
    expect(provider.sent).toHaveLength(0);
  });
});
