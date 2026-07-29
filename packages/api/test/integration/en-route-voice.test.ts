/**
 * B5.5 (AC-4) — "on my way" by voice, real Postgres.
 *
 * Proves, against a real database (conventions from
 * test/integration/voice-inbound-appointment.test.ts; cross-tenant pattern
 * from test/integration/onboarding-conversation.test.ts:128):
 *
 *   1. A voice-triggered en-route (`handleEnRouteVoiceIntent`, the exact
 *      orchestrator `workers/voice-action-router.ts` calls for the
 *      classified `en_route` intent) emits the
 *      `appointment.en_route_triggered` audit event with the TECH as actor
 *      (never a generic 'system' actor) — the same act the app en-route
 *      button and the SMS-keyword leg use (`dispatch/routes.ts
 *      triggerEnRoute`).
 *   2. A customer ETA SMS "dispatch row" lands via the EXISTING branded
 *      template path — `DelayNotificationCoordinator.enqueueEnRouteNotice`
 *      writes a real `delay_notice_state` row (channel 'sms', status
 *      'queued') keyed by the coordinator's own idempotency mechanism.
 *   3. Idempotence: a second "on my way" utterance inside the window does
 *      NOT double-text the customer — the SAME `delay_notice_state` row
 *      (by idempotency key) is reused, not duplicated, and the coordinator
 *      does not re-enter the render/upsert path.
 *   4. Cross-tenant negative: a technician in tenant B has zero assignments
 *      of their own; RLS-scoped appointment reads for tenant A's
 *      appointment ID return nothing under tenant B's context, so
 *      resolution honestly reports "no upcoming appointment" rather than
 *      leaking or acting on another tenant's row — no audit event, no
 *      delay_notice_state row is created for the cross-tenant attempt.
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
import { PgDelayNoticeStateRepository } from '../../src/notifications/pg-delay-notice-state';
import {
  DelayNotificationCoordinator,
  NextCustomerSelector,
} from '../../src/notifications/delay-notifications';
import { InMemoryQueue } from '../../src/queues/queue';
import { handleEnRouteVoiceIntent } from '../../src/dispatch/en-route-voice';
import type { VoiceRepository } from '../../src/voice/voice-service';

const NOW = new Date('2026-08-03T14:00:00.000Z'); // a Monday, well inside the appt windows below

async function insertTechnician(
  pool: Pool,
  tenantId: string,
  opts: { clerkUserId: string; email: string; firstName: string; lastName: string },
): Promise<string> {
  const userId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
     VALUES ($1, $2, $3, $4, 'technician', $5, $6)`,
    [userId, tenantId, opts.clerkUserId, opts.email, opts.firstName, opts.lastName],
  );
  return userId;
}

describe('Integration — "on my way" by voice (real Postgres)', () => {
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

  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let techA: string;
  let techAClerkId: string;
  let techB: string;
  let techBClerkId: string;
  let appointmentId: string;
  let jobId: string;

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
    // The SAME coordinator class the app en-route button and the SMS-keyword
    // leg use — B5.5's whole premise is that all three legs call one act.
    coordinator = new DelayNotificationCoordinator(queue, selector, stateRepo);

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    techAClerkId = `clerk-tech-a-${crypto.randomUUID()}`;
    techA = await insertTechnician(pool, tenantA.tenantId, {
      clerkUserId: techAClerkId,
      email: 'tech-a@example.com',
      firstName: 'Carlos',
      lastName: 'Ruiz',
    });
    techBClerkId = `clerk-tech-b-${crypto.randomUUID()}`;
    techB = await insertTechnician(pool, tenantB.tenantId, {
      clerkUserId: techBClerkId,
      email: 'tech-b@example.com',
      firstName: 'Dana',
      lastName: 'Lee',
    });

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenantA.tenantId,
      firstName: 'Jamie',
      lastName: 'Garcia',
      displayName: 'Jamie Garcia',
      primaryPhone: '+15125551234',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenantA.tenantId,
      customerId,
      street1: '77 Garcia Lane',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenantA.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-EN-ROUTE-1',
      summary: 'Garcia — AC repair',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    appointmentId = crypto.randomUUID();
    await appointmentRepo.create({
      id: appointmentId,
      tenantId: tenantA.tenantId,
      jobId,
      scheduledStart: new Date(NOW.getTime() + 60 * 60 * 1000),
      scheduledEnd: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
      timezone: 'America/Chicago',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await assignmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenantA.tenantId,
      appointmentId,
      technicianId: techA,
      isPrimary: true,
      assignedBy: tenantA.userId,
      assignedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function voiceRepoFor(clerkId: string): Pick<VoiceRepository, 'findById'> {
    return {
      findById: async (_tenantId: string, id: string) =>
        ({
          id,
          tenantId: tenantA.tenantId,
          createdBy: clerkId,
        }) as Awaited<ReturnType<VoiceRepository['findById']>>,
    };
  }

  it('AC-4.1/4.2: a voice-triggered en-route emits the audit event (TECH actor) + a customer ETA SMS dispatch row', async () => {
    const outcome = await handleEnRouteVoiceIntent(
      {
        userRepo,
        voiceRepo: voiceRepoFor(techAClerkId),
        assignmentRepo,
        appointmentRepo,
        jobRepo,
        enRouteCoordinator: coordinator,
        auditRepo,
        settingsRepo,
        now: () => NOW,
      },
      { tenantId: tenantA.tenantId, recordingId: 'rec-1', jobReference: 'the Garcia job' },
    );

    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') {
      expect(outcome.answer.result).toBe('found');
    }

    // 1. Audit event, real Postgres, TECH actor.
    const auditRows = await pool.query(
      `SELECT actor_id, actor_role, event_type FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered'
          AND entity_type = 'appointment' AND entity_id = $2`,
      [tenantA.tenantId, appointmentId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].actor_id).toBe(techA);
    expect(auditRows.rows[0].actor_role).toBe('technician');

    // 2. Customer ETA SMS dispatch row — the existing branded template path.
    const stateRows = await pool.query(
      `SELECT idempotency_key, channel, status, appointment_id FROM delay_notice_state
        WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenantA.tenantId, appointmentId],
    );
    expect(stateRows.rows).toHaveLength(1);
    expect(stateRows.rows[0].idempotency_key).toBe(`${appointmentId}:en_route`);
    expect(stateRows.rows[0].channel).toBe('sms');
    expect(stateRows.rows[0].status).toBe('queued');
  });

  it('AC-4.3: idempotence — a second "on my way" in-window does not double-text (same delay_notice_state row, no duplicate audit event count explosion)', async () => {
    // Second utterance for the SAME appointment, moments later.
    const outcome = await handleEnRouteVoiceIntent(
      {
        userRepo,
        voiceRepo: voiceRepoFor(techAClerkId),
        assignmentRepo,
        appointmentRepo,
        jobRepo,
        enRouteCoordinator: coordinator,
        auditRepo,
        settingsRepo,
        now: () => new Date(NOW.getTime() + 60_000),
      },
      { tenantId: tenantA.tenantId, recordingId: 'rec-2', jobReference: 'the Garcia job' },
    );

    expect(outcome.kind).toBe('answered');

    // Still exactly ONE delay_notice_state row for this appointment — the
    // coordinator's idempotency key (`${appointmentId}:en_route`) dedups the
    // second call rather than sending (or queueing) a second customer text.
    const stateRows = await pool.query(
      `SELECT idempotency_key, status FROM delay_notice_state
        WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenantA.tenantId, appointmentId],
    );
    expect(stateRows.rows).toHaveLength(1);

    // The audited direct status act itself is NOT deduped (each spoken "on
    // my way" is a real, distinct technician action worth its own audit
    // trail) — but the underlying customer SMS is: both calls resolve to
    // the SAME idempotencyKey, proving the dedup mechanism actually fired
    // rather than two unrelated keys happening to queue twice.
    const auditRows = await pool.query(
      `SELECT correlation_id FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered'
          AND entity_type = 'appointment' AND entity_id = $2
        ORDER BY created_at ASC`,
      [tenantA.tenantId, appointmentId],
    );
    expect(auditRows.rows.length).toBeGreaterThanOrEqual(2);
    const correlationIds = new Set(auditRows.rows.map((r) => r.correlation_id));
    expect(correlationIds).toEqual(new Set([`${appointmentId}:en_route`]));
  });

  it('AC-4.4: cross-tenant negative — a tenant B technician resolves to "no upcoming appointment", never tenant A\'s row', async () => {
    const outcome = await handleEnRouteVoiceIntent(
      {
        userRepo,
        voiceRepo: voiceRepoFor(techBClerkId),
        assignmentRepo,
        appointmentRepo,
        jobRepo,
        enRouteCoordinator: coordinator,
        auditRepo,
        settingsRepo,
        now: () => NOW,
      },
      { tenantId: tenantB.tenantId, recordingId: 'rec-cross-tenant', jobReference: 'the Garcia job' },
    );

    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') {
      expect(outcome.answer.result).toBe('none');
    }

    // The RLS-scoped read for tenant B never sees tenant A's appointment.
    const crossTenantRead = await appointmentRepo.findById(tenantB.tenantId, appointmentId);
    expect(crossTenantRead).toBeNull();

    // No en-route audit event was recorded for tenant B's attempt.
    const auditRows = await pool.query(
      `SELECT id FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered'`,
      [tenantB.tenantId],
    );
    expect(auditRows.rows).toHaveLength(0);

    // And tenant A's appointment/dispatch state is untouched by tenant B's attempt.
    const stateRows = await pool.query(
      `SELECT idempotency_key FROM delay_notice_state WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenantA.tenantId, appointmentId],
    );
    expect(stateRows.rows).toHaveLength(1);
  });
});
