/**
 * §8.4 row 4.5 — the SMS-keyword leg of "on my way", at real Postgres.
 *
 * test/integration/en-route-voice.test.ts already proves the voice, phone
 * (Gather) and chat legs of "on my way" hit real rows — the SAME
 * `appointment.en_route_triggered` audit event + `delay_notice_state` row
 * that dispatch/routes.ts's app-button `triggerEnRoute` writes.
 * test/sms/tech-status/en-route-keyword.test.ts proves the SMS-keyword
 * handler's own logic, but only against in-memory repos and a mocked
 * `enRouteCoordinator` — it never opens a pool. That gap is what #1008
 * flagged: "the SMS-keyword leg is the Docker gap."
 *
 * This file drives `dispatchInboundSms` with the REAL
 * `registerEnRouteSmsKeyword` handler (exactly as app.ts wires it) against
 * real Postgres-backed repos, proving:
 *   1. Parity with the other three legs — the SAME status row
 *      (`appointment.en_route_triggered` audit event, TECH actor) and the
 *      SAME `delay_notice_state` row shape.
 *   2. T1 — a second tenant's technician texting OMW never reaches, and
 *      leaves untouched, tenant A's appointment/audit/delay-notice rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ensureTenantSettings } from '../../src/settings/settings';
import { PgDelayNoticeStateRepository } from '../../src/notifications/pg-delay-notice-state';
import { DelayNotificationCoordinator, NextCustomerSelector } from '../../src/notifications/delay-notifications';
import { InMemoryQueue } from '../../src/queues/queue';
import { registerEnRouteSmsKeyword } from '../../src/sms/tech-status';
import {
  dispatchInboundSms,
  __resetKeywordRegistryForTests,
} from '../../src/sms/inbound-dispatch';

const NOW = new Date('2026-08-17T14:00:00.000Z');

describe('Postgres integration — "on my way" SMS-keyword leg (row 4.5)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let userRepo: PgUserRepository;
  let auditRepo: PgAuditRepository;
  let settingsRepo: PgSettingsRepository;
  let stateRepo: PgDelayNoticeStateRepository;
  let coordinator: DelayNotificationCoordinator;

  async function seedTenantFixture(label: string) {
    const t = await createTestTenant(pool);
    await ensureTenantSettings(t.tenantId, settingsRepo);
    await settingsRepo.upsertIdentityFields(t.tenantId, { timezone: 'America/Chicago' });

    const techId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, mobile_number, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'technician', $5, 'Terry', 'Field')`,
      [techId, t.tenantId, techId, `${label}@example.com`, `+1555${label}0001`],
    );

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Robin',
      lastName: 'Nguyen',
      displayName: 'Robin Nguyen',
      primaryPhone: '+15125559876',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: t.userId,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '9 Nguyen Court',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${label.toUpperCase()}`,
      summary: 'Water heater replacement',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const appointmentId = crypto.randomUUID();
    await appointmentRepo.create({
      id: appointmentId,
      tenantId: t.tenantId,
      jobId,
      scheduledStart: new Date(NOW.getTime() + 60 * 60 * 1000),
      scheduledEnd: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
      timezone: 'America/Chicago',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: t.userId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await assignmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      appointmentId,
      technicianId: techId,
      isPrimary: true,
      assignedBy: t.userId,
      assignedAt: NOW,
    });

    return { tenant: t, techId, techMobile: `+1555${label}0001`, appointmentId };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    userRepo = new PgUserRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    stateRepo = new PgDelayNoticeStateRepository(pool);

    const queue = new InMemoryQueue();
    const selector = new NextCustomerSelector(appointmentRepo, assignmentRepo, jobRepo, customerRepo);
    coordinator = new DelayNotificationCoordinator(queue, selector, stateRepo);

    __resetKeywordRegistryForTests();
    registerEnRouteSmsKeyword({
      userRepo,
      settingsRepo,
      assignmentRepo,
      appointmentRepo,
      jobRepo,
      enRouteCoordinator: coordinator,
      auditRepo,
      now: () => NOW,
    });
  });

  afterAll(async () => {
    __resetKeywordRegistryForTests();
    await closeSharedTestDb();
  });

  it('a registered tech texting OMW fires the SAME audited act + delay_notice_state row as the app button/voice/chat legs', async () => {
    const fx = await seedTenantFixture('sms-a');

    const result = await dispatchInboundSms({
      tenantId: fx.tenant.tenantId,
      fromE164: fx.techMobile,
      body: 'OMW',
      messageSid: `SM-${crypto.randomUUID()}`,
    });

    expect(result.handled).toBe(true);
    expect(result.handler).toBe('en-route-sms');

    const auditRows = await pool.query(
      `SELECT actor_id, actor_role FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered' AND entity_id = $2`,
      [fx.tenant.tenantId, fx.appointmentId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].actor_id).toBe(fx.techId);
    expect(auditRows.rows[0].actor_role).toBe('technician');

    const stateRows = await pool.query(
      `SELECT idempotency_key, channel, status FROM delay_notice_state
        WHERE tenant_id = $1 AND appointment_id = $2`,
      [fx.tenant.tenantId, fx.appointmentId],
    );
    expect(stateRows.rows).toHaveLength(1);
    expect(stateRows.rows[0].idempotency_key).toBe(`${fx.appointmentId}:en_route`);
    expect(stateRows.rows[0].channel).toBe('sms');
    expect(stateRows.rows[0].status).toBe('queued');
  });

  it('T1 — a second tenant\'s tech texting OMW never touches the first tenant\'s rows', async () => {
    const fxA = await seedTenantFixture('sms-t1a');
    const fxB = await seedTenantFixture('sms-t1b');

    const resultB = await dispatchInboundSms({
      tenantId: fxB.tenant.tenantId,
      fromE164: fxB.techMobile,
      body: 'on my way',
      messageSid: `SM-${crypto.randomUUID()}`,
    });
    expect(resultB.handled).toBe(true);

    // Tenant B gets its own real rows.
    const auditB = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered' AND entity_id = $2`,
      [fxB.tenant.tenantId, fxB.appointmentId],
    );
    expect(auditB.rows).toHaveLength(1);

    // Tenant A's appointment (created in this same test, never texted) has
    // zero en-route audit rows and zero delay_notice_state rows — tenant B's
    // OMW never reached it.
    const auditA = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered' AND entity_id = $2`,
      [fxA.tenant.tenantId, fxA.appointmentId],
    );
    expect(auditA.rows).toHaveLength(0);
    const stateA = await pool.query(
      `SELECT idempotency_key FROM delay_notice_state WHERE tenant_id = $1 AND appointment_id = $2`,
      [fxA.tenant.tenantId, fxA.appointmentId],
    );
    expect(stateA.rows).toHaveLength(0);

    // Cross-tenant read: tenant A's id can never see tenant B's audit row.
    const crossRead = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND entity_id = $2`,
      [fxA.tenant.tenantId, fxB.appointmentId],
    );
    expect(crossRead.rows).toHaveLength(0);
  });
});
