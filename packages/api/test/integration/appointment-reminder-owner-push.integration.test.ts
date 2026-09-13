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
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { listAllTenantIds } from '../../src/tenants/list-tenant-ids';
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
  let auditRepo: PgAuditRepository;
  let transactionalComms: TransactionalCommsService;
  let delivery: InMemoryDeliveryProvider;
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
    auditRepo = new PgAuditRepository(pool);
    delivery = new InMemoryDeliveryProvider();
    transactionalComms = new TransactionalCommsService({
      delivery,
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
    // `delivery` is a single instance shared across every test in this file
    // (built once in beforeAll, alongside `transactionalComms`), and the
    // fixture customer phone number is a fixed constant — without a reset,
    // a later test's `delivery.sentSms.find(...)` can match a STALE send
    // left over from an earlier test's tenant instead of its own.
    delivery.reset();
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
      undefined,
      auditRepo,
      'owner',
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

  it('appointment.created is readable back through PgAuditRepository.findByEntity', async () => {
    const events = await auditRepo.findByEntity(tenant.tenantId, 'appointment', apptId);
    expect(events.some((e) => e.eventType === 'appointment.created')).toBe(true);
  });

  /** A second, independent tenant with its own timezone/customer/appointment due at `dueAt`. */
  async function seedSecondTenant(opts: {
    timezone: string;
    dueAt: Date;
  }): Promise<{ tenantId: string; userId: string; apptId: string; phone: string; customerId: string }> {
    const second = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), second.tenantId, 'Second Tenant Co', opts.timezone],
    );
    const secondCustomerId = uuidv4();
    const phone = `+1555${second.tenantId.replace(/-/g, '').slice(0, 7)}`;
    await customerRepo.create({
      id: secondCustomerId,
      tenantId: second.tenantId,
      firstName: 'Jamie',
      lastName: 'Nguyen',
      displayName: 'Jamie Nguyen',
      primaryPhone: phone,
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: second.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = uuidv4();
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [locationId, second.tenantId, secondCustomerId, '2 Second St', 'Phoenix', 'AZ', '85001', 'US'],
    );
    const jobId = uuidv4();
    await jobRepo.create({
      id: jobId,
      tenantId: second.tenantId,
      customerId: secondCustomerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: 'Second-tenant tune-up',
      status: 'scheduled',
      priority: 'normal',
      createdBy: second.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const secondAppt = await createAppointment(
      {
        tenantId: second.tenantId,
        jobId,
        scheduledStart: opts.dueAt,
        scheduledEnd: new Date(opts.dueAt.getTime() + 60 * 60 * 1000),
        timezone: opts.timezone,
        createdBy: second.userId,
      },
      appointmentRepo,
    );
    return { tenantId: second.tenantId, userId: second.userId, apptId: secondAppt.id, phone, customerId: secondCustomerId };
  }

  it('T1 — fans out to a second tenant on the REAL enumerator without crossing either tenant\'s push or dispatch rows', async () => {
    const otherTenant = await seedSecondTenant({
      timezone: 'America/Chicago',
      dueAt: new Date(now.getTime() + APPOINTMENT_REMINDER_LEAD_MS),
    });

    const realIds = await listAllTenantIds(pool);
    expect(realIds).toEqual(expect.arrayContaining([tenant.tenantId, otherTenant.tenantId]));

    await runAppointmentReminderSweep({
      appointmentRepo,
      transactionalComms,
      jobRepo,
      customerRepo,
      settingsRepo,
      dispatchRepo,
      listTenantIds: () => listAllTenantIds(pool),
      logger,
      now: () => now,
    });

    // Each tenant's own appointment got its own dispatch row — neither tenant's
    // key leaks into the other's.
    const firstRows = await dispatchRepo.findByEntity(tenant.tenantId, 'appointment_reminder', apptId);
    const otherRows = await dispatchRepo.findByEntity(otherTenant.tenantId, 'appointment_reminder', otherTenant.apptId);
    expect(firstRows.some((r) => r.idempotencyKey === ownerReminderDispatchKey(apptId))).toBe(true);
    expect(otherRows.some((r) => r.idempotencyKey === ownerReminderDispatchKey(otherTenant.apptId))).toBe(true);
    // cross-tenant leak check: the FIRST tenant's dispatch row is not readable
    // under the OTHER tenant's id, and vice versa — another tenant never sees it.
    expect(await dispatchRepo.findByEntity(otherTenant.tenantId, 'appointment_reminder', apptId)).toEqual([]);
    expect(await dispatchRepo.findByEntity(tenant.tenantId, 'appointment_reminder', otherTenant.apptId)).toEqual([]);
  });

  it('T3 — two tenants in two timezones, both due at the SAME instant, each gets exactly its own reminder', async () => {
    const phoenix = await seedSecondTenant({
      timezone: 'America/Phoenix',
      dueAt: new Date(now.getTime() + APPOINTMENT_REMINDER_LEAD_MS),
    });

    await runAppointmentReminderSweep({
      appointmentRepo,
      transactionalComms,
      jobRepo,
      customerRepo,
      settingsRepo,
      dispatchRepo,
      listTenantIds: async () => [tenant.tenantId, phoenix.tenantId],
      logger,
      now: () => now,
    });

    // Both tenants' customers were reminded in the SAME sweep pass.
    const chicagoSms = delivery.sentSms.find((m) => m.to === '+15125550100');
    const phoenixSms = delivery.sentSms.find((m) => m.to === phoenix.phone);
    expect(chicagoSms).toBeDefined();
    expect(phoenixSms).toBeDefined();
    // …and each carries ITS OWN tenant scope — not the other tenant's.
    expect(chicagoSms?.tenantId).toBe(tenant.tenantId);
    expect(phoenixSms?.tenantId).toBe(phoenix.tenantId);
  });
});
