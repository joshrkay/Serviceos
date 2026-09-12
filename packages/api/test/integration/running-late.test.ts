/**
 * §8.4 row 4.6 — "running late" (POST /:id/running-late), at real Postgres.
 *
 * test/routes/appointments.running-late.test.ts already pins the route's
 * permission/validation logic, but entirely against in-memory repos and a
 * `vi.fn()` stand-in for `DelayNotificationCoordinator` — it never opens a
 * pool, and never proves what actually lands in `delay_notice_state`. This
 * file drives the SAME route with real Postgres-backed repos and the REAL
 * `DelayNotificationCoordinator`, proving:
 *   1. A technician's one-tap running-late notice writes a real
 *      `appointment.running_late_triggered` audit row AND a real
 *      `delay_notice_state` row (channel/status), keyed by the SAME
 *      idempotency scheme as "on my way".
 *   2. T1 — a technician in tenant B cannot trigger (or see) a running-late
 *      notice against tenant A's appointment, and tenant A's rows are
 *      untouched by tenant B's own running-late notice.
 *
 * §12.4d honesty, NOT invented around: the ticket's target for this row is
 * "a customer message as a comms-class PROPOSAL (never auto-sent), consent-
 * gated". Reading routes/appointments.ts's `handleRunningLate` and
 * `DelayNotificationCoordinator.enqueueDelayNotice`
 * (src/notifications/delay-notifications.ts) shows the ACTUAL behavior is a
 * DIRECT audited act — the same shape as "on my way" (dispatch/routes.ts's
 * doc comment calls en-route "the human acting directly, not an AI
 * proposal") — gated on SMS consent + DNC (`isSmsSuppressed`), but never
 * gated behind a proposal an owner must approve; it auto-sends (subject to
 * that consent/DNC check) as soon as the technician taps. No
 * `reschedule_appointment`-shaped comms proposal is created anywhere on this
 * path. This test proves the REAL behavior; it does not assert the
 * proposal-gated behavior the ticket describes, because that behavior does
 * not exist in product code (out of scope for this TEST-ONLY lane to add).
 * Flagged for Fable/Josh — see the lane report.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import express, { Response, NextFunction } from 'express';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgJobTimelineRepository } from '../../src/jobs/pg-job-lifecycle';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ensureTenantSettings } from '../../src/settings/settings';
import { PgDelayNoticeStateRepository } from '../../src/notifications/pg-delay-notice-state';
import { DelayNotificationCoordinator, NextCustomerSelector } from '../../src/notifications/delay-notifications';
import { InMemoryQueue } from '../../src/queues/queue';
import { createAppointmentRouter } from '../../src/routes/appointments';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const NOW = new Date('2026-08-24T14:00:00.000Z');

describe('Postgres integration — "running late" one-tap notice (row 4.6)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let timelineRepo: PgJobTimelineRepository;
  let auditRepo: PgAuditRepository;
  let settingsRepo: PgSettingsRepository;
  let stateRepo: PgDelayNoticeStateRepository;
  let coordinator: DelayNotificationCoordinator;

  async function seedTenantFixture(label: string) {
    const t = await createTestTenant(pool);
    await ensureTenantSettings(t.tenantId, settingsRepo);
    await settingsRepo.upsertIdentityFields(t.tenantId, { timezone: 'America/Chicago' });

    const techId = crypto.randomUUID();
    const techClerkId = `clerk-${label}-${crypto.randomUUID()}`;
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'technician', 'Carlos', 'Ruiz')`,
      [techId, t.tenantId, techClerkId, `${label}@example.com`],
    );

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Jamie',
      lastName: 'Garcia',
      displayName: 'Jamie Garcia',
      primaryPhone: '+15125551234',
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
      street1: '77 Garcia Lane',
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
      summary: 'AC repair',
      status: 'scheduled',
      priority: 'normal',
      assignedTechnicianId: techId,
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

    // NextCustomerSelector.select (delay-notifications.ts) resolves the
    // delay notice to the technician's NEXT appointment later the SAME
    // service day — not the current one — so a second, later appointment
    // for the SAME tech is required for enqueueDelayNotice to find a target.
    const nextCustomerId = crypto.randomUUID();
    await customerRepo.create({
      id: nextCustomerId,
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
    const nextLocationId = crypto.randomUUID();
    await locationRepo.create({
      id: nextLocationId,
      tenantId: t.tenantId,
      customerId: nextCustomerId,
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
    const nextJobId = crypto.randomUUID();
    await jobRepo.create({
      id: nextJobId,
      tenantId: t.tenantId,
      customerId: nextCustomerId,
      locationId: nextLocationId,
      jobNumber: `JOB-${label.toUpperCase()}-NEXT`,
      summary: 'Water heater replacement',
      status: 'scheduled',
      priority: 'normal',
      assignedTechnicianId: techId,
      createdBy: t.userId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const nextAppointmentId = crypto.randomUUID();
    await appointmentRepo.create({
      id: nextAppointmentId,
      tenantId: t.tenantId,
      jobId: nextJobId,
      scheduledStart: new Date(NOW.getTime() + 3 * 60 * 60 * 1000),
      scheduledEnd: new Date(NOW.getTime() + 4 * 60 * 60 * 1000),
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
      appointmentId: nextAppointmentId,
      technicianId: techId,
      isPrimary: true,
      assignedBy: t.userId,
      assignedAt: NOW,
    });

    return { tenant: t, techId, techClerkId, jobId, appointmentId, nextAppointmentId };
  }

  function appFor(tenantId: string, userId: string, canonicalUserId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId,
        canonicalUserId,
        sessionId: 'sess-running-late',
        tenantId,
        role: 'technician',
      };
      next();
    });
    app.use(
      '/api/appointments',
      createAppointmentRouter(
        appointmentRepo,
        permissiveTenantOwnership(),
        jobRepo,
        timelineRepo,
        { delayNotificationCoordinator: coordinator },
        auditRepo,
      ),
    );
    return app;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    timelineRepo = new PgJobTimelineRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    stateRepo = new PgDelayNoticeStateRepository(pool);

    const queue = new InMemoryQueue();
    const selector = new NextCustomerSelector(appointmentRepo, assignmentRepo, jobRepo, customerRepo);
    coordinator = new DelayNotificationCoordinator(queue, selector, stateRepo);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a technician tapping running-late writes a real audit row + delay_notice_state row', async () => {
    const fx = await seedTenantFixture('rl-a');
    const app = appFor(fx.tenant.tenantId, fx.techClerkId, fx.techId);

    const res = await request(app)
      .post(`/api/appointments/${fx.appointmentId}/running-late`)
      .send({ delayMinutes: 20 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ appointmentId: fx.appointmentId, delayMinutes: 20, queued: true });

    const auditRows = await pool.query(
      `SELECT actor_id, actor_role, event_type FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.running_late_triggered' AND entity_id = $2`,
      [fx.tenant.tenantId, fx.appointmentId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].actor_id).toBe(fx.techClerkId);
    expect(auditRows.rows[0].actor_role).toBe('technician');

    // The delay notice targets the technician's NEXT appointment the same
    // day (NextCustomerSelector.select), not the appointment the tech is
    // currently running late FROM.
    const stateRows = await pool.query(
      `SELECT idempotency_key, channel, status, delay_version FROM delay_notice_state
        WHERE tenant_id = $1 AND appointment_id = $2`,
      [fx.tenant.tenantId, fx.nextAppointmentId],
    );
    expect(stateRows.rows).toHaveLength(1);
    expect(stateRows.rows[0].idempotency_key).toBe(`${fx.nextAppointmentId}:0`);
    expect(stateRows.rows[0].channel).toBe('sms');
    expect(stateRows.rows[0].status).toBe('queued');
  });

  it('T1 — a tenant B technician cannot see or trigger a running-late notice against tenant A\'s appointment', async () => {
    const fxA = await seedTenantFixture('rl-t1a');
    const fxB = await seedTenantFixture('rl-t1b');

    // Tenant B's technician, hitting tenant A's appointment id under tenant
    // B's own auth context — the RLS-scoped read returns nothing, so the
    // route 404s rather than leaking (or acting on) tenant A's appointment.
    const crossApp = appFor(fxB.tenant.tenantId, fxB.techClerkId, fxB.techId);
    const crossRes = await request(crossApp)
      .post(`/api/appointments/${fxA.appointmentId}/running-late`)
      .send({});
    expect(crossRes.status).toBe(404);

    // Tenant A's rows are untouched by the cross-tenant attempt.
    const auditA = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'appointment.running_late_triggered' AND entity_id = $2`,
      [fxA.tenant.tenantId, fxA.appointmentId],
    );
    expect(auditA.rows).toHaveLength(0);
    const stateA = await pool.query(
      `SELECT idempotency_key FROM delay_notice_state WHERE tenant_id = $1 AND appointment_id = $2`,
      [fxA.tenant.tenantId, fxA.appointmentId],
    );
    expect(stateA.rows).toHaveLength(0);

    // Tenant B's OWN technician, on tenant B's OWN appointment, still works
    // normally and produces tenant B's own rows only.
    const ownApp = appFor(fxB.tenant.tenantId, fxB.techClerkId, fxB.techId);
    const ownRes = await request(ownApp)
      .post(`/api/appointments/${fxB.appointmentId}/running-late`)
      .send({});
    expect(ownRes.status).toBe(200);

    const auditB = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'appointment.running_late_triggered' AND entity_id = $2`,
      [fxB.tenant.tenantId, fxB.appointmentId],
    );
    expect(auditB.rows).toHaveLength(1);

    // And a cross-tenant read of tenant B's new row under tenant A's id
    // still returns nothing.
    const crossRead = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND entity_id = $2`,
      [fxA.tenant.tenantId, fxB.appointmentId],
    );
    expect(crossRead.rows).toHaveLength(0);
  });
});
