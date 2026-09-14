/**
 * #1131 — "on my way" notice delivery at real Postgres: the worker must
 * settle a DELIVERED notice as `sent`, record its analytics row, and never
 * re-send it.
 *
 * The defect: `dispatch_analytics.event_type`'s CHECK (migration 105) never
 * listed 'en_route_notice_sent' / 'en_route_notice_failed', which the delay
 * delivery worker (`createDelayNotificationWorker`) writes for every en-route
 * notice. The worker sends the SMS FIRST, marks the state `sent`, then the
 * analytics insert throws 23514 — and the catch block flips the state to
 * `failed` and throws again, so the queue re-delivers the message and the
 * customer is texted again on every retry.
 *
 * Everything here is the production path except the carrier: the real
 * `DelayNotificationCoordinator.enqueueEnRouteNotice` (what the app button,
 * voice, chat and SMS-keyword legs call), the real `PgQueue`, the real
 * worker, `TwilioDelayNotificationService` over the real consent/DNC gate
 * (`GatedMessageDelivery`, 'block' mode) and real Pg repositories. Only the
 * bytes-on-the-wire provider is the in-memory recorder, so the number of
 * texts the customer would have received is countable.
 *
 * The drain loop below mirrors app.ts's `handleQueueMessage` (delete on
 * success; recordFailure + DLQ at max attempts; otherwise the message stays
 * for redelivery) — visibilityTimeout 0 so redelivery is immediate.
 *
 * T1: tenant B has its own consented customer + appointment that is never
 * tapped; its delay_notice_state / dispatch_analytics / message_dispatches
 * stay empty and its RLS-scoped analytics read never sees tenant A's row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgDncRepository } from '../../src/compliance/dnc';
import { PgDelayNoticeStateRepository } from '../../src/notifications/pg-delay-notice-state';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';
import { PgDispatchAnalyticsRepository } from '../../src/dispatch/pg-analytics';
import {
  DelayNotificationCoordinator,
  NextCustomerSelector,
  createDelayNotificationWorker,
  type DelayNoticeQueuePayload,
} from '../../src/notifications/delay-notifications';
import { TwilioDelayNotificationService } from '../../src/notifications/twilio-delay-notification-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { PgQueue } from '../../src/queues/pg-queue';
import { processMessage, type QueueMessage, type WorkerHandler } from '../../src/queues/queue';
import { createLogger } from '../../src/logging/logger';

const NOW = new Date('2026-08-17T14:00:00.000Z');

describe('Postgres integration — en-route notice delivery settles sent + records analytics (#1131)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let stateRepo: PgDelayNoticeStateRepository;
  let analyticsRepo: PgDispatchAnalyticsRepository;
  let queue: PgQueue;
  let carrier: InMemoryDeliveryProvider;
  let coordinator: DelayNotificationCoordinator;
  let worker: WorkerHandler<DelayNoticeQueuePayload>;
  const logger = createLogger({ service: 'en-route-delivery-it', environment: 'test' });

  async function seedTenantFixture(label: string, phone: string) {
    const t = await createTestTenant(pool);
    const techId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'technician', 'Terry', 'Field')`,
      [techId, t.tenantId, techId, `${label}-${techId}@example.com`],
    );

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: label === 'a' ? 'Robin' : 'Casey',
      lastName: 'Nguyen',
      displayName: label === 'a' ? 'Robin Nguyen' : 'Casey Nguyen',
      primaryPhone: phone,
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
      street1: `${label} Nguyen Court`,
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
      jobNumber: `JOB-ENR-${label.toUpperCase()}-${jobId.slice(0, 6)}`,
      summary: label === 'a' ? 'Water heater replacement' : 'AC tune-up',
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

    return { tenantId: t.tenantId, appointmentId, customerId, phone };
  }

  /** Mirrors app.ts handleQueueMessage, restricted to the delay-notice type. */
  async function drainDelayNoticeQueue(): Promise<void> {
    for (let tick = 0; tick < 20; tick++) {
      const batch = await queue.receiveBatch(10);
      const ours = batch.filter((m) => m.type === DelayNotificationCoordinator.QUEUE_TYPE);
      if (ours.length === 0) return;
      for (const message of ours) {
        const result = await processMessage(
          message as QueueMessage<DelayNoticeQueuePayload>,
          worker,
          logger,
        );
        if (result.success) {
          await queue.delete(message.id);
        } else {
          await queue.recordFailure(message.id, result.error ?? 'unknown error');
          if (message.attempts >= message.maxAttempts) {
            await queue.moveToDeadLetter(message, result.error ?? 'max attempts exceeded');
          }
        }
      }
    }
  }

  function textsTo(phone: string): number {
    return carrier.sentSms.filter((m) => m.to === phone).length;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    stateRepo = new PgDelayNoticeStateRepository(pool);
    analyticsRepo = new PgDispatchAnalyticsRepository(pool);

    queue = new PgQueue(pool, { maxRetries: 3, visibilityTimeout: 0 });
    // Lazily create the global queue tables, then start from a clean slate
    // (files run one at a time — vitest.integration.config.ts maxWorkers: 1).
    await queue.depth();
    await pool.query(`DELETE FROM _queue_messages WHERE type = $1`, [DelayNotificationCoordinator.QUEUE_TYPE]);

    carrier = new InMemoryDeliveryProvider();
    const gated = new GatedMessageDelivery({
      base: carrier,
      dnc: new PgDncRepository(pool),
      auditRepo: new PgAuditRepository(pool),
      enforcement: 'block',
      env: {},
    });
    const service = new TwilioDelayNotificationService(gated, new PgDispatchRepository(pool), customerRepo);

    coordinator = new DelayNotificationCoordinator(
      queue,
      new NextCustomerSelector(appointmentRepo, assignmentRepo, jobRepo, customerRepo),
      stateRepo,
    );
    worker = createDelayNotificationWorker({ service, stateRepo, analyticsRepo });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a consented customer\'s "on my way" notice settles sent, records ONE en_route_notice_sent row, and is texted exactly once — even after a second tap; T1', async () => {
    const a = await seedTenantFixture('a', '+15125550131');
    const b = await seedTenantFixture('b', '+15125550132');

    const key = await coordinator.enqueueEnRouteNotice({
      tenantId: a.tenantId,
      appointmentId: a.appointmentId,
      technicianName: 'Terry',
    });
    expect(key).toBe(`${a.appointmentId}:en_route`);
    await drainDelayNoticeQueue();

    const stateRows = await pool.query(
      `SELECT status, channel, last_error FROM delay_notice_state WHERE tenant_id = $1 AND appointment_id = $2`,
      [a.tenantId, a.appointmentId],
    );
    const analyticsRows = await pool.query(
      `SELECT event_type, metadata->>'channel' AS channel FROM dispatch_analytics
        WHERE tenant_id = $1 AND appointment_id = $2 ORDER BY recorded_at`,
      [a.tenantId, a.appointmentId],
    );
    const dispatchRows = await pool.query(
      `SELECT entity_type, status FROM message_dispatches WHERE tenant_id = $1 AND entity_id = $2`,
      [a.tenantId, a.appointmentId],
    );
    // One observation object so a failing run shows the whole picture at once.
    expect({
      deliveryState: stateRows.rows,
      analytics: analyticsRows.rows,
      dispatches: dispatchRows.rows,
      textsToCustomer: textsTo(a.phone),
    }).toEqual({
      deliveryState: [{ status: 'sent', channel: 'sms', last_error: null }],
      analytics: [{ event_type: 'en_route_notice_sent', channel: 'sms' }],
      dispatches: [{ entity_type: 'appointment_en_route', status: 'sent' }],
      textsToCustomer: 1,
    });

    // A second tap (or the voice/SMS-keyword leg firing for the same visit)
    // must not re-text a customer whose notice was already delivered.
    await coordinator.enqueueEnRouteNotice({
      tenantId: a.tenantId,
      appointmentId: a.appointmentId,
      technicianName: 'Terry',
    });
    await drainDelayNoticeQueue();
    expect(textsTo(a.phone), 'a second tap must not send a duplicate SMS').toBe(1);
    const analyticsAfterRetap = await pool.query(
      `SELECT count(*)::int AS c FROM dispatch_analytics WHERE tenant_id = $1 AND event_type = 'en_route_notice_sent'`,
      [a.tenantId],
    );
    expect(analyticsAfterRetap.rows[0].c).toBe(1);

    // ── T1 — tenant B (divergent data, never tapped) is untouched. ─────────
    expect(textsTo(b.phone)).toBe(0);
    const stateB = await pool.query(`SELECT 1 FROM delay_notice_state WHERE tenant_id = $1`, [b.tenantId]);
    expect(stateB.rows).toHaveLength(0);
    const analyticsB = await pool.query(`SELECT 1 FROM dispatch_analytics WHERE tenant_id = $1`, [b.tenantId]);
    expect(analyticsB.rows).toHaveLength(0);
    const dispatchB = await pool.query(`SELECT 1 FROM message_dispatches WHERE tenant_id = $1`, [b.tenantId]);
    expect(dispatchB.rows).toHaveLength(0);
    // RLS-scoped read through the product repository: B never sees A's row,
    // A sees exactly its own.
    expect(await analyticsRepo.getMetrics(b.tenantId)).toEqual([]);
    const metricsA = await analyticsRepo.getMetrics(a.tenantId);
    expect(metricsA.map((m) => m.eventType)).toEqual(['en_route_notice_sent']);
    expect(metricsA.every((m) => m.tenantId === a.tenantId)).toBe(true);
  });
});
