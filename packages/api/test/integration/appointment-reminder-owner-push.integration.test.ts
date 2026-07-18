/**
 * U4 — Docker-gated integration test for the appointment-reminder OWNER push.
 *
 * Seeds a real appointment (+ job + customer + settings + owner device token)
 * in Postgres, runs the reminder sweep, and asserts:
 *   1. the owner notifier fired for the REAL appointment id / customer, and
 *   2. the SEPARATE owner-push dispatch row was persisted (durable idempotency).
 *
 * Gating: like every test under test/integration/, this only runs via
 * `npm run test:integration`, where vitest globalSetup provisions a Postgres
 * testcontainer and sets TEST_DB_URL. Without Docker / TEST_DB_URL,
 * getSharedTestDb throws and the file is not exercised in PR-CI unit runs.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';
import { PgDeviceTokenRepository } from '../../src/push/pg-device-token-repository';
import { PgDncRepository } from '../../src/compliance/dnc';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { createAppointment } from '../../src/appointments/appointment';
import { TransactionalCommsService } from '../../src/notifications/transactional-comms-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import {
  runAppointmentReminderSweep,
  ownerReminderDispatchKey,
  APPOINTMENT_REMINDER_LEAD_MS,
} from '../../src/workers/appointment-reminder-worker';
import { OwnerNotificationService } from '../../src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import { setOwnerNotifications } from '../../src/notifications/owner-notifications-instance';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

describe('Postgres integration — appointment-reminder owner push (U4)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let settingsRepo: PgSettingsRepository;
  let dispatchRepo: PgDispatchRepository;
  let deviceTokenRepo: PgDeviceTokenRepository;
  let transactionalComms: TransactionalCommsService;
  let provider: InMemoryPushDeliveryProvider;
  let tenant: { tenantId: string; userId: string };
  let now: Date;
  let apptId: string;
  let customerId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    dispatchRepo = new PgDispatchRepository(pool);
    deviceTokenRepo = new PgDeviceTokenRepository(pool);
    transactionalComms = new TransactionalCommsService({
      delivery: new InMemoryDeliveryProvider(),
      dispatchRepo,
      dncRepo: new PgDncRepository(pool),
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      invoiceRepo: new PgInvoiceRepository(pool),
      pool,
      logger,
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
    now = new Date('2026-06-01T12:00:00Z');
    const start = new Date(now.getTime() + APPOINTMENT_REMINDER_LEAD_MS);

    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), tenant.tenantId, 'Acme Plumbing', 'America/Chicago'],
    );

    customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Pat',
      lastName: 'Rivera',
      displayName: 'Pat Rivera',
      primaryPhone: '+15125550100',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = uuidv4();
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [locationId, tenant.tenantId, customerId, '1 Main St', 'Austin', 'TX', '78701', 'US'],
    );

    const jobId = uuidv4();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: 'Tune-up',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const appt = await createAppointment(
      {
        tenantId: tenant.tenantId,
        jobId,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 60 * 60 * 1000),
        timezone: 'America/Chicago',
        createdBy: tenant.userId,
      },
      appointmentRepo,
    );
    apptId = appt.id;

    await deviceTokenRepo.register({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      expoPushToken: `ExponentPushToken[${tenant.tenantId.slice(0, 8)}]`,
      platform: 'ios',
    });

    provider = new InMemoryPushDeliveryProvider();
    // No resolveUserIds → back-compat send-to-all-tenant-devices, so the seeded
    // owner device receives the push without standing up the RBAC resolver.
    setOwnerNotifications(
      new OwnerNotificationService({ deviceTokenRepo, provider }),
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
      listTenantIds: async () => [tenant.tenantId],
      logger,
      now: () => now,
    });
  }

  it('fires the owner push for the real appointment and persists the owner-push dispatch key', async () => {
    await sweep();

    expect(provider.sent).toHaveLength(1);
    const msg = provider.sent[0];
    expect(msg.data?.type).toBe('appointment_reminder');
    expect(msg.data?.entityId).toBe(apptId);
    expect(msg.body).toContain('Pat Rivera');

    const rows = await dispatchRepo.findByEntity(
      tenant.tenantId,
      'appointment_reminder',
      apptId,
    );
    expect(rows.some((r) => r.idempotencyKey === ownerReminderDispatchKey(apptId))).toBe(true);
  });

  it('does not double-push across sweeps (durable dispatch-key idempotency)', async () => {
    await sweep();
    await sweep();
    expect(provider.sent).toHaveLength(1);
  });
});
